/**
 * Direct-Mount WOLF RPG Editor (.wolf / DXArchive v1-v8) Virtual Filesystem
 *
 * Indexes encrypted or unencrypted .wolf / .dxa archives in memory in a few milliseconds
 * and decodes entries on demand with an in-memory cache — zero SD card extraction,
 * zero FAT32 Japanese/symbol short-filename issues, instant startup, and persistent
 * SD card saves in `<gameDir>/Save/`.
 */
#include "wolf_archive.h"
#include "sjis_table.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <functional>
#include <list>
#include <map>
#include <set>
#include <sys/stat.h>
#include <unistd.h>
#include <unordered_map>
#include <vector>

namespace wolf {

uint64_t fnv1a64(const std::string& s) {
  uint64_t h = 14695981039346656037ULL;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  return h ? h : 1ULL;
}

namespace {

constexpr uint32_t DIR_ATTR = 0x10;
constexpr uint32_t MAX_U32_VAL = 0xFFFFFFFFu;
constexpr uint64_t MAX_U64_VAL = 0xFFFFFFFFFFFFFFFFULL;
constexpr size_t MAX_CACHE_BYTES = 96ULL * 1024 * 1024; // 96 MiB decoded asset cache

uint16_t readU16LE(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}
uint16_t readU16BE(const uint8_t* p) {
  return (static_cast<uint16_t>(p[0]) << 8) | static_cast<uint16_t>(p[1]);
}
uint32_t readU32LE(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) |
         (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}
uint32_t readU32BE(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) |
         (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) |
         static_cast<uint32_t>(p[3]);
}
uint64_t readU64LE(const uint8_t* p) {
  return static_cast<uint64_t>(readU32LE(p)) |
         (static_cast<uint64_t>(readU32LE(p + 4)) << 32);
}
void writeU16LE(uint8_t* p, uint16_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
}
void writeU32LE(uint8_t* p, uint32_t v) {
  p[0] = static_cast<uint8_t>(v & 0xFF);
  p[1] = static_cast<uint8_t>((v >> 8) & 0xFF);
  p[2] = static_cast<uint8_t>((v >> 16) & 0xFF);
  p[3] = static_cast<uint8_t>((v >> 24) & 0xFF);
}

std::string toLower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

bool endsWithIgnoreCase(const std::string& s, const std::string& suf) {
  if (s.size() < suf.size()) return false;
  return toLower(s.substr(s.size() - suf.size())) == toLower(suf);
}

bool isHostDir(const std::string& p) {
  struct stat st {};
  return stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

bool isHostFile(const std::string& p, uint64_t* outSz = nullptr) {
  struct stat st {};
  if (stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode)) {
    if (outSz) *outSz = static_cast<uint64_t>(st.st_size);
    return true;
  }
  return false;
}

void mkdirsHost(const std::string& path) {
  if (path.empty() || isHostDir(path)) return;
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

std::string parentPathOf(const std::string& rel) {
  size_t pos = rel.rfind('/');
  return (pos == std::string::npos) ? std::string() : rel.substr(0, pos);
}

std::string baseNameOf(const std::string& rel) {
  size_t pos = rel.rfind('/');
  return (pos == std::string::npos) ? rel : rel.substr(pos + 1);
}

std::vector<std::string> listHostDir(const std::string& dir) {
  std::vector<std::string> out;
  DIR* d = opendir(dir.c_str());
  if (!d) return out;
  while (struct dirent* e = readdir(d)) {
    if (!e->d_name[0] || strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    out.emplace_back(e->d_name);
  }
  closedir(d);
  std::sort(out.begin(), out.end());
  return out;
}

bool readAt(FILE* fp, uint64_t offset, void* buf, size_t size) {
  if (size == 0) return true;
  if (fseeko(fp, static_cast<off_t>(offset), SEEK_SET) != 0) return false;
  return fread(buf, 1, size, fp) == size;
}

bool readWholeHostFile(const std::string& path, std::vector<uint8_t>& out) {
  FILE* fp = fopen(path.c_str(), "rb");
  if (!fp) return false;
  if (fseeko(fp, 0, SEEK_END) != 0) { fclose(fp); return false; }
  off_t sz = ftello(fp);
  if (sz < 0) { fclose(fp); return false; }
  fseeko(fp, 0, SEEK_SET);
  out.resize(static_cast<size_t>(sz));
  bool ok = (sz == 0) || (fread(out.data(), 1, static_cast<size_t>(sz), fp) == static_cast<size_t>(sz));
  fclose(fp);
  return ok;
}

std::string sanitizeEntryName(const std::string& name) {
  if (name.empty() || name == "." || name == "..") return {};
  for (char c : name) {
    if (c == '/' || c == '\\' || c == '\0') return {};
  }
  return name;
}

std::string decodeDxName(const std::vector<uint8_t>& nameTable, uint64_t addr, uint32_t codePage) {
  if (addr + 4 > nameTable.size()) return {};
  uint16_t packs = readU16LE(&nameTable[addr]);
  size_t start = static_cast<size_t>(addr) + 4 + static_cast<size_t>(packs) * 4;
  if (start >= nameTable.size()) return {};
  size_t limit = std::min(start + static_cast<size_t>(packs) * 4, nameTable.size());
  size_t end = start;
  while (end < limit && nameTable[end] != 0) end++;
  if (codePage == 65001) {
    return std::string(reinterpret_cast<const char*>(&nameTable[start]), end - start);
  }
  return cp932ToUtf8(&nameTable[start], end - start);
}

std::vector<uint8_t> normalizedDxNameBytes(const std::vector<uint8_t>& nameTable, uint64_t addr) {
  if (addr + 4 > nameTable.size()) return {};
  uint16_t packs = readU16LE(&nameTable[addr]);
  size_t start = static_cast<size_t>(addr) + 4;
  if (start >= nameTable.size()) return {};
  size_t limit = std::min(start + static_cast<size_t>(packs) * 4, nameTable.size());
  size_t end = start;
  while (end < limit && nameTable[end] != 0) end++;
  return std::vector<uint8_t>(nameTable.begin() + start, nameTable.begin() + end);
}

// ============================================================================
// LZ & Huffman Decompression + Ciphers
// ============================================================================
bool decodeLz(const uint8_t* src, size_t srcLen, uint64_t expectedSize, std::vector<uint8_t>& out) {
  if (srcLen < 9) return false;
  uint32_t dstSize = readU32LE(src + 0);
  uint32_t encSize = readU32LE(src + 4);
  if (encSize < 9 || encSize > srcLen) return false;
  if (expectedSize != MAX_U64_VAL && dstSize != expectedSize) return false;

  uint8_t keyCode = src[8];
  out.assign(dstSize, 0);
  size_t si = 9, di = 0;
  while (si < encSize) {
    uint8_t b = src[si];
    if (b != keyCode) {
      if (di >= dstSize) return false;
      out[di++] = b;
      si++;
      continue;
    }
    if (si + 1 >= encSize) return false;
    if (src[si + 1] == keyCode) {
      if (di >= dstSize) return false;
      out[di++] = keyCode;
      si += 2;
      continue;
    }
    uint32_t code = src[si + 1];
    if (code > keyCode) code--;
    si += 2;
    uint32_t copyLen = code >> 3;
    if (code & 4) {
      if (si >= encSize) return false;
      copyLen |= static_cast<uint32_t>(src[si++]) << 5;
    }
    copyLen += 4;
    uint32_t idxSize = code & 3;
    if (idxSize == 3 || si + idxSize >= encSize) return false;
    uint32_t dist = src[si];
    if (idxSize >= 1) dist |= static_cast<uint32_t>(src[si + 1]) << 8;
    if (idxSize == 2) dist |= static_cast<uint32_t>(src[si + 2]) << 16;
    si += idxSize + 1;
    dist += 1;
    if (dist > di || di + copyLen > dstSize) return false;
    for (uint32_t k = 0; k < copyLen; k++) {
      out[di] = out[di - dist];
      di++;
    }
  }
  return di == dstSize;
}

struct HuffBitReader {
  const uint8_t* src;
  size_t len;
  size_t byteOff = 0;
  int bitOff = 0;
  bool read(int bits, uint64_t& val) {
    if (bits < 0 || bits > 53) return false;
    val = 0;
    for (int i = 0; i < bits; i++) {
      if (byteOff >= len) return false;
      val = (val << 1) | ((src[byteOff] >> (7 - bitOff)) & 1u);
      if (++bitOff == 8) { bitOff = 0; byteOff++; }
    }
    return true;
  }
  size_t bytesRead() const { return byteOff + (bitOff == 0 ? 0 : 1); }
};

bool decodeHuffman(const uint8_t* src, size_t srcLen, uint64_t expectedSize,
                   std::vector<uint8_t>& out, uint64_t* outOrigSize = nullptr) {
  HuffBitReader br{src, srcLen};
  uint64_t ob = 0, origSize = 0, cb = 0, compSize = 0;
  if (!br.read(6, ob) || !br.read(static_cast<int>(ob + 1), origSize)) return false;
  if (!br.read(6, cb) || !br.read(static_cast<int>(cb + 1), compSize)) return false;

  uint16_t weights[256] {};
  for (int i = 0; i < 256; i++) {
    uint64_t bc = 0, minus = 0, delta = 0;
    if (!br.read(3, bc) || !br.read(1, minus) || !br.read(static_cast<int>((bc + 1) * 2), delta)) return false;
    int prev = (i == 0) ? 0 : weights[i - 1];
    int next = prev + (minus ? -static_cast<int>(delta) : static_cast<int>(delta));
    weights[i] = static_cast<uint16_t>(next & 0xFFFF);
  }
  size_t hdrSize = br.bytesRead();
  if (hdrSize + compSize > srcLen) return false;
  if (outOrigSize) *outOrigSize = origSize;
  if (expectedSize != MAX_U64_VAL && origSize != expectedSize) return false;
  if (origSize > 512ULL * 1024 * 1024) return false;

  out.assign(static_cast<size_t>(origSize), 0);
  if (origSize == 0) return true;

  struct Node { uint32_t weight; int parent; int child[2]; };
  Node nodes[511];
  for (int i = 0; i < 511; i++) {
    nodes[i] = {i < 256 ? static_cast<uint32_t>(weights[i]) : 0u, -1, {-1, -1}};
  }
  int active = 256, nextNode = 256;
  while (active > 1) {
    int first = -1, second = -1, seen = 0;
    for (int ni = 0; seen < active && ni < nextNode; ni++) {
      if (nodes[ni].parent != -1) continue;
      seen++;
      if (first == -1 || nodes[first].weight > nodes[ni].weight) {
        second = first; first = ni;
      } else if (second == -1 || nodes[second].weight > nodes[ni].weight) {
        second = ni;
      }
    }
    if (first == -1 || second == -1 || nextNode >= 511) return false;
    nodes[nextNode] = {nodes[first].weight + nodes[second].weight, -1, {first, second}};
    nodes[first].parent = nextNode;
    nodes[second].parent = nextNode;
    nextNode++;
    active--;
  }

  const uint8_t* data = src + hdrSize;
  size_t maxBits = static_cast<size_t>(compSize) * 8;
  size_t bitPos = 0;
  for (size_t oi = 0; oi < out.size(); oi++) {
    int ni = 510;
    while (ni > 255) {
      if (bitPos >= maxBits) return false;
      int branch = (data[bitPos >> 3] >> (bitPos & 7)) & 1;
      bitPos++;
      ni = nodes[ni].child[branch];
      if (ni < 0 || ni >= 511) return false;
    }
    out[oi] = static_cast<uint8_t>(ni);
  }
  return true;
}

std::array<uint8_t, 12> makeLegacyDxKey(const uint8_t src[12]) {
  std::array<uint8_t, 12> k {};
  for (int i = 0; i < 12; i++) k[i] = src[i];
  k[0] = static_cast<uint8_t>(~k[0]);
  k[1] = static_cast<uint8_t>((k[1] >> 4) | (k[1] << 4));
  k[2] ^= 0x8A;
  k[3] = static_cast<uint8_t>(~((k[3] >> 4) | (k[3] << 4)));
  k[4] = static_cast<uint8_t>(~k[4]);
  k[5] ^= 0xAC;
  k[6] = static_cast<uint8_t>(~k[6]);
  k[7] = static_cast<uint8_t>(~((k[7] >> 3) | (k[7] << 5)));
  k[8] = static_cast<uint8_t>((k[8] >> 5) | (k[8] << 3));
  k[9] ^= 0x7F;
  k[10] = static_cast<uint8_t>(((k[10] >> 4) | (k[10] << 4)) ^ 0xD6);
  k[11] ^= 0xCC;
  return k;
}

void xorKeyInPlace(uint8_t* buf, size_t len, const uint8_t* key, size_t keyLen, uint64_t pos) {
  if (!key || keyLen == 0) return;
  for (size_t i = 0; i < len; i++) buf[i] ^= key[(pos + i) % keyLen];
}

static const uint8_t kKeyWolf201[12] = {0x0f,0x53,0xe1,0x3e,0x04,0x37,0x12,0x17,0x60,0x0f,0x53,0xe1};
static const uint8_t kKeyWolf210[12] = {0x4c,0xd9,0x2a,0xb7,0x28,0x9b,0xac,0x07,0x3e,0x77,0xec,0x4c};
static const uint8_t kKeyWolf220[12] = {0x38,0x50,0x40,0x28,0x72,0x4f,0x21,0x70,0x3b,0x73,0x35,0x38};
static const uint8_t kKeyDxDefault12[12] = {'D','X','L','I','B','A','R','C',0,0,0,0};

uint32_t crc32Dx8(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) crc = (crc & 1u) ? (0xEDB88320u ^ (crc >> 1)) : (crc >> 1);
  }
  return ~crc;
}

std::array<uint8_t, 7> makeDx8Key(const std::vector<uint8_t>& srcIn) {
  std::vector<uint8_t> src = srcIn;
  if (src.size() < 4) {
    const char* def = "DXLIBARC";
    src.insert(src.end(), def, def + 8);
  }
  std::vector<uint8_t> even((src.size() + 1) / 2), odd(src.size() / 2);
  for (size_t i = 0; i < src.size(); i++) {
    if ((i & 1) == 0) even[i >> 1] = src[i];
    else odd[i >> 1] = src[i];
  }
  uint32_t ec = crc32Dx8(even.data(), even.size());
  uint32_t oc = crc32Dx8(odd.data(), odd.size());
  std::array<uint8_t, 7> k {};
  writeU32LE(k.data(), ec);
  k[4] = static_cast<uint8_t>(oc & 0xFF);
  k[5] = static_cast<uint8_t>((oc >> 8) & 0xFF);
  k[6] = static_cast<uint8_t>((oc >> 16) & 0xFF);
  return k;
}

inline uint8_t ror8(uint8_t v, int bits) { return static_cast<uint8_t>((v >> bits) | (v << (8 - bits))); }
inline uint32_t rol32(uint32_t v, int bits) { return (v << bits) | (v >> (32 - bits)); }

struct MsvcRng {
  uint32_t state;
  explicit MsvcRng(uint32_t seed) : state(seed) {}
  uint16_t next() {
    state = state * 214013u + 2531011u;
    return static_cast<uint16_t>((state >> 16) & 0x7FFFu);
  }
};

static const uint8_t kAesSbox[256] = {
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
};
static const uint8_t kAesRcon[11] = {0x8d,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36};

bool isModernCryptVer(uint32_t cv) { return (cv >= 331 && cv < 1000) || cv >= 1010; }
bool isVer35(uint32_t cv) { return (cv >= 0x015e && cv < 0x03e8) || cv >= 0x03fc; }

void cryptModernHeader(uint8_t hdr[64], uint32_t cv) {
  const uint8_t* pw = hdr + 49;
  if (isVer35(cv)) {
    MsvcRng rng(0x0Cu + static_cast<uint32_t>(pw[9]) * pw[10] + pw[3]);
    size_t off = 8;
    for (int g = 0; g < 2; g++) {
      for (int i = 3; i >= 0; i--) writeU16LE(hdr + off + i * 2, readU16LE(hdr + off + i * 2) ^ rng.next());
      off += 8;
    }
    uint64_t r0 = static_cast<uint64_t>(rng.next()) << 17;
    uint64_t r1 = static_cast<uint64_t>(rng.next()) << 31;
    uint64_t comb = r0 | r1 | static_cast<uint64_t>(rng.next());
    writeU32LE(hdr + off, readU32LE(hdr + off) ^ static_cast<uint32_t>(comb & 0xFFFFFFFFu));
    writeU32LE(hdr + off + 4, readU32LE(hdr + off + 4) ^ static_cast<uint32_t>((comb >> 32) & 0xFFFFFFFFu));
    off += 8;
    for (int i = 3; i >= 0; i--) writeU16LE(hdr + off + i * 2, readU16LE(hdr + off + i * 2) ^ rng.next());
    return;
  }
  MsvcRng rng(static_cast<uint32_t>(pw[0]) + static_cast<uint32_t>(pw[7]) * pw[12]);
  size_t off = 8;
  for (int g = 0; g < 4; g++) {
    for (int i = 3; i >= 0; i--) writeU16LE(hdr + off + i * 2, readU16LE(hdr + off + i * 2) ^ rng.next());
    off += 8;
  }
}

std::array<uint8_t, 768> createWolfCryptKey(uint32_t cv, const uint8_t pw[15], bool other,
                                            const std::vector<uint8_t>& keyStr) {
  std::array<uint8_t, 768> key {};
  uint8_t factors[3] {};
  uint8_t s0 = pw[2], s1 = pw[5], s2 = pw[12], s3 = 0;
  int length = pw[other ? 8 : 11] / (other ? 4 : 3);
  for (int i = 0; i < length; i++) {
    s3 = static_cast<uint8_t>((i ^ ror8(s3 ^ pw[i % 15], other ? 2 : 3)) & 0xFF);
  }
  MsvcRng rng(static_cast<uint32_t>(s0) * s1 + s2 + s3);
  factors[s3 % 3] = static_cast<uint8_t>(rng.next() & 0xFF);
  if (!other && isVer35(cv)) factors[1] = static_cast<uint8_t>(rng.next() % 0xFB);
  for (int i = 0; i < 256; i++) {
    uint16_t r16 = rng.next();
    key[i] = factors[0] ^ static_cast<uint8_t>(rng.next() & 0xFF);
    key[i + 256] = factors[1] ^ static_cast<uint8_t>(r16 >> 8);
    key[i + 512] = factors[2] ^ static_cast<uint8_t>(r16 & 0xFF);
  }
  if (!other) return key;

  std::vector<uint8_t> saltSrc = (cv == 0x015e) ? std::vector<uint8_t>{'9', '5', '8'} : keyStr;
  if (saltSrc.empty()) saltSrc.push_back(0);
  uint8_t salt[128];
  for (size_t i = 0; i < 128; i++) salt[i] = static_cast<uint8_t>((i / saltSrc.size() + saltSrc[i % saltSrc.size()]) & 0xFF);
  int factor = 7;
  if (isVer35(cv)) { s3 = static_cast<uint8_t>(s3 + 0x22); factor = 16; }
  for (int part = 0; part < 3; part++) {
    int running = s3;
    for (int i = 0; i < 256; i++) {
      uint8_t cs = salt[i & 0x7F], ss = salt[(i + part) & 0x7F], ck = key[part * 256 + i];
      uint8_t sxk = cs ^ ck;
      int round = (ss | (static_cast<int>(cs) << 8)) % factor;
      int nk = sxk;
      bool skip = false;
      switch (round) {
        case 1: if (ss % 0x0B == 0) nk = ck; break;
        case 2: if (cs % 0x1D == 0) nk = ~sxk; break;
        case 3: if ((round + i) % 0x25 == 0) nk = ss ^ sxk; break;
        case 4: if ((cs + ss) % 97 == 0) nk = cs + sxk; break;
        case 5: if ((i * round) % 0x7B == 0) nk = sxk ^ running; break;
        case 6: if (cs == 0xFF && ss == 0) { nk = 0; skip = true; } break;
        case 7:
          if (cv >= 0x0154 && !(cv > 0x03E8 && cv < 0x03FC) && ((round + i) % 0x33 == 0 || cv >= 0x03FC)) nk ^= cs;
          break;
        case 8:
          if (cv >= 0x0154 && !(cv > 0x03E8 && cv < 0x03FC) && (cs % 0x1D == 0 || cv >= 0x03FC)) nk ^= cs;
          break;
      }
      if ((i + part) % ((cs % 5) + 1) == 0) nk ^= running;
      else if (skip) nk = ~sxk;
      key[part * 256 + i] = static_cast<uint8_t>(nk & 0xFF);
      running += part;
    }
  }
  return key;
}

void xorWolfCryptInPlace(uint8_t* buf, size_t len, const std::array<uint8_t, 768>& key, uint64_t pos, uint32_t cv) {
  uint32_t low = static_cast<uint32_t>(pos & 0xFF);
  uint32_t mid = static_cast<uint32_t>((pos >> 8) & 0xFF);
  uint32_t high = static_cast<uint32_t>((pos >> 16) & 0xFF);
  if (isVer35(cv)) {
    uint8_t exp[512];
    for (int i = 0; i < 512; i++) exp[i] = key[i & 0xFF] ^ static_cast<uint8_t>((7 * i) & 0xFF);
    for (size_t i = 0; i < len; i++) {
      buf[i] ^= exp[low] ^ exp[mid + 256];
      if (++low == 256) { low = 0; mid = (mid + 1) & 0xFF; }
    }
    return;
  }
  for (size_t i = 0; i < len; i++) {
    buf[i] ^= key[low] ^ key[mid + 256] ^ key[high + 512];
    if (++low == 256) {
      low = 0;
      if (++mid == 256) { mid = 0; high = (high + 1) & 0xFF; }
    }
  }
}

struct WolfAesCtx {
  std::array<uint8_t, 176> roundKey {};
  std::array<uint8_t, 16> iv {};
};

WolfAesCtx makeWolfAesCtx(uint32_t cv, const uint8_t pw[15]) {
  uint8_t key[16] {}, iv[16] {};
  if (isVer35(cv)) {
    for (int i = 0; i < 15; i++) {
      int ki = ((i * 7) ^ (3 * pw[i])) % 15;
      int ii = ((i * 0x0B) ^ (5 * pw[(i + 3) % 15])) % 15;
      key[i] ^= static_cast<uint8_t>((i + (pw[ki] << (i % 3))) % 0xFB);
      iv[i] ^= static_cast<uint8_t>(((pw[ii] >> (i % 2)) + (i * i)) % 0xF6);
      key[15] ^= static_cast<uint8_t>((7 * (pw[i] + (i + 1))) % 0xFD);
      uint16_t diff = static_cast<uint16_t>((pw[i] - (i * 2)) & 0xFFFF);
      iv[15] ^= static_cast<uint8_t>((11 * diff) & 0xFF);
    }
  } else {
    for (int i = 0; i < 15; i++) {
      key[i] ^= static_cast<uint8_t>((pw[(i * 7) % 15] + i * i) & 0xFF);
      iv[i] ^= static_cast<uint8_t>((pw[(i * 11) % 15] - i * i) & 0xFF);
      key[15] ^= static_cast<uint8_t>((pw[i] + i * 3) & 0xFF);
      iv[15] ^= static_cast<uint8_t>((pw[i] + i * 5) & 0xFF);
    }
  }
  WolfAesCtx ctx;
  memcpy(ctx.roundKey.data(), key, 16);
  memcpy(ctx.iv.data(), iv, 16);
  uint8_t tmp[4];
  for (int i = 4; i < 44; i++) {
    memcpy(tmp, &ctx.roundKey[(i - 1) * 4], 4);
    if (i % 4 == 0) {
      uint8_t f = tmp[0]; tmp[0] = tmp[1]; tmp[1] = tmp[2]; tmp[2] = tmp[3]; tmp[3] = f;
      tmp[0] = kAesSbox[tmp[0]] ^ kAesRcon[i / 4];
      tmp[1] = kAesSbox[tmp[1]] >> 4;
      tmp[2] = static_cast<uint8_t>(~kAesSbox[tmp[2]]);
      tmp[3] = ror8(kAesSbox[tmp[3]], 7);
    }
    for (int b = 0; b < 4; b++) ctx.roundKey[i * 4 + b] = ctx.roundKey[(i - 4) * 4 + b] ^ tmp[b];
  }
  return ctx;
}

inline uint8_t aesXtime(uint8_t v) { return static_cast<uint8_t>((v << 1) ^ (((v >> 7) & 1u) * 0x1Bu)); }

void wolfAesBlock(const uint8_t in[16], const uint8_t rk[176], uint8_t st[16]) {
  memcpy(st, in, 16);
  for (int i = 0; i < 16; i++) st[i] ^= rk[i];
  for (int r = 1; r < 10; r++) {
    for (int i = 0; i < 16; i++) st[i] = kAesSbox[st[i]];
    uint8_t t = st[1]; st[1] = st[5]; st[5] = st[9]; st[9] = st[13]; st[13] = t;
    t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
    t = st[3]; st[3] = st[15]; st[15] = st[11]; st[11] = st[7]; st[7] = t;
    for (int c = 0; c < 4; c++) {
      int o = c * 4;
      uint8_t f = st[o], cb = st[o] ^ st[o + 1] ^ st[o + 2] ^ st[o + 3];
      st[o] ^= cb ^ aesXtime(st[o] ^ st[o + 1]);
      st[o + 1] ^= cb ^ aesXtime(st[o + 1] ^ st[o + 2]);
      st[o + 2] ^= cb ^ aesXtime(st[o + 2] ^ st[o + 3]);
      st[o + 3] ^= cb ^ aesXtime(st[o + 3] ^ f);
    }
    for (int i = 0; i < 16; i++) st[i] ^= rk[r * 16 + i];
  }
  for (int i = 0; i < 16; i++) st[i] = kAesSbox[st[i]];
  uint8_t t = st[1]; st[1] = st[5]; st[5] = st[9]; st[9] = st[13]; st[13] = t;
  t = st[2]; st[2] = st[10]; st[10] = t; t = st[6]; st[6] = st[14]; st[14] = t;
  t = st[3]; st[3] = st[15]; st[15] = st[11]; st[11] = st[7]; st[7] = t;
  for (int i = 0; i < 16; i++) st[i] ^= rk[160 + i];
}

void xorWolfAesInPlace(uint8_t* buf, size_t len, const WolfAesCtx& ctx, uint64_t streamPos) {
  uint64_t block = streamPos / 16;
  size_t off = static_cast<size_t>(streamPos % 16), pos = 0;
  while (pos < len) {
    uint8_t ctr[16];
    memcpy(ctr, ctx.iv.data(), 16);
    uint64_t carry = block;
    for (int i = 15; i >= 0 && carry != 0; i--) {
      uint64_t sum = ctr[i] + (carry & 0xFFu);
      ctr[i] = static_cast<uint8_t>(sum & 0xFFu);
      carry = (carry >> 8) + (sum >> 8);
    }
    uint8_t stream[16];
    wolfAesBlock(ctr, ctx.roundKey.data(), stream);
    size_t chunk = std::min(16 - off, len - pos);
    for (size_t i = 0; i < chunk; i++) buf[pos + i] ^= stream[off + i];
    pos += chunk; block++; off = 0;
  }
}

void xorChaCha20InPlace(uint8_t* buf, size_t len, const uint8_t key[32], const uint8_t nonce[12], uint64_t pos) {
  uint32_t counter = static_cast<uint32_t>(1 + pos / 64);
  size_t off = static_cast<size_t>(pos % 64), cur = 0;
  auto qr = [](uint32_t s[16], int a, int b, int c, int d) {
    s[a] += s[b]; s[d] = rol32(s[d] ^ s[a], 16);
    s[c] += s[d]; s[b] = rol32(s[b] ^ s[c], 12);
    s[a] += s[b]; s[d] = rol32(s[d] ^ s[a], 8);
    s[c] += s[d]; s[b] = rol32(s[b] ^ s[c], 7);
  };
  while (cur < len) {
    uint32_t init[16];
    memcpy(init, "expand 32-byte k", 16);
    for (int i = 0; i < 8; i++) init[4 + i] = readU32LE(key + i * 4);
    init[12] = counter;
    for (int i = 0; i < 3; i++) init[13 + i] = readU32LE(nonce + i * 4);
    uint32_t st[16];
    memcpy(st, init, sizeof(st));
    for (int r = 0; r < 10; r++) {
      qr(st, 0, 4, 8, 12); qr(st, 1, 5, 9, 13); qr(st, 2, 6, 10, 14); qr(st, 3, 7, 11, 15);
      qr(st, 0, 5, 10, 15); qr(st, 1, 6, 11, 12); qr(st, 2, 7, 8, 13); qr(st, 3, 4, 9, 14);
    }
    uint8_t stream[64];
    for (int i = 0; i < 16; i++) writeU32LE(stream + i * 4, st[i] + init[i]);
    size_t chunk = std::min(64 - off, len - cur);
    for (size_t i = 0; i < chunk; i++) buf[cur + i] ^= stream[off + i];
    cur += chunk; counter++; off = 0;
  }
}

struct ModernCryptCtx {
  bool active = false;
  uint64_t archiveSize = 0;
  uint64_t bodySize = 0;
  uint64_t nameTableStart = 0;
  uint32_t cryptVersion = 0;
  std::array<uint8_t, 768> innerKey {};
  std::array<uint8_t, 768> outerKey {};
  WolfAesCtx aes {};
};

uint64_t calcModernBodySize(uint32_t cv, const uint8_t pw[15], uint64_t archiveSize) {
  if (!isVer35(cv)) return 0x400;
  uint32_t seed = static_cast<uint32_t>(pw[2]) * pw[4] + pw[12];
  if (seed == 0) seed = 1;
  auto xs = [&]() -> uint32_t { seed ^= seed << 11; seed ^= seed >> 19; seed ^= seed << 7; return seed; };
  xs();
  if (archiveSize >= (xs() % 500) + 800) xs();
  uint64_t sz = archiveSize - 64;
  if (sz >= (xs() % 500) + 800) sz = (xs() % 500) + 800;
  return sz;
}

void applyModernOuter(uint8_t* buf, size_t len, uint64_t absPos, const ModernCryptCtx& ctx) {
  if (!ctx.active || len == 0) return;
  auto xformRange = [&](uint64_t rStart, uint64_t rEnd, auto fn) {
    uint64_t sEnd = absPos + len;
    uint64_t oStart = std::max(absPos, rStart), oEnd = std::min(sEnd, rEnd);
    if (oStart < oEnd) fn(buf + (oStart - absPos), static_cast<size_t>(oEnd - oStart), oStart);
  };
  xformRange(64, ctx.archiveSize - 64, [&](uint8_t* p, size_t n, uint64_t pos) {
    xorWolfCryptInPlace(p, n, ctx.outerKey, pos, ctx.cryptVersion);
  });
  xformRange(64, 64 + ctx.bodySize, [&](uint8_t* p, size_t n, uint64_t pos) {
    xorWolfAesInPlace(p, n, ctx.aes, pos - 64);
  });
  uint64_t tblStreamStart = ((ctx.bodySize + 15) / 16) * 16;
  xformRange(ctx.nameTableStart, ctx.archiveSize, [&](uint8_t* p, size_t n, uint64_t pos) {
    xorWolfAesInPlace(p, n, ctx.aes, tblStreamStart + pos - ctx.nameTableStart);
  });
}

enum class Dx8Alg { Clear, Dx8, Wolf, ChaCha20 };
struct Dx8ModeSpec {
  uint32_t cryptVer;
  Dx8Alg alg;
  std::vector<uint8_t> key;
  std::array<uint8_t, 12> nonce {};
};

std::vector<Dx8ModeSpec> getBuiltinDx8Modes() {
  static const uint8_t k300[] = {
    0x0f,0x53,0xe1,0x3e,0x8e,0xb5,0x41,0x91,0x52,0x16,0x55,0xae,0x34,0xc9,0x8f,0x79,
    0x59,0x2f,0x59,0x6b,0x95,0x19,0x9b,0x1b,0x35,0x9a,0x2f,0xde,0xc9,0x7c,0x12,0x96,
    0xc3,0x14,0xb5,0x0f,0x53,0xe1,0x3e,0x8e
  };
  static const uint8_t k314[] = {
    0x31,0xf9,0x01,0x36,0xa3,0xe3,0x8d,0x3c,0x7b,0xc3,0x7d,0x25,0xad,0x63,0x28,0x19,
    0x1b,0xf7,0x8e,0x6c,0xc4,0xe5,0xe2,0x76,0x82,0xea,0x4f,0xed,0x61,0xda,0xe0,0x44,
    0x5b,0xb6,0x46,0x3b,0x06,0xd5,0xce,0xb6,0x78,0x58,0xd0,0x7c,0x82
  };
  static const uint8_t k331[] = {
    0xca,0x08,0x4c,0x5d,0x17,0x0d,0xda,0xa1,0xd7,0x27,0xc8,0x41,0x54,0x38,0x82,0x32,
    0x54,0xb7,0xf9,0x46,0x8e,0x13,0x6b,0xca,0xd0,0x5c,0x95,0x95,0xe2,0xdc,0x03,0x53,
    0x60,0x9b,0x4a,0x38,0x17,0xf3,0x69,0x59,0xa4,0xc7,0x9a,0x43,0x63,0xe6,0x54,0xaf,
    0xdb,0xbb,0x43,0x58
  };
  static const uint8_t k350[] = {
    0xd2,0x84,0xce,0x28,0xce,0x88,0x82,0xe4,0x2a,0x18,0x2e,0x4c,0x06,0xb4,0xea,0x84,
    0x06,0xb8,0xc6,0x88,0x5a,0xa0,0x9e,0x7c,0x56,0x40,0xba,0x34,0x52,0xcc,0xc6,0x7c,
    0x2e,0x14,0x12,0x68,0xfe,0x5c,0x76,0x94,0x86,0x78,0x8e,0x4c,0xbe,0x88,0x66,0x9c,
    0x1e,0xe0,0x8e,0x6c
  };
  static const uint8_t kChaKey[32] = {
    0xc9,0x82,0xf8,0xb4,0x2c,0x93,0x9e,0x83,0x0e,0xbc,0xbc,0x92,0x68,0x8d,0x59,0xa1,
    0x4a,0x9e,0x7f,0xb0,0xac,0xaf,0x1d,0x8f,0x8e,0xb8,0x3b,0x9e,0xe8,0x89,0xd9,0xad
  };
  static const std::array<uint8_t, 12> kChaNonce = {0xff,0xbc,0x2d,0xab,0x9d,0x8b,0x0f,0xb4,0xbb,0x9a,0x69,0x85};
  auto strVec = [](const char* s) { return std::vector<uint8_t>(s, s + strlen(s)); };
  return {
    {0, Dx8Alg::Dx8, strVec("WLFRPrO!p(;s5((8P@((UFWlu$#5(=")},
    {0x012c, Dx8Alg::Dx8, std::vector<uint8_t>(k300, k300 + sizeof(k300))},
    {0x013a, Dx8Alg::Dx8, std::vector<uint8_t>(k314, k314 + sizeof(k314))},
    {0x014b, Dx8Alg::Wolf, std::vector<uint8_t>(k331, k331 + sizeof(k331))},
    {0x015e, Dx8Alg::Wolf, std::vector<uint8_t>(k350, k350 + sizeof(k350))},
    {0x0064, Dx8Alg::ChaCha20, std::vector<uint8_t>(kChaKey, kChaKey + 32), kChaNonce},
    {0, Dx8Alg::Dx8, strVec("DXLIBARC")},
    {0, Dx8Alg::Dx8, strVec("nGui9('&1=@3#a")},
    {0, Dx8Alg::Dx8, strVec("Ph=X3^]o2A(,1=@3#a")},
  };
}

// ============================================================================
// TrueType / OpenType Font Family Name Extractor (from buffer)
// ============================================================================
std::vector<std::string> extractFontNamesFromBytes(const uint8_t* buf, size_t len) {
  std::set<std::string> unique;
  auto parseSfnt = [&](size_t sfntOff) {
    if (sfntOff + 12 > len) return;
    uint16_t numTables = readU16BE(buf + sfntOff + 4);
    if (sfntOff + 12 + static_cast<size_t>(numTables) * 16 > len) return;
    size_t nameOff = 0, nameLen = 0;
    for (uint16_t i = 0; i < numTables; i++) {
      size_t rec = sfntOff + 12 + static_cast<size_t>(i) * 16;
      if (memcmp(buf + rec, "name", 4) == 0) {
        nameOff = readU32BE(buf + rec + 8);
        nameLen = readU32BE(buf + rec + 12);
        break;
      }
    }
    if (!nameOff || nameOff + 6 > len) return;
    uint16_t count = readU16BE(buf + nameOff + 2);
    uint16_t strOff = readU16BE(buf + nameOff + 4);
    size_t storage = nameOff + strOff;
    if (storage > len) return;
    for (uint16_t i = 0; i < count; i++) {
      size_t r = nameOff + 6 + static_cast<size_t>(i) * 12;
      if (r + 12 > len || r + 12 > nameOff + nameLen) break;
      uint16_t platformId = readU16BE(buf + r + 0);
      uint16_t encodingId = readU16BE(buf + r + 2);
      uint16_t nameId = readU16BE(buf + r + 6);
      uint16_t sLen = readU16BE(buf + r + 8);
      uint16_t sOff = readU16BE(buf + r + 10);
      if (nameId != 1 && nameId != 4 && nameId != 16) continue;
      if (storage + sOff + sLen > len || sLen == 0) continue;
      const uint8_t* strBytes = buf + storage + sOff;
      std::string decoded;
      if (platformId == 0 || (platformId == 3 && (encodingId == 1 || encodingId == 10))) {
        for (size_t b = 0; b + 1 < sLen; b += 2) {
          uint16_t cp = readU16BE(strBytes + b);
          if (cp >= 0x20) appendUtf8(decoded, cp);
        }
      } else if (platformId == 3 && encodingId == 2) {
        decoded = cp932ToUtf8(strBytes, sLen);
      } else if (platformId == 1 && encodingId == 0) {
        for (size_t b = 0; b < sLen; b++) {
          if (strBytes[b] >= 0x20 && strBytes[b] < 0x7F) decoded.push_back(static_cast<char>(strBytes[b]));
        }
      }
      if (!decoded.empty() && decoded.find('=') == std::string::npos &&
          decoded.find('\r') == std::string::npos && decoded.find('\n') == std::string::npos) {
        unique.insert(decoded);
      }
    }
  };
  if (len >= 12 && memcmp(buf, "ttcf", 4) == 0) {
    uint32_t numFonts = readU32BE(buf + 8);
    for (uint32_t i = 0; i < numFonts && 12 + (i + 1) * 4 <= len; i++) {
      parseSfnt(readU32BE(buf + 12 + i * 4));
    }
  } else if (len >= 12) {
    parseSfnt(0);
  }
  return std::vector<std::string>(unique.begin(), unique.end());
}

// ============================================================================
// Mounted Archive Representations
// ============================================================================
enum class ArchiveKind { Legacy1To5, Dx6, Dx8 };

struct MountedArchive {
  FILE* fp = nullptr;
  uint64_t archiveSize = 0;
  ArchiveKind kind = ArchiveKind::Legacy1To5;
  uint16_t dxVer = 5;
  bool useKey = false;
  std::array<uint8_t, 12> legacyKey {};
  // DX8 fields
  uint32_t cryptVer = 0;
  uint8_t huffKB = 0;
  Dx8ModeSpec dx8Mode {};
  ModernCryptCtx modern {};
};

struct ArchiveEntryRef {
  size_t archiveIdx = 0;
  std::string origRelPath;
  uint64_t dataPos = 0;
  uint64_t dataSize = 0;
  uint64_t pressSize = MAX_U64_VAL;
  uint64_t huffSize = MAX_U64_VAL;
  bool hasFileKey7 = false;
  std::array<uint8_t, 7> fileKey7 {};
};

} // namespace

