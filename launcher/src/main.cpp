/**
 * SW2RPGMGL — Native Switch 2 (libounce) Universal RPG Maker Launcher
 *
 * Lightweight (~2 MiB), instant-boot (< 0.2s) native launcher UI for Nintendo Switch 2
 * (kaiHEN / ounce-devkit) that discovers RPG Maker MV and VX Ace / VX / XP games on
 * the SD card and chain-loads modular engine NROs via envSetNextLoad:
 *   - engines/mv-engine-switch2.nro   (RPG Maker MV via nx.js + OunceVK)
 *   - engines/mkxp-z-switch2.nro      (RPG Maker VX Ace / VX / XP via mkxp-z + OunceVK)
 */
#include <switch.h>

#include <ft2build.h>
#include FT_FREETYPE_H

#include <png.h>
#include <jpeglib.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <unordered_map>
#include <vector>

#ifndef SW2RPGMGL_VERSION
#define SW2RPGMGL_VERSION "0.3.2"
#endif

namespace {

constexpr int SCREEN_W = 1280;
constexpr int SCREEN_H = 720;

// ============================================================================
// Logging
// ============================================================================
FILE* g_logFile = nullptr;
uint64_t g_bootTicks = 0;

double nowMs() {
    uint64_t dt = armGetSystemTick() - g_bootTicks;
    return static_cast<double>(armTicksToNs(dt)) / 1e6;
}

void logMsg(const char* fmt, ...) {
    if (!g_logFile) return;
    fprintf(g_logFile, "[%6.0fms] ", nowMs());
    va_list ap;
    va_start(ap, fmt);
    vfprintf(g_logFile, fmt, ap);
    va_end(ap);
    fputc('\n', g_logFile);
    fflush(g_logFile);
}

// ============================================================================
// String / Path / FS Helpers
// ============================================================================
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

bool endsWithIgnoreCase(const std::string& s, const std::string& suffix) {
    if (s.size() < suffix.size()) return false;
    return toLower(s.substr(s.size() - suffix.size())) == toLower(suffix);
}

bool startsWithIgnoreCase(const std::string& s, const std::string& prefix) {
    if (s.size() < prefix.size()) return false;
    return toLower(s.substr(0, prefix.size())) == toLower(prefix);
}

bool isDir(const std::string& p) {
    struct stat st {};
    return stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

bool isRegularFile(const std::string& p) {
    struct stat st {};
    return stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

std::string readTextFile(const std::string& p, size_t maxBytes = 512 * 1024) {
    FILE* f = fopen(p.c_str(), "rb");
    if (!f) return {};
    std::string out;
    char buf[4096];
    while (out.size() < maxBytes) {
        size_t want = std::min(sizeof(buf), maxBytes - out.size());
        size_t n = fread(buf, 1, want, f);
        if (n == 0) break;
        out.append(buf, n);
    }
    fclose(f);
    // Strip UTF-8 BOM if present
    if (out.size() >= 3 &&
        static_cast<unsigned char>(out[0]) == 0xEF &&
        static_cast<unsigned char>(out[1]) == 0xBB &&
        static_cast<unsigned char>(out[2]) == 0xBF) {
        out.erase(0, 3);
    }
    return out;
}

std::vector<std::string> listDirNames(const std::string& dir) {
    std::vector<std::string> names;
    DIR* d = opendir(dir.c_str());
    if (!d) return names;
    while (struct dirent* ent = readdir(d)) {
        if (ent->d_name[0] == '\0') continue;
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        names.emplace_back(ent->d_name);
    }
    closedir(d);
    return names;
}

std::string normalizeSdmcPath(std::string raw) {
    for (char& c : raw) if (c == '\\') c = '/';
    raw = trim(raw);
    while (raw.size() > 1 && raw.back() == '/') raw.pop_back();
    if (raw.empty()) return {};
    if (raw[0] == '/') return "sdmc:" + raw;
    if (startsWithIgnoreCase(raw, "sdmc:/")) return raw;
    return raw;
}

std::string dirNameOf(const std::string& path) {
    size_t pos = path.rfind('/');
    if (pos == std::string::npos || pos <= 5) return "sdmc:/switch/SW2RPGMGL";
    return path.substr(0, pos);
}

bool isValidUtf8(const std::string& s) {
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if (c < 0x80) { i++; continue; }
        int extra = 0;
        if ((c & 0xE0) == 0xC0 && c >= 0xC2) extra = 1;
        else if ((c & 0xF0) == 0xE0) extra = 2;
        else if ((c & 0xF8) == 0xF0 && c <= 0xF4) extra = 3;
        else return false;
        if (i + extra >= s.size()) return false;
        for (int k = 1; k <= extra; k++) {
            if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80) return false;
        }
        i += extra + 1;
    }
    return true;
}

// Lightweight JSON string-field extractor (handles escaped quotes and \uXXXX escapes)
std::string extractJsonStringField(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return {};
    pos += needle.size();
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) pos++;
    if (pos >= json.size() || json[pos] != ':') return {};
    pos++;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) pos++;
    if (pos >= json.size() || json[pos] != '"') return {};
    pos++;
    std::string out;
    while (pos < json.size()) {
        char c = json[pos++];
        if (c == '"') break;
        if (c == '\\' && pos < json.size()) {
            char esc = json[pos++];
            if (esc == '"' || esc == '\\' || esc == '/') out.push_back(esc);
            else if (esc == 'n') out.push_back(' ');
            else if (esc == 't') out.push_back(' ');
            else if (esc == 'u' && pos + 4 <= json.size()) {
                unsigned int cp = 0;
                if (sscanf(json.c_str() + pos, "%4x", &cp) == 1) {
                    if (cp < 0x80) {
                        out.push_back(static_cast<char>(cp));
                    } else if (cp < 0x800) {
                        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
                        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                    } else {
                        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
                        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
                        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
                    }
                }
                pos += 4;
            }
        } else {
            out.push_back(c);
        }
    }
    return trim(out);
}

bool extractJsonBoolField(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos += needle.size();
    while (pos < json.size() && (std::isspace(static_cast<unsigned char>(json[pos])) || json[pos] == ':')) pos++;
    return json.compare(pos, 4, "true") == 0;
}

// ============================================================================
// RGBA Color & Software Canvas Renderer (1280x720)
// ============================================================================
struct Color {
    uint8_t r, g, b, a;
};

constexpr Color rgb(uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255) {
    return {r, g, b, a};
}

constexpr Color hexColor(uint32_t hex, uint8_t a = 255) {
    return {
        static_cast<uint8_t>((hex >> 16) & 0xFF),
        static_cast<uint8_t>((hex >> 8) & 0xFF),
        static_cast<uint8_t>(hex & 0xFF),
        a
    };
}

inline uint32_t packColor(uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255) {
    return (static_cast<uint32_t>(a) << 24) |
           (static_cast<uint32_t>(b) << 16) |
           (static_cast<uint32_t>(g) << 8) |
           static_cast<uint32_t>(r);
}

struct ImageRGBA {
    int w = 0;
    int h = 0;
    std::vector<uint8_t> pixels; // RGBA8
    bool valid() const { return w > 0 && h > 0 && pixels.size() >= static_cast<size_t>(w * h * 4); }
};

class Canvas {
public:
    uint32_t* pixels = nullptr;
    int width = SCREEN_W;
    int height = SCREEN_H;
    int pitch = SCREEN_W;

    void bind(uint32_t* buf, int w, int h, int strideBytes) {
        pixels = buf;
        width = w;
        height = h;
        pitch = strideBytes / 4;
    }

    inline void blendPixel(int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
        if (x < 0 || y < 0 || x >= width || y >= height || a == 0) return;
        uint32_t& dst = pixels[y * pitch + x];
        if (a == 255) {
            dst = packColor(r, g, b, 255);
            return;
        }
        uint32_t dr = dst & 0xFF;
        uint32_t dg = (dst >> 8) & 0xFF;
        uint32_t db = (dst >> 16) & 0xFF;
        uint32_t inv = 255 - a;
        uint8_t nr = static_cast<uint8_t>((r * a + dr * inv + 127) / 255);
        uint8_t ng = static_cast<uint8_t>((g * a + dg * inv + 127) / 255);
        uint8_t nb = static_cast<uint8_t>((b * a + db * inv + 127) / 255);
        dst = packColor(nr, ng, nb, 255);
    }

    void fillRect(int x, int y, int w, int h, Color c) {
        int x0 = std::max(0, x);
        int y0 = std::max(0, y);
        int x1 = std::min(width, x + w);
        int y1 = std::min(height, y + h);
        if (x0 >= x1 || y0 >= y1 || c.a == 0) return;
        if (c.a == 255) {
            uint32_t packed = packColor(c.r, c.g, c.b, 255);
            for (int py = y0; py < y1; py++) {
                uint32_t* row = pixels + py * pitch + x0;
                for (int px = x0; px < x1; px++) *row++ = packed;
            }
        } else {
            for (int py = y0; py < y1; py++) {
                for (int px = x0; px < x1; px++) {
                    blendPixel(px, py, c.r, c.g, c.b, c.a);
                }
            }
        }
    }

