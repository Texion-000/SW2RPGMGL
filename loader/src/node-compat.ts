/**
 * Minimal, safe Node.js / NW.js compatibility shim for RPG Maker MV plugins:
 *   - path, fs, nw.gui, child_process, process, Buffer
 *   - Confines all plugin file writes safely inside the active game's directory & save folder.
 */
import { ensureDir, type SwitchApi } from './log';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeBase64(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = chars.indexOf(clean[i]);
    const b = chars.indexOf(clean[i + 1] ?? '=');
    const c = chars.indexOf(clean[i + 2] ?? '=');
    const d = chars.indexOf(clean[i + 3] ?? '=');
    out.push((a << 2) | (b >> 4));
    if (c >= 0 && clean[i + 2] !== '=') out.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0 && clean[i + 3] !== '=') out.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(out);
}

function encodeBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const c = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >= 0 ? b >> 4 : 0)];
    out += b < 0 ? '=' : chars[((b & 15) << 2) | (c >= 0 ? c >> 6 : 0)];
    out += c < 0 ? '=' : chars[c & 63];
  }
  return out;
}

export class MiniBuffer extends Uint8Array {
  constructor(arg: any, encoding?: string) {
    if (typeof arg === 'string') {
      const enc = (encoding || 'utf8').toLowerCase();
      super(enc === 'base64' ? decodeBase64(arg) : encodeUtf8(arg));
    } else if (typeof arg === 'number') {
      super(Math.max(0, arg | 0));
    } else if (arg instanceof ArrayBuffer || ArrayBuffer.isView(arg)) {
      const u = arg instanceof ArrayBuffer
        ? new Uint8Array(arg)
        : new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength);
      super(u);
    } else if (Array.isArray(arg)) {
      super(arg);
    } else {
      super(0);
    }
  }
  static override from(val: any, encOrMap?: any, _thisArg?: any): MiniBuffer {
    return new MiniBuffer(val, typeof encOrMap === 'string' ? encOrMap : undefined);
  }
  static alloc(size: number, fill = 0): MiniBuffer {
    const b = new MiniBuffer(size);
    if (fill) b.fill(fill & 0xff);
    return b;
  }
  static isBuffer(x: unknown): x is MiniBuffer {
    return x instanceof MiniBuffer || x instanceof Uint8Array;
  }
  override toString(encoding = 'utf8'): string {
    const enc = encoding.toLowerCase();
    if (enc === 'base64') return encodeBase64(this);
    return decodeUtf8(this);
  }
}

export function resolveSafeSdPath(wwwRoot: string, raw: string): string | null {
  let p = String(raw ?? '').trim();
  if (!p) return null;
  p = p.replace(/\\/g, '/');
  if (p.startsWith('sdmc:/')) {
    const segs = p.slice(6).split('/').filter((s) => s && s !== '.');
    const resolved: string[] = [];
    for (const s of segs) {
      if (s === '..') {
        if (resolved.length === 0) return null;
        resolved.pop();
      } else {
        resolved.push(s);
      }
    }
    return `sdmc:/${resolved.join('/')}`;
  }
  const appRoot = wwwRoot.replace(/\/+$/, '').replace(/\/www$/i, '');
  const baseSegs = appRoot.replace(/^sdmc:\/+/i, '').split('/').filter(Boolean);
  const relSegs = p.replace(/^\/+/, '').split('/').filter((s) => s && s !== '.');
  const resolved = [...baseSegs];
  for (const s of relSegs) {
    if (s === '..') {
      if (resolved.length <= 1) return null;
      resolved.pop();
    } else {
      resolved.push(s);
    }
  }
  return `sdmc:/${resolved.join('/')}`;
}

