/**
 * SW2RPGMGL — Native Switch 2 WOLF RPG Editor Engine (wolf-engine-switch2.nro)
 *
 * Runs BrowserWoditor (woditor.wasm ahead-of-time compiled to ARM64 C via wasm2c)
 * natively on Nintendo Switch 2 (kaiHEN / libounce + OunceVK GLES3 + OpenAL Soft),
 * mounting .wolf archives directly in memory via WolfVfs (zero SD extraction),
 * with custom font registration, Switch 2 Software Keyboard, gamepad/touch, and Quick Menu.
 */
#include <switch.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>

#ifndef AL_LIBTYPE_STATIC
#define AL_LIBTYPE_STATIC
#endif

// LANG exposed to BrowserWoditor (Emscripten derives it from navigator.language in a browser)
#ifndef WOLF_ENV_LANG
#define WOLF_ENV_LANG "ja_JP.UTF-8"
#endif
#include <AL/al.h>
#include <AL/alc.h>

#include <ft2build.h>
#include FT_FREETYPE_H

#include "woditor_wasm.h"
#include "wolf_archive.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <csetjmp>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <fcntl.h>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_map>
#include <vector>

struct w2c_env { int dummy; };
struct w2c_wasi__snapshot__preview1 { int dummy; };

#ifndef SW2RPGMGL_VERSION
#define SW2RPGMGL_VERSION "0.3.2"
#endif

namespace {

constexpr int SCREEN_W = 1280;
constexpr int SCREEN_H = 720;

enum JumpKind : int {
  JMP_NONE = 0,
  JMP_CXA = 1,
  JMP_LONGJMP = 2,
  JMP_MAIN_LOOP_UNWIND = 3,
  JMP_EXIT = 4,
};

FILE* g_logFile = nullptr;
uint64_t g_bootTicks = 0;

std::string g_selfNro;
std::string g_launcherDir;
std::string g_gameDir;
std::string g_returnNro;
std::string g_projectId = "wolfgame";
std::string g_windowTitle = "WOLF RPG Editor";

wolf::WolfVfs g_vfs;

w2c_woditor g_inst {};
w2c_env g_env {};
w2c_wasi__snapshot__preview1 g_wasi {};
bool g_wasmReady = false;

u32 g_mainLoopFn = 0;
bool g_mainLoopPaused = false;
bool g_shouldExit = false;
bool g_returnToLauncher = false;

constexpr int MAX_JMP_DEPTH = 128;
jmp_buf g_jmpStack[MAX_JMP_DEPTH];
int g_jmpDepth = 0;
jmp_buf g_topJmp;
bool g_hasTopJmp = false;

u32 g_excLast = 0;
std::vector<u32> g_excCaught;
u32 g_uncaughtExcCount = 0;

double nowMs() {
  uint64_t dt = armGetSystemTick() - g_bootTicks;
  return static_cast<double>(armTicksToNs(dt)) / 1e6;
}

void logMsg(const char* fmt, ...) {
  if (!g_logFile) return;
  fprintf(g_logFile, "[%7.1fms] ", nowMs());
  va_list ap;
  va_start(ap, fmt);
  vfprintf(g_logFile, fmt, ap);
  va_end(ap);
  fputc('\n', g_logFile);
  fflush(g_logFile);
}

[[noreturn]] void unwindOrJump(JumpKind kind) {
  if (kind == JMP_MAIN_LOOP_UNWIND || kind == JMP_EXIT) {
    g_jmpDepth = 0;
    if (g_hasTopJmp) longjmp(g_topJmp, kind);
    std::abort();
  }
  if (g_jmpDepth > 0) {
    longjmp(g_jmpStack[--g_jmpDepth], kind);
  }
  if (g_hasTopJmp) {
    longjmp(g_topJmp, kind);
  }
  std::abort();
}

// ============================================================================
// Wasm Linear Memory Helpers
// ============================================================================
inline uint8_t* wasmMem() { return g_inst.w2c_memory.data; }
inline uint8_t* wasmPtr(u32 off) { return g_inst.w2c_memory.data + off; }

std::string wasmCStr(u32 ptr) {
  if (!ptr || !g_inst.w2c_memory.data || ptr >= g_inst.w2c_memory.size) return {};
  const char* s = reinterpret_cast<const char*>(g_inst.w2c_memory.data + ptr);
  size_t maxLen = static_cast<size_t>(g_inst.w2c_memory.size - ptr);
  return std::string(s, strnlen(s, maxLen));
}

u32 writeWasmCStr(const std::string& s, u32 ptr, u32 maxBytes) {
  if (!ptr || maxBytes == 0 || ptr + maxBytes > g_inst.w2c_memory.size) return 0;
  size_t copyLen = std::min<size_t>(s.size(), maxBytes - 1);
  if (copyLen > 0) memcpy(wasmPtr(ptr), s.data(), copyLen);
  wasmMem()[ptr + copyLen] = 0;
  return static_cast<u32>(copyLen);
}

inline void writeWasmU16(u32 ptr, uint16_t v) { memcpy(wasmPtr(ptr), &v, 2); }
inline void writeWasmU32(u32 ptr, uint32_t v) { memcpy(wasmPtr(ptr), &v, 4); }
inline void writeWasmI32(u32 ptr, int32_t v) { memcpy(wasmPtr(ptr), &v, 4); }
inline void writeWasmU64(u32 ptr, uint64_t v) { memcpy(wasmPtr(ptr), &v, 8); }
inline void writeWasmI64(u32 ptr, int64_t v) { memcpy(wasmPtr(ptr), &v, 8); }
inline void writeWasmF64(u32 ptr, double v) { memcpy(wasmPtr(ptr), &v, 8); }
inline uint32_t readWasmU32(u32 ptr) { uint32_t v; memcpy(&v, wasmPtr(ptr), 4); return v; }

std::unordered_map<std::string, u32> g_staticStrCache;
u32 staticWasmStr(const char* s) {
  if (!s) s = "";
  std::string key(s);
  auto it = g_staticStrCache.find(key);
  if (it != g_staticStrCache.end()) return it->second;
  u32 len = static_cast<u32>(key.size() + 1);
  u32 p = w2c_woditor_malloc(&g_inst, len);
  if (p) memcpy(wasmPtr(p), key.c_str(), len);
  g_staticStrCache[key] = p;
  return p;
}

std::string toLower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string trim(const std::string& s) {
  size_t a = 0;
  while (a < s.size() && std::isspace(static_cast<unsigned char>(s[a]))) a++;
  size_t b = s.size();
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) b--;
  return s.substr(a, b - a);
}

std::string normalizeSdmcPath(std::string raw) {
  for (char& c : raw) if (c == '\\') c = '/';
  raw = trim(raw);
  while (raw.size() > 1 && raw.back() == '/') raw.pop_back();
  if (raw.empty()) return {};
  if (raw[0] == '/') return "sdmc:" + raw;
  return raw;
}

std::string dirNameOf(const std::string& p) {
  size_t pos = p.rfind('/');
  if (pos == std::string::npos || pos <= 5) return "sdmc:/switch/SW2RPGMGL";
  return p.substr(0, pos);
}

void mkdirsHost(const std::string& path) {
  if (path.empty()) return;
  struct stat st {};
  if (stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) return;
  std::string cur;
  for (char c : path) {
    cur.push_back(c);
    if (c == '/' && cur.size() > 1 && cur != "sdmc:/") {
      std::string sub = cur.substr(0, cur.size() - 1);
      if (!sub.empty() && sub.back() != ':') mkdir(sub.c_str(), 0777);
    }
  }
  if (cur.back() != ':') mkdir(cur.c_str(), 0777);
}

std::string urlDecode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size()) {
      unsigned int v = 0;
      if (sscanf(s.c_str() + i + 1, "%2x", &v) == 1) {
        out.push_back(static_cast<char>(v));
        i += 2;
        continue;
      }
    }
    out.push_back(s[i]);
  }
  return out;
}

// ============================================================================
// Virtual Path Resolution & Open Descriptor Table
// ============================================================================
std::string g_cwd = "/";

std::string normalizeVPath(const std::string& rawIn) {
  std::string p = rawIn;
  for (char& c : p) if (c == '\\') c = '/';
  if (p.empty() || p[0] != '/') {
    std::string base = (g_cwd == "/") ? "" : g_cwd;
    p = base + "/" + p;
  }
  std::vector<std::string> parts;
  size_t i = 0;
  while (i < p.size()) {
    size_t j = p.find('/', i);
    if (j == std::string::npos) j = p.size();
    std::string seg = p.substr(i, j - i);
    if (!seg.empty() && seg != ".") {
      if (seg == "..") {
        if (!parts.empty()) parts.pop_back();
      } else {
        parts.push_back(std::move(seg));
      }
    }
    i = j + 1;
  }
  std::string out = "/";
  for (size_t k = 0; k < parts.size(); k++) {
    if (k > 0) out.push_back('/');
    out += parts[k];
  }
  return out;
}

struct OpenFd {
  std::string normVPath;
  bool isDir = false;
  bool writable = false;
  bool dirty = false;
  int64_t pos = 0;
  std::shared_ptr<std::vector<uint8_t>> roBuf;
  std::vector<uint8_t> rwBuf;
  std::vector<wolf::VfsDirEntry> dirEntries;
};

int g_nextFd = 10;
std::unordered_map<int, OpenFd> g_fds;

std::string resolveAtVPath(s32 dirfd, u32 pathPtr) {
  std::string raw = wasmCStr(pathPtr);
  if (raw.empty()) {
    auto it = g_fds.find(dirfd);
    return (it != g_fds.end()) ? it->second.normVPath : normalizeVPath(".");
  }
  if (raw[0] == '/' || dirfd == -100 || g_fds.find(dirfd) == g_fds.end()) {
    return normalizeVPath(raw);
  }
  const std::string& base = g_fds[dirfd].normVPath;
  return normalizeVPath((base == "/" ? "" : base) + "/" + raw);
}

void writeVfsStatToWasm(u32 bufPtr, const wolf::VfsStat& st) {
  memset(wasmPtr(bufPtr), 0, 96);
  uint32_t mode = st.isDir ? 0040777u : 0100666u;
  writeWasmU32(bufPtr + 0, st.dev);
  writeWasmU32(bufPtr + 4, mode);
  writeWasmU32(bufPtr + 8, 1);
  writeWasmI64(bufPtr + 24, static_cast<int64_t>(st.size));
  writeWasmI32(bufPtr + 32, 4096);
  writeWasmI32(bufPtr + 36, static_cast<int32_t>((st.size + 511) / 512));
  writeWasmI64(bufPtr + 40, st.mtime);
  writeWasmI64(bufPtr + 56, st.mtime);
  writeWasmI64(bufPtr + 72, st.mtime);
  writeWasmU64(bufPtr + 88, st.ino);
}

// ============================================================================
// EGL / OpenGL ES 3.0 Offscreen Game FBO + Overlay UI Renderer
// ============================================================================
EGLDisplay g_eglDpy = EGL_NO_DISPLAY;
EGLSurface g_eglSurf = EGL_NO_SURFACE;
EGLContext g_eglCtx = EGL_NO_CONTEXT;
int g_screenW = SCREEN_W;
int g_screenH = SCREEN_H;

int g_gameW = 640;
int g_gameH = 480;
GLuint g_gameFbo = 0;
GLuint g_gameColorTex = 0;
GLuint g_gameDepthRbo = 0;
int g_fboTexW = 0;
int g_fboTexH = 0;

GLuint g_wasmFbo = 0;
GLuint g_wasmArrayBuf = 0;
GLuint g_wasmElemBuf = 0;
bool g_gameFrameDirty = false;

enum class ScaleMode { Fit = 0, IntegerPixel = 1, Stretch = 2 };
ScaleMode g_scaleMode = ScaleMode::Fit;
bool g_smoothFilter = false;
bool g_showPerfHud = false;
bool g_quickMenuOpen = false;
int g_quickMenuSel = 0;

struct ViewRect { int x = 160, y = 0, w = 960, h = 720; };
ViewRect g_lastViewRect;

GLuint g_uiProg = 0, g_uiVao = 0, g_uiVbo = 0, g_uiTex = 0;
std::vector<uint32_t> g_uiPixels;
int g_uiTexW = 0, g_uiTexH = 0;

struct CachedGlyph {
  int w = 0, h = 0, left = 0, top = 0, advance = 0;
  std::vector<uint8_t> alpha;
};

class OverlayFont {
public:
  FT_Library ft = nullptr;
  FT_Face face = nullptr;
  int curSize = 0;
  std::unordered_map<uint64_t, CachedGlyph> cache;

  bool initFromSharedFont(const PlFontData& fd) {
    if (FT_Init_FreeType(&ft) != 0) return false;
    if (FT_New_Memory_Face(ft, reinterpret_cast<const FT_Byte*>(fd.address),
                           static_cast<FT_Long>(fd.size), 0, &face) != 0) {
      FT_Done_FreeType(ft); ft = nullptr; return false;
    }
    FT_Select_Charmap(face, FT_ENCODING_UNICODE);
    return true;
  }

  void shutdown() {
    cache.clear();
    if (face) { FT_Done_Face(face); face = nullptr; }
    if (ft) { FT_Done_FreeType(ft); ft = nullptr; }
  }