    // Anti-aliased rounded rectangle (filled + optional border)
    void drawRoundedRect(int x, int y, int w, int h, int radius, Color fill, int borderW = 0, Color border = rgb(0, 0, 0, 0)) {
        if (w <= 0 || h <= 0) return;
        int r = std::max(0, std::min(radius, std::min(w, h) / 2));
        if (r == 0) {
            fillRect(x, y, w, h, fill);
            if (borderW > 0 && border.a > 0) {
                fillRect(x, y, w, borderW, border);
                fillRect(x, y + h - borderW, w, borderW, border);
                fillRect(x, y, borderW, h, border);
                fillRect(x + w - borderW, y, borderW, h, border);
            }
            return;
        }

        // Fast interior fill (non-corner rows & middle band)
        const float fr = static_cast<float>(r);
        const float innerR = std::max(0.0f, fr - static_cast<float>(borderW));
        const int x0 = std::max(0, x);
        const int y0 = std::max(0, y);
        const int x1 = std::min(width, x + w);
        const int y1 = std::min(height, y + h);

        // Middle band without rounded corners (fast path!)
        int midY0 = std::max(y0, y + r);
        int midY1 = std::min(y1, y + h - r);
        if (midY0 < midY1) {
            if (borderW > 0 && border.a > 0) {
                fillRect(x, midY0, borderW, midY1 - midY0, border);
                fillRect(x + w - borderW, midY0, borderW, midY1 - midY0, border);
                fillRect(x + borderW, midY0, w - 2 * borderW, midY1 - midY0, fill);
            } else {
                fillRect(x, midY0, w, midY1 - midY0, fill);
            }
        }

        // Top and bottom bands (height r each) with smooth subpixel corner AA
        auto drawCornerBand = [&](int bandY0, int bandY1) {
            int by0 = std::max(y0, bandY0);
            int by1 = std::min(y1, bandY1);
            for (int py = by0; py < by1; py++) {
                float cy = (py < y + r) ? static_cast<float>(y + r) : static_cast<float>(y + h - r - 1);
                float dy = static_cast<float>(py) - cy;
                // Middle horizontal strip between corners
                int midX0 = std::max(x0, x + r);
                int midX1 = std::min(x1, x + w - r);
                bool inBorderY = (borderW > 0 && border.a > 0) &&
                                 (py < y + borderW || py >= y + h - borderW);
                Color stripCol = inBorderY ? border : fill;
                if (midX0 < midX1 && stripCol.a > 0) {
                    if (stripCol.a == 255) {
                        uint32_t packed = packColor(stripCol.r, stripCol.g, stripCol.b, 255);
                        uint32_t* row = pixels + py * pitch + midX0;
                        for (int px = midX0; px < midX1; px++) *row++ = packed;
                    } else {
                        for (int px = midX0; px < midX1; px++) {
                            blendPixel(px, py, stripCol.r, stripCol.g, stripCol.b, stripCol.a);
                        }
                    }
                }
                // Left and right corner spans
                auto drawSpan = [&](int sx0, int sx1, float cx) {
                    sx0 = std::max(x0, sx0);
                    sx1 = std::min(x1, sx1);
                    for (int px = sx0; px < sx1; px++) {
                        float dx = static_cast<float>(px) - cx;
                        float dist = std::sqrt(dx * dx + dy * dy);
                        float outerCov = std::clamp(fr - dist + 0.5f, 0.0f, 1.0f);
                        if (outerCov <= 0.0f) continue;
                        if (borderW > 0 && border.a > 0) {
                            float innerCov = std::clamp(innerR - dist + 0.5f, 0.0f, 1.0f);
                            float borderCov = std::max(0.0f, outerCov - innerCov);
                            if (innerCov > 0.0f && fill.a > 0) {
                                uint8_t a = static_cast<uint8_t>(fill.a * innerCov + 0.5f);
                                blendPixel(px, py, fill.r, fill.g, fill.b, a);
                            }
                            if (borderCov > 0.0f) {
                                uint8_t a = static_cast<uint8_t>(border.a * borderCov + 0.5f);
                                blendPixel(px, py, border.r, border.g, border.b, a);
                            }
                        } else if (fill.a > 0) {
                            uint8_t a = static_cast<uint8_t>(fill.a * outerCov + 0.5f);
                            blendPixel(px, py, fill.r, fill.g, fill.b, a);
                        }
                    }
                };
                drawSpan(x, x + r, static_cast<float>(x + r));
                drawSpan(x + w - r, x + w, static_cast<float>(x + w - r - 1));
            }
        };
        drawCornerBand(y, y + r);
        drawCornerBand(y + h - r, y + h);
    }

    void blitImageRounded(const ImageRGBA& img, int x, int y, int radius) {
        if (!img.valid()) return;
        const float fr = static_cast<float>(std::max(0, std::min(radius, std::min(img.w, img.h) / 2)));
        for (int iy = 0; iy < img.h; iy++) {
            int py = y + iy;
            if (py < 0 || py >= height) continue;
            for (int ix = 0; ix < img.w; ix++) {
                int px = x + ix;
                if (px < 0 || px >= width) continue;
                float cov = 1.0f;
                if (fr > 0.0f) {
                    float dx = 0.0f, dy = 0.0f;
                    if (ix < fr) dx = fr - ix;
                    else if (ix >= img.w - fr) dx = ix - (img.w - fr - 1);
                    if (iy < fr) dy = fr - iy;
                    else if (iy >= img.h - fr) dy = iy - (img.h - fr - 1);
                    if (dx > 0.0f && dy > 0.0f) {
                        float dist = std::sqrt(dx * dx + dy * dy);
                        cov = std::clamp(fr - dist + 0.5f, 0.0f, 1.0f);
                    }
                }
                if (cov <= 0.0f) continue;
                const uint8_t* sp = &img.pixels[(iy * img.w + ix) * 4];
                uint8_t a = static_cast<uint8_t>(sp[3] * cov + 0.5f);
                blendPixel(px, py, sp[0], sp[1], sp[2], a);
            }
        }
    }
};

// ============================================================================
// FreeType Font Renderer (Switch 2 Built-in Shared Font + Glyph Cache)
// ============================================================================
struct CachedGlyph {
    int w = 0;
    int h = 0;
    int left = 0;
    int top = 0;
    int advance = 0;
    std::vector<uint8_t> alpha;
};

class FontRenderer {
public:
    FT_Library ft = nullptr;
    FT_Face face = nullptr;
    int currentSize = 0;
    std::unordered_map<uint64_t, CachedGlyph> cache;

    bool init(const PlFontData& fontData) {
        if (FT_Init_FreeType(&ft) != 0) return false;
        if (FT_New_Memory_Face(ft, reinterpret_cast<const FT_Byte*>(fontData.address),
                               static_cast<FT_Long>(fontData.size), 0, &face) != 0) {
            FT_Done_FreeType(ft);
            ft = nullptr;
            return false;
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
            i += 2;
            return cp;
        }
        if ((c & 0xF0) == 0xE0 && i + 2 < s.size()) {
            uint32_t cp = ((c & 0x0F) << 12) |
                          ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 6) |
                          (static_cast<unsigned char>(s[i + 2]) & 0x3F);
            i += 3;
            return cp;
        }
        if ((c & 0xF8) == 0xF0 && i + 3 < s.size()) {
            uint32_t cp = ((c & 0x07) << 18) |
                          ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 12) |
                          ((static_cast<unsigned char>(s[i + 2]) & 0x3F) << 6) |
                          (static_cast<unsigned char>(s[i + 3]) & 0x3F);
            i += 4;
            return cp;
        }
        i++;
        return '?';
    }

    const CachedGlyph& getGlyph(uint32_t cp, int pxSize) {
        uint64_t key = (static_cast<uint64_t>(cp) << 16) | static_cast<uint64_t>(pxSize & 0xFFFF);
        auto it = cache.find(key);
        if (it != cache.end()) return it->second;

        CachedGlyph g;
        if (face) {
            if (currentSize != pxSize) {
                FT_Set_Pixel_Sizes(face, 0, pxSize);
                currentSize = pxSize;
            }
            FT_UInt gi = FT_Get_Char_Index(face, cp);
            if (gi == 0 && cp != ' ') gi = FT_Get_Char_Index(face, '?');
            if (FT_Load_Glyph(face, gi, FT_LOAD_RENDER) == 0) {
                FT_GlyphSlot slot = face->glyph;
                g.w = slot->bitmap.width;
                g.h = slot->bitmap.rows;
                g.left = slot->bitmap_left;
                g.top = slot->bitmap_top;
                g.advance = static_cast<int>(slot->advance.x >> 6);
                if (g.w > 0 && g.h > 0 && slot->bitmap.buffer) {
                    g.alpha.resize(static_cast<size_t>(g.w * g.h));
                    for (int row = 0; row < g.h; row++) {
                        memcpy(&g.alpha[row * g.w],
                               slot->bitmap.buffer + row * slot->bitmap.pitch,
                               static_cast<size_t>(g.w));
                    }
                }
            }
        }
        if (cache.size() > 4096) cache.clear();
        auto res = cache.emplace(key, std::move(g));
        return res.first->second;
    }

    int measureWidth(const std::string& text, int pxSize) {
        int w = 0;
        size_t i = 0;
        while (i < text.size()) {
            uint32_t cp = nextUtf8(text, i);
            w += getGlyph(cp, pxSize).advance;
        }
        return w;
    }

    std::string truncate(const std::string& text, int pxSize, int maxW) {
        if (measureWidth(text, pxSize) <= maxW) return text;
        const std::string ell = "\xE2\x80\xA6"; // UTF-8 ellipsis
        int ellW = measureWidth(ell, pxSize);
        if (ellW >= maxW) return ell;
        int acc = 0;
        size_t i = 0;
        size_t lastOk = 0;
        while (i < text.size()) {
            size_t nextI = i;
            uint32_t cp = nextUtf8(text, nextI);
            int adv = getGlyph(cp, pxSize).advance;
            if (acc + adv + ellW > maxW) break;
            acc += adv;
            lastOk = nextI;
            i = nextI;
        }
        return text.substr(0, lastOk) + ell;
    }

    enum class Align { Left, Center, Right };

    void drawText(Canvas& canvas, const std::string& text, int x, int y, int pxSize,
                  Color col, Align align = Align::Left, bool verticalCenter = false) {
        if (text.empty() || !face) return;
        int penX = x;
        if (align == Align::Center) penX -= measureWidth(text, pxSize) / 2;
        else if (align == Align::Right) penX -= measureWidth(text, pxSize);

        // Baseline placement matching HTML Canvas textBaseline='top' / 'middle'
        int baselineY = verticalCenter
            ? (y + static_cast<int>(pxSize * 0.35f))
            : (y + static_cast<int>(pxSize * 0.85f));

        size_t i = 0;
        while (i < text.size()) {
            uint32_t cp = nextUtf8(text, i);
            const CachedGlyph& g = getGlyph(cp, pxSize);
            int gx0 = penX + g.left;
            int gy0 = baselineY - g.top;
            for (int row = 0; row < g.h; row++) {
                int py = gy0 + row;
                if (py < 0 || py >= canvas.height) continue;
                const uint8_t* srcRow = &g.alpha[row * g.w];
                for (int colIdx = 0; colIdx < g.w; colIdx++) {
                    uint8_t ga = srcRow[colIdx];
                    if (ga == 0) continue;
                    uint8_t a = (col.a == 255) ? ga : static_cast<uint8_t>((ga * col.a + 127) / 255);
                    canvas.blendPixel(gx0 + colIdx, py, col.r, col.g, col.b, a);
                }
            }
            penX += g.advance;
        }
    }
};