struct WolfVfs::Impl {
  std::string gameDir;
  std::string saveDir;
  std::string romfsDir;
  std::string projectId;

  std::vector<MountedArchive> archives;
  // Keyed by lowercase relative path (e.g. "data/charachip/――――.png", no leading/trailing '/')
  std::unordered_map<std::string, ArchiveEntryRef> archiveFiles;
  // Keyed by lowercase relative dir path ("" for root) -> map<lowerChildName, VfsDirEntry>
  std::unordered_map<std::string, std::map<std::string, VfsDirEntry>> virtualDirs;

  // In-memory writable files & static virtual files (e.g. FontList.ini, BrowserWoditor.dat, /Save/*)
  struct MemFile {
    std::string origRelPath;
    std::shared_ptr<std::vector<uint8_t>> data;
    int64_t mtime = 1700000000;
  };
  std::unordered_map<std::string, MemFile> memFiles;
  std::set<std::string> memDirs;     // lowercase relative dir paths
  std::set<std::string> deletedKeys; // lowercase relative paths explicitly unlinked at runtime

  // Loose host files indexed from <gameDir> and romfs:/ (keyed by lowercase relative path)
  struct HostFileRef {
    std::string origRelPath;
    std::string hostFullPath;
    uint64_t size = 0;
  };
  std::unordered_map<std::string, HostFileRef> hostFiles;