  static uint32_t nextUtf8(const std::string& s, size_t& i) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c < 0x80) { i++; return c; }
    if ((c & 0xE0) == 0xC0 && i + 1 < s.size()) {
      uint32_t cp = ((c & 0x1F) << 6) | (static_cast<unsigned char>(s[i + 1]) & 0x3F);
      i += 2; return cp;
    }
    if ((c & 0xF0) == 0xE0 && i + 2 < s.size()) {
      uint32_t cp = ((c & 0x0F) << 12) | ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 6) |
                    (static_cast<unsigned char>(s[i + 2]) & 0x3F);
      i += 3; return cp;
    }
    if ((c & 0xF8) == 0xF0 && i + 3 < s.size()) {
      uint32_t cp = ((c & 0x07) << 18) | ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 12) |
                    ((static_cast<unsigned char>(s[i + 2]) & 0x3F) << 6) |
                    (static_cast<unsigned char>(s[i + 3]) & 0x3F);
      i += 4; return cp;
    }
    i++; return '?';
  }

  const CachedGlyph& glyph(uint32_t cp, int px) {
    uint64_t key = (static_cast<uint64_t>(cp) << 16) | static_cast<uint64_t>(px & 0xFFFF);
    auto it = cache.find(key);
    if (it != cache.end()) return it->second;
    CachedGlyph g;
    if (face) {
      if (curSize != px) { FT_Set_Pixel_Sizes(face, 0, px); curSize = px; }
      FT_UInt gi = FT_Get_Char_Index(face, cp);
      if (gi == 0 && cp != ' ') gi = FT_Get_Char_Index(face, '?');
      if (FT_Load_Glyph(face, gi, FT_LOAD_RENDER) == 0) {
        FT_GlyphSlot s = face->glyph;
        g.w = s->bitmap.width; g.h = s->bitmap.rows;
        g.left = s->bitmap_left; g.top = s->bitmap_top;
        g.advance = static_cast<int>(s->advance.x >> 6);
        if (g.w > 0 && g.h > 0 && s->bitmap.buffer) {
          g.alpha.resize(static_cast<size_t>(g.w * g.h));
          for (int r = 0; r < g.h; r++) {
            memcpy(&g.alpha[r * g.w], s->bitmap.buffer + r * s->bitmap.pitch, static_cast<size_t>(g.w));
          }
        }
      }
    }
    if (cache.size() > 2048) cache.clear();
    return cache.emplace(key, std::move(g)).first->second;
  }

  int measure(const std::string& t, int px) {
    int w = 0; size_t i = 0;
    while (i < t.size()) w += glyph(nextUtf8(t, i), px).advance;
    return w;
  }

  void draw(uint32_t* buf, int bw, int bh, const std::string& t, int x, int y, int px,
            uint32_t rgbaHex, int align = 0) {
    if (t.empty() || !face) return;
    int penX = x;
    if (align == 1) penX -= measure(t, px) / 2;
    else if (align == 2) penX -= measure(t, px);
    int baseY = y + static_cast<int>(px * 0.82f);
    uint8_t cr = (rgbaHex >> 24) & 0xFF, cg = (rgbaHex >> 16) & 0xFF;
    uint8_t cb = (rgbaHex >> 8) & 0xFF, ca = rgbaHex & 0xFF;
    size_t i = 0;
    while (i < t.size()) {
      const CachedGlyph& g = glyph(nextUtf8(t, i), px);
      int gx0 = penX + g.left, gy0 = baseY - g.top;
      for (int r = 0; r < g.h; r++) {
        int py = gy0 + r;
        if (py < 0 || py >= bh) continue;
        for (int c = 0; c < g.w; c++) {
          int pxC = gx0 + c;
          if (pxC < 0 || pxC >= bw) continue;
          uint8_t a = static_cast<uint8_t>((g.alpha[r * g.w + c] * ca + 127) / 255);
          if (!a) continue;
          uint32_t& dst = buf[py * bw + pxC];
          uint8_t dr = dst & 0xFF, dg = (dst >> 8) & 0xFF, db = (dst >> 16) & 0xFF, da = (dst >> 24) & 0xFF;
          uint32_t inv = 255 - a;
          uint8_t nr = static_cast<uint8_t>((cr * a + dr * inv + 127) / 255);
          uint8_t ng = static_cast<uint8_t>((cg * a + dg * inv + 127) / 255);
          uint8_t nb = static_cast<uint8_t>((cb * a + db * inv + 127) / 255);
          uint8_t na = static_cast<uint8_t>(a + (da * inv + 127) / 255);
          dst = (static_cast<uint32_t>(na) << 24) | (static_cast<uint32_t>(nb) << 16) |
                (static_cast<uint32_t>(ng) << 8) | nr;
        }
      }
      penX += g.advance;
    }
  }
};

OverlayFont g_font;

void fillOverlayRect(uint32_t* buf, int bw, int bh, int x, int y, int w, int h, uint32_t rgbaHex) {
  int x0 = std::max(0, x), y0 = std::max(0, y);
  int x1 = std::min(bw, x + w), y1 = std::min(bh, y + h);
  if (x0 >= x1 || y0 >= y1) return;
  uint8_t cr = (rgbaHex >> 24) & 0xFF, cg = (rgbaHex >> 16) & 0xFF;
  uint8_t cb = (rgbaHex >> 8) & 0xFF, ca = rgbaHex & 0xFF;
  uint32_t packed = (static_cast<uint32_t>(ca) << 24) | (static_cast<uint32_t>(cb) << 16) |
                    (static_cast<uint32_t>(cg) << 8) | cr;
  for (int py = y0; py < y1; py++) {
    uint32_t* row = buf + py * bw + x0;
    if (ca == 255) {
      for (int px = x0; px < x1; px++) *row++ = packed;
    } else {
      uint32_t inv = 255 - ca;
      for (int px = x0; px < x1; px++) {
        uint32_t d = *row;
        uint8_t dr = d & 0xFF, dg = (d >> 8) & 0xFF, db = (d >> 16) & 0xFF, da = (d >> 24) & 0xFF;
        uint8_t nr = static_cast<uint8_t>((cr * ca + dr * inv + 127) / 255);
        uint8_t ng = static_cast<uint8_t>((cg * ca + dg * inv + 127) / 255);
        uint8_t nb = static_cast<uint8_t>((cb * ca + db * inv + 127) / 255);
        uint8_t na = static_cast<uint8_t>(ca + (da * inv + 127) / 255);
        *row++ = (static_cast<uint32_t>(na) << 24) | (static_cast<uint32_t>(nb) << 16) |
                 (static_cast<uint32_t>(ng) << 8) | nr;
      }
    }
  }
}

void ensureGameFbo(int w, int h) {
  if (w <= 0) w = 640;
  if (h <= 0) h = 480;
  g_gameW = w;
  g_gameH = h;
  if (g_gameFbo && g_fboTexW == w && g_fboTexH == h) return;

  GLint prevTex = 0, prevRbo = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTex);
  glGetIntegerv(GL_RENDERBUFFER_BINDING, &prevRbo);

  if (!g_gameFbo) glGenFramebuffers(1, &g_gameFbo);
  if (!g_gameColorTex) glGenTextures(1, &g_gameColorTex);
  if (!g_gameDepthRbo) glGenRenderbuffers(1, &g_gameDepthRbo);

  glBindTexture(GL_TEXTURE_2D, g_gameColorTex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

  glBindRenderbuffer(GL_RENDERBUFFER, g_gameDepthRbo);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, w, h);

  glBindFramebuffer(GL_FRAMEBUFFER, g_gameFbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_gameColorTex, 0);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, g_gameDepthRbo);

  glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);

  g_fboTexW = w;
  g_fboTexH = h;

  glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevTex));
  glBindRenderbuffer(GL_RENDERBUFFER, static_cast<GLuint>(prevRbo));
  glBindFramebuffer(GL_FRAMEBUFFER, g_wasmFbo ? g_wasmFbo : g_gameFbo);
  logMsg("[gl] Game offscreen FBO ready: %dx%d (fbo=%u tex=%u)", w, h, g_gameFbo, g_gameColorTex);
}

bool initUiOverlayGl() {
  const char* vsSrc =
      "#version 300 es\n"
      "layout(location=0) in vec2 aPos;\n"
      "layout(location=1) in vec2 aUv;\n"
      "out vec2 vUv;\n"
      "void main() { vUv = aUv; gl_Position = vec4(aPos, 0.0, 1.0); }\n";
  const char* fsSrc =
      "#version 300 es\n"
      "precision mediump float;\n"
      "in vec2 vUv;\n"
      "uniform sampler2D uTex;\n"
      "out vec4 oCol;\n"
      "void main() { oCol = texture(uTex, vUv); }\n";

  auto compile = [](GLenum type, const char* src) -> GLuint {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    return s;
  };
  GLuint vs = compile(GL_VERTEX_SHADER, vsSrc);
  GLuint fs = compile(GL_FRAGMENT_SHADER, fsSrc);
  g_uiProg = glCreateProgram();
  glAttachShader(g_uiProg, vs);
  glAttachShader(g_uiProg, fs);
  glLinkProgram(g_uiProg);
  glDeleteShader(vs);
  glDeleteShader(fs);

  glGenVertexArrays(1, &g_uiVao);
  glGenBuffers(1, &g_uiVbo);
  glGenTextures(1, &g_uiTex);

  glBindVertexArray(g_uiVao);
  glBindBuffer(GL_ARRAY_BUFFER, g_uiVbo);
  const float verts[] = {
      -1.0f,  1.0f, 0.0f, 0.0f,
      -1.0f, -1.0f, 0.0f, 1.0f,
       1.0f,  1.0f, 1.0f, 0.0f,
       1.0f, -1.0f, 1.0f, 1.0f,
  };
  glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_DYNAMIC_DRAW);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<const void*>(0));
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<const void*>(2 * sizeof(float)));
  glBindVertexArray(0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);

  glBindTexture(GL_TEXTURE_2D, g_uiTex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glBindTexture(GL_TEXTURE_2D, 0);
  return true;
}

bool initEglSwitch2() {
  NWindow* win = nwindowGetDefault();
  g_eglDpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (!g_eglDpy) return false;
  if (!eglInitialize(g_eglDpy, nullptr, nullptr)) return false;
  eglBindAPI(EGL_OPENGL_ES_API);

  EGLConfig cfg {};
  EGLint numCfg = 0;
  const EGLint attrs[] = {
      EGL_RENDERABLE_TYPE, 0x0040,
      EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
      EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
      EGL_NONE,
  };
  eglChooseConfig(g_eglDpy, attrs, &cfg, 1, &numCfg);
  if (!numCfg) return false;

  g_eglSurf = eglCreateWindowSurface(g_eglDpy, cfg, win, nullptr);
  if (!g_eglSurf) return false;

  const EGLint ctxAttrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
  g_eglCtx = eglCreateContext(g_eglDpy, cfg, EGL_NO_CONTEXT, ctxAttrs);
  if (!g_eglCtx) return false;
  if (eglMakeCurrent(g_eglDpy, g_eglSurf, g_eglSurf, g_eglCtx) != EGL_TRUE) return false;
  eglSwapInterval(g_eglDpy, 1);

  GLint vp[4] = {0, 0, 0, 0};
  glGetIntegerv(GL_VIEWPORT, vp);
  if (vp[2] > 0 && vp[3] > 0) { g_screenW = vp[2]; g_screenH = vp[3]; }
  initUiOverlayGl();
  ensureGameFbo(640, 480);
  logMsg("[egl] OunceVK ES3 ready: %dx%d (%s)", g_screenW, g_screenH,
         reinterpret_cast<const char*>(glGetString(GL_VERSION)));
  return true;
}

void shutdownEgl() {
  if (g_eglDpy != EGL_NO_DISPLAY) {
    eglMakeCurrent(g_eglDpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (g_eglCtx != EGL_NO_CONTEXT) eglDestroyContext(g_eglDpy, g_eglCtx);
    if (g_eglSurf != EGL_NO_SURFACE) eglDestroySurface(g_eglDpy, g_eglSurf);
    eglTerminate(g_eglDpy);
    g_eglDpy = EGL_NO_DISPLAY;
  }
}

void drawOverlayBuffer(int w, int h, float x0Ndc, float y0Ndc, float x1Ndc, float y1Ndc) {
  GLint prevProg = 0, prevArrBuf = 0, prevActTex = 0, prevTex2d = 0, prevVp[4] {};
  GLboolean wasBlend = glIsEnabled(GL_BLEND);
  GLboolean wasDepth = glIsEnabled(GL_DEPTH_TEST);
  GLboolean wasCull = glIsEnabled(GL_CULL_FACE);
  GLboolean wasScissor = glIsEnabled(GL_SCISSOR_TEST);
  GLint blendSrcRgb = 0, blendDstRgb = 0, blendSrcA = 0, blendDstA = 0;
  glGetIntegerv(GL_CURRENT_PROGRAM, &prevProg);
  glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &prevArrBuf);
  glGetIntegerv(GL_ACTIVE_TEXTURE, &prevActTex);
  glActiveTexture(GL_TEXTURE0);
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTex2d);
  glGetIntegerv(GL_VIEWPORT, prevVp);
  glGetIntegerv(GL_BLEND_SRC_RGB, &blendSrcRgb);
  glGetIntegerv(GL_BLEND_DST_RGB, &blendDstRgb);
  glGetIntegerv(GL_BLEND_SRC_ALPHA, &blendSrcA);
  glGetIntegerv(GL_BLEND_DST_ALPHA, &blendDstA);

  glViewport(0, 0, g_screenW, g_screenH);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_CULL_FACE);
  glDisable(GL_SCISSOR_TEST);
  glEnable(GL_BLEND);
  glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);

  glBindTexture(GL_TEXTURE_2D, g_uiTex);
  if (g_uiTexW != w || g_uiTexH != h) {
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, g_uiPixels.data());
    g_uiTexW = w; g_uiTexH = h;
  } else {
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, g_uiPixels.data());
  }

  const float verts[] = {
      x0Ndc, y1Ndc, 0.0f, 0.0f,
      x0Ndc, y0Ndc, 0.0f, 1.0f,
      x1Ndc, y1Ndc, 1.0f, 0.0f,
      x1Ndc, y0Ndc, 1.0f, 1.0f,
  };
  glUseProgram(g_uiProg);
  glBindVertexArray(g_uiVao);
  glBindBuffer(GL_ARRAY_BUFFER, g_uiVbo);
  glBufferSubData(GL_ARRAY_BUFFER, 0, sizeof(verts), verts);
  glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  glBindVertexArray(0);

  glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevTex2d));
  glActiveTexture(static_cast<GLenum>(prevActTex));
  glBindBuffer(GL_ARRAY_BUFFER, static_cast<GLuint>(prevArrBuf));
  glUseProgram(static_cast<GLuint>(prevProg));
  glBlendFuncSeparate(blendSrcRgb, blendDstRgb, blendSrcA, blendDstA);
  if (!wasBlend) glDisable(GL_BLEND);
  if (wasDepth) glEnable(GL_DEPTH_TEST);
  if (wasCull) glEnable(GL_CULL_FACE);
  if (wasScissor) glEnable(GL_SCISSOR_TEST);
  glViewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
}

// Truncate to maxChars code points with a trailing "…" (matches the MV/MZ splash clipping)
std::string clipUtf8(const std::string& s, size_t maxChars) {
  size_t i = 0, n = 0, cut = std::string::npos;
  while (i < s.size()) {
    if (n == maxChars - 1) cut = i;
    if (++n > maxChars) return s.substr(0, cut) + "\xE2\x80\xA6";
    unsigned char c = static_cast<unsigned char>(s[i]);
    i += (c < 0x80) ? 1 : ((c & 0xE0) == 0xC0) ? 2 : ((c & 0xF0) == 0xE0) ? 3 : 4;
  }
  return s;
}

std::string g_loadingTitle;  // game folder name (WOLF games have no title until Game.dat is parsed)