export function installNodeCompat(
  target: Record<string, any>,
  sw: SwitchApi | null,
  wwwRoot: string,
  saveDir: string,
  logFn?: (s: string) => void,
  gameDir?: string,
  gameTitle = 'RPG Maker MV',
): void {
  const cleanWww = wwwRoot.replace(/\/+$/, '');
  const appRoot = (gameDir || cleanWww.replace(/\/www$/i, '')).replace(/\/+$/, '');
  const cleanSaveDir = saveDir.replace(/\/+$/, '');

  // Redirect writes targeting `save/` or screenshots safely into the active game's folder.
  function mapWritePath(raw: string): string | null {
    const resolved = resolveSafeSdPath(cleanWww, raw);
    if (!resolved) return null;
    if (/\/save(\/|$)/i.test(resolved)) {
      const idx = resolved.toLowerCase().lastIndexOf('/save');
      const tail = resolved.slice(idx + 5);
      return `${cleanSaveDir}${tail}`;
    }
    if (resolved.toLowerCase().includes('game clear') || resolved.toLowerCase().includes('screenshot')) {
      const base = resolved.split('/').pop() || 'capture.png';
      return `${appRoot}/screenshots/${base}`;
    }
    // Never allow arbitrary writes outside appRoot or cleanSaveDir
    const low = resolved.toLowerCase();
    if (!low.startsWith(appRoot.toLowerCase()) && !low.startsWith(cleanSaveDir.toLowerCase())) {
      return `${appRoot}/userdata/${resolved.split('/').pop() || 'file.dat'}`;
    }
    return resolved;
  }

  const pathMod: Record<string, any> = {
    sep: '/',
    dirname(p: string): string {
      const n = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
      const i = n.lastIndexOf('/');
      return i <= 0 ? (n.startsWith('sdmc:') ? 'sdmc:/' : n.startsWith('/') ? '/' : '.') : n.slice(0, i);
    },
    basename(p: string, ext?: string): string {
      const n = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
      const i = n.lastIndexOf('/');
      let base = i >= 0 ? n.slice(i + 1) : n;
      if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
      return base;
    },
    join(...parts: string[]): string {
      const raw = parts.filter(Boolean).join('/').replace(/\\/g, '/');
      const prefix = raw.startsWith('sdmc:/') ? 'sdmc:/' : raw.startsWith('/') ? '/' : '';
      const rest = prefix ? raw.slice(prefix.length) : raw;
      const out: string[] = [];
      for (const seg of rest.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else out.push(seg);
      }
      return prefix + out.join('/');
    },
    resolve(...parts: string[]): string {
      return pathMod.join(...parts);
    },
    extname(p: string): string {
      const b = pathMod.basename(p);
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    },
    isAbsolute(p: string): boolean {
      const n = String(p ?? '').replace(/\\/g, '/');
      return n.startsWith('/') || n.startsWith('sdmc:/') || /^[a-zA-Z]:\//.test(n);
    },
  };
  pathMod.posix = pathMod;
  pathMod.win32 = pathMod;

  const fsMod = {
    existsSync(raw: string): boolean {
      if (!sw) return false;
      const p = mapWritePath(raw) ?? resolveSafeSdPath(cleanWww, raw);
      if (!p) return false;
      try { return sw.statSync(p) !== null; } catch { return false; }
    },
    statSync(raw: string) {
      if (!sw) throw new Error(`ENOENT: ${raw}`);
      const p = mapWritePath(raw) ?? resolveSafeSdPath(cleanWww, raw);
      const st = p ? sw.statSync(p) : null;
      if (!st) throw new Error(`ENOENT: ${raw}`);
      const mode = st.mode ?? S_IFREG;
      return {
        mode,
        size: st.size ?? 0,
        isDirectory: () => (mode & 0o170000) === S_IFDIR,
        isFile: () => (mode & 0o170000) === S_IFREG,
      };
    },
    readFileSync(raw: string, options?: string | { encoding?: string }): string | MiniBuffer {
      if (!sw) throw new Error(`ENOENT: ${raw}`);
      const p = mapWritePath(raw) ?? resolveSafeSdPath(cleanWww, raw);
      const bytes = p ? sw.readFileSync(p) : null;
      if (bytes === null) throw new Error(`ENOENT: ${raw}`);
      const enc = typeof options === 'string' ? options : options?.encoding;
      if (enc) return new TextDecoder().decode(bytes);
      return new MiniBuffer(bytes);
    },
    writeFileSync(raw: string, data: string | Uint8Array | ArrayBuffer): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (!p) return;
      ensureDir(sw, pathMod.dirname(p));
      if (typeof data === 'string') {
        sw.writeFileSync(p, data);
      } else if (data instanceof ArrayBuffer) {
        sw.writeFileSync(p, data);
      } else {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        sw.writeFileSync(p, copy.buffer);
      }
    },
    mkdirSync(raw: string): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (p) ensureDir(sw, p);
    },
    unlinkSync(raw: string): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (!p) return;
      try {
        if (sw.statSync(p)) sw.removeSync(p);
      } catch { /* ignore */ }
    },
    renameSync(oldRaw: string, newRaw: string): void {
      if (!sw) return;
      const src = mapWritePath(oldRaw);
      const dst = mapWritePath(newRaw);
      if (!src || !dst || src === dst) return;
      const bytes = sw.readFileSync(src);
      if (!bytes) return;
      ensureDir(sw, pathMod.dirname(dst));
      sw.writeFileSync(dst, bytes);
      try { sw.removeSync(src); } catch { /* ignore */ }
    },
    readdirSync(raw: string): string[] {
      if (!sw) return [];
      const p = resolveSafeSdPath(cleanWww, raw);
      if (!p) return [];
      try { return sw.readDirSync(`${p.replace(/\/+$/, '')}/`) ?? []; } catch { return []; }
    },
    readdir(raw: string, cb: (err: Error | null, files: string[]) => void): void {
      try {
        const files = fsMod.readdirSync(raw);
        setTimeout(() => cb(null, files), 0);
      } catch (e) {
        setTimeout(() => cb(e as Error, []), 0);
      }
    },
  };

  const fakeWindow = {
    get width(): number { return (target.Graphics?.width as number) || 816; },
    set width(_v: number) {},
    get height(): number { return (target.Graphics?.height as number) || 624; },
    set height(_v: number) {},
    x: 0,
    y: 0,
    title: gameTitle,
    menu: null,
    isFullscreen: true,
    on() {},
    once() {},
    removeListener() {},
    show() {},
    hide() {},
    focus() {},
    blur() {},
    close() { if (typeof target.close === 'function') target.close(); else sw?.exit(); },
    reload() {},
    reloadIgnoringCache() {},
    showDevTools() {},
    closeDevTools() {},
    isDevToolsOpen() { return false; },
    enterFullscreen() {},
    leaveFullscreen() {},
    toggleFullscreen() {},
    setAlwaysOnTop() {},
    resizeTo() {},
    moveTo() {},
    moveBy() {},
  };

  const nwGuiMod = {
    Window: { get: () => fakeWindow },
    App: { argv: [], fullArgv: [], dataPath: appRoot, quit: () => { if (typeof target.close === 'function') target.close(); else sw?.exit(); } },
    Menu: class { items: any[] = []; append(x: any) { this.items.push(x); } },
    MenuItem: class { constructor(public opts: any) {} },
    Clipboard: { get: () => ({ get: () => '', set() {} }) },
    Shell: { openExternal() {} },
  };

  const childProcessMod = {
    exec(_cmd: string, cb?: (err: Error | null) => void) {
      logFn?.(`[node-compat] ignored child_process.exec`);
      if (cb) setTimeout(() => cb(null), 0);
    },
    execSync() {
      logFn?.(`[node-compat] ignored child_process.execSync`);
      return new MiniBuffer(0);
    },
    spawn() {
      logFn?.(`[node-compat] ignored child_process.spawn`);
      return { on() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {} };
    },
  };

  // Complete safe Steamworks / Greenworks shim (used by Fear & Hunger, OrangeGreenworks, etc.)
  // Reports initAPI()=true so DRM/init checks pass while keeping Steam Cloud & Overlay disabled
  // so saves stay on SD card. Wrapped in a Proxy so any extra Steam method never throws TypeError.
  const greenworksBase: Record<string, any> = {
    init: () => true,
    initAPI: () => true,
    isSteamRunning: () => true,
    isGameOverlayEnabled: () => false,
    isCloudEnabled: () => false,
    isCloudEnabledForUser: () => false,
    enableCloud: () => {},
    getSteamId: () => ({
      screenName: 'Switch2',
      steamId: '0',
      accountId: 0,
      staticAccountId: '0',
      level: 1,
      isValid: () => false,
    }),
    getCurrentGameLanguage: () => 'english',
    getCurrentUILanguage: () => 'english',
    getNumberOfPlayers: (cb?: (n: number) => void) => { cb?.(1); },
    getAchievementNames: () => [],
    getAchievement: (_name: string, cb?: (achieved: boolean) => void) => { cb?.(false); },
    activateAchievement: (name: string, cb?: () => void) => {
      logFn?.(`[steam] achievement unlocked (offline): ${String(name)}`);
      cb?.();
    },
    clearAchievement: (_name: string, cb?: () => void) => { cb?.(); },
    saveTextToFile: (_name: string, _content: string, cb?: () => void) => { cb?.(); },
    readTextFromFile: (_name: string, _cb?: any, errCb?: (e: Error) => void) => {
      errCb?.(new Error('Steam Cloud disabled on Switch 2'));
    },
    deleteFile: (_name: string, cb?: () => void) => { cb?.(); },
    saveFilesToCloud: (_files: string[], cb?: () => void) => { cb?.(); },
    getCloudQuota: (cb?: (total: number, avail: number) => void) => { cb?.(0, 0); },
    isSubscribedApp: () => true,
    isDLCInstalled: () => false,
    getDLCCount: () => 0,
    setRichPresence: () => true,
    clearRichPresence: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };
  const greenworksMod = new Proxy(greenworksBase, {
    get(obj, prop) {
      if (prop in obj) return obj[prop as string];
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
      return (...args: any[]) => {
        const last = args[args.length - 1];
        if (typeof last === 'function') {
          try { last(); } catch { /* ignore */ }
        }
        return false;
      };
    },
  });

  // Safe Discord RPC stub
  const discordRpcMod = {
    register() {},
    Client: class {
      on() { return this; }
      once() { return this; }
      login() { return Promise.resolve(this); }
      setActivity() { return Promise.resolve(); }
      clearActivity() { return Promise.resolve(); }
      destroy() { return Promise.resolve(); }
    },
  };

  // Minimal Node `os` shim
  const osMod = {
    EOL: '\n',
    platform: () => 'linux',
    arch: () => 'arm64',
    type: () => 'Switch2',
    release: () => '1.0.0',
    hostname: () => 'switch2',
    homedir: () => appRoot,
    tmpdir: () => `${appRoot}/tmp`,
    userInfo: () => ({ username: 'Switch2', uid: 1000, gid: 1000, shell: null, homedir: appRoot }),
    cpus: () => [{}, {}, {}, {}],
    totalmem: () => 4 * 1024 * 1024 * 1024,
    freemem: () => 2 * 1024 * 1024 * 1024,
  };

  // Minimal Node `events` EventEmitter shim
  class MiniEventEmitter {
    private _listeners = new Map<string, Array<(...a: any[]) => void>>();
    on(ev: string, fn: (...a: any[]) => void) {
      const list = this._listeners.get(ev) ?? [];
      list.push(fn);
      this._listeners.set(ev, list);
      return this;
    }
    addListener(ev: string, fn: (...a: any[]) => void) { return this.on(ev, fn); }
    once(ev: string, fn: (...a: any[]) => void) {
      const wrap = (...a: any[]) => { this.off(ev, wrap); fn(...a); };
      return this.on(ev, wrap);
    }
    off(ev: string, fn: (...a: any[]) => void) {
      const list = this._listeners.get(ev);
      if (list) this._listeners.set(ev, list.filter((f) => f !== fn));
      return this;
    }
    removeListener(ev: string, fn: (...a: any[]) => void) { return this.off(ev, fn); }
    removeAllListeners(ev?: string) {
      if (ev) this._listeners.delete(ev);
      else this._listeners.clear();
      return this;
    }
    emit(ev: string, ...args: any[]) {
      const list = this._listeners.get(ev);
      if (!list || list.length === 0) return false;
      for (const fn of list.slice()) fn(...args);
      return true;
    }
  }
  const eventsMod = Object.assign(MiniEventEmitter, { EventEmitter: MiniEventEmitter });

  // Minimal Node `url` & `util` shims
  const urlMod = {
    parse(str: string) {
      try {
        const u = new URL(str, 'file:///');
        return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash };
      } catch {
        return { href: str, protocol: '', host: '', hostname: '', pathname: str, search: '', hash: '' };
      }
    },
    format(obj: any) { return typeof obj === 'string' ? obj : String(obj?.href || obj?.pathname || ''); },
    resolve(from: string, to: string) { return pathMod.join(pathMod.dirname(from), to); },
  };
  const utilMod = {
    format(...args: any[]) { return args.map(String).join(' '); },
    inspect(v: any) { try { return JSON.stringify(v); } catch { return String(v); } },
    inherits(ctor: any, superCtor: any) {
      if (ctor && superCtor) {
        ctor.super_ = superCtor;
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      }
    },
  };
  const cryptoMod = {
    randomBytes(size: number) {
      const b = MiniBuffer.alloc(size);
      for (let i = 0; i < size; i++) b[i] = (Math.random() * 256) | 0;
      return b;
    },
  };

  const proc = {
    platform: 'switch2',
    arch: 'arm64',
    env: {},
    argv: [sw?.argv?.[0] || 'switch2-MV-loader.nro'],
    cwd: () => appRoot,
    mainModule: { filename: `${cleanWww}/index.html` },
    versions: { node: '18.0.0', nw: '0.29.4' },
    nextTick: (fn: (...a: any[]) => void, ...args: any[]) => Promise.resolve().then(() => fn(...args)),
  };

  (nwGuiMod as any).process = proc;
  target.process = proc;
  target.Buffer = MiniBuffer;
  target.nw = nwGuiMod;
  target.require = (id: string) => {
    const cleanId = String(id ?? '').trim();
    const low = cleanId.toLowerCase();
    switch (low) {
      case 'fs': return fsMod;
      case 'path': return pathMod;
      case 'nw.gui': return nwGuiMod;
      case 'child_process': return childProcessMod;
      case 'os': return osMod;
      case 'events': return eventsMod;
      case 'url': return urlMod;
      case 'util': return utilMod;
      case 'crypto': return cryptoMod;
    }
    if (low.includes('greenworks') || low.includes('steamworks')) {
      logFn?.(`[node-compat] shimmed Steamworks/Greenworks module: require('${cleanId}')`);
      return greenworksMod;
    }
    if (low.includes('discord')) {
      logFn?.(`[node-compat] shimmed Discord module: require('${cleanId}')`);
      return discordRpcMod;
    }
    logFn?.(`[node-compat] unsupported require('${cleanId}')`);
    return {};
  };
}