  // Decoded LRU cache for archive/host files
  std::list<std::string> lruOrder;
  struct CacheNode {
    std::shared_ptr<std::vector<uint8_t>> data;
    std::list<std::string>::iterator it;
  };
  std::unordered_map<std::string, CacheNode> cache;
  size_t cachedBytes = 0;

  void addDirHierarchy(const std::string& origRelPath, bool isFileLeaf) {
    std::string curOrig;
    size_t i = 0;
    std::vector<std::string> parts;
    while (i < origRelPath.size()) {
      size_t j = origRelPath.find('/', i);
      if (j == std::string::npos) j = origRelPath.size();
      if (j > i) parts.push_back(origRelPath.substr(i, j - i));
      i = j + 1;
    }
    if (parts.empty()) return;
    size_t dirCount = isFileLeaf ? (parts.size() - 1) : parts.size();
    std::string parentLow;
    for (size_t d = 0; d < dirCount; d++) {
      std::string seg = parts[d];
      std::string segLow = toLower(seg);
      std::string fullLow = parentLow.empty() ? segLow : (parentLow + "/" + segLow);
      virtualDirs[parentLow][segLow] = {seg, true, fnv1a64("vdir:" + fullLow)};
      virtualDirs[fullLow]; // ensure child map exists
      parentLow = fullLow;
    }
    if (isFileLeaf) {
      std::string leaf = parts.back();
      std::string leafLow = toLower(leaf);
      std::string fullLow = parentLow.empty() ? leafLow : (parentLow + "/" + leafLow);
      virtualDirs[parentLow][leafLow] = {leaf, false, fnv1a64("vfile:" + fullLow)};
    }
  }