// Same layout, sizes and colours as the SW2RPGMGL MV/MZ splash (loader/src/main.ts drawSplash)
// and the mkxp-z loading screen: title, engine line, full-width bar, status, detail, Quick Menu hint.
void renderBootLoadingFrame(float pct, const std::string& statusText, const std::string& detail = "") {
  if (g_eglDpy == EGL_NO_DISPLAY) return;
  g_uiPixels.assign(static_cast<size_t>(SCREEN_W * SCREEN_H), 0xFF18100Du);
  uint32_t* px = g_uiPixels.data();
  fillOverlayRect(px, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H, 0x0D1018FFu);

  const int margin = 72;
  const std::string title = g_loadingTitle.empty() ? std::string("Loading...") : clipUtf8(g_loadingTitle, 36);
  g_font.draw(px, SCREEN_W, SCREEN_H, title, margin, 76, 40, 0xF1F5FFFFu);
  g_font.draw(px, SCREEN_W, SCREEN_H,
              "SW2RPGMGL  \xE2\x80\xA2  WOLF RPG Editor (BrowserWoditor / wasm2c AArch64)",
              margin, 130, 20, 0x6C8CFFFFu);

  const int barX = margin, barY = 204, barW = SCREEN_W - margin * 2, barH = 18;
  fillOverlayRect(px, SCREEN_W, SCREEN_H, barX, barY, barW, barH, 0x1E2638FFu);
  int fillW = static_cast<int>(std::lround(std::clamp(pct, 0.0f, 1.0f) * barW));
  if (fillW > 0) fillOverlayRect(px, SCREEN_W, SCREEN_H, barX, barY, fillW, barH, 0x5C7CFAFFu);

  g_font.draw(px, SCREEN_W, SCREEN_H, statusText, margin, 242, 24, 0xFFFFFFFFu);
  if (!detail.empty()) g_font.draw(px, SCREEN_W, SCREEN_H, clipUtf8(detail, 110), margin, 288, 18, 0xA8B5D1FFu);
  g_font.draw(px, SCREEN_W, SCREEN_H,
              "Press Minus (-) anytime in-game for Display, Filter, HUD, Game Select & Exit",
              margin, SCREEN_H - 54, 16, 0x73809EFFu);

  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glClearColor(0.05f, 0.06f, 0.09f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  drawOverlayBuffer(SCREEN_W, SCREEN_H, -1.0f, -1.0f, 1.0f, 1.0f);
  eglSwapBuffers(g_eglDpy, g_eglSurf);
  glBindFramebuffer(GL_FRAMEBUFFER, g_wasmFbo ? g_wasmFbo : g_gameFbo);
}

double g_fpsLastMs = 0.0;
int g_fpsFrames = 0;
float g_fpsValue = 60.0f;

ViewRect computeDestViewport() {
  if (g_scaleMode == ScaleMode::Stretch || g_gameW <= 0 || g_gameH <= 0) {
    return {0, 0, g_screenW, g_screenH};
  }
  if (g_scaleMode == ScaleMode::IntegerPixel) {
    int mult = std::min(g_screenW / g_gameW, g_screenH / g_gameH);
    if (mult >= 1) {
      int dw = g_gameW * mult, dh = g_gameH * mult;
      return {(g_screenW - dw) / 2, (g_screenH - dh) / 2, dw, dh};
    }
  }
  float sc = std::min(static_cast<float>(g_screenW) / g_gameW,
                      static_cast<float>(g_screenH) / g_gameH);
  int dw = std::max(1, static_cast<int>(std::round(g_gameW * sc)));
  int dh = std::max(1, static_cast<int>(std::round(g_gameH * sc)));
  return {(g_screenW - dw) / 2, (g_screenH - dh) / 2, dw, dh};
}

constexpr int QUICK_MENU_COUNT = 7;

void presentGameAndOverlay() {
  if (g_eglDpy == EGL_NO_DISPLAY) return;

  g_fpsFrames++;
  double t = nowMs();
  if (g_fpsLastMs == 0.0) g_fpsLastMs = t;
  else if (t - g_fpsLastMs >= 500.0) {
    g_fpsValue = static_cast<float>(g_fpsFrames * 1000.0 / (t - g_fpsLastMs));
    g_fpsFrames = 0;
    g_fpsLastMs = t;
  }

  GLboolean wasScissor = glIsEnabled(GL_SCISSOR_TEST);
  if (wasScissor) glDisable(GL_SCISSOR_TEST);

  ViewRect vr = computeDestViewport();
  g_lastViewRect = vr;
  int glY0 = g_screenH - (vr.y + vr.h);
  int glY1 = g_screenH - vr.y;

  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);

  glBindFramebuffer(GL_READ_FRAMEBUFFER, g_gameFbo);
  GLenum filt = (g_smoothFilter && g_scaleMode != ScaleMode::IntegerPixel) ? GL_LINEAR : GL_NEAREST;
  glBlitFramebuffer(0, 0, g_gameW, g_gameH, vr.x, glY0, vr.x + vr.w, glY1, GL_COLOR_BUFFER_BIT, filt);

  if (g_showPerfHud && !g_quickMenuOpen) {
    int hw = 250, hh = 34;
    g_uiPixels.assign(static_cast<size_t>(hw * hh), 0);
    fillOverlayRect(g_uiPixels.data(), hw, hh, 0, 0, hw, hh, 0x0D1220D8u);
    char buf[96];
    snprintf(buf, sizeof(buf), "%.0f FPS  \xE2\x80\xA2  %dx%d  WOLF", g_fpsValue, g_gameW, g_gameH);
    g_font.draw(g_uiPixels.data(), hw, hh, buf, 12, 7, 15, 0x8EF5B8FFu, 0);
    float x0 = -1.0f + 2.0f * (16.0f / g_screenW);
    float x1 = -1.0f + 2.0f * ((16.0f + hw) / g_screenW);
    float y1 = 1.0f - 2.0f * (14.0f / g_screenH);
    float y0 = 1.0f - 2.0f * ((14.0f + hh) / g_screenH);
    drawOverlayBuffer(hw, hh, x0, y0, x1, y1);
  }

  if (g_quickMenuOpen) {
    g_uiPixels.assign(static_cast<size_t>(SCREEN_W * SCREEN_H), 0);
    fillOverlayRect(g_uiPixels.data(), SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H, 0x070A12B8u);

    int mw = 560, mh = 456;
    int mx = (SCREEN_W - mw) / 2, my = (SCREEN_H - mh) / 2;
    fillOverlayRect(g_uiPixels.data(), SCREEN_W, SCREEN_H, mx - 2, my - 2, mw + 4, mh + 4, 0x5C7CFAFFu);
    fillOverlayRect(g_uiPixels.data(), SCREEN_W, SCREEN_H, mx, my, mw, mh, 0x141A29FAu);

    g_font.draw(g_uiPixels.data(), SCREEN_W, SCREEN_H, "WOLF RPG Quick Menu", mx + 28, my + 20, 23, 0xFFFFFFFFu, 0);
    char sub[128];
    snprintf(sub, sizeof(sub), "%.0f FPS  \xE2\x80\xA2  Native %dx%d", g_fpsValue, g_gameW, g_gameH);
    g_font.draw(g_uiPixels.data(), SCREEN_W, SCREEN_H, sub, mx + mw - 28, my + 24, 15, 0x8FA6D8FFu, 2);
    fillOverlayRect(g_uiPixels.data(), SCREEN_W, SCREEN_H, mx + 24, my + 58, mw - 48, 1, 0x2A3654FFu);

    const char* scaleLabel = (g_scaleMode == ScaleMode::Fit)
        ? "Display Mode: Fit Aspect"
        : (g_scaleMode == ScaleMode::IntegerPixel ? "Display Mode: Integer Pixel" : "Display Mode: Stretch 16:9");
    const char* filtLabel = g_smoothFilter ? "Scaling Filter: Smooth (Bilinear)" : "Scaling Filter: Crisp (Nearest)";
    const char* hudLabel = g_showPerfHud ? "Performance HUD: On" : "Performance HUD: Off";

    const char* items[QUICK_MENU_COUNT] = {
        "Resume Game",
        scaleLabel,
        filtLabel,
        hudLabel,
        "Soft Reset Game (F12)",
        g_returnNro.empty() ? "Return to Game Select (N/A)" : "Return to Game Select",
        "Exit to Homebrew Menu",
    };

    for (int i = 0; i < QUICK_MENU_COUNT; i++) {
      int ry = my + 74 + i * 48;
      bool sel = (i == g_quickMenuSel);
      fillOverlayRect(g_uiPixels.data(), SCREEN_W, SCREEN_H, mx + 24, ry, mw - 48, 40,
                      sel ? 0x35539EFFu : 0x1C2438FFu);
      g_font.draw(g_uiPixels.data(), SCREEN_W, SCREEN_H, items[i], mx + 42, ry + 9, 18,
                  sel ? 0xFFFFFFFFu : 0xD2DCF2FFu, 0);
    }

    g_font.draw(g_uiPixels.data(), SCREEN_W, SCREEN_H,
                "A: Confirm   \xE2\x80\xA2   B / Minus (-): Resume",
                mx + mw / 2, my + mh - 32, 14, 0x7D90B8FFu, 1);

    drawOverlayBuffer(SCREEN_W, SCREEN_H, -1.0f, -1.0f, 1.0f, 1.0f);
  }

  eglSwapBuffers(g_eglDpy, g_eglSurf);
  g_gameFrameDirty = false;

  if (wasScissor) glEnable(GL_SCISSOR_TEST);
  glBindFramebuffer(GL_FRAMEBUFFER, g_wasmFbo ? g_wasmFbo : g_gameFbo);
}

// ============================================================================
// OpenAL Soft Device & Context State
// ============================================================================
ALCdevice* g_alDev = nullptr;
ALCcontext* g_alCtx = nullptr;

void initOpenAlHost() {
  g_alDev = alcOpenDevice(nullptr);
  if (g_alDev) {
    g_alCtx = alcCreateContext(g_alDev, nullptr);
    if (g_alCtx) alcMakeContextCurrent(g_alCtx);
    logMsg("[audio] OpenAL initialized (%s)", alcGetString(g_alDev, ALC_DEVICE_SPECIFIER));
  } else {
    logMsg("[audio] WARNING: alcOpenDevice returned null");
  }
}

void shutdownOpenAlHost() {
  if (g_alCtx) {
    alcMakeContextCurrent(nullptr);
    alcDestroyContext(g_alCtx);
    g_alCtx = nullptr;
  }
  if (g_alDev) {
    alcCloseDevice(g_alDev);
    g_alDev = nullptr;
  }
}

// ============================================================================
// Switch 2 Input -> Emscripten Keyboard / Mouse / Touch + Software Keyboard
// ============================================================================
PadState g_pads[8] {};
bool g_padsInited = false;

void initSwitchPads() {
  padConfigureInput(8, HidNpadStyleSet_NpadStandard | HidNpadStyleTag_NpadGc);
  padInitializeDefault(&g_pads[0]);
  for (int i = 1; i < 8; i++) {
    padInitialize(&g_pads[i], static_cast<HidNpadIdType>(HidNpadIdType_No1 + i));
  }
  hidInitializeTouchScreen();
  g_padsInited = true;
}

struct RegisteredCb { u32 fn = 0; u32 userData = 0; };
std::vector<RegisteredCb> g_keyDownCbs, g_keyUpCbs;
std::vector<RegisteredCb> g_mouseDownCbs, g_mouseMoveCbs, g_mouseUpCbs;
std::vector<RegisteredCb> g_touchStartCbs, g_touchMoveCbs, g_touchEndCbs;

u32 g_keyEventBuf = 0, g_mouseEventBuf = 0, g_touchEventBuf = 0;

void emitKeyEvent(bool down, int keyCode, const char* key, const char* code, bool shift, bool ctrl) {
  if (!g_wasmReady) return;
  auto& list = down ? g_keyDownCbs : g_keyUpCbs;
  if (list.empty()) return;
  if (!g_keyEventBuf) g_keyEventBuf = w2c_woditor_malloc(&g_inst, 160);
  if (!g_keyEventBuf) return;

  memset(wasmPtr(g_keyEventBuf), 0, 160);
  writeWasmF64(g_keyEventBuf + 0, nowMs());
  wasmMem()[g_keyEventBuf + 12] = ctrl ? 1 : 0;
  wasmMem()[g_keyEventBuf + 13] = shift ? 1 : 0;
  writeWasmI32(g_keyEventBuf + 24, keyCode);
  writeWasmI32(g_keyEventBuf + 28, keyCode);
  writeWasmCStr(key, g_keyEventBuf + 32, 32);
  writeWasmCStr(code, g_keyEventBuf + 64, 32);

  u32 evType = down ? 2u : 3u;
  for (const auto& cb : list) {
    if (cb.fn) w2c_woditor_dynCall_iiii(&g_inst, cb.fn, evType, g_keyEventBuf, cb.userData);
  }
}

void emitPointerEvent(int type, int gx, int gy, bool buttonsDown) {
  if (!g_wasmReady) return;
  std::vector<RegisteredCb>* mList = nullptr;
  u32 mType = 0;
  if (type == 0) { mList = &g_mouseDownCbs; mType = 5; }
  else if (type == 1) { mList = &g_mouseMoveCbs; mType = 8; }
  else { mList = &g_mouseUpCbs; mType = 6; }

  if (mList && !mList->empty()) {
    if (!g_mouseEventBuf) g_mouseEventBuf = w2c_woditor_malloc(&g_inst, 64);
    if (g_mouseEventBuf) {
      memset(wasmPtr(g_mouseEventBuf), 0, 64);
      writeWasmF64(g_mouseEventBuf + 0, nowMs());
      writeWasmI32(g_mouseEventBuf + 8, gx);
      writeWasmI32(g_mouseEventBuf + 12, gy);
      writeWasmI32(g_mouseEventBuf + 16, gx);
      writeWasmI32(g_mouseEventBuf + 20, gy);
      writeWasmU16(g_mouseEventBuf + 28, 0);
      writeWasmU16(g_mouseEventBuf + 30, buttonsDown ? 1 : 0);
      writeWasmI32(g_mouseEventBuf + 40, gx);
      writeWasmI32(g_mouseEventBuf + 44, gy);
      for (const auto& cb : *mList) {
        if (cb.fn) w2c_woditor_dynCall_iiii(&g_inst, cb.fn, mType, g_mouseEventBuf, cb.userData);
      }
    }
  }

  std::vector<RegisteredCb>* tList = nullptr;
  u32 tType = 0;
  if (type == 0) { tList = &g_touchStartCbs; tType = 22; }
  else if (type == 1) { tList = &g_touchMoveCbs; tType = 24; }
  else { tList = &g_touchEndCbs; tType = 23; }

  if (tList && !tList->empty()) {
    if (!g_touchEventBuf) g_touchEventBuf = w2c_woditor_malloc(&g_inst, 1552);
    if (g_touchEventBuf) {
      memset(wasmPtr(g_touchEventBuf), 0, 1552);
      writeWasmF64(g_touchEventBuf + 0, nowMs());
      writeWasmI32(g_touchEventBuf + 8, 1);
      u32 t0 = g_touchEventBuf + 16;
      writeWasmI32(t0 + 0, 0);
      writeWasmI32(t0 + 4, gx);
      writeWasmI32(t0 + 8, gy);
      writeWasmI32(t0 + 12, gx);
      writeWasmI32(t0 + 16, gy);
      writeWasmI32(t0 + 20, gx);
      writeWasmI32(t0 + 24, gy);
      wasmMem()[t0 + 28] = 1;
      wasmMem()[t0 + 29] = buttonsDown ? 1 : 0;
      writeWasmI32(t0 + 32, gx);
      writeWasmI32(t0 + 36, gy);
      for (const auto& cb : *tList) {
        if (cb.fn) w2c_woditor_dynCall_iiii(&g_inst, cb.fn, tType, g_touchEventBuf, cb.userData);
      }
    }
  }
}