// ============================================================================
// PNG / JPEG Image Decoder & High-Quality Area-Box Scaler
// ============================================================================
ImageRGBA decodePngFile(const std::string& path) {
    ImageRGBA img;
    FILE* fp = fopen(path.c_str(), "rb");
    if (!fp) return img;

    png_byte header[8];
    if (fread(header, 1, 8, fp) != 8 || png_sig_cmp(header, 0, 8) != 0) {
        fclose(fp);
        return img;
    }

    png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
    if (!png) { fclose(fp); return img; }
    png_infop info = png_create_info_struct(png);
    if (!info) { png_destroy_read_struct(&png, nullptr, nullptr); fclose(fp); return img; }

    if (setjmp(png_jmpbuf(png))) {
        png_destroy_read_struct(&png, &info, nullptr);
        fclose(fp);
        return ImageRGBA{};
    }

    png_init_io(png, fp);
    png_set_sig_bytes(png, 8);
    png_read_info(png, info);

    png_uint_32 w = png_get_image_width(png, info);
    png_uint_32 h = png_get_image_height(png, info);
    png_byte colorType = png_get_color_type(png, info);
    png_byte bitDepth = png_get_bit_depth(png, info);

    if (w == 0 || h == 0 || w > 2048 || h > 2048) {
        png_destroy_read_struct(&png, &info, nullptr);
        fclose(fp);
        return img;
    }

    if (bitDepth == 16) png_set_strip_16(png);
    if (colorType == PNG_COLOR_TYPE_PALETTE) png_set_palette_to_rgb(png);
    if (colorType == PNG_COLOR_TYPE_GRAY && bitDepth < 8) png_set_expand_gray_1_2_4_to_8(png);
    if (png_get_valid(png, info, PNG_INFO_tRNS)) png_set_tRNS_to_alpha(png);
    if (colorType == PNG_COLOR_TYPE_RGB || colorType == PNG_COLOR_TYPE_GRAY || colorType == PNG_COLOR_TYPE_PALETTE) {
        png_set_filler(png, 0xFF, PNG_FILLER_AFTER);
    }
    if (colorType == PNG_COLOR_TYPE_GRAY || colorType == PNG_COLOR_TYPE_GRAY_ALPHA) {
        png_set_gray_to_rgb(png);
    }
    png_read_update_info(png, info);

    img.w = static_cast<int>(w);
    img.h = static_cast<int>(h);
    img.pixels.resize(static_cast<size_t>(w * h * 4));
    std::vector<png_bytep> rows(h);
    for (png_uint_32 y = 0; y < h; y++) {
        rows[y] = &img.pixels[y * w * 4];
    }
    png_read_image(png, rows.data());
    png_destroy_read_struct(&png, &info, nullptr);
    fclose(fp);
    return img;
}