  void putStaticMemFile(const std::string& origRelPath, const void* bytes, size_t len) {
    std::string low = toLower(origRelPath);
    auto vec = std::make_shared<std::vector<uint8_t>>(static_cast<const uint8_t*>(bytes),
                                                      static_cast<const uint8_t*>(bytes) + len);
    memFiles[low] = {origRelPath, vec, 1700000000};
    deletedKeys.erase(low);
    addDirHierarchy(origRelPath, true);
  }

  void scanLooseHostTree(const std::string& hostRoot, const std::string& relPrefix, int depth = 0) {
    if (depth > 6 || !isHostDir(hostRoot)) return;
    virtualDirs[toLower(relPrefix)];
    for (const auto& name : listHostDir(hostRoot)) {
      if (name.empty() || name[0] == '.') continue;
      std::string lowName = toLower(name);
      // Skip Save folder in loose GameAssets scan (Save is its own mem/persist layer!)
      if (relPrefix.empty() && lowName == "save") continue;
      std::string fullHost = hostRoot + "/" + name;
      std::string rel = relPrefix.empty() ? name : (relPrefix + "/" + name);
      uint64_t fsz = 0;
      if (isHostDir(fullHost)) {
        addDirHierarchy(rel, false);
        scanLooseHostTree(fullHost, rel, depth + 1);
      } else if (isHostFile(fullHost, &fsz)) {
        std::string lowRel = toLower(rel);
        if (hostFiles.find(lowRel) == hostFiles.end()) {
          hostFiles[lowRel] = {rel, fullHost, fsz};
          addDirHierarchy(rel, true);
        }
      }
    }
  }