struct KeyBindState {
  int keyCode;
  const char* key;
  const char* code;
  bool wasHeld;
};

KeyBindState g_keyBinds[] = {
    {38, "ArrowUp",    "ArrowUp",      false},
    {40, "ArrowDown",  "ArrowDown",    false},
    {37, "ArrowLeft",  "ArrowLeft",    false},
    {39, "ArrowRight", "ArrowRight",   false},
    {90, "z",          "KeyZ",         false},
    {88, "x",          "KeyX",         false},
    {67, "c",          "KeyC",         false},
    {16, "Shift",      "ShiftLeft",    false},
    {65, "a",          "KeyA",         false},
    {83, "s",          "KeyS",         false},
    {17, "Control",    "ControlLeft",  false},
    {13, "Enter",      "Enter",        false},
    {27, "Escape",     "Escape",       false},
};

bool g_prevTouchDown = false;
int g_lastGameTouchX = 0, g_lastGameTouchY = 0;
int g_pendingF12ReleaseFrames = 0;

void releaseAllHeldKeys() {
  for (auto& kb : g_keyBinds) {
    if (kb.wasHeld) {
      kb.wasHeld = false;
      emitKeyEvent(false, kb.keyCode, kb.key, kb.code, false, false);
    }
  }
}

void executeQuickMenuAction(int idx) {
  switch (idx) {
    case 0: g_quickMenuOpen = false; break;
    case 1: g_scaleMode = static_cast<ScaleMode>((static_cast<int>(g_scaleMode) + 1) % 3); break;
    case 2: g_smoothFilter = !g_smoothFilter; break;
    case 3: g_showPerfHud = !g_showPerfHud; break;
    case 4:
      g_quickMenuOpen = false;
      emitKeyEvent(true, 123, "F12", "F12", false, false);
      g_pendingF12ReleaseFrames = 3;
      break;
    case 5:
      if (!g_returnNro.empty()) {
        g_returnToLauncher = true;
        g_shouldExit = true;
        g_quickMenuOpen = false;
      }
      break;
    case 6:
      g_returnToLauncher = false;
      g_shouldExit = true;
      g_quickMenuOpen = false;
      break;
  }
}

void pollSwitchInput() {
  if (!g_padsInited) return;
  u64 kDown = 0, kHeld = 0;
  HidAnalogStickState stickL {0, 0};
  for (int i = 0; i < 8; i++) {
    padUpdate(&g_pads[i]);
    kDown |= padGetButtonsDown(&g_pads[i]);
    kHeld |= padGetButtons(&g_pads[i]);
    HidAnalogStickState s = padGetStickPos(&g_pads[i], 0);
    if (std::abs(s.x) > std::abs(stickL.x)) stickL.x = s.x;
    if (std::abs(s.y) > std::abs(stickL.y)) stickL.y = s.y;
  }

  if (g_pendingF12ReleaseFrames > 0 && --g_pendingF12ReleaseFrames == 0) {
    emitKeyEvent(false, 123, "F12", "F12", false, false);
  }

  if (kDown & HidNpadButton_Minus) {
    g_quickMenuOpen = !g_quickMenuOpen;
    if (g_quickMenuOpen) {
      g_quickMenuSel = 0;
      releaseAllHeldKeys();
    }
    return;
  }

  HidTouchScreenState ts {};
  bool touchDown = (hidGetTouchScreenStates(&ts, 1) > 0 && ts.count > 0);
  int tx = touchDown ? static_cast<int>(ts.touches[0].x) : 0;
  int ty = touchDown ? static_cast<int>(ts.touches[0].y) : 0;

  if (g_quickMenuOpen) {
    if (kDown & HidNpadButton_B) { g_quickMenuOpen = false; return; }
    if (kDown & (HidNpadButton_Up | HidNpadButton_StickLUp)) {
      g_quickMenuSel = (g_quickMenuSel + QUICK_MENU_COUNT - 1) % QUICK_MENU_COUNT;
    }
    if (kDown & (HidNpadButton_Down | HidNpadButton_StickLDown)) {
      g_quickMenuSel = (g_quickMenuSel + 1) % QUICK_MENU_COUNT;
    }
    if (kDown & HidNpadButton_A) { executeQuickMenuAction(g_quickMenuSel); return; }
    if (touchDown && !g_prevTouchDown) {
      int mw = 560, mh = 456;
      int mx = (SCREEN_W - mw) / 2, my = (SCREEN_H - mh) / 2;
      for (int i = 0; i < QUICK_MENU_COUNT; i++) {
        int ry = my + 74 + i * 48;
        if (tx >= mx + 24 && tx <= mx + mw - 24 && ty >= ry && ty <= ry + 40) {
          g_quickMenuSel = i;
          executeQuickMenuAction(i);
          break;
        }
      }
    }
    g_prevTouchDown = touchDown;
    return;
  }

  bool nowHeld[13] = {
      ((kHeld & HidNpadButton_Up) != 0) || (stickL.y > 14000),
      ((kHeld & HidNpadButton_Down) != 0) || (stickL.y < -14000),
      ((kHeld & HidNpadButton_Left) != 0) || (stickL.x < -14000),
      ((kHeld & HidNpadButton_Right) != 0) || (stickL.x > 14000),
      (kHeld & HidNpadButton_A) != 0,
      (kHeld & HidNpadButton_B) != 0,
      (kHeld & HidNpadButton_X) != 0,
      (kHeld & HidNpadButton_Y) != 0,
      (kHeld & HidNpadButton_L) != 0,
      (kHeld & HidNpadButton_R) != 0,
      (kHeld & HidNpadButton_ZL) != 0,
      (kHeld & HidNpadButton_ZR) != 0,
      (kHeld & HidNpadButton_Plus) != 0,
  };

  bool shiftHeld = nowHeld[7], ctrlHeld = nowHeld[10];
  for (int i = 0; i < 13; i++) {
    if (nowHeld[i] != g_keyBinds[i].wasHeld) {
      g_keyBinds[i].wasHeld = nowHeld[i];
      emitKeyEvent(nowHeld[i], g_keyBinds[i].keyCode, g_keyBinds[i].key, g_keyBinds[i].code,
                   shiftHeld, ctrlHeld);
    }
  }

  if (touchDown) {
    const ViewRect& vr = g_lastViewRect;
    int gx = std::clamp((tx - vr.x) * g_gameW / std::max(1, vr.w), 0, std::max(0, g_gameW - 1));
    int gy = std::clamp((ty - vr.y) * g_gameH / std::max(1, vr.h), 0, std::max(0, g_gameH - 1));
    g_lastGameTouchX = gx; g_lastGameTouchY = gy;
    emitPointerEvent(g_prevTouchDown ? 1 : 0, gx, gy, true);
  } else if (g_prevTouchDown) {
    emitPointerEvent(2, g_lastGameTouchX, g_lastGameTouchY, false);
  }
  g_prevTouchDown = touchDown;
}

u32 g_textInputMaxLen = 32;
u32 g_textInputState = 0;
std::string g_textInputValue;

} // namespace

extern "C" void wolf_on_wasm_trap(wasm_rt_trap_t code) {
  logMsg("[TRAP] wasm_rt_trap(%d): %s", static_cast<int>(code), wasm_rt_strerror(code));
  g_shouldExit = true;
  if (g_hasTopJmp) longjmp(g_topJmp, JMP_EXIT);
}

// ============================================================================
// Emscripten Host Imports ('env' & 'wasi_snapshot_preview1')
// ============================================================================
extern "C" {

void w2c_env_0x5F_asyncjs_0x5FinitializeJS(struct w2c_env*) {
  g_vfs.ensureDir("/Save");
  g_vfs.ensureDir("/data0/" + g_projectId + "-Save");
}

void w2c_env_0x5F_asyncjs_0x5FsyncFS(struct w2c_env*, u32 syncFrom) {
  logMsg("[syncFS] syncFrom=%u", syncFrom);
  if (syncFrom == 0) {
    g_vfs.syncWorkingSavesToDisk();
  }
}

u32 w2c_env_0x5F_asyncjs_0x5FtestFileChangedJS(struct w2c_env*, u32 urlPtr, u32 pathPtr) {
  wolf::VfsStat st {};
  if (g_vfs.statPath(normalizeVPath(wasmCStr(pathPtr)), st)) return 0;
  std::string u = urlDecode(wasmCStr(urlPtr));
  while (!u.empty() && (u[0] == '.' || u[0] == '/')) u.erase(0, 1);
  if (g_vfs.statPath(normalizeVPath("/" + u), st)) return 0;
  return 1;
}

u32 w2c_env_emscripten_async_wget2_data(struct w2c_env*, u32 urlP, u32, u32,
                                        u32 arg, u32 freeBuf, u32 onload, u32 onerror, u32) {
  std::string url = urlDecode(wasmCStr(urlP));
  while (!url.empty() && (url[0] == '.' || url[0] == '/')) url.erase(0, 1);
  auto bytes = g_vfs.readFile(normalizeVPath("/" + url));
  if (bytes) {
    u32 sz = static_cast<u32>(bytes->size());
    u32 buf = w2c_woditor_malloc(&g_inst, sz ? sz : 1u);
    if (sz > 0) memcpy(wasmPtr(buf), bytes->data(), sz);
    if (onload) w2c_woditor_dynCall_viiii(&g_inst, onload, 1, arg, buf, sz);
    if (freeBuf && buf) w2c_woditor_free(&g_inst, buf);
  } else {
    logMsg("[wget2] 404: %s", url.c_str());
    if (onerror) w2c_woditor_dynCall_viiii(&g_inst, onerror, 1, arg, 404, 0);
  }
  return 1;
}

void w2c_env_wget2StartJS(struct w2c_env*, u32) {}
void w2c_env_wget2ProgressJS(struct w2c_env*, u32, u32, u32) {}
void w2c_env_wget2ErrorJS(struct w2c_env*, u32 code) { logMsg("[wget2Error] %u", code); }

void w2c_env_getProjectId(struct w2c_env*, u32 ptr, u32 sz) { writeWasmCStr(g_projectId, ptr, sz); }
void w2c_env_getLocationJS(struct w2c_env*, u32 ptr, u32 sz) { writeWasmCStr("http://localhost/index.html", ptr, sz); }
f64 w2c_env_getScreenRateJS(struct w2c_env*) { return 1.0; }

void w2c_env_setGameSizeJS(struct w2c_env*, u32 w, u32 h) {
  logMsg("[woditor] setGameSizeJS(%u, %u)", w, h);
  ensureGameFbo(static_cast<int>(w), static_cast<int>(h));
}

void w2c_env_setWindowTextJS(struct w2c_env*, u32 ptr) {
  std::string title = wasmCStr(ptr);
  if (title.empty()) return;
  g_windowTitle = title;
  if (!g_mainLoopFn) {
    int filled = 0;
    size_t pos = 0;
    while ((pos = title.find("\xE2\x96\xA0", pos)) != std::string::npos) {
      filled++;
      pos += 3;
    }
    if (filled > 0) {
      renderBootLoadingFrame(0.45f + 0.13f * std::min(4, filled), "Initializing WOLF RPG engine\xE2\x80\xA6",
                             "Loading game data (step " + std::to_string(std::min(4, filled)) + "/4)");
    }
  }
}

void w2c_env_passGameMessageJS(struct w2c_env*, u32 ptr) { logMsg("[gameMsg] %s", wasmCStr(ptr).c_str()); }
void w2c_env_playMidiFile(struct w2c_env*, u32, u32, u32, u32) {}
void w2c_env_stopMidiFile(struct w2c_env*) {}
void w2c_env_setVolumeMidiFile(struct w2c_env*, f32) {}

void w2c_env_makeTextInputJS(struct w2c_env*, u32 maxLen) {
  g_textInputMaxLen = std::clamp<u32>(maxLen ? maxLen : 32u, 1u, 256u);
}
void w2c_env_setTextInputJS(struct w2c_env*, u32 bufPtr) { g_textInputValue = wasmCStr(bufPtr); }
void w2c_env_startTextInputJS(struct w2c_env*) {
  releaseAllHeldKeys();
  SwkbdConfig kbd {};
  Result rc = swkbdCreate(&kbd, 0);
  if (R_SUCCEEDED(rc)) {
    swkbdConfigMakePresetDefault(&kbd);
    swkbdConfigSetStringLenMax(&kbd, g_textInputMaxLen);
    if (!g_textInputValue.empty()) swkbdConfigSetInitialText(&kbd, g_textInputValue.c_str());
    swkbdConfigSetHeaderText(&kbd, "Enter Text / Password");
    char outBuf[512] {};
    rc = swkbdShow(&kbd, outBuf, sizeof(outBuf));
    swkbdClose(&kbd);
    if (R_SUCCEEDED(rc)) {
      g_textInputValue = outBuf;
      g_textInputState = 1;
      return;
    }
  }
  g_textInputState = 2;
}
u32 w2c_env_checkTextInputJS(struct w2c_env*) { return g_textInputState; }
void w2c_env_getTextInputJS(struct w2c_env*, u32 bufPtr) {
  writeWasmCStr(g_textInputValue, bufPtr, static_cast<u32>(g_textInputValue.size() + 1));
}
void w2c_env_endTextInputJS(struct w2c_env*) { g_textInputState = 0; }
void w2c_env_setTextInputColorJS(struct w2c_env*, u32) {}
void w2c_env_setTextInputPositionJS(struct w2c_env*, u32, u32) {}

f64 w2c_env_emscripten_get_now(struct w2c_env*) { return nowMs(); }
f64 w2c_env_emscripten_date_now(struct w2c_env*) {
  struct timespec ts {};
  clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<double>(ts.tv_sec) * 1000.0 + static_cast<double>(ts.tv_nsec) / 1e6;
}

u32 w2c_env_emscripten_resize_heap(struct w2c_env*, u32 requestedSize) {
  uint64_t curBytes = g_inst.w2c_memory.size;
  if (requestedSize <= curBytes) return 1;
  uint64_t addPages = (requestedSize - curBytes + 65535ULL) / 65536ULL;
  uint64_t res = wasm_rt_grow_memory(&g_inst.w2c_memory, addPages);
  return (res == UINT32_MAX) ? 0u : 1u;
}

u32 w2c_env_emscripten_asm_const_int(struct w2c_env*, u32 code, u32, u32) {
  if (code == 726512u) return static_cast<u32>(g_gameW);
  if (code == 726688u) svcSleepThread(16666667ULL);
  return 0;
}
f64 w2c_env_emscripten_asm_const_double(struct w2c_env*, u32 code, u32, u32) {
  if (code == 726512u) return static_cast<double>(g_gameW);
  return 0.0;
}

void w2c_env_emscripten_set_main_loop(struct w2c_env*, u32 fn, u32 fps, u32 simInf) {
  logMsg("[loop] emscripten_set_main_loop(fn=%u, fps=%u, inf=%u)", fn, fps, simInf);
  g_mainLoopFn = fn;
  if (simInf) unwindOrJump(JMP_MAIN_LOOP_UNWIND);
}
void w2c_env_emscripten_pause_main_loop(struct w2c_env*) { g_mainLoopPaused = true; }
void w2c_env_emscripten_resume_main_loop(struct w2c_env*) { g_mainLoopPaused = false; }

void w2c_env_emscripten_sleep(struct w2c_env*, u32 ms) {
  if (!appletMainLoop() || g_shouldExit) {
    g_shouldExit = true;
    unwindOrJump(JMP_EXIT);
  }
  do {
    pollSwitchInput();
    if (g_shouldExit || !appletMainLoop()) {
      g_shouldExit = true;
      unwindOrJump(JMP_EXIT);
    }
    if (g_gameFrameDirty || g_quickMenuOpen) {
      presentGameAndOverlay();
    } else if (ms > 0) {
      svcSleepThread(static_cast<uint64_t>(std::min<u32>(ms, 16u)) * 1000000ULL);
    }
  } while (g_quickMenuOpen);
}

u32 w2c_env_emscripten_sample_gamepad_data(struct w2c_env*) { return 0; }
u32 w2c_env_emscripten_get_num_gamepads(struct w2c_env*) { return 0; }
u32 w2c_env_emscripten_get_gamepad_status(struct w2c_env*, u32, u32) { return static_cast<u32>(-7); }
u32 w2c_env_emscripten_set_gamepadconnected_callback_on_thread(struct w2c_env*, u32, u32, u32, u32) { return 0; }
u32 w2c_env_emscripten_set_gamepaddisconnected_callback_on_thread(struct w2c_env*, u32, u32, u32, u32) { return 0; }

u32 w2c_env_emscripten_set_keydown_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_keyDownCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_keyup_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_keyUpCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_mousedown_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_mouseDownCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_mousemove_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_mouseMoveCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_mouseup_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_mouseUpCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_touchstart_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_touchStartCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_touchmove_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_touchMoveCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_touchend_callback_on_thread(struct w2c_env*, u32, u32 ud, u32, u32 cb, u32) {
  if (cb) g_touchEndCbs.push_back({cb, ud});
  return 0;
}
u32 w2c_env_emscripten_set_touchcancel_callback_on_thread(struct w2c_env*, u32, u32, u32, u32, u32) { return 0; }
u32 w2c_env_emscripten_set_wheel_callback_on_thread(struct w2c_env*, u32, u32, u32, u32, u32) { return 0; }

void w2c_env_0x5Fabort_js(struct w2c_env*) {
  logMsg("[abort_js] called");
  g_shouldExit = true;
  unwindOrJump(JMP_EXIT);
}
void w2c_env_0x5Femscripten_runtime_keepalive_clear(struct w2c_env*) {}
void w2c_env_exit(struct w2c_env*, u32 code) {
  logMsg("[exit] game exited with code %u", code);
  g_shouldExit = true;
  unwindOrJump(JMP_EXIT);
}
void w2c_wasi__snapshot__preview1_proc_exit(struct w2c_wasi__snapshot__preview1*, u32 code) {
  logMsg("[proc_exit] %u", code);
  g_shouldExit = true;
  unwindOrJump(JMP_EXIT);
}

static void fillWasmTm(u32 tmPtr, const struct tm& t) {
  writeWasmI32(tmPtr + 0, t.tm_sec);
  writeWasmI32(tmPtr + 4, t.tm_min);
  writeWasmI32(tmPtr + 8, t.tm_hour);
  writeWasmI32(tmPtr + 12, t.tm_mday);
  writeWasmI32(tmPtr + 16, t.tm_mon);
  writeWasmI32(tmPtr + 20, t.tm_year);
  writeWasmI32(tmPtr + 24, t.tm_wday);
  writeWasmI32(tmPtr + 28, t.tm_yday);
  writeWasmI32(tmPtr + 32, t.tm_isdst);
}

u32 w2c_env_0x5Flocaltime_js(struct w2c_env*, u64 tSec, u32 tmPtr) {
  time_t tt = static_cast<time_t>(tSec);
  struct tm out {};
  localtime_r(&tt, &out);
  fillWasmTm(tmPtr, out);
  return 0;
}
u32 w2c_env_0x5Fgmtime_js(struct w2c_env*, u64 tSec, u32 tmPtr) {
  time_t tt = static_cast<time_t>(tSec);
  struct tm out {};
  gmtime_r(&tt, &out);
  fillWasmTm(tmPtr, out);
  return 0;
}
void w2c_env_0x5Ftzset_js(struct w2c_env*, u32 tzP, u32 dlP, u32 stdP, u32 dstP) {
  if (tzP) writeWasmI32(tzP, 0);
  if (dlP) writeWasmI32(dlP, 0);
  if (stdP) writeWasmU32(stdP, staticWasmStr("UTC"));
  if (dstP) writeWasmU32(dstP, staticWasmStr("UTC"));
}
u32 w2c_env_0x5Fsetitimer_js(struct w2c_env*, u32, f64) { return 0; }

// --- WolfVfs-backed POSIX / WASI / mmap Syscalls ---
static void flushOpenFd(OpenFd& f) {
  if (f.writable && f.dirty) {
    g_vfs.writeMemFile(f.normVPath, f.rwBuf.data(), f.rwBuf.size());
    f.dirty = false;
  }
}

u32 w2c_env_0x5Fmmap_js(struct w2c_env*, u32 len, u32, u32, u32 fd,
                        u64 offset, u32 allocatedPtr, u32 addrPtr) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it == g_fds.end() || it->second.isDir) return static_cast<u32>(-8);
  u32 ptr = w2c_woditor_emscripten_builtin_memalign(&g_inst, 65536u, len);
  if (!ptr) return static_cast<u32>(-48);
  memset(wasmPtr(ptr), 0, len);
  const auto& src = it->second.writable ? it->second.rwBuf : *it->second.roBuf;
  if (offset < src.size()) {
    size_t avail = std::min<size_t>(len, src.size() - static_cast<size_t>(offset));
    memcpy(wasmPtr(ptr), src.data() + offset, avail);
  }
  writeWasmI32(allocatedPtr, 1);
  writeWasmU32(addrPtr, ptr);
  return 0;
}

