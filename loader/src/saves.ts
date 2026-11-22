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
  const resolveSlotPath = (id: any): string => {
    if (origLocalFilePath) {
      try {
        const p = origLocalFilePath.call(manager, id);
        if (typeof p === 'string' && p.length > 0) {
          // Normalize so all writes stay safely inside cleanDir
          const base = p.replace(/\\/g, '/').split('/').pop();
          if (base) return filePath(base);
        }
      } catch {
        /* fall through to fallback */
      }
    }
    return filePath(fallbackSlotFilename(id));
  };

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
    const journal = `${path}.journal`;
    const prev = readText(path);
    if (prev !== null) sw.writeFileSync(journal, prev);
    sw.writeFileSync(path, content);
    if (prev !== null) removeFile(journal);
  };

  let globalCache: string | null | undefined = undefined;

  // Keep plugin-chained localFilePath intact (SoundTest.rpgsave, achievements.rpgsave, etc.)
  manager.localFilePath = (id: any) => resolveSlotPath(id);

  manager.save = (id: any, json: string) => {
    const compressed = codec.compressToBase64(json);
    atomicWrite(resolveSlotPath(id), compressed);
    if (id === 0) globalCache = json;
  };
  manager.saveToLocalFile = manager.save;

  manager.load = (id: any) => {
    if (id === 0 && globalCache !== undefined) return globalCache;
    const raw = readText(resolveSlotPath(id));
    const decoded = raw === null ? null : codec.decompressFromBase64(raw);
    if (id === 0) globalCache = decoded;
    return decoded;
  };
  manager.loadFromLocalFile = manager.load;

  manager.exists = (id: any) => existsFile(resolveSlotPath(id));
  manager.localFileExists = manager.exists;

  manager.remove = (id: any) => {
    removeFile(resolveSlotPath(id));
    if (id === 0) globalCache = null;
  };
  manager.removeLocalFile = manager.remove;

  manager.backup = (id: any) => {
    const p = resolveSlotPath(id);
    const raw = readText(p);
    if (raw !== null) sw.writeFileSync(`${p}.bak`, raw);
  };
  manager.backupExists = (id: any) => existsFile(`${resolveSlotPath(id)}.bak`);
  manager.cleanBackup = (id: any) => removeFile(`${resolveSlotPath(id)}.bak`);
  manager.restoreBackup = (id: any) => {
    const p = resolveSlotPath(id);
    const bak = readText(`${p}.bak`);
    if (bak !== null) {
      atomicWrite(p, bak);
      removeFile(`${p}.bak`);
    }
  };

  // UTA_CommonSave.js shared unlocks / recollection mode (used by many Japanese MV games)
  const commonPath = filePath('common.rpgsave');
  manager.localFilePathCommonSave = () => commonPath;
  manager.saveCommonSave = (json: string) => {
    const compressed = codec.compressToBase64(json);
    atomicWrite(commonPath, compressed);
  };
  manager.loadCommonSave = () => {
    const raw = readText(commonPath);
    return raw === null ? null : codec.decompressFromBase64(raw);
  };
  manager.existsCommonSave = () => existsFile(commonPath);
  manager.removeCommonSave = () => removeFile(commonPath);

  log(`[saves] SD-card saves mounted at ${cleanDir}`);
}