  bool tryMountLegacy1To5(FILE* fp, uint64_t sz, const std::string& mountPrefix, int& countOut) {
    if (sz < 24) return false;
    uint8_t rawHdr[28] {};
    size_t hdrRead = static_cast<size_t>(std::min<uint64_t>(28, sz));
    if (!readAt(fp, 0, rawHdr, hdrRead)) return false;

    const uint8_t* candidates[4] = {kKeyWolf210, kKeyWolf201, kKeyDxDefault12, nullptr};
    MountedArchive ma {};
    ma.fp = fp;
    ma.archiveSize = sz;
    ma.kind = ArchiveKind::Legacy1To5;

    uint32_t headSize = 0, dataStart = 0, nts = 0, fts = 0, dts = 0, codePage = 932;
    bool matched = false;
    for (int c = 0; c < 4; c++) {
      uint8_t dec[28];
      memcpy(dec, rawHdr, sizeof(dec));
      std::array<uint8_t, 12> key {};
      if (candidates[c]) {
        key = makeLegacyDxKey(candidates[c]);
        xorKeyInPlace(dec, hdrRead, key.data(), 12, 0);
      }
      if (dec[0] != 'D' || dec[1] != 'X') continue;
      uint16_t v = readU16LE(dec + 2);
      if (v < 1 || v > 5) continue;
      uint32_t expHdr = (v >= 4) ? 28u : 24u;
      if (sz < expHdr) continue;
      uint32_t hs = readU32LE(dec + 4), ds = readU32LE(dec + 8);
      uint32_t n = readU32LE(dec + 12), f = readU32LE(dec + 16), d = readU32LE(dec + 20);
      uint32_t cp = (v >= 4) ? readU32LE(dec + 24) : 932u;
      if (ds != expHdr || n < expHdr || static_cast<uint64_t>(n) + hs > sz || f > d || d > hs) continue;
      ma.dxVer = v; ma.legacyKey = key; ma.useKey = (candidates[c] != nullptr);
      headSize = hs; dataStart = ds; nts = n; fts = f; dts = d; codePage = cp ? cp : 932u;
      matched = true;
      break;
    }
    if (!matched) return false;

    std::vector<uint8_t> tables(headSize);
    if (!readAt(fp, nts, tables.data(), headSize)) return false;
    if (ma.useKey) xorKeyInPlace(tables.data(), headSize, ma.legacyKey.data(), 12, (ma.dxVer >= 5) ? 0 : nts);

    size_t fileHdrSz = (ma.dxVer >= 2) ? 44u : 40u;
    auto checkValid = [&](const std::vector<uint8_t>& t) -> bool {
      if (dts + 16 > t.size()) return false;
      uint32_t parent = readU32LE(&t[dts + 4]);
      uint32_t cnt = readU32LE(&t[dts + 8]);
      uint32_t fh = readU32LE(&t[dts + 12]);
      return (parent == MAX_U32_VAL || parent == 0) &&
             (static_cast<uint64_t>(fh) + static_cast<uint64_t>(cnt) * fileHdrSz <= (dts - fts));
    };
    if (!checkValid(tables) && ma.useKey && ma.dxVer < 5) {
      if (!readAt(fp, nts, tables.data(), headSize)) return false;
      xorKeyInPlace(tables.data(), headSize, ma.legacyKey.data(), 12, 0);
      if (!checkValid(tables)) return false;
    }

    size_t archIdx = archives.size();
    archives.push_back(ma);

    std::vector<uint8_t> nameTable(tables.begin(), tables.begin() + fts);
    const uint8_t* fileTable = tables.data() + fts;
    size_t fileTableLen = dts - fts;
    const uint8_t* dirTable = tables.data() + dts;
    size_t dirTableLen = headSize - dts;
    std::set<uint32_t> visited;

    std::function<void(uint32_t, const std::string&)> walk = [&](uint32_t dirOff, const std::string& relDir) {
      if (visited.count(dirOff) || dirOff + 16 > dirTableLen) return;
      visited.insert(dirOff);
      if (!relDir.empty()) addDirHierarchy(relDir, false);
      uint32_t cnt = readU32LE(dirTable + dirOff + 8);
      uint32_t fh = readU32LE(dirTable + dirOff + 12);
      for (uint32_t i = 0; i < cnt; i++) {
        size_t fo = static_cast<size_t>(fh) + static_cast<size_t>(i) * fileHdrSz;
        if (fo + fileHdrSz > fileTableLen) break;
        uint32_t nameAddr = readU32LE(fileTable + fo + 0);
        uint32_t attr = readU32LE(fileTable + fo + 4);
        uint32_t dataAddr = readU32LE(fileTable + fo + 32);
        uint32_t dataSize = readU32LE(fileTable + fo + 36);
        uint32_t pressSize = (ma.dxVer >= 2) ? readU32LE(fileTable + fo + 40) : MAX_U32_VAL;
        std::string name = sanitizeEntryName(decodeDxName(nameTable, nameAddr, codePage));
        if (name.empty()) continue;
        std::string rel = relDir.empty() ? name : (relDir + "/" + name);
        if (attr & DIR_ATTR) {
          walk(dataAddr, rel);
        } else {
          ArchiveEntryRef ref {};
          ref.archiveIdx = archIdx;
          ref.origRelPath = rel;
          ref.dataPos = static_cast<uint64_t>(dataStart) + dataAddr;
          ref.dataSize = dataSize;
          ref.pressSize = (pressSize == MAX_U32_VAL) ? MAX_U64_VAL : static_cast<uint64_t>(pressSize);
          archiveFiles[toLower(rel)] = ref;
          addDirHierarchy(rel, true);
          countOut++;
        }
      }
    };
    walk(0, mountPrefix);
    return true;
  }

  bool tryMountDx6(FILE* fp, uint64_t sz, const std::string& mountPrefix, int& countOut) {
    if (sz < 48) return false;
    uint8_t rawHdr[48] {};
    if (!readAt(fp, 0, rawHdr, 48)) return false;

    const uint8_t* candidates[4] = {kKeyWolf220, kKeyWolf210, kKeyDxDefault12, nullptr};
    MountedArchive ma {};
    ma.fp = fp; ma.archiveSize = sz; ma.kind = ArchiveKind::Dx6; ma.dxVer = 6;
    uint32_t headSize = 0, codePage = 932;
    uint64_t dataStart = 0, nts = 0, fts = 0, dts = 0;
    bool matched = false;
    for (int c = 0; c < 4; c++) {
      uint8_t dec[48];
      memcpy(dec, rawHdr, 48);
      std::array<uint8_t, 12> key {};
      if (candidates[c]) { key = makeLegacyDxKey(candidates[c]); xorKeyInPlace(dec, 48, key.data(), 12, 0); }
      if (dec[0] != 'D' || dec[1] != 'X' || readU16LE(dec + 2) != 6) continue;
      uint32_t hs = readU32LE(dec + 4);
      uint64_t ds = readU64LE(dec + 8), n = readU64LE(dec + 16), f = readU64LE(dec + 24), d = readU64LE(dec + 32);
      uint64_t cp = readU64LE(dec + 40);
      if (ds != 48 || n < 48 || n + hs > sz || f > d || d > hs) continue;
      headSize = hs; dataStart = ds; nts = n; fts = f; dts = d;
      codePage = cp ? static_cast<uint32_t>(cp) : 932u;
      ma.legacyKey = key; ma.useKey = (candidates[c] != nullptr);
      matched = true;
      break;
    }
    if (!matched) return false;

    std::vector<uint8_t> tables(headSize);
    if (!readAt(fp, nts, tables.data(), headSize)) return false;
    if (ma.useKey) xorKeyInPlace(tables.data(), headSize, ma.legacyKey.data(), 12, 0);

    size_t archIdx = archives.size();
    archives.push_back(ma);

    std::vector<uint8_t> nameTable(tables.begin(), tables.begin() + fts);
    const uint8_t* fileTable = tables.data() + fts;
    size_t fileTableLen = static_cast<size_t>(dts - fts);
    const uint8_t* dirTable = tables.data() + dts;
    size_t dirTableLen = static_cast<size_t>(headSize - dts);
    std::set<uint64_t> visited;

    std::function<void(uint64_t, const std::string&)> walk = [&](uint64_t dirOff, const std::string& relDir) {
      if (visited.count(dirOff) || dirOff + 32 > dirTableLen) return;
      visited.insert(dirOff);
      if (!relDir.empty()) addDirHierarchy(relDir, false);
      uint64_t cnt = readU64LE(dirTable + dirOff + 16);
      uint64_t fh = readU64LE(dirTable + dirOff + 24);
      for (uint64_t i = 0; i < cnt; i++) {
        uint64_t fo = fh + i * 64;
        if (fo + 64 > fileTableLen) break;
        uint64_t nameAddr = readU64LE(fileTable + fo + 0);
        uint64_t attr = readU64LE(fileTable + fo + 8);
        uint64_t dataAddr = readU64LE(fileTable + fo + 40);
        uint64_t dataSize = readU64LE(fileTable + fo + 48);
        uint64_t pressSize = readU64LE(fileTable + fo + 56);
        std::string name = sanitizeEntryName(decodeDxName(nameTable, nameAddr, codePage));
        if (name.empty()) continue;
        std::string rel = relDir.empty() ? name : (relDir + "/" + name);
        if (attr & DIR_ATTR) walk(dataAddr, rel);
        else {
          ArchiveEntryRef ref {};
          ref.archiveIdx = archIdx;
          ref.origRelPath = rel;
          ref.dataPos = dataStart + dataAddr;
          ref.dataSize = dataSize;
          ref.pressSize = pressSize;
          archiveFiles[toLower(rel)] = ref;
          addDirHierarchy(rel, true);
          countOut++;
        }
      }
    };
    walk(0, mountPrefix);
    return true;
  }