u32 w2c_env_0x5Fmunmap_js(struct w2c_env*, u32 addr, u32 len, u32 prot, u32, u32 fd, u64 offset) {
  if (prot & 2u) {
    auto it = g_fds.find(static_cast<int>(fd));
    if (it != g_fds.end() && !it->second.isDir && it->second.writable) {
      size_t end = static_cast<size_t>(offset) + len;
      if (it->second.rwBuf.size() < end) it->second.rwBuf.resize(end, 0);
      memcpy(it->second.rwBuf.data() + offset, wasmPtr(addr), len);
      it->second.dirty = true;
      flushOpenFd(it->second);
    }
  }
  if (addr) w2c_woditor_free(&g_inst, addr);
  return 0;
}

u32 w2c_env_0x5F_syscall_getcwd(struct w2c_env*, u32 buf, u32 size) {
  if (size == 0) return static_cast<u32>(-28);
  writeWasmCStr(g_cwd, buf, size);
  return buf;
}

u32 w2c_env_0x5F_syscall_chdir(struct w2c_env*, u32 pathP) {
  g_cwd = normalizeVPath(wasmCStr(pathP));
  return 0;
}

u32 w2c_env_0x5F_syscall_openat(struct w2c_env*, u32 dirfd, u32 pathP, u32 flags, u32) {
  std::string vpath = resolveAtVPath(static_cast<s32>(dirfd), pathP);
  const u32 acc = flags & 3u;
  const bool wantWrite = (acc != 0u) || ((flags & 0100u) != 0u) || ((flags & 01000u) != 0u);
  const bool wantDir = (flags & 0200000u) != 0u;

  wolf::VfsStat st {};
  bool exists = g_vfs.statPath(vpath, st);

  if (wantDir || (exists && st.isDir)) {
    if (!exists || !st.isDir) return static_cast<u32>(-44);
    OpenFd ofd {};
    ofd.normVPath = vpath;
    ofd.isDir = true;
    if (!g_vfs.listDirectory(vpath, ofd.dirEntries)) return static_cast<u32>(-44);
    int fd = g_nextFd++;
    g_fds.emplace(fd, std::move(ofd));
    return static_cast<u32>(fd);
  }

  if (!wantWrite) {
    auto bytes = g_vfs.readFile(vpath);
    if (!bytes) {
      // Missing game files are the usual cause of in-game "file not found" errors; log the first few
      static int missLogged = 0;
      std::string lowPath = vpath;
      for (char& c : lowPath) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
      auto endsWith = [&](const char* suf) {
        size_t n = strlen(suf);
        return lowPath.size() >= n && lowPath.compare(lowPath.size() - n, n, suf) == 0;
      };
      // Skip Woditor's normal archive probing
      const bool probe = endsWith(".dxa") || endsWith(".wolf") || endsWith(".wolfx") || endsWith(".resource");
      static std::set<std::string> missSeen;
      if (!probe && missLogged < 48 && missSeen.insert(lowPath).second) {
        missLogged++;
        logMsg("[vfs] open miss: %s%s", vpath.c_str(), missLogged == 48 ? " (further misses not logged)" : "");
      }
      return static_cast<u32>(-44);
    }
    OpenFd ofd {};
    ofd.normVPath = vpath;
    ofd.roBuf = std::move(bytes);
    int fd = g_nextFd++;
    g_fds.emplace(fd, std::move(ofd));
    return static_cast<u32>(fd);
  }

  // Writable file
  if (!exists && !(flags & 0100u)) return static_cast<u32>(-44);
  OpenFd ofd {};
  ofd.normVPath = vpath;
  ofd.writable = true;
  if (exists && !(flags & 01000u)) {
    auto prev = g_vfs.readFile(vpath);
    if (prev) ofd.rwBuf = *prev;
  } else {
    ofd.dirty = true;
  }
  if (flags & 02000u) ofd.pos = static_cast<int64_t>(ofd.rwBuf.size());
  flushOpenFd(ofd);
  int fd = g_nextFd++;
  g_fds.emplace(fd, std::move(ofd));
  return static_cast<u32>(fd);
}

u32 w2c_env_0x5F_syscall_stat64(struct w2c_env*, u32 pathP, u32 bufP) {
  wolf::VfsStat st {};
  if (!g_vfs.statPath(normalizeVPath(wasmCStr(pathP)), st)) return static_cast<u32>(-44);
  writeVfsStatToWasm(bufP, st);
  return 0;
}

u32 w2c_env_0x5F_syscall_lstat64(struct w2c_env* env, u32 pathP, u32 bufP) {
  return w2c_env_0x5F_syscall_stat64(env, pathP, bufP);
}

u32 w2c_env_0x5F_syscall_fstat64(struct w2c_env*, u32 fd, u32 bufP) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it == g_fds.end()) return static_cast<u32>(-8);
  flushOpenFd(it->second);
  wolf::VfsStat st {};
  if (!g_vfs.statPath(it->second.normVPath, st)) {
    if (!it->second.isDir) {
      st.dev = 2;
      st.ino = wolf::fnv1a64(it->second.normVPath);
      st.isDir = false;
      st.size = it->second.writable ? it->second.rwBuf.size() : (it->second.roBuf ? it->second.roBuf->size() : 0);
    } else {
      return static_cast<u32>(-44);
    }
  }
  writeVfsStatToWasm(bufP, st);
  return 0;
}

u32 w2c_env_0x5F_syscall_newfstatat(struct w2c_env*, u32 dirfd, u32 pathP, u32 bufP, u32) {
  wolf::VfsStat st {};
  if (!g_vfs.statPath(resolveAtVPath(static_cast<s32>(dirfd), pathP), st)) return static_cast<u32>(-44);
  writeVfsStatToWasm(bufP, st);
  return 0;
}

u32 w2c_env_0x5F_syscall_getdents64(struct w2c_env*, u32 fd, u32 dirp, u32 count) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it == g_fds.end() || !it->second.isDir) return static_cast<u32>(-8);
  OpenFd& d = it->second;
  size_t startIdx = static_cast<size_t>(d.pos / 280);
  size_t maxItems = count / 280;
  size_t endIdx = std::min(d.dirEntries.size(), startIdx + maxItems);
  u32 pos = 0;
  size_t idx = startIdx;
  for (; idx < endIdx; idx++) {
    const auto& ent = d.dirEntries[idx];
    memset(wasmPtr(dirp + pos), 0, 280);
    writeWasmU64(dirp + pos + 0, ent.ino);
    writeWasmI64(dirp + pos + 8, static_cast<int64_t>(280 * (idx + 1)));
    writeWasmU16(dirp + pos + 16, 280);
    wasmMem()[dirp + pos + 18] = ent.isDir ? 4 : 8;
    writeWasmCStr(ent.name, dirp + pos + 19, 256);
    pos += 280;
  }
  d.pos = static_cast<int64_t>(280 * idx);
  return pos;
}

u32 w2c_env_0x5F_syscall_mkdirat(struct w2c_env*, u32 dirfd, u32 pathP, u32) {
  g_vfs.ensureDir(resolveAtVPath(static_cast<s32>(dirfd), pathP));
  return 0;
}

u32 w2c_env_0x5F_syscall_unlinkat(struct w2c_env*, u32 dirfd, u32 pathP, u32 flags) {
  return g_vfs.removePath(resolveAtVPath(static_cast<s32>(dirfd), pathP), flags == 512u)
      ? 0u
      : static_cast<u32>(-44);
}

u32 w2c_env_0x5F_syscall_rmdir(struct w2c_env*, u32 pathP) {
  return g_vfs.removePath(normalizeVPath(wasmCStr(pathP)), true) ? 0u : static_cast<u32>(-44);
}

u32 w2c_env_0x5F_syscall_renameat(struct w2c_env*, u32 oldfd, u32 oldP, u32 newfd, u32 newP) {
  return g_vfs.renamePath(resolveAtVPath(static_cast<s32>(oldfd), oldP),
                          resolveAtVPath(static_cast<s32>(newfd), newP))
      ? 0u
      : static_cast<u32>(-44);
}

u32 w2c_env_0x5F_syscall_ftruncate64(struct w2c_env*, u32 fd, u64 len) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it == g_fds.end() || it->second.isDir || !it->second.writable) return static_cast<u32>(-8);
  it->second.rwBuf.resize(static_cast<size_t>(len), 0);
  it->second.dirty = true;
  flushOpenFd(it->second);
  return 0;
}

