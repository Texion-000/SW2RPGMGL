/**
 * Atomic SD-card save manager for Universal Switch 2 RPG Maker MV Loader.
 * Supports:
 *   - config.rpgsave (slot -1)
 *   - global.rpgsave (slot 0)
 *   - file1.rpgsave .. fileN.rpgsave
 *   - UTA_CommonSave.js (common.rpgsave)
 *   - Any plugin-chained `StorageManager.localFilePath(id)` (SoundTest, achievements, YEP_SaveCore, etc.)
 *
 * Uses exact PC LZString-base64 `.rpgsave` format so PC saves can be copied
 * directly into `sdmc:/switch/switch2-MV-loader/<game-folder>/save/` and back!
 */
import { ensureDir, log, type SwitchApi } from './log';

function fallbackSlotFilename(id: unknown): string {
  if (id === -1) return 'config.rpgsave';
  if (id === 0) return 'global.rpgsave';
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return `file${id}.rpgsave`;
  const safe = String(id ?? 'custom').replace(/[^A-Za-z0-9._-]/g, '_');
  return `custom_${safe}.rpgsave`;
}

export function installSdSaves(
  runtime: Record<string, any>,
  sw: SwitchApi,
  saveDir: string,
): void {
  const manager = runtime.StorageManager;
  const codec = runtime.LZString;
  if (!manager || !codec) {
    log('[saves] StorageManager or LZString unavailable');
    return;
  }

  const cleanDir = saveDir.replace(/\/+$/, '');
  ensureDir(sw, cleanDir);

  const origLocalFilePath: ((id: any) => string) | null =
    typeof manager.localFilePath === 'function' ? manager.localFilePath : null;

  manager.isLocalMode = () => true;
  manager.localFileDirectoryPath = () => `${cleanDir}/`;

  const filePath = (name: string) => `${cleanDir}/${name}`;
  const cleanDirPrefix = `${cleanDir.toLowerCase()}/`;
  const resolveSlotPath = (id: any): string => {
    if (origLocalFilePath) {
      try {
        const p = origLocalFilePath.call(manager, id);
        if (typeof p === 'string' && p.length > 0) {
          const norm = p.replace(/\\/g, '/');
          // Preserve plugin subdirectories already rooted inside cleanDir (e.g. CoffinAndyLeyley/)
          if (norm.toLowerCase().startsWith(cleanDirPrefix)) {
            const sub = norm.slice(cleanDir.length + 1).split('/').filter((s) => s && s !== '.' && s !== '..');
            if (sub.length > 0) return filePath(sub.join('/'));
          }
          // Otherwise normalize basename so all writes stay safely inside cleanDir
          const base = norm.split('/').pop();
          if (base) return filePath(base);
        }
      } catch {
        /* fall through to fallback */
      }
    }
    return filePath(fallbackSlotFilename(id));
  };
  const isGlobalSavePath = (resolvedPath: string): boolean =>
    resolvedPath.toLowerCase().endsWith('/global.rpgsave');

  const readText = (path: string): string | null => {
    try {
      const buf = sw.readFileSync(path);
      return buf ? new TextDecoder().decode(buf) : null;
    } catch {
      return null;
    }
  };
  const existsFile = (path: string): boolean => {
    try { return sw.statSync(path) !== null; } catch { return false; }
  };
  const removeFile = (path: string): void => {
    try {
      if (sw.statSync(path) !== null) sw.removeSync(path);
    } catch { /* ignore */ }
  };

  // Recover any interrupted journal left by an unexpected power loss.
  try {
    const entries = sw.readDirSync(`${cleanDir}/`) ?? [];
    for (const entry of entries) {
      if (entry.endsWith('.journal')) {
        const origName = entry.slice(0, -'.journal'.length);
        const origPath = filePath(origName);
        const journalPath = filePath(entry);
        if (!existsFile(origPath)) {
          const data = readText(journalPath);
          if (data !== null) sw.writeFileSync(origPath, data);
        }
        removeFile(journalPath);
        log(`[saves] recovered journal for ${origName}`);
      }
    }
  } catch { /* ignore */ }

  const atomicWrite = (path: string, content: string): void => {
    const slash = path.lastIndexOf('/');
    if (slash > 0) ensureDir(sw, path.slice(0, slash));
    const journal = `${path}.journal`;
    const prev = readText(path);
    if (prev !== null) sw.writeFileSync(journal, prev);
    sw.writeFileSync(path, content);
    if (prev !== null) removeFile(journal);
  };

  let globalCache: string | null | undefined = undefined;
  const slotCache = new Map<string, string | null>();
  const setSlotCache = (path: string, val: string | null) => {
    if (slotCache.has(path)) slotCache.delete(path);
    else if (slotCache.size >= 64) {
      const oldest = slotCache.keys().next().value;
      if (oldest !== undefined) slotCache.delete(oldest);
    }
    slotCache.set(path, val);
  };

  // Wire native C++ LZString Base64 codec (`$.lzStringCompressBase64` / `$.lzStringDecompressBase64`)
  // when running on Switch 2 with stock RPG Maker MV LZString (~200x faster than jitless JS).
  const nativeInit = (globalThis as any).$;
  const nativeCompress = typeof nativeInit?.lzStringCompressBase64 === 'function'
    ? nativeInit.lzStringCompressBase64.bind(nativeInit)
    : null;
  const nativeDecompress = typeof nativeInit?.lzStringDecompressBase64 === 'function'
    ? nativeInit.lzStringDecompressBase64.bind(nativeInit)
    : null;
  if ((nativeCompress || nativeDecompress) && !codec.__drNativeLzWired) {
    const compSrc = String(codec.compressToBase64 || '');
    const decSrc = String(codec.decompressFromBase64 || '');
    const isStockMvLz = compSrc.includes('_keyStr') && decSrc.includes('_keyStr');
    if (isStockMvLz) {
      codec.__drNativeLzWired = true;
      if (nativeCompress) {
        const origComp = codec.compressToBase64.bind(codec);
        codec.compressToBase64 = (input: any) => {
          if (input == null) return '';
          try {
            return nativeCompress(String(input));
          } catch {
            return origComp(input);
          }
        };
      }
      if (nativeDecompress) {
        const origDec = codec.decompressFromBase64.bind(codec);
        codec.decompressFromBase64 = (input: any) => {
          if (input == null) return '';
          if (input === '') return null;
          try {
            return nativeDecompress(String(input));
          } catch {
            return origDec(input);
          }
        };
      }
      log('[saves] native C++ LZString Base64 codec enabled');
    }
  }

  // Keep plugin-chained localFilePath intact (SoundTest.rpgsave, achievements.rpgsave, etc.)
  manager.localFilePath = (id: any) => resolveSlotPath(id);

  manager.save = (id: any, json: string) => {
    const targetPath = resolveSlotPath(id);
    const compressed = codec.compressToBase64(json);
    atomicWrite(targetPath, compressed);
    if (isGlobalSavePath(targetPath)) globalCache = json;
    setSlotCache(targetPath, json);
  };
  manager.saveToLocalFile = manager.save;

  manager.load = (id: any) => {
    const targetPath = resolveSlotPath(id);
    const isGlobal = isGlobalSavePath(targetPath);
    if (isGlobal && globalCache !== undefined) return globalCache;
    if (slotCache.has(targetPath)) return slotCache.get(targetPath)!;
    const raw = readText(targetPath);
    const decoded = raw === null ? null : codec.decompressFromBase64(raw);
    if (isGlobal) globalCache = decoded;
    setSlotCache(targetPath, decoded);
    return decoded;
  };
  manager.loadFromLocalFile = manager.load;

  manager.exists = (id: any) => existsFile(resolveSlotPath(id));
  manager.localFileExists = manager.exists;

  manager.remove = (id: any) => {
    const targetPath = resolveSlotPath(id);
    removeFile(targetPath);
    if (isGlobalSavePath(targetPath)) globalCache = null;
    slotCache.delete(targetPath);
  };
  manager.removeLocalFile = manager.remove;

  manager.backup = (id: any) => {
    const p = resolveSlotPath(id);
    const raw = readText(p);
    if (raw !== null) {
      const slash = p.lastIndexOf('/');
      if (slash > 0) ensureDir(sw, p.slice(0, slash));
      sw.writeFileSync(`${p}.bak`, raw);
    }
  };
  manager.backupExists = (id: any) => existsFile(`${resolveSlotPath(id)}.bak`);
  manager.cleanBackup = (id: any) => removeFile(`${resolveSlotPath(id)}.bak`);
  manager.restoreBackup = (id: any) => {
    const p = resolveSlotPath(id);
    const bak = readText(`${p}.bak`);
    if (bak !== null) {
      atomicWrite(p, bak);
      removeFile(`${p}.bak`);
      slotCache.delete(p);
      if (isGlobalSavePath(p)) globalCache = undefined;
    }
  };

  // UTA_CommonSave.js shared unlocks / recollection mode (used by many Japanese MV games)
  const commonPath = filePath('common.rpgsave');
  manager.localFilePathCommonSave = () => commonPath;
  manager.saveCommonSave = (json: string) => {
    const compressed = codec.compressToBase64(json);
    atomicWrite(commonPath, compressed);
    setSlotCache(commonPath, json);
  };
  manager.loadCommonSave = () => {
    if (slotCache.has(commonPath)) return slotCache.get(commonPath)!;
    const raw = readText(commonPath);
    const decoded = raw === null ? null : codec.decompressFromBase64(raw);
    setSlotCache(commonPath, decoded);
    return decoded;
  };
  manager.existsCommonSave = () => existsFile(commonPath);
  manager.removeCommonSave = () => {
    removeFile(commonPath);
    slotCache.delete(commonPath);
  };

  log(`[saves] SD-card saves mounted at ${cleanDir}`);
}