  bool tryMountDx8(FILE* fp, uint64_t sz, const std::string& mountPrefix, int& countOut) {
    if (sz < 64) return false;
    uint8_t hdr[64] {};
    if (!readAt(fp, 0, hdr, 64)) return false;
    if (hdr[0] != 'D' || hdr[1] != 'X' || readU16LE(hdr + 2) != 8) return false;

    uint32_t rawFlags = readU32LE(hdr + 44);
    uint32_t cryptVer = rawFlags >> 16;
    if (isModernCryptVer(cryptVer)) cryptModernHeader(hdr, cryptVer);

    uint32_t headSize = readU32LE(hdr + 4);
    uint64_t dataStart = readU64LE(hdr + 8), nts = readU64LE(hdr + 16);
    uint64_t fts = readU64LE(hdr + 24), dts = readU64LE(hdr + 32);
    uint32_t codePage = readU32LE(hdr + 40);
    uint8_t huffKB = hdr[48];
    uint8_t reserve[15];
    memcpy(reserve, hdr + 49, 15);
    if (!codePage) codePage = 932;
    if (dataStart != 64 || nts < 64 || nts > sz || fts > dts || dts > headSize) return false;

    bool noKey = (rawFlags & 1u) != 0;
    bool noHeadPress = (rawFlags & 2u) != 0;
    uint64_t storedTblSz = noHeadPress ? headSize : (sz - nts);
    if (storedTblSz == 0 || nts + storedTblSz > sz) return false;

    std::vector<Dx8ModeSpec> candidates;
    if (noKey) candidates.push_back({cryptVer, Dx8Alg::Clear, {}});
    else {
      for (const auto& m : getBuiltinDx8Modes()) {
        if (m.cryptVer == cryptVer) candidates.push_back(m);
      }
    }
    if (candidates.empty()) return false;

    std::vector<uint8_t> tables;
    Dx8ModeSpec activeMode {};
    ModernCryptCtx modern {};
    bool ok = false;

    for (const auto& mode : candidates) {
      ModernCryptCtx mctx {};
      if (mode.alg == Dx8Alg::Wolf) {
        mctx.active = true; mctx.archiveSize = sz;
        mctx.bodySize = calcModernBodySize(cryptVer, reserve, sz);
        mctx.nameTableStart = nts; mctx.cryptVersion = cryptVer;
        mctx.innerKey = createWolfCryptKey(cryptVer, reserve, false, {});
        mctx.outerKey = createWolfCryptKey(cryptVer, reserve, true, mode.key);
        mctx.aes = makeWolfAesCtx(cryptVer, reserve);
      }
      std::vector<uint8_t> stored(static_cast<size_t>(storedTblSz));
      if (!readAt(fp, nts, stored.data(), stored.size())) continue;
      if (mctx.active) applyModernOuter(stored.data(), stored.size(), nts, mctx);

      if (mode.alg == Dx8Alg::Dx8) {
        std::vector<uint8_t> ks = mode.key;
        if (ks.size() > 63) ks.resize(63);
        auto k7 = makeDx8Key(ks);
        xorKeyInPlace(stored.data(), stored.size(), k7.data(), 7, 0);
      } else if (mode.alg == Dx8Alg::Wolf) {
        xorWolfCryptInPlace(stored.data(), stored.size(), mctx.innerKey, 0, cryptVer);
      } else if (mode.alg == Dx8Alg::ChaCha20) {
        xorChaCha20InPlace(stored.data(), stored.size(), mode.key.data(), mode.nonce.data(), 0);
      }

      std::vector<uint8_t> cand;
      if (noHeadPress) cand = std::move(stored);
      else {
        std::vector<uint8_t> huffOut;
        uint64_t hOrig = 0;
        if (!decodeHuffman(stored.data(), stored.size(), MAX_U64_VAL, huffOut, &hOrig)) continue;
        if (hOrig < 9 || hOrig > static_cast<uint64_t>(headSize) * 2 + 1024) continue;
        if (!decodeLz(huffOut.data(), huffOut.size(), headSize, cand)) continue;
      }
      if (cand.size() != headSize || dts + 32 > cand.size()) continue;
      if (readU64LE(cand.data() + dts + 8) != MAX_U64_VAL) continue;
      if (readU64LE(cand.data() + dts + 16) > (dts - fts) / 72) continue;
      tables = std::move(cand); activeMode = mode; modern = mctx; ok = true;
      break;
    }
    if (!ok) return false;

    MountedArchive ma {};
    ma.fp = fp; ma.archiveSize = sz; ma.kind = ArchiveKind::Dx8; ma.dxVer = 8;
    ma.cryptVer = cryptVer; ma.huffKB = huffKB; ma.dx8Mode = activeMode; ma.modern = modern;
    size_t archIdx = archives.size();
    archives.push_back(ma);

    std::vector<uint8_t> nameTable(tables.begin(), tables.begin() + fts);
    const uint8_t* fileTable = tables.data() + fts;
    size_t fileTableLen = static_cast<size_t>(dts - fts);
    const uint8_t* dirTable = tables.data() + dts;
    size_t dirTableLen = static_cast<size_t>(headSize - dts);
    std::set<uint64_t> visited;

    auto buildFileKey7 = [&](uint64_t dirOff, uint64_t fnAddr) -> std::array<uint8_t, 7> {
      std::vector<uint8_t> buf = activeMode.key;
      auto fnB = normalizedDxNameBytes(nameTable, fnAddr);
      buf.insert(buf.end(), fnB.begin(), fnB.end());
      uint64_t cur = dirOff;
      int guard = 0;
      while (cur + 32 <= dirTableLen && guard++ < 64) {
        uint64_t dfAddr = readU64LE(dirTable + cur + 0);
        uint64_t pOff = readU64LE(dirTable + cur + 8);
        if (pOff == MAX_U64_VAL || dfAddr + 72 > fileTableLen) break;
        auto dnB = normalizedDxNameBytes(nameTable, readU64LE(fileTable + dfAddr));
        buf.insert(buf.end(), dnB.begin(), dnB.end());
        cur = pOff;
      }
      if (buf.size() > 2040) buf.resize(2040);
      return makeDx8Key(buf);
    };

    std::function<void(uint64_t, const std::string&)> walk = [&](uint64_t dirOff, const std::string& relDir) {
      if (visited.count(dirOff) || dirOff + 32 > dirTableLen) return;
      visited.insert(dirOff);
      if (!relDir.empty()) addDirHierarchy(relDir, false);
      uint64_t cnt = readU64LE(dirTable + dirOff + 16);
      uint64_t fh = readU64LE(dirTable + dirOff + 24);
      for (uint64_t i = 0; i < cnt; i++) {
        uint64_t fo = fh + i * 72;
        if (fo + 72 > fileTableLen) break;
        uint64_t nameAddr = readU64LE(fileTable + fo + 0);
        uint64_t attr = readU64LE(fileTable + fo + 8);
        uint64_t dataAddr = readU64LE(fileTable + fo + 40);
        uint64_t dataSize = readU64LE(fileTable + fo + 48);
        uint64_t pressSize = readU64LE(fileTable + fo + 56);
        uint64_t huffSize = readU64LE(fileTable + fo + 64);
        std::string name = sanitizeEntryName(decodeDxName(nameTable, nameAddr, codePage));
        if (name.empty()) continue;
        std::string rel = relDir.empty() ? name : (relDir + "/" + name);
        if (attr & DIR_ATTR) walk(dataAddr, rel);
        else {
          ArchiveEntryRef ref {};
          ref.archiveIdx = archIdx;
          ref.origRelPath = rel;
          ref.dataPos = dataStart + dataAddr;
          ref.dataSize = dataSize;
          ref.pressSize = pressSize;
          ref.huffSize = huffSize;
          if (activeMode.alg == Dx8Alg::Dx8) {
            ref.hasFileKey7 = true;
            ref.fileKey7 = buildFileKey7(dirOff, nameAddr);
          }
          archiveFiles[toLower(rel)] = ref;
          addDirHierarchy(rel, true);
          countOut++;
        }
      }
    };
    walk(0, mountPrefix);
    return true;
  }

  std::shared_ptr<std::vector<uint8_t>> decodeArchiveEntry(const ArchiveEntryRef& ref) {
    if (ref.dataSize == 0) return std::make_shared<std::vector<uint8_t>>();
    const MountedArchive& ma = archives[ref.archiveIdx];

    if (ma.kind == ArchiveKind::Legacy1To5 || ma.kind == ArchiveKind::Dx6) {
      uint64_t stored = (ref.pressSize != MAX_U64_VAL) ? ref.pressSize : ref.dataSize;
      std::vector<uint8_t> raw(static_cast<size_t>(stored));
      if (!readAt(ma.fp, ref.dataPos, raw.data(), raw.size())) return nullptr;
      if (ma.useKey) {
        uint64_t xorPos = (ma.dxVer >= 5) ? ref.dataSize : ref.dataPos;
        xorKeyInPlace(raw.data(), raw.size(), ma.legacyKey.data(), 12, xorPos);
      }
      if (ref.pressSize != MAX_U64_VAL) {
        auto out = std::make_shared<std::vector<uint8_t>>();
        if (!decodeLz(raw.data(), raw.size(), ref.dataSize, *out)) return nullptr;
        return out;
      }
      return std::make_shared<std::vector<uint8_t>>(std::move(raw));
    }

    // DX8
    auto applyInner = [&](uint8_t* buf, size_t len, uint64_t pos) {
      if (ma.dx8Mode.alg == Dx8Alg::Dx8 && ref.hasFileKey7) {
        xorKeyInPlace(buf, len, ref.fileKey7.data(), 7, pos);
      } else if (ma.dx8Mode.alg == Dx8Alg::Wolf) {
        xorWolfCryptInPlace(buf, len, ma.modern.innerKey, pos, ma.cryptVer);
      } else if (ma.dx8Mode.alg == Dx8Alg::ChaCha20) {
        xorChaCha20InPlace(buf, len, ma.dx8Mode.key.data(), ma.dx8Mode.nonce.data(), pos);
      }
    };

    uint64_t baseSize = (ref.pressSize != MAX_U64_VAL) ? ref.pressSize : ref.dataSize;
    std::vector<uint8_t> base;
    if (ref.huffSize != MAX_U64_VAL) {
      std::vector<uint8_t> encH(static_cast<size_t>(ref.huffSize));
      if (!readAt(ma.fp, ref.dataPos, encH.data(), encH.size())) return nullptr;
      if (ma.modern.active) applyModernOuter(encH.data(), encH.size(), ref.dataPos, ma.modern);
      applyInner(encH.data(), encH.size(), ref.dataSize);

      size_t edgeSz = static_cast<size_t>(ma.huffKB) * 1024;
      if (ma.huffKB != 0xFF && baseSize > edgeSz * 2) {
        std::vector<uint8_t> edges;
        if (!decodeHuffman(encH.data(), encH.size(), edgeSz * 2, edges)) return nullptr;
        size_t midSz = static_cast<size_t>(baseSize) - edgeSz * 2;
        std::vector<uint8_t> mid(midSz);
        if (!readAt(ma.fp, ref.dataPos + ref.huffSize, mid.data(), midSz)) return nullptr;
        if (ma.modern.active) applyModernOuter(mid.data(), mid.size(), ref.dataPos + ref.huffSize, ma.modern);
        applyInner(mid.data(), mid.size(), ref.dataSize + ref.huffSize);
        base.resize(static_cast<size_t>(baseSize));
        memcpy(base.data(), edges.data(), edgeSz);
        memcpy(base.data() + edgeSz, mid.data(), midSz);
        memcpy(base.data() + edgeSz + midSz, edges.data() + edgeSz, edgeSz);
      } else {
        if (!decodeHuffman(encH.data(), encH.size(), baseSize, base)) return nullptr;
      }
    } else {
      base.resize(static_cast<size_t>(baseSize));
      if (!readAt(ma.fp, ref.dataPos, base.data(), base.size())) return nullptr;
      if (ma.modern.active) applyModernOuter(base.data(), base.size(), ref.dataPos, ma.modern);
      applyInner(base.data(), base.size(), ref.dataSize);
    }

    if (ref.pressSize != MAX_U64_VAL) {
      auto out = std::make_shared<std::vector<uint8_t>>();
      if (!decodeLz(base.data(), base.size(), ref.dataSize, *out)) return nullptr;
      return out;
    }
    return std::make_shared<std::vector<uint8_t>>(std::move(base));
  }

  std::shared_ptr<std::vector<uint8_t>> getCachedOrLoad(const std::string& lowRel) {
    auto cit = cache.find(lowRel);
    if (cit != cache.end()) {
      lruOrder.erase(cit->second.it);
      lruOrder.push_front(lowRel);
      cit->second.it = lruOrder.begin();
      return cit->second.data;
    }
    std::shared_ptr<std::vector<uint8_t>> decoded;
    auto ait = archiveFiles.find(lowRel);
    if (ait != archiveFiles.end()) {
      decoded = decodeArchiveEntry(ait->second);
    } else {
      auto hit = hostFiles.find(lowRel);
      if (hit != hostFiles.end()) {
        auto v = std::make_shared<std::vector<uint8_t>>();
        if (readWholeHostFile(hit->second.hostFullPath, *v)) decoded = v;
      }
    }
    if (!decoded) return nullptr;

    size_t sz = decoded->size();
    if (sz <= 32 * 1024 * 1024) {
      while (!lruOrder.empty() && cachedBytes + sz > MAX_CACHE_BYTES) {
        std::string evictKey = lruOrder.back();
        lruOrder.pop_back();
        auto eit = cache.find(evictKey);
        if (eit != cache.end()) {
          cachedBytes -= eit->second.data->size();
          cache.erase(eit);
        }
      }
      lruOrder.push_front(lowRel);
      cache[lowRel] = {decoded, lruOrder.begin()};
      cachedBytes += sz;
    }
    return decoded;
  }

  enum class RouteKind { RootAssets, GameCacheAssets, WorkingSave, PersistSave, Data0Root };
  struct RoutedPath {
    RouteKind kind;
    std::string rel;     // original case, no leading slash
    std::string lowRel;  // lowercase rel
    uint32_t dev;
  };