u32 w2c_env_0x5F_syscall_chmod(struct w2c_env*, u32, u32) { return 0; }
u32 w2c_env_0x5F_syscall_fchmod(struct w2c_env*, u32, u32) { return 0; }
u32 w2c_env_0x5F_syscall_fcntl64(struct w2c_env*, u32, u32, u32) { return 0; }
u32 w2c_env_0x5F_syscall_ioctl(struct w2c_env*, u32, u32, u32) { return static_cast<u32>(-59); }
u32 w2c_env_0x5F_syscall_linkat(struct w2c_env*, u32, u32, u32, u32, u32) { return static_cast<u32>(-38); }
u32 w2c_env_0x5F_syscall_symlinkat(struct w2c_env*, u32, u32, u32) { return static_cast<u32>(-38); }
u32 w2c_env_0x5F_syscall_readlinkat(struct w2c_env*, u32, u32, u32, u32) { return static_cast<u32>(-28); }

u32 w2c_wasi__snapshot__preview1_fd_write(struct w2c_wasi__snapshot__preview1*,
                                          u32 fd, u32 iovs, u32 iovsLen, u32 nwrittenP) {
  u32 total = 0;
  auto it = g_fds.find(static_cast<int>(fd));
  std::string consoleLine;
  for (u32 i = 0; i < iovsLen; i++) {
    u32 ptr = readWasmU32(iovs + i * 8);
    u32 len = readWasmU32(iovs + i * 8 + 4);
    if (len == 0) continue;
    if (fd == 1 || fd == 2) {
      consoleLine.append(reinterpret_cast<const char*>(wasmPtr(ptr)), len);
    } else if (it != g_fds.end() && !it->second.isDir && it->second.writable) {
      size_t end = static_cast<size_t>(it->second.pos) + len;
      if (it->second.rwBuf.size() < end) it->second.rwBuf.resize(end, 0);
      memcpy(it->second.rwBuf.data() + it->second.pos, wasmPtr(ptr), len);
      it->second.pos += len;
      it->second.dirty = true;
    }
    total += len;
  }
  if (!consoleLine.empty()) {
    while (!consoleLine.empty() && (consoleLine.back() == '\n' || consoleLine.back() == '\r')) {
      consoleLine.pop_back();
    }
    if (!consoleLine.empty()) logMsg("[woditor] %s", consoleLine.c_str());
  }
  if (it != g_fds.end()) flushOpenFd(it->second);
  writeWasmU32(nwrittenP, total);
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_read(struct w2c_wasi__snapshot__preview1*,
                                         u32 fd, u32 iovs, u32 iovsLen, u32 nreadP) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it == g_fds.end() || it->second.isDir) return 8;
  const auto& src = it->second.writable ? it->second.rwBuf : *it->second.roBuf;
  u32 total = 0;
  for (u32 i = 0; i < iovsLen; i++) {
    u32 ptr = readWasmU32(iovs + i * 8);
    u32 len = readWasmU32(iovs + i * 8 + 4);
    if (len == 0) continue;
    size_t pos = static_cast<size_t>(std::max<int64_t>(0, it->second.pos));
    size_t avail = (pos < src.size()) ? std::min<size_t>(len, src.size() - pos) : 0;
    if (avail > 0) memcpy(wasmPtr(ptr), src.data() + pos, avail);
    it->second.pos = static_cast<int64_t>(pos + avail);
    total += static_cast<u32>(avail);
    if (avail < len) break;
  }
  writeWasmU32(nreadP, total);
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_seek(struct w2c_wasi__snapshot__preview1*,
                                         u32 fd, u64 offset, u32 whence, u32 newOffP) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it == g_fds.end()) return 8;
  int64_t delta = static_cast<int64_t>(offset);
  if (it->second.isDir) {
    if (whence == 0) it->second.pos = delta;
    else if (whence == 1) it->second.pos += delta;
    writeWasmU64(newOffP, static_cast<uint64_t>(std::max<int64_t>(0, it->second.pos)));
    return 0;
  }
  const size_t fsz = it->second.writable ? it->second.rwBuf.size() : it->second.roBuf->size();
  if (whence == 0) it->second.pos = delta;
  else if (whence == 1) it->second.pos += delta;
  else if (whence == 2) it->second.pos = static_cast<int64_t>(fsz) + delta;
  writeWasmU64(newOffP, static_cast<uint64_t>(std::max<int64_t>(0, it->second.pos)));
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_close(struct w2c_wasi__snapshot__preview1*, u32 fd) {
  auto it = g_fds.find(static_cast<int>(fd));
  if (it != g_fds.end()) {
    flushOpenFd(it->second);
    g_fds.erase(it);
  }
  return 0;
}

u32 w2c_wasi__snapshot__preview1_fd_fdstat_get(struct w2c_wasi__snapshot__preview1*, u32 fd, u32 statP) {
  memset(wasmPtr(statP), 0, 24);
  auto it = g_fds.find(static_cast<int>(fd));
  wasmMem()[statP] = (fd <= 2) ? 2 : ((it != g_fds.end() && it->second.isDir) ? 3 : 4);
  return 0;
}

// Mirror Emscripten's getEnvStrings() defaults exactly: BrowserWoditor's startup code walks the
// environment, and an empty environ makes it take a different (heap-corrupting) path than in a browser.
static const std::vector<std::string>& emscriptenEnvStrings() {
  static const std::vector<std::string> env = {
      "USER=web_user", "LOGNAME=web_user", "PATH=/", "PWD=/", "HOME=/home/web_user",
      "LANG=" WOLF_ENV_LANG, "_=./this.program",
  };
  return env;
}
u32 w2c_wasi__snapshot__preview1_environ_sizes_get(struct w2c_wasi__snapshot__preview1*, u32 cntP, u32 szP) {
  u32 total = 0;
  for (const auto& s : emscriptenEnvStrings()) total += static_cast<u32>(s.size() + 1);
  writeWasmU32(cntP, static_cast<u32>(emscriptenEnvStrings().size()));
  writeWasmU32(szP, total);
  return 0;
}
u32 w2c_wasi__snapshot__preview1_environ_get(struct w2c_wasi__snapshot__preview1*, u32 environP, u32 bufP) {
  u32 off = 0, idx = 0;
  for (const auto& s : emscriptenEnvStrings()) {
    writeWasmU32(environP + idx * 4, bufP + off);
    memcpy(wasmPtr(bufP + off), s.c_str(), s.size() + 1);
    off += static_cast<u32>(s.size() + 1);
    idx++;
  }
  return 0;
}

u32 w2c_wasi__snapshot__preview1_clock_time_get(struct w2c_wasi__snapshot__preview1*,
                                                u32 clockId, u64, u32 outP) {
  if (clockId == 0) {
    struct timespec ts {};
    clock_gettime(CLOCK_REALTIME, &ts);
    writeWasmU64(outP, static_cast<uint64_t>(ts.tv_sec) * 1000000000ULL + static_cast<uint64_t>(ts.tv_nsec));
  } else {
    writeWasmU64(outP, armTicksToNs(armGetSystemTick() - g_bootTicks));
  }
  return 0;
}

// --- OpenAL & ALC Bindings ---
u32 w2c_env_alcOpenDevice(struct w2c_env*, u32) {
  if (!g_alDev) initOpenAlHost();
  return g_alDev ? 1u : 0u;
}
u32 w2c_env_alcCreateContext(struct w2c_env*, u32, u32) { return g_alCtx ? 1u : 0u; }
u32 w2c_env_alcMakeContextCurrent(struct w2c_env*, u32) { return g_alCtx ? 1u : 0u; }
void w2c_env_alcDestroyContext(struct w2c_env*, u32) {}
u32 w2c_env_alcCloseDevice(struct w2c_env*, u32) { return 1u; }
u32 w2c_env_alcGetString(struct w2c_env*, u32, u32 param) {
  const ALCchar* s = g_alDev ? alcGetString(g_alDev, static_cast<ALCenum>(param)) : "OpenAL Soft";
  return staticWasmStr(s ? s : "OpenAL Soft");
}
u32 w2c_env_alGetError(struct w2c_env*) { return g_alCtx ? static_cast<u32>(alGetError()) : 0u; }
void w2c_env_alGenBuffers(struct w2c_env*, u32 n, u32 ptr) {
  if (g_alCtx) alGenBuffers(static_cast<ALsizei>(n), reinterpret_cast<ALuint*>(wasmPtr(ptr)));
}
void w2c_env_alDeleteBuffers(struct w2c_env*, u32 n, u32 ptr) {
  if (g_alCtx) alDeleteBuffers(static_cast<ALsizei>(n), reinterpret_cast<const ALuint*>(wasmPtr(ptr)));
}
void w2c_env_alGenSources(struct w2c_env*, u32 n, u32 ptr) {
  if (g_alCtx) alGenSources(static_cast<ALsizei>(n), reinterpret_cast<ALuint*>(wasmPtr(ptr)));
}
void w2c_env_alDeleteSources(struct w2c_env*, u32 n, u32 ptr) {
  if (g_alCtx) alDeleteSources(static_cast<ALsizei>(n), reinterpret_cast<const ALuint*>(wasmPtr(ptr)));
}
void w2c_env_alBufferData(struct w2c_env*, u32 buf, u32 fmt, u32 dataP, u32 sz, u32 freq) {
  if (g_alCtx) {
    alBufferData(buf, static_cast<ALenum>(fmt), dataP ? wasmPtr(dataP) : nullptr,
                 static_cast<ALsizei>(sz), static_cast<ALsizei>(freq));
  }
}
void w2c_env_alSourcePlay(struct w2c_env*, u32 src) { if (g_alCtx) alSourcePlay(src); }
void w2c_env_alSourceStop(struct w2c_env*, u32 src) { if (g_alCtx) alSourceStop(src); }
void w2c_env_alSourceQueueBuffers(struct w2c_env*, u32 src, u32 n, u32 ptr) {
  if (g_alCtx) alSourceQueueBuffers(src, static_cast<ALsizei>(n), reinterpret_cast<const ALuint*>(wasmPtr(ptr)));
}
void w2c_env_alSourceUnqueueBuffers(struct w2c_env*, u32 src, u32 n, u32 ptr) {
  if (g_alCtx) alSourceUnqueueBuffers(src, static_cast<ALsizei>(n), reinterpret_cast<ALuint*>(wasmPtr(ptr)));
}
void w2c_env_alSourcef(struct w2c_env*, u32 src, u32 p, f32 v) {
  if (g_alCtx) alSourcef(src, static_cast<ALenum>(p), v);
}
void w2c_env_alSourcefv(struct w2c_env*, u32 src, u32 p, u32 ptr) {
  if (g_alCtx) alSourcefv(src, static_cast<ALenum>(p), reinterpret_cast<const ALfloat*>(wasmPtr(ptr)));
}
void w2c_env_alSourcei(struct w2c_env*, u32 src, u32 p, u32 v) {
  if (g_alCtx) alSourcei(src, static_cast<ALenum>(p), static_cast<ALint>(v));
}
void w2c_env_alGetSourcei(struct w2c_env*, u32 src, u32 p, u32 outP) {
  ALint val = 0;
  if (g_alCtx) alGetSourcei(src, static_cast<ALenum>(p), &val);
  writeWasmI32(outP, val);
}

// --- WebGL / EGL / OpenGL ES Bindings ---
u32 w2c_env_emscripten_webgl_create_context(struct w2c_env*, u32, u32) { return 1u; }
u32 w2c_env_emscripten_webgl_make_context_current(struct w2c_env*, u32) { return 0u; }
u32 w2c_env_eglMakeCurrent(struct w2c_env*, u32, u32, u32, u32) { return 1u; }
u32 w2c_env_eglDestroyContext(struct w2c_env*, u32, u32) { return 1u; }
u32 w2c_env_eglDestroySurface(struct w2c_env*, u32, u32) { return 1u; }
u32 w2c_env_eglTerminate(struct w2c_env*, u32) { return 1u; }
u32 w2c_env_eglQuerySurface(struct w2c_env*, u32, u32, u32 attr, u32 outP) {
  writeWasmI32(outP, (attr == 0x3057u) ? g_gameW : g_gameH);
  return 1u;
}

