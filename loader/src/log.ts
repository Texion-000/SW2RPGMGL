/**
 * Lightweight Switch 2 SD-card & console logger with dynamic loader-root discovery.
 * Resolves the loader directory from `Switch.argv[0]` (falling back to
 * `sdmc:/switch/switch2-MV-loader`) and writes to `<loaderDir>/debug.log`.
 */

export interface SwitchApi {
  argv?: string[];
  entrypoint?: string;
  readFile(path: string): Promise<ArrayBuffer | null>;
  readFileSync(path: string): ArrayBuffer | null;
  writeFileSync(path: string, data: string | ArrayBuffer | Uint8Array): void;
  appendFileSync?(path: string, data: string | ArrayBuffer | Uint8Array): void;
  mkdirSync(path: string): void;
  removeSync(path: string): void;
  statSync(path: string): { mode: number; size?: number } | null;
  readDirSync(path: string): string[] | null;
  exit(): void;
  memoryUsage?(): { used?: number; total?: number };
  version?: Record<string, string>;
  Application?: {
    new (path: string): {
      launch(...args: string[]): never;
    };
    self?: {
      launch?(...args: string[]): never;
    };
  };
}

export const DEFAULT_LOADER_DIR = 'sdmc:/switch/SW2RPGMGL';

export interface LaunchArgs {
  loaderDir: string;
  directGameDir: string | null;
  returnNroPath: string | null;
}

function normalizeSdmcPath(raw?: string | null): string | null {
  const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  if (s.startsWith('/')) return `sdmc:${s}`;
  if (/^sdmc:\//i.test(s)) return s;
  return null;
}

let resolvedLoaderDir: string | null = null;
let logReady = false;
const memoryLog: string[] = [];
const MAX_MEM_LOG = 200;

export function getSwitch(): SwitchApi | null {
  return ((globalThis as any).Switch as SwitchApi | undefined) ?? null;
}

/**
 * Derive the loader's base directory from `Switch.argv[0]` (the path to this `.nro`).
 * Strips a trailing `/engines` folder when the MV engine lives inside `<launcher>/engines/`.
 */
export function resolveLoaderDirFromArgv(argv0?: string | null): string {
  const normalized = normalizeSdmcPath(argv0);
  if (!normalized) return DEFAULT_LOADER_DIR;

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 'sdmc:'.length) {
    return DEFAULT_LOADER_DIR;
  }
  let dir = normalized.slice(0, lastSlash);
  if (/\/engines$/i.test(dir)) {
    dir = dir.slice(0, -'/engines'.length);
  }
  return dir || DEFAULT_LOADER_DIR;
}

/**
 * Parse `Switch.argv` for direct-launch handoff from `SW2RPGMGL.nro`.
 * Supported calling conventions:
 *   1. `[mvEngineNro, mvEngineNro, gameDir, returnNro]` (nx.js `.nro` self-romfs bootstrap)
 *   2. `[mvEngineNro, gameDir, returnNro]` (if invoked without duplicate self-nro arg)
 *   3. `[standaloneNro]` (standalone mode -> shows built-in Game Select fallback)
 */
export function resolveLaunchArgs(argv?: string[] | null): LaunchArgs {
  const args = Array.isArray(argv) ? argv : [];
  let directGameDir: string | null = null;
  let returnNroPath: string | null = null;

  if (args.length >= 3 && /\.nro$/i.test(String(args[1] ?? '').trim())) {
    directGameDir = normalizeSdmcPath(args[2]);
    returnNroPath = normalizeSdmcPath(args[3]);
  } else if (args.length >= 2 && !/\.nro$/i.test(String(args[1] ?? '').trim())) {
    directGameDir = normalizeSdmcPath(args[1]);
    returnNroPath = normalizeSdmcPath(args[2]);
  }

  const loaderDir = returnNroPath
    ? resolveLoaderDirFromArgv(returnNroPath)
    : resolveLoaderDirFromArgv(args[0]);

  return { loaderDir, directGameDir, returnNroPath };
}

export function getLoaderDir(sw?: Pick<SwitchApi, 'argv'> | null): string {
  if (sw && Array.isArray(sw.argv) && sw.argv.length > 0) {
    return resolveLaunchArgs(sw.argv).loaderDir;
  }
  if (resolvedLoaderDir) return resolvedLoaderDir;
  const activeSw = getSwitch();
  resolvedLoaderDir = resolveLaunchArgs(activeSw?.argv).loaderDir;
  return resolvedLoaderDir;
}

export function getLogPath(sw?: Pick<SwitchApi, 'argv'> | null): string {
  return `${getLoaderDir(sw)}/log/debug.log`;
}

export function ensureDir(fs: Pick<SwitchApi, 'statSync' | 'mkdirSync'>, dir: string): void {
  const clean = dir.replace(/\/+$/, '');
  const parts = clean.split('/');
  let acc = parts[0]; // e.g. 'sdmc:'
  for (let i = 1; i < parts.length; i++) {
    acc += '/' + parts[i];
    try {
      if (!fs.statSync(acc)) fs.mkdirSync(acc);
    } catch {
      try { fs.mkdirSync(acc); } catch { /* ignore */ }
    }
  }
}

export function initLog(): void {
  const sw = getSwitch();
  if (!sw) return;
  resolvedLoaderDir = resolveLaunchArgs(sw.argv).loaderDir;
  const logDir = `${resolvedLoaderDir}/log`;
  const logPath = `${logDir}/debug.log`;
  try {
    ensureDir(sw, logDir);
    sw.writeFileSync(
      logPath,
      `=== SW2RPGMGL — MV/MZ Engine (kaiHEN) Boot Log ===\nLoader Dir: ${resolvedLoaderDir}\nargv: ${JSON.stringify(sw.argv ?? [])}\n`,
    );
    logReady = true;
  } catch {
    logReady = false;
  }
}

export function log(msg: string): void {
  const line = `[${Math.round(performance.now())}ms] ${msg}`;
  memoryLog.push(line);
  if (memoryLog.length > MAX_MEM_LOG) memoryLog.shift();
  try { console.log(line); } catch { /* ignore */ }
  if (!logReady) return;
  const sw = getSwitch();
  if (!sw) return;
  const logPath = getLogPath(sw);
  try {
    if (typeof sw.appendFileSync === 'function') {
      sw.appendFileSync(logPath, line + '\n');
    } else {
      const prev = sw.readFileSync(logPath);
      const prevText = prev ? new TextDecoder().decode(prev) : '';
      sw.writeFileSync(logPath, prevText + line + '\n');
    }
  } catch {
    /* ignore SD write glitches during logging */
  }
}

export function recentLogs(): string[] {
  return memoryLog.slice();
}