  RoutedPath route(const std::string& normVPath) const {
    if (normVPath == "/" || normVPath.empty()) return {RouteKind::RootAssets, "", "", 1};
    if (normVPath == "/data0") return {RouteKind::Data0Root, "", "", 5};

    if (normVPath.compare(0, 7, "/data0/") == 0) {
      size_t sl = normVPath.find('/', 7);
      std::string bucket = (sl == std::string::npos) ? normVPath.substr(7) : normVPath.substr(7, sl - 7);
      std::string rest = (sl == std::string::npos) ? "" : normVPath.substr(sl + 1);
      if (bucket.size() > 5 && bucket.substr(bucket.size() - 5) == "-Save") {
        return {RouteKind::PersistSave, rest, toLower(rest), 3};
      }
      if (bucket.size() > 10 && bucket.substr(bucket.size() - 10) == "-GameCache") {
        return {RouteKind::GameCacheAssets, rest, toLower(rest), 4};
      }
    }

    std::string rel = normVPath.substr(1);
    std::string low = toLower(rel);
    if (low == "save" || low.compare(0, 5, "save/") == 0) {
      return {RouteKind::WorkingSave, rel, low, 2};
    }
    return {RouteKind::RootAssets, rel, low, 1};
  }

  // Single source of truth for inode numbers so stat()/fstat() and getdents64() always agree
  // (Emscripten's readdir + stat-based dedup / dir-walk logic compares d_ino against st_ino).
  static uint64_t inodeFor(const RoutedPath& r, bool isDir) {
    if (r.kind == RouteKind::Data0Root) return fnv1a64("data0:dir:");
    const char* ns = "root:";
    if (r.kind == RouteKind::WorkingSave) ns = "memsave:";
    else if (r.kind == RouteKind::GameCacheAssets) ns = "cache:";
    else if (r.kind == RouteKind::PersistSave) ns = "persist:";
    return fnv1a64(std::string(ns) + (isDir ? "dir:" : "file:") + r.lowRel);
  }

  static std::string parentVPath(const std::string& normVPath) {
    if (normVPath.empty() || normVPath == "/") return "/";
    size_t pos = normVPath.rfind('/');
    return (pos == 0 || pos == std::string::npos) ? std::string("/") : normVPath.substr(0, pos);
  }

  static std::string childVPath(const std::string& normVPath, const std::string& name) {
    return (normVPath.empty() || normVPath == "/") ? ("/" + name) : (normVPath + "/" + name);
  }
};

WolfVfs::WolfVfs() = default;

WolfVfs::~WolfVfs() {
  shutdown();
}

void WolfVfs::shutdown() {
  if (!impl_) return;
  syncWorkingSavesToDisk();
  for (auto& a : impl_->archives) {
    if (a.fp) {
      fclose(a.fp);
      a.fp = nullptr;
    }
  }
  impl_.reset();
}

bool WolfVfs::init(const std::string& gameDir, const std::string& romfsDir, const std::string& projectId) {
  shutdown();
  impl_ = std::make_unique<Impl>();
  impl_->gameDir = gameDir;
  impl_->saveDir = gameDir + "/Save";
  impl_->romfsDir = romfsDir;
  impl_->projectId = projectId;
  indexedFilesCount_ = 0;
  ftpSafeAliasCount_ = 0;

  mkdirsHost(impl_->saveDir);

  // Initialize virtual root & working /Save directory
  impl_->virtualDirs[""];
  impl_->memDirs.insert("");
  impl_->memDirs.insert("save");
  impl_->addDirHierarchy("Save", false);

  // 1. Scan loose files in <gameDir> first (for unpacked games & custom .ttf fonts)
  impl_->scanLooseHostTree(gameDir, "");

  // 1b. FTP-safe filename aliases (scripts/make-ftp-safe.py): Switch FTP servers can't transfer
  //     non-ASCII names, so such files are uploaded as e.g. Data/BGM/_jp_0012.ogg and listed in
  //     <gameDir>/_jp_map.txt as "<original path>\t<ascii path>". Expose them under their original
  //     (Japanese) path only, so Woditor finds them by the names stored in its data files.
  {
    std::vector<uint8_t> mapBytes;
    if (readWholeHostFile(gameDir + "/_jp_map.txt", mapBytes)) {
      std::string text(mapBytes.begin(), mapBytes.end());
      std::vector<std::string> usedAliases;
      int aliasCount = 0;
      size_t pos = 0;
      while (pos < text.size()) {
        size_t eol = text.find('\n', pos);
        if (eol == std::string::npos) eol = text.size();
        std::string line = text.substr(pos, eol - pos);
        pos = eol + 1;
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.size() >= 3 && line.compare(0, 3, "\xEF\xBB\xBF") == 0) line.erase(0, 3);
        if (line.empty() || line[0] == '#') continue;
        size_t tab = line.find('\t');
        if (tab == std::string::npos || tab == 0 || tab + 1 >= line.size()) continue;
        std::string orig = line.substr(0, tab);
        std::string alias = line.substr(tab + 1);
        for (std::string* s : {&orig, &alias}) {
          for (char& c : *s) if (c == '\\') c = '/';
          while (!s->empty() && s->front() == '/') s->erase(0, 1);
        }
        auto hit = impl_->hostFiles.find(toLower(alias));
        if (hit == impl_->hostFiles.end()) continue;
        std::string origLow = toLower(orig);
        if (origLow == hit->first) continue;
        Impl::HostFileRef ref = hit->second;
        ref.origRelPath = orig;
        impl_->hostFiles[origLow] = ref;
        impl_->addDirHierarchy(orig, true);
        usedAliases.push_back(hit->first);
        aliasCount++;
      }
      for (const auto& low : usedAliases) {
        impl_->hostFiles.erase(low);
        auto pit = impl_->virtualDirs.find(parentPathOf(low));
        if (pit != impl_->virtualDirs.end()) pit->second.erase(baseNameOf(low));
      }
      ftpSafeAliasCount_ = aliasCount;
    }
  }

  // 2. Mount all .wolf / .wolfx / .dxa archives in <gameDir> and <gameDir>/Data directly in memory!
  auto tryMountFile = [&](const std::string& fullPath, const std::string& baseName, bool inDataSub) {
    std::string low = toLower(baseName);
    if (!endsWithIgnoreCase(low, ".wolf") && !endsWithIgnoreCase(low, ".wolfx") && !endsWithIgnoreCase(low, ".dxa")) {
      return;
    }
    uint64_t sz = 0;
    if (!isHostFile(fullPath, &sz) || sz < 24) return;
    FILE* fp = fopen(fullPath.c_str(), "rb");
    if (!fp) return;
    setvbuf(fp, nullptr, _IOFBF, 65536);

    size_t dot = baseName.rfind('.');
    std::string stem = (dot == std::string::npos) ? baseName : baseName.substr(0, dot);
    std::string mountPfx;
    if (!inDataSub && toLower(stem) == "data") mountPfx = "Data";
    else if (inDataSub) mountPfx = "Data/" + stem;
    else mountPfx = stem;

    bool mounted = impl_->tryMountDx8(fp, sz, mountPfx, indexedFilesCount_) ||
                   impl_->tryMountDx6(fp, sz, mountPfx, indexedFilesCount_) ||
                   impl_->tryMountLegacy1To5(fp, sz, mountPfx, indexedFilesCount_);
    if (!mounted) {
      fclose(fp);
      return;
    }
    // Hide the raw archive once its contents are mounted: Woditor otherwise finds e.g.
    // `/data0/<id>-GameCache/Data.wolf`, tries to parse it itself and rejects older
    // WolfCrypt/DX versions ("too old versions. Abort startup"). It must only see the
    // unpacked virtual tree, exactly like a manually extracted game.
    std::string relLow = toLower(inDataSub ? ("Data/" + baseName) : baseName);
    impl_->hostFiles.erase(relLow);
    auto pit = impl_->virtualDirs.find(parentPathOf(relLow));
    if (pit != impl_->virtualDirs.end()) pit->second.erase(baseNameOf(relLow));
  };

  for (const auto& name : listHostDir(gameDir)) {
    tryMountFile(gameDir + "/" + name, name, false);
  }
  if (isHostDir(gameDir + "/Data")) {
    for (const auto& name : listHostDir(gameDir + "/Data")) {
      tryMountFile(gameDir + "/Data/" + name, name, true);
    }
  }

  // 3. Register RomFS default fonts & Game.ini fallback
  for (const char* f : {"DefaultFont.ttf", "DefaultSubFont.ttf", "Game.ini"}) {
    std::string low = toLower(f);
    std::string romPath = romfsDir + "/" + f;
    uint64_t rsz = 0;
    if (impl_->hostFiles.find(low) == impl_->hostFiles.end() && isHostFile(romPath, &rsz)) {
      impl_->hostFiles[low] = {f, romPath, rsz};
      impl_->addDirHierarchy(f, true);
    }
  }

  // 4. Inject virtual BrowserWoditor.dat ("0.2") & InitialDownloadList.ini
  //    Only when a real Data/ tree exists (mounted archive or loose files). Injecting it next to an
  //    unmounted Data.wolf would fabricate a near-empty Data/ folder the browser never has.
  if (impl_->virtualDirs.count("data/basicdata")) {
    impl_->putStaticMemFile("Data/BasicData/BrowserWoditor.dat", "0.2", 3);
  }
  const char* initDl = "Game.ini\r\n";
  impl_->putStaticMemFile("InitialDownloadList.ini", initDl, strlen(initDl));

  // 5. Discover all custom .ttf / .otf / .ttc fonts (both loose in <gameDir> and inside .wolf archives!)
  std::string fontList = "\xEF\xBB\xBF"
                         "DefaultFont.ttf=M PLUS 1p Regular\r\n"
                         "DefaultSubFont.ttf=Oxygen Mono\r\n";

  std::map<std::string, std::string> customFontPaths; // lowRel -> origRelPath
  for (const auto& [low, hf] : impl_->hostFiles) {
    if (low == "defaultfont.ttf" || low == "defaultsubfont.ttf") continue;
    if (endsWithIgnoreCase(low, ".ttf") || endsWithIgnoreCase(low, ".otf") || endsWithIgnoreCase(low, ".ttc")) {
      customFontPaths[low] = hf.origRelPath;
    }
  }
  for (const auto& [low, af] : impl_->archiveFiles) {
    if (endsWithIgnoreCase(low, ".ttf") || endsWithIgnoreCase(low, ".otf") || endsWithIgnoreCase(low, ".ttc")) {
      customFontPaths[low] = af.origRelPath;
    }
  }

  for (const auto& [low, origRel] : customFontPaths) {
    auto bytes = impl_->getCachedOrLoad(low);
    std::vector<std::string> famNames;
    if (bytes && !bytes->empty()) {
      famNames = extractFontNamesFromBytes(bytes->data(), bytes->size());
    }
    if (famNames.empty()) {
      std::string bn = baseNameOf(origRel);
      size_t dot = bn.rfind('.');
      famNames.push_back(dot == std::string::npos ? bn : bn.substr(0, dot));
    }
    for (const auto& fam : famNames) {
      fontList += origRel + "=" + fam + "\r\n";
    }
  }
  impl_->putStaticMemFile("FontList.ini", fontList.data(), fontList.size());

  return true;
}