void w2c_env_glActiveTexture(struct w2c_env*, u32 t) { glActiveTexture(t); }
void w2c_env_glAttachShader(struct w2c_env*, u32 p, u32 s) { glAttachShader(p, s); }
void w2c_env_glBindBuffer(struct w2c_env*, u32 target, u32 buf) {
  if (target == GL_ARRAY_BUFFER) g_wasmArrayBuf = buf;
  else if (target == GL_ELEMENT_ARRAY_BUFFER) g_wasmElemBuf = buf;
  glBindBuffer(target, buf);
}
void w2c_env_glBindFramebuffer(struct w2c_env*, u32 target, u32 fbo) {
  g_wasmFbo = fbo;
  glBindFramebuffer(target, fbo == 0 ? g_gameFbo : fbo);
}
void w2c_env_glBindRenderbuffer(struct w2c_env*, u32 target, u32 rbo) { glBindRenderbuffer(target, rbo); }
void w2c_env_glBindTexture(struct w2c_env*, u32 target, u32 tex) { glBindTexture(target, tex); }
void w2c_env_glBlendEquationSeparate(struct w2c_env*, u32 mRGB, u32 mA) { glBlendEquationSeparate(mRGB, mA); }
void w2c_env_glBlendFuncSeparate(struct w2c_env*, u32 sRGB, u32 dRGB, u32 sA, u32 dA) {
  glBlendFuncSeparate(sRGB, dRGB, sA, dA);
}
u32 w2c_env_glCheckFramebufferStatus(struct w2c_env*, u32 target) { return glCheckFramebufferStatus(target); }
void w2c_env_glClear(struct w2c_env*, u32 mask) {
  if (g_wasmFbo == 0) g_gameFrameDirty = true;
  glClear(mask);
}
void w2c_env_glClearColor(struct w2c_env*, f32 r, f32 g, f32 b, f32 a) { glClearColor(r, g, b, a); }
void w2c_env_glCompileShader(struct w2c_env*, u32 s) { glCompileShader(s); }
void w2c_env_glCompressedTexImage2D(struct w2c_env*, u32 target, u32 level, u32 ifmt,
                                    u32 w, u32 h, u32 border, u32 sz, u32 dataP) {
  glCompressedTexImage2D(target, static_cast<GLint>(level), ifmt, static_cast<GLsizei>(w),
                         static_cast<GLsizei>(h), static_cast<GLint>(border),
                         static_cast<GLsizei>(sz), dataP ? wasmPtr(dataP) : nullptr);
}
u32 w2c_env_glCreateProgram(struct w2c_env*) { return glCreateProgram(); }
u32 w2c_env_glCreateShader(struct w2c_env*, u32 type) { return glCreateShader(type); }
void w2c_env_glCullFace(struct w2c_env*, u32 mode) { glCullFace(mode); }
void w2c_env_glDeleteBuffers(struct w2c_env*, u32 n, u32 ptr) {
  glDeleteBuffers(static_cast<GLsizei>(n), reinterpret_cast<const GLuint*>(wasmPtr(ptr)));
}
void w2c_env_glDeleteFramebuffers(struct w2c_env*, u32 n, u32 ptr) {
  glDeleteFramebuffers(static_cast<GLsizei>(n), reinterpret_cast<const GLuint*>(wasmPtr(ptr)));
}
void w2c_env_glDeleteProgram(struct w2c_env*, u32 p) { glDeleteProgram(p); }
void w2c_env_glDeleteRenderbuffers(struct w2c_env*, u32 n, u32 ptr) {
  glDeleteRenderbuffers(static_cast<GLsizei>(n), reinterpret_cast<const GLuint*>(wasmPtr(ptr)));
}
void w2c_env_glDeleteShader(struct w2c_env*, u32 s) { glDeleteShader(s); }
void w2c_env_glDeleteTextures(struct w2c_env*, u32 n, u32 ptr) {
  glDeleteTextures(static_cast<GLsizei>(n), reinterpret_cast<const GLuint*>(wasmPtr(ptr)));
}
void w2c_env_glDepthFunc(struct w2c_env*, u32 fn) { glDepthFunc(fn); }
void w2c_env_glDepthMask(struct w2c_env*, u32 flag) { glDepthMask(flag ? GL_TRUE : GL_FALSE); }
void w2c_env_glDisable(struct w2c_env*, u32 cap) { glDisable(cap); }
void w2c_env_glDisableVertexAttribArray(struct w2c_env*, u32 idx) { glDisableVertexAttribArray(idx); }
void w2c_env_glDrawArrays(struct w2c_env*, u32 mode, u32 first, u32 count) {
  if (g_wasmFbo == 0) g_gameFrameDirty = true;
  glDrawArrays(mode, static_cast<GLint>(first), static_cast<GLsizei>(count));
}
void w2c_env_glDrawElements(struct w2c_env*, u32 mode, u32 count, u32 type, u32 indicesP) {
  if (g_wasmFbo == 0) g_gameFrameDirty = true;
  const void* ptr = g_wasmElemBuf
      ? reinterpret_cast<const void*>(static_cast<uintptr_t>(indicesP))
      : reinterpret_cast<const void*>(wasmPtr(indicesP));
  glDrawElements(mode, static_cast<GLsizei>(count), type, ptr);
}
void w2c_env_glEnable(struct w2c_env*, u32 cap) { glEnable(cap); }
void w2c_env_glEnableVertexAttribArray(struct w2c_env*, u32 idx) { glEnableVertexAttribArray(idx); }
void w2c_env_glFramebufferRenderbuffer(struct w2c_env*, u32 t, u32 att, u32 rt, u32 rbo) {
  glFramebufferRenderbuffer(t, att, rt, rbo);
}
void w2c_env_glFramebufferTexture2D(struct w2c_env*, u32 t, u32 att, u32 tt, u32 tex, u32 lvl) {
  glFramebufferTexture2D(t, att, tt, tex, static_cast<GLint>(lvl));
}
void w2c_env_glFrontFace(struct w2c_env*, u32 mode) { glFrontFace(mode); }
void w2c_env_glGenFramebuffers(struct w2c_env*, u32 n, u32 ptr) {
  glGenFramebuffers(static_cast<GLsizei>(n), reinterpret_cast<GLuint*>(wasmPtr(ptr)));
}
void w2c_env_glGenRenderbuffers(struct w2c_env*, u32 n, u32 ptr) {
  glGenRenderbuffers(static_cast<GLsizei>(n), reinterpret_cast<GLuint*>(wasmPtr(ptr)));
}
void w2c_env_glGenTextures(struct w2c_env*, u32 n, u32 ptr) {
  glGenTextures(static_cast<GLsizei>(n), reinterpret_cast<GLuint*>(wasmPtr(ptr)));
}
u32 w2c_env_glGetAttribLocation(struct w2c_env*, u32 prog, u32 nameP) {
  return static_cast<u32>(glGetAttribLocation(prog, reinterpret_cast<const GLchar*>(wasmPtr(nameP))));
}
void w2c_env_glGetIntegerv(struct w2c_env*, u32 pname, u32 outP) {
  if (pname == GL_FRAMEBUFFER_BINDING) {
    writeWasmI32(outP, static_cast<int32_t>(g_wasmFbo));
    return;
  }
  glGetIntegerv(pname, reinterpret_cast<GLint*>(wasmPtr(outP)));
}
void w2c_env_glGetShaderInfoLog(struct w2c_env*, u32 s, u32 maxLen, u32 lenP, u32 logP) {
  glGetShaderInfoLog(s, static_cast<GLsizei>(maxLen),
                     lenP ? reinterpret_cast<GLsizei*>(wasmPtr(lenP)) : nullptr,
                     reinterpret_cast<GLchar*>(wasmPtr(logP)));
}
void w2c_env_glGetShaderiv(struct w2c_env*, u32 s, u32 pname, u32 outP) {
  glGetShaderiv(s, pname, reinterpret_cast<GLint*>(wasmPtr(outP)));
}
u32 w2c_env_glGetString(struct w2c_env*, u32 name) {
  const char* s = reinterpret_cast<const char*>(glGetString(name));
  return staticWasmStr(s ? s : "");
}
u32 w2c_env_glGetUniformLocation(struct w2c_env*, u32 prog, u32 nameP) {
  return static_cast<u32>(glGetUniformLocation(prog, reinterpret_cast<const GLchar*>(wasmPtr(nameP))));
}
void w2c_env_glLinkProgram(struct w2c_env*, u32 p) { glLinkProgram(p); }
void w2c_env_glPixelStorei(struct w2c_env*, u32 pname, u32 param) {
  glPixelStorei(pname, static_cast<GLint>(param));
}
void w2c_env_glReadPixels(struct w2c_env*, u32 x, u32 y, u32 w, u32 h, u32 fmt, u32 type, u32 pixP) {
  glReadPixels(static_cast<GLint>(x), static_cast<GLint>(y), static_cast<GLsizei>(w),
               static_cast<GLsizei>(h), fmt, type, pixP ? wasmPtr(pixP) : nullptr);
}
void w2c_env_glRenderbufferStorage(struct w2c_env*, u32 t, u32 ifmt, u32 w, u32 h) {
  if (ifmt == 0x84F9u) ifmt = GL_DEPTH24_STENCIL8;
  glRenderbufferStorage(t, ifmt, static_cast<GLsizei>(w), static_cast<GLsizei>(h));
}
void w2c_env_glShaderSource(struct w2c_env*, u32 s, u32 count, u32 strPtrArray, u32 lenArray) {
  std::vector<const GLchar*> ptrs(count);
  for (u32 i = 0; i < count; i++) {
    ptrs[i] = reinterpret_cast<const GLchar*>(wasmPtr(readWasmU32(strPtrArray + i * 4)));
  }
  const GLint* lens = lenArray ? reinterpret_cast<const GLint*>(wasmPtr(lenArray)) : nullptr;
  glShaderSource(s, static_cast<GLsizei>(count), ptrs.data(), lens);
}
void w2c_env_glTexImage2D(struct w2c_env*, u32 target, u32 lvl, u32 ifmt, u32 w, u32 h,
                          u32 border, u32 fmt, u32 type, u32 pixP) {
  glTexImage2D(target, static_cast<GLint>(lvl), static_cast<GLint>(ifmt),
               static_cast<GLsizei>(w), static_cast<GLsizei>(h), static_cast<GLint>(border),
               fmt, type, pixP ? wasmPtr(pixP) : nullptr);
}
void w2c_env_glTexParameteri(struct w2c_env*, u32 t, u32 p, u32 v) { glTexParameteri(t, p, static_cast<GLint>(v)); }
void w2c_env_glTexSubImage2D(struct w2c_env*, u32 target, u32 lvl, u32 xo, u32 yo,
                             u32 w, u32 h, u32 fmt, u32 type, u32 pixP) {
  glTexSubImage2D(target, static_cast<GLint>(lvl), static_cast<GLint>(xo), static_cast<GLint>(yo),
                  static_cast<GLsizei>(w), static_cast<GLsizei>(h), fmt, type,
                  pixP ? wasmPtr(pixP) : nullptr);
}
void w2c_env_glUniform1f(struct w2c_env*, u32 loc, f32 v0) { glUniform1f(static_cast<GLint>(loc), v0); }
void w2c_env_glUniform1i(struct w2c_env*, u32 loc, u32 v0) { glUniform1i(static_cast<GLint>(loc), static_cast<GLint>(v0)); }
void w2c_env_glUniform2fv(struct w2c_env*, u32 loc, u32 cnt, u32 ptr) {
  glUniform2fv(static_cast<GLint>(loc), static_cast<GLsizei>(cnt), reinterpret_cast<const GLfloat*>(wasmPtr(ptr)));
}
void w2c_env_glUniform3fv(struct w2c_env*, u32 loc, u32 cnt, u32 ptr) {
  glUniform3fv(static_cast<GLint>(loc), static_cast<GLsizei>(cnt), reinterpret_cast<const GLfloat*>(wasmPtr(ptr)));
}
void w2c_env_glUniform4f(struct w2c_env*, u32 loc, f32 x, f32 y, f32 z, f32 w) {
  glUniform4f(static_cast<GLint>(loc), x, y, z, w);
}
void w2c_env_glUniform4fv(struct w2c_env*, u32 loc, u32 cnt, u32 ptr) {
  glUniform4fv(static_cast<GLint>(loc), static_cast<GLsizei>(cnt), reinterpret_cast<const GLfloat*>(wasmPtr(ptr)));
}
void w2c_env_glUseProgram(struct w2c_env*, u32 p) { glUseProgram(p); }
void w2c_env_glVertexAttribPointer(struct w2c_env*, u32 idx, u32 sz, u32 type, u32 norm, u32 stride, u32 ptr) {
  const void* hostPtr = g_wasmArrayBuf
      ? reinterpret_cast<const void*>(static_cast<uintptr_t>(ptr))
      : reinterpret_cast<const void*>(wasmPtr(ptr));
  glVertexAttribPointer(idx, static_cast<GLint>(sz), type, norm ? GL_TRUE : GL_FALSE,
                        static_cast<GLsizei>(stride), hostPtr);
}
void w2c_env_glViewport(struct w2c_env*, u32 x, u32 y, u32 w, u32 h) {
  glViewport(static_cast<GLint>(x), static_cast<GLint>(y), static_cast<GLsizei>(w), static_cast<GLsizei>(h));
}

// --- Emscripten C++ Exception & SjLj Runtime ---
static void excInitHeader(u32 excPtr, u32 type, u32 destructor) {
  u32 p = excPtr - 24;
  writeWasmU32(p + 16, 0);
  writeWasmU32(p + 4, type);
  writeWasmU32(p + 8, destructor);
  wasmMem()[p + 12] = 0;
  wasmMem()[p + 13] = 0;
}

static u32 findMatchingCatchImpl(const u32* types, size_t n) {
  u32 thrown = g_excLast;
  if (!thrown) { w2c_woditor_0x5Femscripten_tempret_set(&g_inst, 0); return 0; }
  u32 p = thrown - 24;
  writeWasmU32(p + 16, thrown);
  u32 thrownType = readWasmU32(p + 4);
  if (!thrownType) { w2c_woditor_0x5Femscripten_tempret_set(&g_inst, 0); return thrown; }
  for (size_t i = 0; i < n; i++) {
    u32 ct = types[i];
    if (ct == 0 || ct == thrownType ||
        w2c_woditor_0x5F_cxa_can_catch(&g_inst, ct, thrownType, p + 16) != 0) {
      w2c_woditor_0x5Femscripten_tempret_set(&g_inst, ct);
      return thrown;
    }
  }
  w2c_woditor_0x5Femscripten_tempret_set(&g_inst, thrownType);
  return thrown;
}

u32 w2c_env_llvm_eh_typeid_for(struct w2c_env*, u32 t) { return t; }

void w2c_env_0x5F_cxa_throw(struct w2c_env*, u32 ptr, u32 type, u32 destructor) {
  std::string rttiName = type ? wasmCStr(readWasmU32(type + 4)) : "(null)";
  logMsg("[__cxa_throw] ptr=%u type=%s jmpDepth=%d", ptr, rttiName.c_str(), g_jmpDepth);
  excInitHeader(ptr, type, destructor);
  w2c_woditor_0x5F_cxa_increment_exception_refcount(&g_inst, ptr);
  g_excLast = ptr;
  g_uncaughtExcCount++;
  unwindOrJump(JMP_CXA);
}

void w2c_env_0x5F_cxa_rethrow(struct w2c_env*) {
  if (g_excCaught.empty()) unwindOrJump(JMP_EXIT);
  u32 ptr = g_excCaught.back();
  u32 p = ptr - 24;
  wasmMem()[p + 13] = 1;
  wasmMem()[p + 12] = 0;
  g_uncaughtExcCount++;
  w2c_woditor_0x5F_cxa_increment_exception_refcount(&g_inst, ptr);
  g_excLast = ptr;
  unwindOrJump(JMP_CXA);
}

void w2c_env_0x5F_resumeException(struct w2c_env*, u32 ptr) {
  if (!g_excLast) g_excLast = ptr;
  unwindOrJump(JMP_CXA);
}

u32 w2c_env_0x5F_cxa_find_matching_catch_2(struct w2c_env*) { return findMatchingCatchImpl(nullptr, 0); }
u32 w2c_env_0x5F_cxa_find_matching_catch_3(struct w2c_env*, u32 a0) { return findMatchingCatchImpl(&a0, 1); }
u32 w2c_env_0x5F_cxa_find_matching_catch_4(struct w2c_env*, u32 a0, u32 a1) {
  u32 arr[2] = {a0, a1};
  return findMatchingCatchImpl(arr, 2);
}

u32 w2c_env_0x5F_cxa_begin_catch(struct w2c_env*, u32 ptr) {
  u32 p = ptr - 24;
  if (!wasmMem()[p + 12]) {
    wasmMem()[p + 12] = 1;
    if (g_uncaughtExcCount > 0) g_uncaughtExcCount--;
  }
  wasmMem()[p + 13] = 0;
  g_excCaught.push_back(ptr);
  return w2c_woditor_0x5F_cxa_get_exception_ptr(&g_inst, ptr);
}

void w2c_env_0x5F_cxa_end_catch(struct w2c_env*) {
  w2c_woditor_setThrew(&g_inst, 0, 0);
  if (!g_excCaught.empty()) {
    u32 ptr = g_excCaught.back();
    g_excCaught.pop_back();
    if (ptr) w2c_woditor_0x5F_cxa_decrement_exception_refcount(&g_inst, ptr);
  }
  g_excLast = 0;
}