ImageRGBA decodeJpegFile(const std::string& path) {
    ImageRGBA img;
    FILE* fp = fopen(path.c_str(), "rb");
    if (!fp) return img;

    struct jpeg_decompress_struct cinfo {};
    struct jpeg_error_mgr jerr {};
    cinfo.err = jpeg_std_error(&jerr);
    jpeg_create_decompress(&cinfo);
    jpeg_stdio_src(&cinfo, fp);
    if (jpeg_read_header(&cinfo, TRUE) != JPEG_HEADER_OK) {
        jpeg_destroy_decompress(&cinfo);
        fclose(fp);
        return img;
    }
    cinfo.out_color_space = JCS_RGB;
    jpeg_start_decompress(&cinfo);

    if (cinfo.output_width == 0 || cinfo.output_height == 0 ||
        cinfo.output_width > 2048 || cinfo.output_height > 2048) {
        jpeg_destroy_decompress(&cinfo);
        fclose(fp);
        return img;
    }

    img.w = static_cast<int>(cinfo.output_width);
    img.h = static_cast<int>(cinfo.output_height);
    img.pixels.resize(static_cast<size_t>(img.w * img.h * 4));
    std::vector<uint8_t> rowBuf(static_cast<size_t>(img.w * 3));
    while (cinfo.output_scanline < cinfo.output_height) {
        int y = static_cast<int>(cinfo.output_scanline);
        JSAMPROW rowPtr = rowBuf.data();
        jpeg_read_scanlines(&cinfo, &rowPtr, 1);
        uint8_t* dst = &img.pixels[y * img.w * 4];
        for (int x = 0; x < img.w; x++) {
            dst[x * 4 + 0] = rowBuf[x * 3 + 0];
            dst[x * 4 + 1] = rowBuf[x * 3 + 1];
            dst[x * 4 + 2] = rowBuf[x * 3 + 2];
            dst[x * 4 + 3] = 255;
        }
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    fclose(fp);
    return img;
}

ImageRGBA resizeImageSquareFit(const ImageRGBA& src, int dstSize) {
    ImageRGBA dst;
    if (!src.valid() || dstSize <= 0) return dst;
    dst.w = dstSize;
    dst.h = dstSize;
    dst.pixels.assign(static_cast<size_t>(dstSize * dstSize * 4), 0);

    // Fill dark backing box (#0b0e17)
    for (int i = 0; i < dstSize * dstSize; i++) {
        dst.pixels[i * 4 + 0] = 11;
        dst.pixels[i * 4 + 1] = 14;
        dst.pixels[i * 4 + 2] = 23;
        dst.pixels[i * 4 + 3] = 255;
    }

    float scale = std::min(static_cast<float>(dstSize) / src.w, static_cast<float>(dstSize) / src.h);
    int drawW = std::max(1, static_cast<int>(std::round(src.w * scale)));
    int drawH = std::max(1, static_cast<int>(std::round(src.h * scale)));
    int offX = (dstSize - drawW) / 2;
    int offY = (dstSize - drawH) / 2;

    float sxStep = static_cast<float>(src.w) / drawW;
    float syStep = static_cast<float>(src.h) / drawH;

    for (int dy = 0; dy < drawH; dy++) {
        float sy0 = dy * syStep;
        float sy1 = std::min(static_cast<float>(src.h), (dy + 1) * syStep);
        int iy0 = static_cast<int>(std::floor(sy0));
        int iy1 = std::min(src.h - 1, static_cast<int>(std::floor(sy1)));
        for (int dx = 0; dx < drawW; dx++) {
            float sx0 = dx * sxStep;
            float sx1 = std::min(static_cast<float>(src.w), (dx + 1) * sxStep);
            int ix0 = static_cast<int>(std::floor(sx0));
            int ix1 = std::min(src.w - 1, static_cast<int>(std::floor(sx1)));
            float r = 0, g = 0, b = 0, a = 0, wSum = 0;
            for (int sy = iy0; sy <= iy1; sy++) {
                float wy = std::min(static_cast<float>(sy + 1), sy1) - std::max(static_cast<float>(sy), sy0);
                if (wy <= 0.0f) continue;
                for (int sx = ix0; sx <= ix1; sx++) {
                    float wx = std::min(static_cast<float>(sx + 1), sx1) - std::max(static_cast<float>(sx), sx0);
                    if (wx <= 0.0f) continue;
                    float w = wx * wy;
                    const uint8_t* sp = &src.pixels[(sy * src.w + sx) * 4];
                    r += sp[0] * w;
                    g += sp[1] * w;
                    b += sp[2] * w;
                    a += sp[3] * w;
                    wSum += w;
                }
            }
            if (wSum <= 0.0f) continue;
            float inv = 1.0f / wSum;
            uint8_t sr = static_cast<uint8_t>(std::clamp(r * inv, 0.0f, 255.0f));
            uint8_t sg = static_cast<uint8_t>(std::clamp(g * inv, 0.0f, 255.0f));
            uint8_t sb = static_cast<uint8_t>(std::clamp(b * inv, 0.0f, 255.0f));
            uint8_t sa = static_cast<uint8_t>(std::clamp(a * inv, 0.0f, 255.0f));
            uint8_t* dp = &dst.pixels[((offY + dy) * dstSize + (offX + dx)) * 4];
            if (sa == 255) {
                dp[0] = sr; dp[1] = sg; dp[2] = sb; dp[3] = 255;
            } else if (sa > 0) {
                int invA = 255 - sa;
                dp[0] = static_cast<uint8_t>((sr * sa + dp[0] * invA + 127) / 255);
                dp[1] = static_cast<uint8_t>((sg * sa + dp[1] * invA + 127) / 255);
                dp[2] = static_cast<uint8_t>((sb * sa + dp[2] * invA + 127) / 255);
                dp[3] = 255;
            }
        }
    }
    return dst;
}

ImageRGBA loadGameIconRaw(const std::string& path) {
    if (path.empty()) return {};
    if (endsWithIgnoreCase(path, ".png")) return decodePngFile(path);
    if (endsWithIgnoreCase(path, ".jpg") || endsWithIgnoreCase(path, ".jpeg")) return decodeJpegFile(path);
    return {};
}

// ============================================================================
// Game Discovery & Metadata (Exact Parity with loader/src/games.ts)
// ============================================================================
enum class GameEngine { MV, MZ, VXAce, VX, XP, Wolf };

struct GameEntry {
    std::string id;
    std::string folderName;
    GameEngine engine = GameEngine::MV;
    std::string title;
    std::string gameDir;
    std::string wwwRoot;
    std::string saveDir;
    std::string iconPath;
    int pluginCount = 0;
    int saveCount = 0;
    bool encrypted = false;

    // Lazily decoded icon cache
    bool iconAttempted = false;
    ImageRGBA iconSmall; // 56x56
    ImageRGBA iconLarge; // 112x112
};

const std::set<std::string> IGNORED_DIRS = {
    ".", "..", "engines", "games", "log", "save", "screenshots", "userdata",
    "rpgvxace", "rtp-vxace", "rtp-vx", "rtp-xp", "rtp", "__macosx"
};

const char* engineBadgeLabel(GameEngine e) {
    switch (e) {
        case GameEngine::MV: return "MV";
        case GameEngine::MZ: return "MZ";
        case GameEngine::VXAce: return "VX ACE";
        case GameEngine::VX: return "VX";
        case GameEngine::XP: return "XP";
        case GameEngine::Wolf: return "WOLF";
    }
    return "MV";
}

const char* engineFullLabel(GameEngine e) {
    switch (e) {
        case GameEngine::MV: return "RPG Maker MV (nx.js)";
        case GameEngine::MZ: return "RPG Maker MZ (nx.js WebGL2)";
        case GameEngine::VXAce: return "RPG Maker VX Ace (mkxp-z)";
        case GameEngine::VX: return "RPG Maker VX (mkxp-z)";
        case GameEngine::XP: return "RPG Maker XP (mkxp-z)";
        case GameEngine::Wolf: return "WOLF RPG Editor (Woditor ARM64)";
    }
    return "RPG Maker MV";
}

std::pair<Color, Color> engineBadgeColor(GameEngine e) {
    switch (e) {
        case GameEngine::MV:    return {hexColor(0x23386b), hexColor(0x9ec5ff)};
        case GameEngine::MZ:    return {hexColor(0x1b4d4a), hexColor(0x7ef7e6)};
        case GameEngine::VXAce: return {hexColor(0x4b2459), hexColor(0xf0b5ff)};
        case GameEngine::VX:    return {hexColor(0x244c59), hexColor(0x9eeaff)};
        case GameEngine::XP:    return {hexColor(0x28543a), hexColor(0x9ef5be)};
        case GameEngine::Wolf:  return {hexColor(0x4a3319), hexColor(0xffcf87)};
    }
    return {hexColor(0x23386b), hexColor(0x9ec5ff)};
}

std::pair<Color, Color> pickMonogramColors(const std::string& seed) {
    static const std::pair<uint32_t, uint32_t> palette[] = {
        {0x3b4252, 0xd8dee9}, {0x4c285e, 0xf2c6ff}, {0x1e4d5c, 0xa8ecff},
        {0x5c3624, 0xffd0b0}, {0x264d36, 0xb2f5cc}, {0x52263b, 0xffb8d9},
        {0x2b3e6b, 0xb8d0ff},
    };
    unsigned int h = 0;
    for (unsigned char c : seed) h = (h * 31u + c) & 0xFFFFu;
    const auto& p = palette[h % (sizeof(palette) / sizeof(palette[0]))];
    return {hexColor(p.first), hexColor(p.second)};
}

int countEnabledPlugins(const std::string& src) {
    int count = 0;
    size_t pos = 0;
    while ((pos = src.find("status", pos)) != std::string::npos) {
        bool validBefore = (pos == 0) ||
            src[pos - 1] == '"' || src[pos - 1] == '{' || src[pos - 1] == ',' ||
            std::isspace(static_cast<unsigned char>(src[pos - 1]));
        pos += 6;
        if (!validBefore) continue;
        if (pos < src.size() && src[pos] == '"') pos++;
        while (pos < src.size() && std::isspace(static_cast<unsigned char>(src[pos]))) pos++;
        if (pos >= src.size() || src[pos] != ':') continue;
        pos++;
        while (pos < src.size() && std::isspace(static_cast<unsigned char>(src[pos]))) pos++;
        if (src.compare(pos, 4, "true") == 0) count++;
    }
    return count;
}

std::string parseHtmlTitle(const std::string& html) {
    std::string lower = toLower(html);
    size_t a = lower.find("<title");
    if (a == std::string::npos) return {};
    a = lower.find('>', a);
    if (a == std::string::npos) return {};
    size_t b = lower.find("</title>", a + 1);
    if (b == std::string::npos || b <= a + 1) return {};
    return trim(html.substr(a + 1, b - a - 1));
}

std::string findMvIconPath(const std::string& wwwRoot) {
    std::string direct = wwwRoot + "/icon/icon.png";
    if (isRegularFile(direct)) return direct;
    std::string iconDir = wwwRoot + "/icon";
    for (const auto& name : listDirNames(iconDir)) {
        if (toLower(name) == "icon.png") return iconDir + "/" + name;
    }
    for (const auto& name : listDirNames(iconDir)) {
        if (endsWithIgnoreCase(name, ".png") || endsWithIgnoreCase(name, ".jpg") || endsWithIgnoreCase(name, ".jpeg")) {
            return iconDir + "/" + name;
        }
    }
    return {};
}

std::string findRgssIconPath(const std::string& gameDir) {
    static const char* cands[] = {"icon.png", "cover.png", "icon.jpg", "cover.jpg", "icon.jpeg", "cover.jpeg"};
    for (const char* c : cands) {
        std::string p = gameDir + "/" + c;
        if (isRegularFile(p)) return p;
    }
    for (const auto& name : listDirNames(gameDir)) {
        std::string l = toLower(name);
        if (l == "icon.png" || l == "cover.png" || l == "icon.jpg" || l == "cover.jpg") {
            return gameDir + "/" + name;
        }
    }
    return {};
}

int countMvSaves(const std::string& saveDir) {
    int count = 0;
    for (const auto& name : listDirNames(saveDir)) {
        std::string l = toLower(name);
        if ((endsWithIgnoreCase(l, ".rpgsave") && l != "config.rpgsave" && l != "global.rpgsave") ||
            (endsWithIgnoreCase(l, ".rmmzsave") && l != "config.rmmzsave" && l != "global.rmmzsave")) {
            count++;
        }
    }
    return count;
}

int countRgssSaves(const std::string& gameDir) {
    int count = 0;
    std::string dirs[3] = {gameDir, gameDir + "/Save", gameDir + "/save"};
    for (const auto& d : dirs) {
        for (const auto& name : listDirNames(d)) {
            std::string l = toLower(name);
            if (startsWithIgnoreCase(l, "save") &&
                (endsWithIgnoreCase(l, ".rvdata2") || endsWithIgnoreCase(l, ".rvdata") || endsWithIgnoreCase(l, ".rxdata"))) {
                count++;
            }
        }
    }
    return count;
}

int countWolfSaves(const std::string& gameDir) {
    int count = 0;
    std::string dirs[2] = {gameDir + "/Save", gameDir + "/save"};
    for (const auto& d : dirs) {
        for (const auto& name : listDirNames(d)) {
            std::string l = toLower(name);
            if (endsWithIgnoreCase(l, ".sav") && l != "syssavedata.sav") {
                count++;
            }
        }
    }
    return count;
}

GameEntry inspectMvGame(const std::string& id, const std::string& folderName,
                        const std::string& gameDir, const std::string& wwwRoot) {
    GameEntry g;
    g.id = id;
    g.folderName = folderName;
    g.engine = GameEngine::MV;
    g.gameDir = gameDir;
    g.wwwRoot = wwwRoot;
    g.saveDir = gameDir + "/save";

    std::string cfgText = readTextFile(gameDir + "/mv-loader.json", 32 * 1024);
    std::string cfgTitle = cfgText.empty() ? "" : extractJsonStringField(cfgText, "title");

    std::string sysText = readTextFile(wwwRoot + "/data/System.json", 128 * 1024);
    std::string sysTitle = sysText.empty() ? "" : extractJsonStringField(sysText, "gameTitle");
    g.encrypted = !sysText.empty() &&
                  (extractJsonBoolField(sysText, "hasEncryptedImages") ||
                   extractJsonBoolField(sysText, "hasEncryptedAudio"));

    std::string htmlText = readTextFile(wwwRoot + "/index.html", 16 * 1024);
    std::string htmlTitle = htmlText.empty() ? "" : parseHtmlTitle(htmlText);

    if (!cfgTitle.empty()) g.title = cfgTitle;
    else if (!sysTitle.empty() && isValidUtf8(sysTitle)) g.title = sysTitle;
    else if (!htmlTitle.empty() && isValidUtf8(htmlTitle)) g.title = htmlTitle;
    else g.title = folderName;

    std::string pluginsText = readTextFile(wwwRoot + "/js/plugins.js", 512 * 1024);
    g.pluginCount = countEnabledPlugins(pluginsText);
    g.saveCount = countMvSaves(g.saveDir);
    g.iconPath = findMvIconPath(wwwRoot);
    return g;
}

struct RgssIniInfo {
    bool valid = false;
    GameEngine engine = GameEngine::VXAce;
    std::string title;
};

RgssIniInfo parseRgssIni(const std::string& iniPath) {
    RgssIniInfo out;
    std::string text = readTextFile(iniPath, 16 * 1024);
    if (text.empty()) return out;

    bool hasGameSection = false;
    bool hasRgssMarker = false;
    std::istringstream iss(text);
    std::string line;
    while (std::getline(iss, line)) {
        std::string t = trim(line);
        if (t.empty() || t[0] == ';' || t[0] == '#') continue;
        if (toLower(t) == "[game]") {
            hasGameSection = true;
            continue;
        }
        size_t eq = t.find('=');
        if (eq == std::string::npos) continue;
        std::string key = toLower(trim(t.substr(0, eq)));
        std::string val = trim(t.substr(eq + 1));
        std::string valLower = toLower(val);
        if (key == "library") {
            if (valLower.find("rgss3") != std::string::npos) {
                hasRgssMarker = true;
                out.engine = GameEngine::VXAce;
            } else if (valLower.find("rgss2") != std::string::npos) {
                hasRgssMarker = true;
                out.engine = GameEngine::VX;
            } else if (valLower.find("rgss1") != std::string::npos) {
                hasRgssMarker = true;
                out.engine = GameEngine::XP;
            }
        } else if (key == "scripts") {
            if (valLower.find(".rvdata2") != std::string::npos) {
                hasRgssMarker = true;
                out.engine = GameEngine::VXAce;
            } else if (valLower.find(".rvdata") != std::string::npos) {
                hasRgssMarker = true;
                out.engine = GameEngine::VX;
            } else if (valLower.find(".rxdata") != std::string::npos) {
                hasRgssMarker = true;
                out.engine = GameEngine::XP;
            }
        } else if (key == "title" && !val.empty()) {
            if (isValidUtf8(val)) out.title = val;
        }
    }
    out.valid = hasGameSection && hasRgssMarker;
    return out;
}

bool tryInspectFolder(const std::string& id, const std::string& folderName,
                      const std::string& gameDir, GameEntry& out) {
    // 0. RPG Maker MZ: <dir>/js/rmmz_core.js or <dir>/www/js/rmmz_core.js
    if (isRegularFile(gameDir + "/js/rmmz_core.js")) {
        out = inspectMvGame(id, folderName, gameDir, gameDir);
        out.engine = GameEngine::MZ;
        return true;
    }
    if (isRegularFile(gameDir + "/www/js/rmmz_core.js")) {
        out = inspectMvGame(id, folderName, gameDir, gameDir + "/www");
        out.engine = GameEngine::MZ;
        return true;
    }
    // 1. Standard RPG Maker MV: <dir>/www/index.html
    if (isRegularFile(gameDir + "/www/index.html")) {
        out = inspectMvGame(id, folderName, gameDir, gameDir + "/www");
        return true;
    }
    // 2. Flat MV web export: <dir>/index.html + <dir>/js/rpg_core.js
    if (isRegularFile(gameDir + "/index.html") && isRegularFile(gameDir + "/js/rpg_core.js")) {
        out = inspectMvGame(id, folderName, gameDir, gameDir);
        return true;
    }

    // 3. RPG Maker VX Ace / VX / XP
    auto entries = listDirNames(gameDir);
    std::string validIniPath;
    RgssIniInfo iniInfo;
    bool hasRgss3a = false, hasRgss2a = false, hasRgssad = false;
    bool hasScripts3 = isRegularFile(gameDir + "/Data/Scripts.rvdata2") || isRegularFile(gameDir + "/data/Scripts.rvdata2");
    bool hasScripts2 = isRegularFile(gameDir + "/Data/Scripts.rvdata") || isRegularFile(gameDir + "/data/Scripts.rvdata");
    bool hasScripts1 = isRegularFile(gameDir + "/Data/Scripts.rxdata") || isRegularFile(gameDir + "/data/Scripts.rxdata");

    for (const auto& name : entries) {
        std::string l = toLower(name);
        if (endsWithIgnoreCase(l, ".rgss3a")) hasRgss3a = true;
        else if (endsWithIgnoreCase(l, ".rgss2a")) hasRgss2a = true;
        else if (endsWithIgnoreCase(l, ".rgssad")) hasRgssad = true;
        else if (endsWithIgnoreCase(l, ".ini")) {
            std::string p = gameDir + "/" + name;
            RgssIniInfo cand = parseRgssIni(p);
            if (cand.valid && (validIniPath.empty() || l == "game.ini")) {
                validIniPath = p;
                iniInfo = cand;
            }
        }
    }

    bool hasRgssAssets = hasRgss3a || hasRgss2a || hasRgssad || hasScripts3 || hasScripts2 || hasScripts1;
    if (iniInfo.valid || hasRgssAssets) {
        GameEntry g;
        g.id = id;
        g.folderName = folderName;
        g.gameDir = gameDir;
        g.wwwRoot = gameDir;
        g.saveDir = gameDir;
        if (iniInfo.valid) {
            g.engine = iniInfo.engine;
        } else if (hasRgss3a || hasScripts3) {
            g.engine = GameEngine::VXAce;
        } else if (hasRgss2a || hasScripts2) {
            g.engine = GameEngine::VX;
        } else {
            g.engine = GameEngine::XP;
        }
        std::string cfgText = readTextFile(gameDir + "/mv-loader.json", 32 * 1024);
        std::string cfgTitle = cfgText.empty() ? "" : extractJsonStringField(cfgText, "title");
        if (!cfgTitle.empty()) g.title = cfgTitle;
        else if (!iniInfo.title.empty()) g.title = iniInfo.title;
        else g.title = folderName;

        g.encrypted = hasRgss3a || hasRgss2a || hasRgssad;
        g.saveCount = countRgssSaves(gameDir);
        g.iconPath = findRgssIconPath(gameDir);
        out = std::move(g);
        return true;
    }

    // 4. WOLF RPG Editor: Data.wolf, Data/*.wolf, or Data/BasicData/Game.dat
    bool hasWolfArchive = false;
    bool hasWolfExe = false;
    for (const auto& name : entries) {
        std::string l = toLower(name);
        if (l == "data.wolf" || l == "data.dxa") hasWolfArchive = true;
        else if (endsWithIgnoreCase(l, ".wolf")) hasWolfArchive = true;
        if (l == "game.exe" || l == "gamepro.exe" || l == "config.exe") hasWolfExe = true;
    }
    if (!hasWolfArchive && isDir(gameDir + "/Data")) {
        for (const auto& name : listDirNames(gameDir + "/Data")) {
            std::string l = toLower(name);
            if (endsWithIgnoreCase(l, ".wolf") || endsWithIgnoreCase(l, ".dxa")) {
                hasWolfArchive = true;
                break;
            }
        }
    }
    bool hasWolfBasicData = isRegularFile(gameDir + "/Data/BasicData/Game.dat") ||
                            isRegularFile(gameDir + "/Data/BasicData/SysDatabase.dat") ||
                            isRegularFile(gameDir + "/data/basicdata/game.dat");
    if (hasWolfArchive || hasWolfBasicData) {
        (void)hasWolfExe;
        GameEntry g;
        g.id = id;
        g.folderName = folderName;
        g.engine = GameEngine::Wolf;
        g.gameDir = gameDir;
        g.wwwRoot = gameDir;
        g.saveDir = gameDir + "/Save";

        std::string cfgText = readTextFile(gameDir + "/mv-loader.json", 32 * 1024);
        std::string cfgTitle = cfgText.empty() ? "" : extractJsonStringField(cfgText, "title");
        g.title = !cfgTitle.empty() ? cfgTitle : folderName;
        g.encrypted = hasWolfArchive;
        g.saveCount = countWolfSaves(gameDir);
        g.iconPath = findRgssIconPath(gameDir);
        out = std::move(g);
        return true;
    }
    return false;
}

void scanGamesRoot(const std::string& rootDir, const std::string& idPrefix, std::vector<GameEntry>& games) {
    if (!isDir(rootDir)) return;
    for (const auto& name : listDirNames(rootDir)) {
        if (name.empty() || name[0] == '.') continue;
        std::string lower = toLower(name);
        if (IGNORED_DIRS.count(lower)) continue;
        if (endsWithIgnoreCase(lower, ".nro") || endsWithIgnoreCase(lower, ".ini") ||
            endsWithIgnoreCase(lower, ".log") || endsWithIgnoreCase(lower, ".json") ||
            endsWithIgnoreCase(lower, ".txt") || endsWithIgnoreCase(lower, ".md")) {
            continue;
        }
        std::string dir = rootDir + "/" + name;
        if (!isDir(dir)) continue;

        std::string fullId = idPrefix.empty() ? name : (idPrefix + "/" + name);
        GameEntry g;
        if (tryInspectFolder(fullId, name, dir, g)) {
            logMsg("[games] + '%s' [%s] (%s)", g.title.c_str(), engineBadgeLabel(g.engine), g.gameDir.c_str());
            games.push_back(std::move(g));
            continue;
        }
        // Check 1 level deeper for nested unzip folders
        for (const auto& sub : listDirNames(dir)) {
            if (sub.empty() || sub[0] == '.' || IGNORED_DIRS.count(toLower(sub))) continue;
            std::string subDir = dir + "/" + sub;
            if (!isDir(subDir)) continue;
            GameEntry nested;
            if (tryInspectFolder(fullId + "/" + sub, name, subDir, nested)) {
                logMsg("[games] + '%s' [%s] (nested: %s)", nested.title.c_str(),
                       engineBadgeLabel(nested.engine), nested.gameDir.c_str());
                games.push_back(std::move(nested));
            }
        }
    }
}

std::vector<GameEntry> discoverGames(const std::string& launcherDir) {
    std::vector<GameEntry> games;
    // Primary location: <launcherDir>/games/
    scanGamesRoot(launcherDir + "/games", "games", games);
    // Backwards-compatible fallback: games directly in <launcherDir>/
    scanGamesRoot(launcherDir, "", games);

    std::sort(games.begin(), games.end(), [](const GameEntry& a, const GameEntry& b) {
        return toLower(a.title) < toLower(b.title);
    });
    logMsg("[games] discovered %zu game(s) in %s", games.size(), launcherDir.c_str());
    return games;
}

std::string findMvEngineNro(const std::string& launcherDir) {
    std::vector<std::string> cands = {
        launcherDir + "/engines/mv-engine-switch2.nro",
        launcherDir + "/mv-engine-switch2.nro",
        launcherDir + "/engines/switch2-MV-loader.nro",
        launcherDir + "/switch2-MV-loader.nro",
    };
    for (const auto& c : cands) {
        if (isRegularFile(c)) return c;
    }
    return {};
}

std::string findMzEngineNro(const std::string& launcherDir) {
    std::vector<std::string> cands = {
        launcherDir + "/engines/mz-engine-switch2.nro",
        launcherDir + "/mz-engine-switch2.nro",
    };
    for (const auto& c : cands) {
        if (isRegularFile(c)) return c;
    }
    return {};
}

std::string findMkxpzEngineNro(const std::string& launcherDir) {
    std::vector<std::string> cands = {
        launcherDir + "/engines/mkxp-z-switch2.nro",
        launcherDir + "/mkxp-z-switch2.nro",
        launcherDir + "/engines/mkxp-z.nro",
        launcherDir + "/mkxp-z.nro",
        "sdmc:/switch/mkxp-z/mkxp-z-switch2.nro",
        "sdmc:/switch/mkxp-z/mkxp-z.nro",
    };
    for (const auto& c : cands) {
        if (isRegularFile(c)) return c;
    }
    return {};
}

std::string findWolfEngineNro(const std::string& launcherDir) {
    std::vector<std::string> cands = {
        launcherDir + "/engines/wolf-engine-switch2.nro",
        launcherDir + "/wolf-engine-switch2.nro",
    };
    for (const auto& c : cands) {
        if (isRegularFile(c)) return c;
    }
    return {};
}

std::string loadLastSelectedGameId(const std::string& launcherDir) {
    std::string text = readTextFile(launcherDir + "/loader-state.json", 4096);
    if (text.empty()) return {};
    return extractJsonStringField(text, "lastGameId");
}

void saveLastSelectedGameId(const std::string& launcherDir, const std::string& id) {
    FILE* f = fopen((launcherDir + "/loader-state.json").c_str(), "wb");
    if (!f) return;
    fprintf(f, "{\n  \"lastGameId\": \"");
    for (char c : id) {
        if (c == '"' || c == '\\') fputc('\\', f);
        fputc(c, f);
    }
    fprintf(f, "\"\n}\n");
    fclose(f);
}

struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
    bool contains(int px, int py) const {
        return w > 0 && h > 0 && px >= x && py >= y && px <= x + w && py <= y + h;
    }
};