void WolfVfs::syncWorkingSavesToDisk() {
  if (!impl_) return;
  mkdirsHost(impl_->saveDir);
  for (const auto& [low, mf] : impl_->memFiles) {
    if (low.compare(0, 5, "save/") != 0 || !mf.data) continue;
    std::string sub = mf.origRelPath.substr(5);
    if (sub.empty() || sub.find('/') != std::string::npos) continue;
    std::string dst = impl_->saveDir + "/" + sub;
    FILE* fp = fopen(dst.c_str(), "wb");
    if (fp) {
      if (!mf.data->empty()) fwrite(mf.data->data(), 1, mf.data->size(), fp);
      fflush(fp);
      fclose(fp);
    }
  }
}

bool WolfVfs::isPersistentSavePath(const std::string& normVPath, std::string& outHostPath) const {
  if (!impl_) return false;
  auto r = impl_->route(normVPath);
  if (r.kind != Impl::RouteKind::PersistSave) return false;
  outHostPath = r.rel.empty() ? impl_->saveDir : (impl_->saveDir + "/" + r.rel);
  return true;
}

bool WolfVfs::statPath(const std::string& normVPath, VfsStat& out) {
  if (!impl_) return false;
  auto r = impl_->route(normVPath);

  if (r.kind == Impl::RouteKind::Data0Root) {
    out = {5, Impl::inodeFor(r, true), true, 4096, 1700000000};
    return true;
  }

  if (r.kind == Impl::RouteKind::PersistSave) {
    std::string hp = r.rel.empty() ? impl_->saveDir : (impl_->saveDir + "/" + r.rel);
    if (!isHostDir(hp)) {
      // Case-insensitive lookup inside <gameDir>/Save
      for (const auto& n : listHostDir(impl_->saveDir)) {
        if (toLower(n) == r.lowRel) { hp = impl_->saveDir + "/" + n; break; }
      }
    }
    struct stat st {};
    if (stat(hp.c_str(), &st) != 0) return false;
    bool dir = S_ISDIR(st.st_mode);
    out.dev = 3;
    out.ino = Impl::inodeFor(r, dir);
    out.isDir = dir;
    out.size = dir ? 4096ULL : static_cast<uint64_t>(st.st_size);
    out.mtime = st.st_mtime ? static_cast<int64_t>(st.st_mtime) : 1700000000;
    return true;
  }

  // WorkingSave or RootAssets / GameCacheAssets
  if (impl_->deletedKeys.count(r.lowRel)) return false;

  auto mfit = impl_->memFiles.find(r.lowRel);
  if (mfit != impl_->memFiles.end()) {
    out = {r.dev, Impl::inodeFor(r, false), false, mfit->second.data->size(), mfit->second.mtime};
    return true;
  }
  if (impl_->memDirs.count(r.lowRel)) {
    out = {r.dev, Impl::inodeFor(r, true), true, 4096, 1700000000};
    return true;
  }
  if (r.kind == Impl::RouteKind::WorkingSave) {
    return false;
  }

  auto vdit = impl_->virtualDirs.find(r.lowRel);
  if (vdit != impl_->virtualDirs.end()) {
    out = {r.dev, Impl::inodeFor(r, true), true, 4096, 1700000000};
    return true;
  }
  auto afit = impl_->archiveFiles.find(r.lowRel);
  if (afit != impl_->archiveFiles.end()) {
    out = {r.dev, Impl::inodeFor(r, false), false, afit->second.dataSize, 1700000000};
    return true;
  }
  auto hfit = impl_->hostFiles.find(r.lowRel);
  if (hfit != impl_->hostFiles.end()) {
    out = {r.dev, Impl::inodeFor(r, false), false, hfit->second.size, 1700000000};
    return true;
  }
  return false;
}

bool WolfVfs::listDirectory(const std::string& normVPath, std::vector<VfsDirEntry>& out) {
  out.clear();
  if (!impl_) return false;
  auto r = impl_->route(normVPath);
  // Re-derive every d_ino from the same route + inodeFor() used by statPath()
  auto finalizeInodes = [&]() {
    for (auto& e : out) {
      if (e.name == ".") e.ino = Impl::inodeFor(r, true);
      else if (e.name == "..") e.ino = Impl::inodeFor(impl_->route(Impl::parentVPath(normVPath)), true);
      else e.ino = Impl::inodeFor(impl_->route(Impl::childVPath(normVPath, e.name)), e.isDir);
    }
    return true;
  };

  if (r.kind == Impl::RouteKind::Data0Root) {
    out.push_back({".", true, fnv1a64("data0:.")});
    out.push_back({"..", true, fnv1a64("root:")});
    out.push_back({impl_->projectId + "-GameCache", true, fnv1a64("cache:dir:")});
    out.push_back({impl_->projectId + "-Save", true, fnv1a64("persist:")});
    return finalizeInodes();
  }

  if (r.kind == Impl::RouteKind::PersistSave) {
    std::string hp = r.rel.empty() ? impl_->saveDir : (impl_->saveDir + "/" + r.rel);
    if (!isHostDir(hp)) return false;
    out.push_back({".", true, fnv1a64("persist:" + r.lowRel)});
    out.push_back({"..", true, fnv1a64("persist:parent:" + r.lowRel)});
    for (const auto& n : listHostDir(hp)) {
      std::string cp = hp + "/" + n;
      bool dir = isHostDir(cp);
      out.push_back({n, dir, fnv1a64("persist:" + r.lowRel + "/" + toLower(n))});
    }
    return finalizeInodes();
  }

  bool existsDir = impl_->memDirs.count(r.lowRel) > 0 ||
                   (r.kind != Impl::RouteKind::WorkingSave && impl_->virtualDirs.count(r.lowRel) > 0);
  if (!existsDir) return false;

  std::string nsPfx = (r.kind == Impl::RouteKind::WorkingSave)
      ? "memsave:"
      : (r.kind == Impl::RouteKind::GameCacheAssets ? "cache:" : "root:");

  out.push_back({".", true, fnv1a64(nsPfx + "dir:" + r.lowRel)});
  out.push_back({"..", true, fnv1a64(nsPfx + "parent:" + r.lowRel)});

  std::map<std::string, VfsDirEntry> merged;
  if (r.kind != Impl::RouteKind::WorkingSave) {
    auto vit = impl_->virtualDirs.find(r.lowRel);
    if (vit != impl_->virtualDirs.end()) {
      for (const auto& [k, ent] : vit->second) {
        std::string childLow = r.lowRel.empty() ? k : (r.lowRel + "/" + k);
        if (!impl_->deletedKeys.count(childLow)) merged[k] = ent;
      }
    }
  }
  // Overlay memDirs & memFiles children
  std::string wantPfx = r.lowRel.empty() ? "" : (r.lowRel + "/");
  for (const auto& md : impl_->memDirs) {
    if (md.empty() || md.size() <= wantPfx.size()) continue;
    if (!wantPfx.empty() && md.compare(0, wantPfx.size(), wantPfx) != 0) continue;
    std::string rem = md.substr(wantPfx.size());
    if (rem.find('/') == std::string::npos && !impl_->deletedKeys.count(md)) {
      if (merged.find(rem) == merged.end()) {
        merged[rem] = {rem, true, fnv1a64(nsPfx + "dir:" + md)};
      }
    }
  }
  for (const auto& [mk, mf] : impl_->memFiles) {
    if (mk.size() <= wantPfx.size()) continue;
    if (!wantPfx.empty() && mk.compare(0, wantPfx.size(), wantPfx) != 0) continue;
    std::string rem = mk.substr(wantPfx.size());
    if (rem.find('/') == std::string::npos) {
      merged[rem] = {baseNameOf(mf.origRelPath), false, fnv1a64(nsPfx + mk)};
    }
  }

  for (auto& [_, ent] : merged) out.push_back(std::move(ent));
  return finalizeInodes();
}

std::shared_ptr<std::vector<uint8_t>> WolfVfs::readFile(const std::string& normVPath) {
  if (!impl_) return nullptr;
  auto r = impl_->route(normVPath);
  if (r.kind == Impl::RouteKind::Data0Root) return nullptr;

  if (r.kind == Impl::RouteKind::PersistSave) {
    std::string hp = impl_->saveDir + "/" + r.rel;
    if (!isHostFile(hp)) {
      for (const auto& n : listHostDir(impl_->saveDir)) {
        if (toLower(n) == r.lowRel) { hp = impl_->saveDir + "/" + n; break; }
      }
    }
    auto v = std::make_shared<std::vector<uint8_t>>();
    return readWholeHostFile(hp, *v) ? v : nullptr;
  }

  if (impl_->deletedKeys.count(r.lowRel)) return nullptr;

  auto mfit = impl_->memFiles.find(r.lowRel);
  if (mfit != impl_->memFiles.end()) return mfit->second.data;

  if (r.kind == Impl::RouteKind::WorkingSave) return nullptr;
  return impl_->getCachedOrLoad(r.lowRel);
}

bool WolfVfs::writeMemFile(const std::string& normVPath, const uint8_t* data, size_t len) {
  if (!impl_) return false;
  auto r = impl_->route(normVPath);
  if (r.kind == Impl::RouteKind::PersistSave) {
    mkdirsHost(impl_->saveDir);
    std::string hp = impl_->saveDir + "/" + r.rel;
    FILE* fp = fopen(hp.c_str(), "wb");
    if (!fp) return false;
    bool ok = (len == 0) || (fwrite(data, 1, len, fp) == len);
    fflush(fp);
    fclose(fp);
    return ok;
  }
  if (r.rel.empty()) return false;
  auto vec = std::make_shared<std::vector<uint8_t>>(data, data + len);
  impl_->memFiles[r.lowRel] = {r.rel, vec, 1700000000};
  impl_->deletedKeys.erase(r.lowRel);
  std::string pDir = parentPathOf(r.lowRel);
  while (!pDir.empty()) {
    impl_->memDirs.insert(pDir);
    pDir = parentPathOf(pDir);
  }
  impl_->addDirHierarchy(r.rel, true);
  return true;
}

bool WolfVfs::ensureDir(const std::string& normVPath) {
  if (!impl_) return false;
  auto r = impl_->route(normVPath);
  if (r.kind == Impl::RouteKind::PersistSave) {
    std::string hp = r.rel.empty() ? impl_->saveDir : (impl_->saveDir + "/" + r.rel);
    mkdirsHost(hp);
    return true;
  }
  if (!r.lowRel.empty()) {
    std::string cur = r.lowRel;
    while (!cur.empty()) {
      impl_->memDirs.insert(cur);
      impl_->deletedKeys.erase(cur);
      cur = parentPathOf(cur);
    }
    impl_->addDirHierarchy(r.rel, false);
  }
  return true;
}

bool WolfVfs::removePath(const std::string& normVPath, bool isDirFlag) {
  if (!impl_) return false;
  auto r = impl_->route(normVPath);
  if (r.kind == Impl::RouteKind::PersistSave) {
    std::string hp = impl_->saveDir + "/" + r.rel;
    int rc = isDirFlag ? rmdir(hp.c_str()) : unlink(hp.c_str());
    return rc == 0;
  }
  if (isDirFlag) {
    impl_->memDirs.erase(r.lowRel);
    return true;
  }
  bool had = (impl_->memFiles.erase(r.lowRel) > 0) ||
             (impl_->archiveFiles.count(r.lowRel) > 0) ||
             (impl_->hostFiles.count(r.lowRel) > 0);
  impl_->deletedKeys.insert(r.lowRel);
  return had;
}

bool WolfVfs::renamePath(const std::string& oldNormVPath, const std::string& newNormVPath) {
  auto bytes = readFile(oldNormVPath);
  if (!bytes) return false;
  if (!writeMemFile(newNormVPath, bytes->data(), bytes->size())) return false;
  removePath(oldNormVPath, false);
  return true;
}

} // namespace wolf