u32 w2c_env_0x5F_cxa_uncaught_exceptions(struct w2c_env*) { return g_uncaughtExcCount; }
void w2c_env_0x5Femscripten_throw_longjmp(struct w2c_env*) { unwindOrJump(JMP_LONGJMP); }

#define WOLF_UNPACK(...) __VA_ARGS__

#define WOLF_INVOKE_VOID(NAME, PARAMS, ARGS)                                 \
  void w2c_env_invoke_##NAME(struct w2c_env*, u32 idx WOLF_UNPACK PARAMS) {  \
    volatile u32 sp = w2c_woditor_emscripten_stack_get_current(&g_inst);     \
    if (g_jmpDepth >= MAX_JMP_DEPTH) abort();                                \
    int j = setjmp(g_jmpStack[g_jmpDepth++]);                                \
    if (j == 0) {                                                            \
      w2c_woditor_dynCall_##NAME(&g_inst, idx WOLF_UNPACK ARGS);             \
      g_jmpDepth--;                                                          \
    } else {                                                                 \
      w2c_woditor_0x5Femscripten_stack_restore(&g_inst, sp);                 \
      w2c_woditor_setThrew(&g_inst, 1, 0);                                   \
    }                                                                        \
  }

#define WOLF_INVOKE_RET(RTYPE, ZERO, NAME, PARAMS, ARGS)                     \
  RTYPE w2c_env_invoke_##NAME(struct w2c_env*, u32 idx WOLF_UNPACK PARAMS) { \
    volatile u32 sp = w2c_woditor_emscripten_stack_get_current(&g_inst);     \
    if (g_jmpDepth >= MAX_JMP_DEPTH) abort();                                \
    int j = setjmp(g_jmpStack[g_jmpDepth++]);                                \
    if (j == 0) {                                                            \
      RTYPE r = w2c_woditor_dynCall_##NAME(&g_inst, idx WOLF_UNPACK ARGS);   \
      g_jmpDepth--;                                                          \
      return r;                                                              \
    } else {                                                                 \
      w2c_woditor_0x5Femscripten_stack_restore(&g_inst, sp);                 \
      w2c_woditor_setThrew(&g_inst, 1, 0);                                   \
      return ZERO;                                                           \
    }                                                                        \
  }

WOLF_INVOKE_RET(u32, 0u, i, (), ())
WOLF_INVOKE_RET(u32, 0u, iffddiiii, (, f32 a, f32 b, f64 c, f64 d, u32 e, u32 f, u32 g, u32 h), (, a, b, c, d, e, f, g, h))
WOLF_INVOKE_RET(u32, 0u, iffffffffii, (, f32 a, f32 b, f32 c, f32 d, f32 e, f32 f, f32 g, f32 h, u32 i, u32 k), (, a, b, c, d, e, f, g, h, i, k))
WOLF_INVOKE_RET(u32, 0u, ii, (, u32 a), (, a))
WOLF_INVOKE_RET(u32, 0u, iii, (, u32 a, u32 b), (, a, b))
WOLF_INVOKE_RET(u32, 0u, iiidddiiii, (, u32 a, u32 b, f64 c, f64 d, f64 e, u32 f, u32 g, u32 h, u32 i), (, a, b, c, d, e, f, g, h, i))
WOLF_INVOKE_RET(u32, 0u, iiii, (, u32 a, u32 b, u32 c), (, a, b, c))
WOLF_INVOKE_RET(u32, 0u, iiiii, (, u32 a, u32 b, u32 c, u32 d), (, a, b, c, d))
WOLF_INVOKE_RET(u32, 0u, iiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e), (, a, b, c, d, e))
WOLF_INVOKE_RET(u32, 0u, iiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f), (, a, b, c, d, e, f))
WOLF_INVOKE_RET(u32, 0u, iiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g), (, a, b, c, d, e, f, g))
WOLF_INVOKE_RET(u32, 0u, iiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h), (, a, b, c, d, e, f, g, h))
WOLF_INVOKE_RET(u32, 0u, iiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i), (, a, b, c, d, e, f, g, h, i))
WOLF_INVOKE_RET(u32, 0u, iiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l), (, a, b, c, d, e, f, g, h, i, k, l))
WOLF_INVOKE_RET(u32, 0u, iiiiij, (, u32 a, u32 b, u32 c, u32 d, u64 e), (, a, b, c, d, e))
WOLF_INVOKE_RET(u32, 0u, iiiij, (, u32 a, u32 b, u32 c, u64 d), (, a, b, c, d))
WOLF_INVOKE_RET(u32, 0u, iiij, (, u32 a, u32 b, u64 c), (, a, b, c))
WOLF_INVOKE_RET(u32, 0u, iiijiiii, (, u32 a, u32 b, u64 c, u32 d, u32 e, u32 f, u32 g), (, a, b, c, d, e, f, g))
WOLF_INVOKE_RET(u32, 0u, iij, (, u32 a, u64 b), (, a, b))
WOLF_INVOKE_RET(u32, 0u, iiji, (, u32 a, u64 b, u32 c), (, a, b, c))
WOLF_INVOKE_RET(u64, 0ULL, ji, (, u32 a), (, a))

WOLF_INVOKE_VOID(v, (), ())
WOLF_INVOKE_VOID(vd, (, f64 a), (, a))
WOLF_INVOKE_VOID(vi, (, u32 a), (, a))
WOLF_INVOKE_VOID(vii, (, u32 a, u32 b), (, a, b))
WOLF_INVOKE_VOID(viiddd, (, u32 a, u32 b, f64 c, f64 d, f64 e), (, a, b, c, d, e))
WOLF_INVOKE_VOID(viii, (, u32 a, u32 b, u32 c), (, a, b, c))
WOLF_INVOKE_VOID(viiidd, (, u32 a, u32 b, u32 c, f64 d, f64 e), (, a, b, c, d, e))
WOLF_INVOKE_VOID(viiii, (, u32 a, u32 b, u32 c, u32 d), (, a, b, c, d))
WOLF_INVOKE_VOID(viiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e), (, a, b, c, d, e))
WOLF_INVOKE_VOID(viiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f), (, a, b, c, d, e, f))
WOLF_INVOKE_VOID(viiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g), (, a, b, c, d, e, f, g))
WOLF_INVOKE_VOID(viiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h), (, a, b, c, d, e, f, g, h))
WOLF_INVOKE_VOID(viiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i), (, a, b, c, d, e, f, g, h, i))
WOLF_INVOKE_VOID(viiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k), (, a, b, c, d, e, f, g, h, i, k))
WOLF_INVOKE_VOID(viiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l), (, a, b, c, d, e, f, g, h, i, k, l))
WOLF_INVOKE_VOID(viiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n), (, a, b, c, d, e, f, g, h, i, k, l, m, n))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p, u32 q), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p, q))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p, u32 q, u32 r, u32 s), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p, q, r, s))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p, u32 q, u32 r, u32 s, u32 t), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p, q, r, s, t))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p, u32 q, u32 r, u32 s, u32 t, u32 u, u32 v), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p, q, r, s, t, u, v))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p, u32 q, u32 r, u32 s, u32 t, u32 u, u32 v, u32 w, u32 x, u32 y), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y))
WOLF_INVOKE_VOID(viiiiiiiiiiiiiiiiiiiiiiiiii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u32 f, u32 g, u32 h, u32 i, u32 k, u32 l, u32 m, u32 n, u32 o, u32 p, u32 q, u32 r, u32 s, u32 t, u32 u, u32 v, u32 w, u32 x, u32 y, u32 z, u32 z2), (, a, b, c, d, e, f, g, h, i, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, z2))
WOLF_INVOKE_VOID(viiiiijjii, (, u32 a, u32 b, u32 c, u32 d, u32 e, u64 f, u64 g, u32 h, u32 i), (, a, b, c, d, e, f, g, h, i))
WOLF_INVOKE_VOID(viiij, (, u32 a, u32 b, u32 c, u64 d), (, a, b, c, d))
WOLF_INVOKE_VOID(vijj, (, u32 a, u64 b, u64 c), (, a, b, c))
WOLF_INVOKE_VOID(vji, (, u64 a, u32 b), (, a, b))

} // extern "C"

// ============================================================================
// Switch 2 Entrypoint
// ============================================================================
int main(int argc, char* argv[]) {
  g_bootTicks = armGetSystemTick();

  g_selfNro = (argc > 0 && argv[0] && argv[0][0])
      ? normalizeSdmcPath(argv[0])
      : "sdmc:/switch/SW2RPGMGL/engines/wolf-engine-switch2.nro";

  std::string selfDir = dirNameOf(g_selfNro);
  if (selfDir.size() > 8 && toLower(selfDir.substr(selfDir.size() - 8)) == "/engines") {
    g_launcherDir = dirNameOf(selfDir);
  } else {
    g_launcherDir = selfDir;
  }

  if (argc > 1 && argv[1] && argv[1][0]) {
    g_gameDir = normalizeSdmcPath(argv[1]);
  } else {
    g_gameDir = g_launcherDir;
  }
  if (argc > 2 && argv[2] && argv[2][0]) {
    g_returnNro = normalizeSdmcPath(argv[2]);
  } else {
    std::string cand = g_launcherDir + "/SW2RPGMGL.nro";
    struct stat st {};
    if (stat(cand.c_str(), &st) == 0 && S_ISREG(st.st_mode)) {
      g_returnNro = cand;
    }
  }

  {
    size_t sl = g_gameDir.rfind('/');
    std::string rawName = (sl == std::string::npos) ? g_gameDir : g_gameDir.substr(sl + 1);
    std::string pid;
    for (unsigned char c : rawName) {
      if (std::isalnum(c)) pid.push_back(static_cast<char>(std::tolower(c)));
      else if (c == '-' || c == '_') pid.push_back(static_cast<char>(c));
    }
    g_projectId = pid.empty() ? "wolfgame" : pid;
    g_loadingTitle = rawName;
  }

  mkdirsHost(g_launcherDir + "/log");
  g_logFile = fopen((g_launcherDir + "/log/wolf.log").c_str(), "wb");
  logMsg("=== SW2RPGMGL v" SW2RPGMGL_VERSION " — WOLF RPG Editor Engine (wolf.log) ===");
  logMsg("gameTitle:   %s", g_loadingTitle.c_str());
  logMsg("selfNro:     %s", g_selfNro.c_str());
  logMsg("launcherDir: %s", g_launcherDir.c_str());
  logMsg("gameDir:     %s", g_gameDir.c_str());
  logMsg("returnNro:   %s", g_returnNro.c_str());
  logMsg("projectId:   %s", g_projectId.c_str());

  Result romRc = romfsInit();
  if (R_FAILED(romRc)) {
    logMsg("[romfs] WARNING: romfsInit failed: 0x%x", romRc);
  }

  Result plRc = plInitialize(PlServiceType_User);
  PlFontData stdFont {};
  if (R_SUCCEEDED(plRc) && R_SUCCEEDED(plGetSharedFontByType(&stdFont, PlSharedFontType_Standard))) {
    g_font.initFromSharedFont(stdFont);
  }

  if (!initEglSwitch2()) {
    logMsg("[FATAL] initEglSwitch2 failed!");
    g_font.shutdown();
    if (R_SUCCEEDED(plRc)) plExit();
    if (R_SUCCEEDED(romRc)) romfsExit();
    if (g_logFile) fclose(g_logFile);
    return 1;
  }

  initSwitchPads();

  renderBootLoadingFrame(0.15f, "Mounting WOLF RPG archives in memory\xE2\x80\xA6", g_gameDir);
  g_vfs.init(g_gameDir, "romfs:", g_projectId);
  logMsg("[vfs] Mounted %d archive file(s) from %s (zero SD extraction)",
         g_vfs.indexedArchiveFiles(), g_gameDir.c_str());
  if (g_vfs.ftpSafeAliases() > 0) {
    logMsg("[vfs] _jp_map.txt: restored %d FTP-safe filename(s) to their original names", g_vfs.ftpSafeAliases());
  }

  renderBootLoadingFrame(0.40f, "Starting BrowserWoditor runtime\xE2\x80\xA6",
                         std::to_string(g_vfs.indexedArchiveFiles()) + " archive file(s) mounted from " + g_gameDir);

  initOpenAlHost();

  wasm_rt_init();
  wasm2c_woditor_instantiate(&g_inst, &g_env, &g_wasi);
  g_wasmReady = true;

  logMsg("[wasm2c] Calling __wasm_call_ctors + main(0, 0) (mem=%llu MiB)...",
         static_cast<unsigned long long>(g_inst.w2c_memory.size / (1024 * 1024)));
  w2c_woditor_0x5F_wasm_call_ctors(&g_inst);

  g_hasTopJmp = true;
  int bootJmp = setjmp(g_topJmp);
  if (bootJmp == 0) {
    w2c_woditor_main(&g_inst, 0, 0);
  } else if (bootJmp == JMP_MAIN_LOOP_UNWIND) {
    logMsg("[wasm2c] Main loop registered (fn=%u); entering 60 Hz Switch 2 frame loop", g_mainLoopFn);
  } else {
    logMsg("[wasm2c] Early exit jump (%d)", bootJmp);
  }

  while (appletMainLoop() && !g_shouldExit && g_mainLoopFn != 0) {
    pollSwitchInput();
    if (g_shouldExit) break;

    if (g_quickMenuOpen || g_mainLoopPaused) {
      presentGameAndOverlay();
      continue;
    }

    int frameJmp = setjmp(g_topJmp);
    if (frameJmp == 0) {
      w2c_woditor_dynCall_v(&g_inst, g_mainLoopFn);
    } else {
      logMsg("[wasm2c] Frame loop exited via jump (%d)", frameJmp);
      break;
    }
    if (g_shouldExit) break;

    presentGameAndOverlay();
  }

  g_hasTopJmp = false;
  logMsg("[shutdown] Cleaning up files, VFS, audio, and EGL (returnToLauncher=%d)...",
         g_returnToLauncher ? 1 : 0);

  for (auto& [fd, ofd] : g_fds) {
    flushOpenFd(ofd);
  }
  g_fds.clear();
  g_vfs.shutdown();

  if (g_wasmReady) {
    wasm2c_woditor_free(&g_inst);
    wasm_rt_free();
    g_wasmReady = false;
  }

  shutdownOpenAlHost();
  shutdownEgl();
  nwindowReleaseVi2Layer(nwindowGetDefault());
  g_font.shutdown();
  if (R_SUCCEEDED(plRc)) plExit();
  if (R_SUCCEEDED(romRc)) romfsExit();

  if (g_returnToLauncher && !g_returnNro.empty() && envHasNextLoad()) {
    std::string args = "\"" + g_returnNro + "\"";
    Result hrc = envSetNextLoad(g_returnNro.c_str(), args.c_str());
    logMsg("[handoff] envSetNextLoad(%s) -> 0x%x", g_returnNro.c_str(), hrc);
  }

  if (g_logFile) fclose(g_logFile);
  return 0;
}