std::string makeInitials(const std::string& title, GameEngine engine) {
    std::string out;
    for (char c : title) {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(c))));
            if (out.size() == 2) break;
        }
    }
    if (!out.empty()) return out;
    return engine == GameEngine::MV ? "MV" : "VX";
}

} // namespace

int main(int argc, char* argv[]) {
    g_bootTicks = armGetSystemTick();

    std::string selfNro = (argc > 0 && argv[0] && argv[0][0])
        ? normalizeSdmcPath(argv[0])
        : "sdmc:/switch/SW2RPGMGL/SW2RPGMGL.nro";
    std::string launcherDir = dirNameOf(selfNro);

    std::string logDir = launcherDir + "/log";
    mkdir(logDir.c_str(), 0777);
    g_logFile = fopen((logDir + "/launcher.log").c_str(), "wb");
    logMsg("=== SW2RPGMGL v" SW2RPGMGL_VERSION " (Native libounce UI — launcher.log) ===");
    logMsg("selfNro: %s", selfNro.c_str());
    logMsg("launcherDir: %s", launcherDir.c_str());

    // Initialize Switch 2 input (controllers + touchscreen)
    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);
    hidInitializeTouchScreen();

    // Initialize Switch 2 built-in system shared font
    Result plRc = plInitialize(PlServiceType_User);
    PlFontData stdFont {};
    FontRenderer font;
    if (R_SUCCEEDED(plRc) && R_SUCCEEDED(plGetSharedFontByType(&stdFont, PlSharedFontType_Standard))) {
        if (!font.init(stdFont)) {
            logMsg("[font] FreeType init failed");
        } else {
            logMsg("[font] Loaded Switch 2 Standard shared font (%zu bytes)", stdFont.size);
        }
    } else {
        logMsg("[font] plInitialize/plGetSharedFontByType failed: 0x%x", plRc);
    }

    // Initialize Switch 2 1280x720 linear framebuffer
    NWindow* win = nwindowGetDefault();
    Framebuffer fb {};
    Result fbRc = framebufferCreate(&fb, win, SCREEN_W, SCREEN_H, PIXEL_FORMAT_RGBA_8888, 2);
    if (R_SUCCEEDED(fbRc)) {
        fbRc = framebufferMakeLinear(&fb);
    }
    if (R_FAILED(fbRc)) {
        logMsg("[fb] Framebuffer init failed: 0x%x", fbRc);
        font.shutdown();
        if (R_SUCCEEDED(plRc)) plExit();
        if (g_logFile) fclose(g_logFile);
        return 1;
    }

    // Discover games & engines
    std::vector<GameEntry> games = discoverGames(launcherDir);
    std::string mvEnginePath = findMvEngineNro(launcherDir);
    std::string mzEnginePath = findMzEngineNro(launcherDir);
    std::string mkxpzEnginePath = findMkxpzEngineNro(launcherDir);
    std::string wolfEnginePath = findWolfEngineNro(launcherDir);
    logMsg("[engines] mv=%s", mvEnginePath.empty() ? "(missing)" : mvEnginePath.c_str());
    logMsg("[engines] mz=%s", mzEnginePath.empty() ? "(missing)" : mzEnginePath.c_str());
    logMsg("[engines] mkxpz=%s", mkxpzEnginePath.empty() ? "(missing)" : mkxpzEnginePath.c_str());
    logMsg("[engines] wolf=%s", wolfEnginePath.empty() ? "(missing)" : wolfEnginePath.c_str());

    int selected = 0;
    int scrollTop = 0;
    const std::string lastId = loadLastSelectedGameId(launcherDir);
    if (!lastId.empty()) {
        for (int i = 0; i < static_cast<int>(games.size()); i++) {
            if (games[i].id == lastId) {
                selected = i;
                break;
            }
        }
    }

    constexpr int headerH = 92;
    constexpr int footerH = 56;
    constexpr int padX = 44;
    constexpr int contentY = headerH + 16;
    constexpr int contentH = SCREEN_H - headerH - footerH - 32; // 540
    constexpr int rowH = 80;
    constexpr int rowGap = 10;
    constexpr int visibleRows = (contentH + rowGap) / (rowH + rowGap); // 6

    if (selected >= visibleRows) {
        scrollTop = std::max(0, selected - visibleRows + 1);
    }

    std::string statusBanner;
    double statusBannerUntil = 0.0;
    auto showToast = [&](const std::string& msg, double durationMs = 2600.0) {
        statusBanner = msg;
        statusBannerUntil = nowMs() + durationMs;
    };

    // Launch target state (set when user launches a game)
    bool shouldLaunch = false;
    std::string nextLoadPath;
    std::string nextLoadArgs;

    auto tryLaunchSelected = [&]() {
        if (games.empty() || selected < 0 || selected >= static_cast<int>(games.size())) return;
        const GameEntry& g = games[selected];
        saveLastSelectedGameId(launcherDir, g.id);

        if (g.engine == GameEngine::MV) {
            mvEnginePath = findMvEngineNro(launcherDir);
            if (mvEnginePath.empty()) {
                showToast("Missing engines/mv-engine-switch2.nro!", 4000.0);
                logMsg("[launch] ERROR: mv-engine-switch2.nro not found");
                return;
            }
            nextLoadPath = mvEnginePath;
            // nx.js resolves argv[1] ending in .nro as its own romfs entrypoint, while passing
            // argv[2]=gameDir and argv[3]=returnNro to Switch.argv in JavaScript.
            nextLoadArgs = "\"" + mvEnginePath + "\" \"" + mvEnginePath + "\" \"" +
                           g.gameDir + "\" \"" + selfNro + "\"";
            shouldLaunch = true;
            logMsg("[launch] MV '%s' -> %s", g.title.c_str(), nextLoadArgs.c_str());
        } else if (g.engine == GameEngine::MZ) {
            mzEnginePath = findMzEngineNro(launcherDir);
            if (mzEnginePath.empty()) {
                showToast("Missing engines/mz-engine-switch2.nro!", 4000.0);
                logMsg("[launch] ERROR: mz-engine-switch2.nro not found");
                return;
            }
            nextLoadPath = mzEnginePath;
            nextLoadArgs = "\"" + mzEnginePath + "\" \"" + mzEnginePath + "\" \"" +
                           g.gameDir + "\" \"" + selfNro + "\"";
            shouldLaunch = true;
            logMsg("[launch] MZ '%s' -> %s", g.title.c_str(), nextLoadArgs.c_str());
        } else if (g.engine == GameEngine::Wolf) {
            wolfEnginePath = findWolfEngineNro(launcherDir);
            if (wolfEnginePath.empty()) {
                showToast("Missing engines/wolf-engine-switch2.nro!", 4000.0);
                logMsg("[launch] ERROR: wolf-engine-switch2.nro not found");
                return;
            }
            nextLoadPath = wolfEnginePath;
            nextLoadArgs = "\"" + wolfEnginePath + "\" \"" + g.gameDir + "\" \"" + selfNro + "\"";
            shouldLaunch = true;
            logMsg("[launch] WOLF '%s' -> %s", g.title.c_str(), nextLoadArgs.c_str());
        } else {
            mkxpzEnginePath = findMkxpzEngineNro(launcherDir);
            if (mkxpzEnginePath.empty()) {
                showToast("Missing engines/mkxp-z-switch2.nro!", 4000.0);
                logMsg("[launch] ERROR: mkxp-z-switch2.nro not found");
                return;
            }
            nextLoadPath = mkxpzEnginePath;
            nextLoadArgs = "\"" + mkxpzEnginePath + "\" \"" + g.gameDir + "\" \"" + selfNro + "\"";
            shouldLaunch = true;
            logMsg("[launch] RGSS '%s' -> %s", g.title.c_str(), nextLoadArgs.c_str());
        }
    };

    auto rescan = [&]() {
        std::string prevId = (!games.empty() && selected < static_cast<int>(games.size())) ? games[selected].id : "";
        games = discoverGames(launcherDir);
        mvEnginePath = findMvEngineNro(launcherDir);
        mzEnginePath = findMzEngineNro(launcherDir);
        mkxpzEnginePath = findMkxpzEngineNro(launcherDir);
        wolfEnginePath = findWolfEngineNro(launcherDir);
        selected = 0;
        scrollTop = 0;
        if (!prevId.empty()) {
            for (int i = 0; i < static_cast<int>(games.size()); i++) {
                if (games[i].id == prevId) { selected = i; break; }
            }
        }
        if (selected >= visibleRows) scrollTop = std::max(0, selected - visibleRows + 1);
        char buf[96];
        snprintf(buf, sizeof(buf), "Rescanned SD card: %zu game%s found",
                 games.size(), games.size() == 1 ? "" : "s");
        showToast(buf, 2200.0);
    };

    // Input state
    bool prevUp = false, prevDown = false;
    int holdDir = 0;
    double holdNextMs = 0.0;
    bool prevTouchDown = false;
    int touchStartX = 0, touchStartY = 0;
    int lastTouchX = 0, lastTouchY = 0;
    int touchPrevY = 0;
    float touchScrollAccum = 0.0f;
    bool touchDragged = false;
    bool touchStartedInList = false;
    bool touchOnScrollbar = false;

    std::vector<std::pair<int, Rect>> cardRects;
    Rect playBtnRect {};
    Rect rescanBtnRect {};
    Canvas canvas;

    constexpr int gap = 24;
    constexpr int totalW = SCREEN_W - padX * 2;
    constexpr int listW = (totalW * 62) / 100;
    constexpr int detailW = totalW - listW - gap;
    constexpr int detailX = padX + listW + gap;
    constexpr int trackX = padX + listW + 6;
    constexpr int trackW = 6;

    while (appletMainLoop()) {
        padUpdate(&pad);
        u64 kDown = padGetButtonsDown(&pad);
        u64 kHeld = padGetButtons(&pad);
        HidAnalogStickState stickL = padGetStickPos(&pad, 0);

        bool up = (kHeld & HidNpadButton_Up) || (stickL.y > 16000);
        bool down = (kHeld & HidNpadButton_Down) || (stickL.y < -16000);
        double tNow = nowMs();
        bool movedByPad = false;

        int dir = up ? -1 : (down ? 1 : 0);
        if (dir != 0) {
            if (dir != holdDir || (!prevUp && !prevDown)) {
                if (!games.empty()) {
                    selected = (selected + dir + static_cast<int>(games.size())) % static_cast<int>(games.size());
                    movedByPad = true;
                }
                holdDir = dir;
                holdNextMs = tNow + 320.0;
            } else if (tNow >= holdNextMs) {
                if (!games.empty()) {
                    selected = (selected + dir + static_cast<int>(games.size())) % static_cast<int>(games.size());
                    movedByPad = true;
                }
                holdNextMs = tNow + 95.0;
            }
        } else {
            holdDir = 0;
        }
        prevUp = up;
        prevDown = down;

        if ((kDown & HidNpadButton_L) && !games.empty()) {
            selected = std::max(0, selected - visibleRows);
            movedByPad = true;
        }
        if ((kDown & HidNpadButton_R) && !games.empty()) {
            selected = std::min(static_cast<int>(games.size()) - 1, selected + visibleRows);
            movedByPad = true;
        }
        if (kDown & HidNpadButton_X) {
            rescan();
            movedByPad = true;
        }
        if (kDown & HidNpadButton_Plus) {
            logMsg("[exit] user pressed Plus (+) -> exiting to hbmenu");
            break;
        }
        if ((kDown & HidNpadButton_A) && !games.empty()) {
            tryLaunchSelected();
            if (shouldLaunch) break;
        }

        int maxScroll = std::max(0, static_cast<int>(games.size()) - visibleRows);

        // Touchscreen tap + drag-to-scroll + scrollbar drag handling
        HidTouchScreenState touchState {};
        bool touchDown = false;
        int curTouchX = lastTouchX;
        int curTouchY = lastTouchY;
        if (hidGetTouchScreenStates(&touchState, 1) > 0 && touchState.count > 0) {
            touchDown = true;
            curTouchX = static_cast<int>(touchState.touches[0].x);
            curTouchY = static_cast<int>(touchState.touches[0].y);
        }

        if (touchDown && !prevTouchDown) {
            // Finger down
            touchStartX = curTouchX;
            touchStartY = curTouchY;
            touchPrevY = curTouchY;
            touchScrollAccum = 0.0f;
            touchDragged = false;
            touchOnScrollbar = (!games.empty() && maxScroll > 0 &&
                                curTouchX >= trackX - 12 && curTouchX <= trackX + trackW + 14 &&
                                curTouchY >= contentY && curTouchY <= contentY + contentH);
            touchStartedInList = (!games.empty() && !touchOnScrollbar &&
                                  curTouchX >= padX && curTouchX <= padX + listW &&
                                  curTouchY >= contentY && curTouchY <= contentY + contentH);
            if (touchOnScrollbar) {
                float frac = std::clamp(static_cast<float>(curTouchY - contentY) / std::max(1, contentH), 0.0f, 1.0f);
                scrollTop = std::clamp(static_cast<int>(std::round(frac * maxScroll)), 0, maxScroll);
                touchDragged = true;
            }
        } else if (touchDown && prevTouchDown) {
            // Finger held / dragging
            int totalDy = curTouchY - touchStartY;
            int totalDx = curTouchX - touchStartX;
            if (std::abs(totalDy) > 14 || std::abs(totalDx) > 20) {
                touchDragged = true;
            }
            if (touchOnScrollbar && maxScroll > 0) {
                float frac = std::clamp(static_cast<float>(curTouchY - contentY) / std::max(1, contentH), 0.0f, 1.0f);
                scrollTop = std::clamp(static_cast<int>(std::round(frac * maxScroll)), 0, maxScroll);
            } else if (touchStartedInList && touchDragged && maxScroll > 0) {
                int stepDy = curTouchY - touchPrevY;
                touchScrollAccum -= static_cast<float>(stepDy);
                constexpr float rowStepPx = static_cast<float>(rowH + rowGap);
                while (touchScrollAccum >= rowStepPx) {
                    if (scrollTop < maxScroll) scrollTop++;
                    touchScrollAccum -= rowStepPx;
                }
                while (touchScrollAccum <= -rowStepPx) {
                    if (scrollTop > 0) scrollTop--;
                    touchScrollAccum += rowStepPx;
                }
            }
            touchPrevY = curTouchY;
        } else if (!touchDown && prevTouchDown) {
            // Finger lifted: process tap only if it wasn't a scroll drag
            if (!touchDragged) {
                if (games.empty() && rescanBtnRect.contains(lastTouchX, lastTouchY)) {
                    rescan();
                } else if (!games.empty() && playBtnRect.contains(lastTouchX, lastTouchY)) {
                    tryLaunchSelected();
                    if (shouldLaunch) break;
                } else {
                    for (const auto& [idx, r] : cardRects) {
                        if (r.contains(lastTouchX, lastTouchY)) {
                            if (idx == selected) {
                                tryLaunchSelected();
                                if (shouldLaunch) break;
                            } else {
                                selected = idx;
                            }
                            break;
                        }
                    }
                    if (shouldLaunch) break;
                }
            }
            touchStartedInList = false;
            touchOnScrollbar = false;
            touchDragged = false;
            touchScrollAccum = 0.0f;
        }
        lastTouchX = curTouchX;
        lastTouchY = curTouchY;
        prevTouchDown = touchDown;

        // Clamp scrollTop; only auto-follow `selected` when navigated by gamepad/buttons
        if (scrollTop < 0) scrollTop = 0;
        if (scrollTop > maxScroll) scrollTop = maxScroll;
        if (movedByPad) {
            if (selected < scrollTop) scrollTop = selected;
            if (selected >= scrollTop + visibleRows) scrollTop = std::max(0, selected - visibleRows + 1);
        }

        // Lazily decode at most 1 visible game icon per frame so startup is instantaneous
        int endIdx = std::min(static_cast<int>(games.size()), scrollTop + visibleRows);
        for (int i = scrollTop; i < endIdx; i++) {
            GameEntry& g = games[i];
            if (!g.iconAttempted && !g.iconPath.empty()) {
                g.iconAttempted = true;
                ImageRGBA raw = loadGameIconRaw(g.iconPath);
                if (raw.valid()) {
                    g.iconSmall = resizeImageSquareFit(raw, 56);
                    g.iconLarge = resizeImageSquareFit(raw, 112);
                }
                break; // 1 icon per frame
            }
        }

        // Render frame to 1280x720 linear framebuffer
        u32 stride = 0;
        u32* fbBuf = reinterpret_cast<u32*>(framebufferBegin(&fb, &stride));
        if (!fbBuf) continue;
        canvas.bind(fbBuf, SCREEN_W, SCREEN_H, static_cast<int>(stride));

        // Background
        canvas.fillRect(0, 0, SCREEN_W, SCREEN_H, hexColor(0x0d1018));

        // Header bar
        canvas.fillRect(0, 0, SCREEN_W, headerH, hexColor(0x141926));
        canvas.fillRect(0, headerH - 2, SCREEN_W, 2, hexColor(0x5c7cfa));

        font.drawText(canvas, "SW2RPGMGL v" SW2RPGMGL_VERSION, padX, 18, 28, hexColor(0xf1f5ff));
        font.drawText(canvas, "Switch 2 RPG Maker & WOLF RPG Launcher (MV / MZ / VX Ace / WOLF)  \xE2\x80\xA2  Native Switch 2 UI",
                      padX, 56, 15, hexColor(0x8b98b8));

        char countBuf[64];
        snprintf(countBuf, sizeof(countBuf), "%zu Game%s Found",
                 games.size(), games.size() == 1 ? "" : "s");
        font.drawText(canvas, countBuf, SCREEN_W - padX, 24, 17, hexColor(0x9db4ff), FontRenderer::Align::Right);
        font.drawText(canvas, font.truncate(launcherDir, 13, 460), SCREEN_W - padX, 54, 13,
                      hexColor(0x6f7d9d), FontRenderer::Align::Right);

        cardRects.clear();
        playBtnRect = {};
        rescanBtnRect = {};

        if (games.empty()) {
            // Empty-state setup guide
            int boxW = 880;
            int boxH = 440;
            int bx = (SCREEN_W - boxW) / 2;
            int by = contentY + (contentH - boxH) / 2;
            canvas.drawRoundedRect(bx, by, boxW, boxH, 14, hexColor(0x151b2b), 2, hexColor(0x2d3958));
            font.drawText(canvas, "No RPG Maker Games Found", bx + 32, by + 28, 26, hexColor(0xffd166));
            font.drawText(canvas, "Copy any PC RPG Maker MV (www/) or VX Ace (Game.ini) game into a subfolder here:",
                          bx + 32, by + 70, 16, hexColor(0xc5d0ea));

            int codeY = by + 108;
            int codeH = 228;
            canvas.drawRoundedRect(bx + 32, codeY, boxW - 64, codeH, 8, hexColor(0x0c1019));
            std::vector<std::string> lines = {
                launcherDir + "/",
                "  |-- SW2RPGMGL.nro",
                "  |-- engines/  (mv-engine-switch2.nro, mkxp-z-switch2.nro)",
                "  |-- RPGVXAce/ (optional shared VX Ace RTP)",
                "  +-- games/",
                "      |-- my-mv-game/www/index.html",
                "      +-- my-vxace-game/Game.ini"
            };
            for (size_t i = 0; i < lines.size(); i++) {
                font.drawText(canvas, font.truncate(lines[i], 15, boxW - 100),
                              bx + 50, codeY + 14 + static_cast<int>(i) * 29, 15, hexColor(0x9ec5ff));
            }

            rescanBtnRect = {bx + 32, by + boxH - 68, 210, 44};
            canvas.drawRoundedRect(rescanBtnRect.x, rescanBtnRect.y, rescanBtnRect.w, rescanBtnRect.h,
                                   8, hexColor(0x334678));
            font.drawText(canvas, "X   Rescan SD Card",
                          rescanBtnRect.x + rescanBtnRect.w / 2, rescanBtnRect.y + rescanBtnRect.h / 2,
                          17, hexColor(0xffffff), FontRenderer::Align::Center, true);
        } else {
            // Two-column layout: left 6-row scrollable list (~62%) + right details panel (~36%)
            for (int i = scrollTop; i < endIdx; i++) {
                const GameEntry& g = games[i];
                int rowIdx = i - scrollTop;
                int cy = contentY + rowIdx * (rowH + rowGap);
                bool isSel = (i == selected);

                cardRects.push_back({i, {padX, cy, listW, rowH}});
                canvas.drawRoundedRect(padX, cy, listW, rowH, 12,
                                       isSel ? hexColor(0x1f2942) : hexColor(0x141926),
                                       isSel ? 3 : 1,
                                       isSel ? hexColor(0x6c8cff) : hexColor(0x232c43));

                if (isSel) {
                    canvas.drawRoundedRect(padX + 5, cy + 12, 5, rowH - 24, 2, hexColor(0x6c8cff));
                }

                // 56x56 icon or monogram
                int iconSize = 56;
                int ix = padX + 18;
                int iy = cy + (rowH - iconSize) / 2;
                if (g.iconSmall.valid()) {
                    canvas.blitImageRounded(g.iconSmall, ix, iy, 8);
                } else {
                    auto [bg, fg] = pickMonogramColors(g.folderName);
                    canvas.drawRoundedRect(ix, iy, iconSize, iconSize, 8, bg);
                    font.drawText(canvas, makeInitials(g.title, g.engine),
                                  ix + iconSize / 2, iy + iconSize / 2, 22, fg,
                                  FontRenderer::Align::Center, true);
                }

                // Engine badge pill
                std::string badge = engineBadgeLabel(g.engine);
                int badgeW = badge.size() > 4 ? 72 : (badge.size() == 4 ? 58 : 46);
                int badgeH = 24;
                int badgeX = padX + listW - badgeW - 16;
                int badgeY = cy + 13;
                auto [badgeBg, badgeFg] = engineBadgeColor(g.engine);
                canvas.drawRoundedRect(badgeX, badgeY, badgeW, badgeH, 6, badgeBg);
                font.drawText(canvas, badge, badgeX + badgeW / 2, badgeY + badgeH / 2, 12,
                              badgeFg, FontRenderer::Align::Center, true);

                // Title & metadata line
                int textX = ix + iconSize + 16;
                int textMaxW = badgeX - textX - 12;
                font.drawText(canvas, font.truncate(g.title, 20, textMaxW), textX, cy + 13, 20,
                              isSel ? hexColor(0xffffff) : hexColor(0xdce4f7));

                char metaBuf[256];
                if (g.engine == GameEngine::MV || g.engine == GameEngine::MZ) {
                    if (g.saveCount > 0) {
                        snprintf(metaBuf, sizeof(metaBuf), "%s/   \xE2\x80\xA2   %d save%s   \xE2\x80\xA2   %d plugin%s",
                                 g.folderName.c_str(), g.saveCount, g.saveCount == 1 ? "" : "s",
                                 g.pluginCount, g.pluginCount == 1 ? "" : "s");
                    } else {
                        snprintf(metaBuf, sizeof(metaBuf), "%s/   \xE2\x80\xA2   no saves yet   \xE2\x80\xA2   %d plugin%s",
                                 g.folderName.c_str(), g.pluginCount, g.pluginCount == 1 ? "" : "s");
                    }
                } else if (g.engine == GameEngine::Wolf) {
                    if (g.saveCount > 0) {
                        snprintf(metaBuf, sizeof(metaBuf), "%s/   \xE2\x80\xA2   %d save%s   \xE2\x80\xA2   woditor arm64",
                                 g.folderName.c_str(), g.saveCount, g.saveCount == 1 ? "" : "s");
                    } else {
                        snprintf(metaBuf, sizeof(metaBuf), "%s/   \xE2\x80\xA2   no saves yet   \xE2\x80\xA2   woditor arm64",
                                 g.folderName.c_str());
                    }
                } else {
                    if (g.saveCount > 0) {
                        snprintf(metaBuf, sizeof(metaBuf), "%s/   \xE2\x80\xA2   %d save%s   \xE2\x80\xA2   mkxp-z runtime",
                                 g.folderName.c_str(), g.saveCount, g.saveCount == 1 ? "" : "s");
                    } else {
                        snprintf(metaBuf, sizeof(metaBuf), "%s/   \xE2\x80\xA2   no saves yet   \xE2\x80\xA2   mkxp-z runtime",
                                 g.folderName.c_str());
                    }
                }
                font.drawText(canvas, font.truncate(metaBuf, 14, listW - (textX - padX) - 20),
                              textX, cy + 46, 14, isSel ? hexColor(0x9eb4e8) : hexColor(0x73809e));
            }

            // Scrollbar (also touch-draggable)
            if (static_cast<int>(games.size()) > visibleRows) {
                int trackH = contentH;
                canvas.fillRect(trackX, contentY, trackW, trackH, hexColor(0x1d2436));
                int thumbH = std::max(32, (visibleRows * trackH) / static_cast<int>(games.size()));
                int maxSc = std::max(1, static_cast<int>(games.size()) - visibleRows);
                int thumbY = contentY + (scrollTop * (trackH - thumbH)) / maxSc;
                canvas.fillRect(trackX, thumbY, trackW, thumbH,
                                touchOnScrollbar ? hexColor(0x8aa4ff) : hexColor(0x5c7cfa));
            }

            // Right details panel
            if (selected >= 0 && selected < static_cast<int>(games.size())) {
                const GameEntry& sel = games[selected];
                canvas.drawRoundedRect(detailX, contentY, detailW, contentH, 14,
                                       hexColor(0x141926), 2, hexColor(0x252f49));

                int bigIcon = 112;
                int bix = detailX + (detailW - bigIcon) / 2;
                int biy = contentY + 26;
                if (sel.iconLarge.valid()) {
                    canvas.blitImageRounded(sel.iconLarge, bix, biy, 14);
                } else {
                    auto [bg, fg] = pickMonogramColors(sel.folderName);
                    canvas.drawRoundedRect(bix, biy, bigIcon, bigIcon, 14, bg);
                    font.drawText(canvas, makeInitials(sel.title, sel.engine),
                                  bix + bigIcon / 2, biy + bigIcon / 2, 42, fg,
                                  FontRenderer::Align::Center, true);
                }

                int dPad = 24;
                int dMaxW = detailW - dPad * 2;
                font.drawText(canvas, font.truncate(sel.title, 21, dMaxW),
                              detailX + detailW / 2, biy + bigIcon + 18, 21, hexColor(0xffffff),
                              FontRenderer::Align::Center);
                font.drawText(canvas, font.truncate("Folder: " + sel.folderName + "/", 14, dMaxW),
                              detailX + detailW / 2, biy + bigIcon + 50, 14, hexColor(0x8294be),
                              FontRenderer::Align::Center);

                bool engineReady = (sel.engine == GameEngine::MV)
                    ? !mvEnginePath.empty()
                    : (sel.engine == GameEngine::MZ)
                        ? !mzEnginePath.empty()
                        : (sel.engine == GameEngine::Wolf)
                            ? !wolfEnginePath.empty()
                            : !mkxpzEnginePath.empty();

                char savesStr[48], pluginsStr[48];
                snprintf(savesStr, sizeof(savesStr), "%d save file%s", sel.saveCount, sel.saveCount == 1 ? "" : "s");
                snprintf(pluginsStr, sizeof(pluginsStr), "%d enabled", sel.pluginCount);

                std::vector<std::pair<std::string, std::string>> rows;
                if (sel.engine == GameEngine::MV) {
                    rows = {
                        {"Engine", engineFullLabel(sel.engine)},
                        {"Runtime", engineReady ? "mv-engine-switch2.nro ready" : "Missing mv-engine-switch2.nro!"},
                        {"Saves", savesStr},
                        {"Plugins", pluginsStr},
                        {"Assets", sel.encrypted ? "Encrypted (.rpgmvp/.rpgmvo)" : "Unencrypted"},
                    };
                } else if (sel.engine == GameEngine::MZ) {
                    rows = {
                        {"Engine", engineFullLabel(sel.engine)},
                        {"Runtime", engineReady ? "mz-engine-switch2.nro ready" : "Missing mz-engine-switch2.nro!"},
                        {"Saves", savesStr},
                        {"Plugins", pluginsStr},
                        {"Assets", sel.encrypted ? "Encrypted (.png_/.ogg_)" : "Unencrypted"},
                    };
                } else if (sel.engine == GameEngine::Wolf) {
                    rows = {
                        {"Engine", engineFullLabel(sel.engine)},
                        {"Runtime", engineReady ? "wolf-engine-switch2.nro ready" : "Missing wolf-engine-switch2.nro!"},
                        {"Saves", savesStr},
                        {"Archive", sel.encrypted ? "Packed (.wolf)" : "Unpacked Data/"},
                        {"Save Path", sel.folderName + "/Save/"},
                    };
                } else {
                    rows = {
                        {"Engine", engineFullLabel(sel.engine)},
                        {"Runtime", engineReady ? "mkxp-z-switch2.nro ready" : "Missing mkxp-z-switch2.nro!"},
                        {"Saves", savesStr},
                        {"Archive", sel.encrypted ? "Encrypted (.rgss3a/.rgss)" : "Unpacked Data/"},
                        {"Save Path", sel.folderName + "/"},
                    };
                }

                int infoStartY = biy + bigIcon + 86;
                for (size_t r = 0; r < rows.size(); r++) {
                    int ry = infoStartY + static_cast<int>(r) * 30;
                    font.drawText(canvas, rows[r].first, detailX + dPad, ry, 14, hexColor(0x6f7e9e));
                    Color valCol = hexColor(0xd3ddf5);
                    if (rows[r].first == "Runtime") {
                        valCol = engineReady ? hexColor(0x7ee7a8) : hexColor(0xff6b7a);
                    }
                    font.drawText(canvas, font.truncate(rows[r].second, 14, (dMaxW * 68) / 100),
                                  detailX + detailW - dPad, ry, 14, valCol, FontRenderer::Align::Right);
                }

                // Launch button
                playBtnRect = {detailX + dPad, contentY + contentH - 74, detailW - dPad * 2, 50};
                canvas.drawRoundedRect(playBtnRect.x, playBtnRect.y, playBtnRect.w, playBtnRect.h,
                                       10, engineReady ? hexColor(0x4c6ef5) : hexColor(0x4a3040));
                font.drawText(canvas, engineReady ? "A   Launch Game" : "Engine NRO Missing",
                              playBtnRect.x + playBtnRect.w / 2, playBtnRect.y + playBtnRect.h / 2,
                              20, hexColor(0xffffff), FontRenderer::Align::Center, true);
            }
        }

        // Transient toast banner
        if (!statusBanner.empty() && tNow < statusBannerUntil) {
            int toastW = 540;
            int toastH = 36;
            int tx = (SCREEN_W - toastW) / 2;
            int ty = SCREEN_H - footerH - toastH - 10;
            canvas.drawRoundedRect(tx, ty, toastW, toastH, 8, hexColor(0x1e2c4e, 240), 1, hexColor(0x5c7cfa));
            font.drawText(canvas, font.truncate(statusBanner, 14, toastW - 24),
                          tx + toastW / 2, ty + toastH / 2, 14, hexColor(0xe5edff),
                          FontRenderer::Align::Center, true);
        }

        // Footer bar
        int footerY = SCREEN_H - footerH;
        canvas.fillRect(0, footerY, SCREEN_W, footerH, hexColor(0x121622));
        canvas.fillRect(0, footerY, SCREEN_W, 1, hexColor(0x232b40));

        const char* legend = games.empty()
            ? "X: Rescan SD Card   \xE2\x80\xA2   +: Exit to hbmenu"
            : "D-Pad / Stick / Touch Scroll: Browse   \xE2\x80\xA2   A / Tap: Launch   \xE2\x80\xA2   X: Rescan   \xE2\x80\xA2   +: Exit";
        font.drawText(canvas, legend, padX, footerY + footerH / 2, 15,
                      hexColor(0x9aa8c7), FontRenderer::Align::Left, true);
        font.drawText(canvas, "In-game Quick Menu: Minus (-)", SCREEN_W - padX, footerY + footerH / 2, 15,
                      hexColor(0x6f7e9e), FontRenderer::Align::Right, true);

        framebufferEnd(&fb);
    }

    // Clean Switch 2 teardown before exiting or chain-loading engine NRO
    framebufferClose(&fb);
    nwindowReleaseVi2Layer(win);
    font.shutdown();
    if (R_SUCCEEDED(plRc)) plExit();

    if (shouldLaunch && !nextLoadPath.empty()) {
        if (envHasNextLoad()) {
            Result rc = envSetNextLoad(nextLoadPath.c_str(), nextLoadArgs.c_str());
            logMsg("[handoff] envSetNextLoad(%s) -> 0x%x", nextLoadPath.c_str(), rc);
        } else {
            logMsg("[handoff] ERROR: envHasNextLoad() is false!");
        }
    }

    if (g_logFile) fclose(g_logFile);
    return 0;
}
