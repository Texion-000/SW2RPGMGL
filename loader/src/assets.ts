/**
 * Safe SD-card asset resolver for any RPG Maker MV `www/` folder.
 * Handles URI-encoded Japanese/Unicode paths and case-insensitive directory fallbacks.
 */
import type { SwitchApi } from './log';

export interface AssetReader {
  readonly wwwRoot: string;
  readonly jpMapCount: number;
  resolvePath(relPath: string): string | null;
  read(relPath: string): Promise<ArrayBuffer | null>;
  readSync(relPath: string): ArrayBuffer | null;
  exists(relPath: string): boolean;
  readDirSync(relDir: string): string[];
}

export function normalizeAssetRelPath(raw: string): string | null {
  let p = String(raw ?? '').trim();
  if (!p) return null;
  p = p.split('?')[0].split('#')[0];
  p = p.replace(/^romfs:\/+/i, '').replace(/^game:\/+/i, '').replace(/^\.\//, '');
  p = p.replace(/\\/g, '/').replace(/^\/+/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw if malformed percent encoding */
  }
  const segs = p.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segs.length === 0) return null;
  if (segs.some((s) => s === '..' || s.includes(':'))) return null;
  return segs.join('/');
}

export function createAssetReader(
  wwwRoot: string,
  fs: Pick<SwitchApi, 'readFile' | 'readFileSync' | 'statSync' | 'readDirSync'>,
): AssetReader {
  const cleanRoot = wwwRoot.replace(/\/+$/, '');
  const dirCache = new Map<string, Map<string, string>>();
  // Optional _jp_map.txt (FTP-safe ASCII filename mapping: <original UTF-8 relPath>\t<ascii relPath>)
  const jpFileMap = new Map<string, string>();
  const jpDirEntries = new Map<string, Set<string>>();

  function registerJpMapping(origRaw: string, asciiRaw: string) {
    const orig = normalizeAssetRelPath(origRaw);
    const ascii = normalizeAssetRelPath(asciiRaw);
    if (!orig || !ascii) return;
    jpFileMap.set(orig.toLowerCase(), ascii);
    const slash = orig.lastIndexOf('/');
    const dirKey = slash >= 0 ? orig.slice(0, slash).toLowerCase() : '';
    const fileName = slash >= 0 ? orig.slice(slash + 1) : orig;
    let set = jpDirEntries.get(dirKey);
    if (!set) {
      set = new Set<string>();
      jpDirEntries.set(dirKey, set);
    }
    set.add(fileName);
  }

  function loadJpMapFile(mapPath: string, stripWwwPrefix: boolean) {
    try {
      if (fs.statSync(mapPath) === null) return;
      const buf = fs.readFileSync(mapPath);
      if (!buf) return;
      const text = new TextDecoder().decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const tab = line.indexOf('\t');
        if (tab <= 0) continue;
        let orig = line.slice(0, tab).trim().replace(/\\/g, '/');
        let ascii = line.slice(tab + 1).trim().replace(/\\/g, '/');
        if (stripWwwPrefix) {
          orig = orig.replace(/^www\/+/i, '');
          ascii = ascii.replace(/^www\/+/i, '');
        }
        registerJpMapping(orig, ascii);
      }
    } catch {
      /* ignore if absent */
    }
  }

  loadJpMapFile(`${cleanRoot}/_jp_map.txt`, true);
  if (/\/www$/i.test(cleanRoot)) {
    const parentDir = cleanRoot.replace(/\/www$/i, '');
    loadJpMapFile(`${parentDir}/_jp_map.txt`, true);
  }

  function resolveCaseInsensitive(rel: string): string | null {
    const segs = rel.split('/');
    let current = cleanRoot;
    for (const seg of segs) {
      const exact = `${current}/${seg}`;
      try {
        if (fs.statSync(exact) !== null) {
          current = exact;
          continue;
        }
      } catch {
        /* try dir scan */
      }
      let entries = dirCache.get(current);
      if (!entries) {
        entries = new Map<string, string>();
        try {
          const list = fs.readDirSync(`${current}/`);
          if (list) {
            for (const name of list) entries.set(name.toLowerCase(), name);
          }
        } catch {
          /* unreadable dir */
        }
        dirCache.set(current, entries);
      }
      const matched = entries.get(seg.toLowerCase());
      if (!matched) return null;
      current = `${current}/${matched}`;
    }
    return current;
  }

  function resolvePath(relPath: string): string | null {
    const rel = normalizeAssetRelPath(relPath);
    if (!rel) return null;
    const mappedAscii = jpFileMap.get(rel.toLowerCase());
    if (mappedAscii) {
      const mappedFull = `${cleanRoot}/${mappedAscii}`;
      try {
        if (fs.statSync(mappedFull) !== null) return mappedFull;
      } catch {
        /* fall through */
      }
    }
    const direct = `${cleanRoot}/${rel}`;
    try {
      if (fs.statSync(direct) !== null) return direct;
    } catch {
      /* fall through */
    }
    return resolveCaseInsensitive(rel);
  }

  function readDirSync(relDir: string): string[] {
    const rel = normalizeAssetRelPath(relDir);
    const dirKey = (rel ?? '').toLowerCase();
    const dirPath = rel ? resolvePath(rel) : cleanRoot;
    const result: string[] = [];
    if (dirPath) {
      try {
        const list = fs.readDirSync(`${dirPath.replace(/\/+$/, '')}/`);
        if (list) result.push(...list);
      } catch {
        /* ignore */
      }
    }
    const extra = jpDirEntries.get(dirKey);
    if (extra) {
      const seen = new Set(result.map((s) => s.toLowerCase()));
      for (const name of extra) {
        if (!seen.has(name.toLowerCase())) {
          result.push(name);
          seen.add(name.toLowerCase());
        }
      }
    }
    return result;
  }

  return {
    wwwRoot: cleanRoot,
    get jpMapCount() {
      return jpFileMap.size;
    },
    resolvePath,
    readDirSync,
    async read(relPath: string): Promise<ArrayBuffer | null> {
      const rel = normalizeAssetRelPath(relPath);
      if (!rel) return null;
      const mappedAscii = jpFileMap.get(rel.toLowerCase());
      if (mappedAscii) {
        try {
          const bytes = await fs.readFile(`${cleanRoot}/${mappedAscii}`);
          if (bytes !== null) return bytes;
        } catch {
          /* fallback */
        }
      }
      const direct = `${cleanRoot}/${rel}`;
      try {
        const bytes = await fs.readFile(direct);
        if (bytes !== null) return bytes;
      } catch {
        /* fallback */
      }
      const resolved = resolveCaseInsensitive(rel);
      if (!resolved || resolved === direct) return null;
      try {
        return await fs.readFile(resolved);
      } catch {
        return null;
      }
    },
    readSync(relPath: string): ArrayBuffer | null {
      const resolved = resolvePath(relPath);
      if (!resolved) return null;
      try {
        return fs.readFileSync(resolved);
      } catch {
        return null;
      }
    },
    exists(relPath: string): boolean {
      return resolvePath(relPath) !== null;
    },
  };
}
