// [switch2-rgss18-syntax-compat]
// Ruby 1.8 (RGSS1 / RPG Maker XP) -> Ruby 3.1 source rewrite for syntax Ruby 1.9 removed.
//
// mkxp-z embeds Ruby 3.1, but RPG Maker XP scripts were written for Ruby 1.8.1. Two Ruby 1.8-only
// constructs are common enough in XP script packs to break boot:
//
//   1. Comma-separated hash literals:  {'a', 1, 'b', 2}   ->  {'a' => 1, 'b' => 2}
//      (e.g. "UMS" Universal Message System: @shortcuts = {'\.', '\p[4]', '\|', '\p[20]', })
//   2. Colon after `when`:              when 1: foo        ->  when 1 then foo
//
// The rewrite is only applied after a script section fails with SyntaxError, so valid scripts are
// never touched. It is a small lexer that understands comments, =begin/=end, strings (with #{}),
// regexps, %-literals, ?c character literals and $' style globals, and only rewrites a {...} when
// every top-level element looks like a plain value (no =>, labels, |block params|, statements, or
// command calls such as `{ p a, b }`) and the element count is even.
#pragma once

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace switch2_rgss18 {

inline bool identChar(char c) {
    unsigned char u = (unsigned char)c;
    return std::isalnum(u) || c == '_' || u >= 0x80;
}

inline char closerOf(char o) {
    switch (o) {
    case '(': return ')';
    case '[': return ']';
    case '{': return '}';
    case '<': return '>';
    default: return o;
    }
}

// Skip a quoted body starting at j (just after the opening delimiter); returns index after closer.
inline size_t skipQuoted(const std::string &s, size_t j, char close, char open, bool interp) {
    const size_t n = s.size();
    int depth = 0;
    while (j < n) {
        char ch = s[j];
        if (ch == '\\') { j += 2; continue; }
        if (interp && ch == '#' && j + 1 < n && s[j + 1] == '{') {
            int d = 1;
            j += 2;
            while (j < n && d > 0) {
                if (s[j] == '\\') { j += 2; continue; }
                if (s[j] == '{') ++d;
                else if (s[j] == '}') --d;
                ++j;
            }
            continue;
        }
        if (open && ch == open) { ++depth; ++j; continue; }
        if (ch == close) {
            if (depth == 0) return j + 1;
            --depth;
        }
        ++j;
    }
    return n;
}

inline bool isValueKeyword(const std::string &w) {
    static const char *const kws[] = {
        "when", "if", "unless", "elsif", "and", "or", "not", "return", "while", "until", "then",
        "do", "else", "case", "in", "yield", "puts", "print", "p", "split", "scan", "gsub", "gsub!",
        "sub", "sub!", "match", "index", "rescue", "include?", nullptr,
    };
    for (int k = 0; kws[k]; ++k)
        if (w == kws[k]) return true;
    return false;
}

// ---------------------------------------------------------------------------------------------
// Byte-level UTF-8 regexps (Ruby 1.8 had no string encodings, so CJK word-wrap scripts matched raw
// UTF-8 bytes, e.g. /(?:\xe4[\xb8-\xbf][\x80-\xbf]|\xe9\xbe[\x80-\xa5])/n). Ruby 3 either rejects them
// ("too short escaped multibyte character") or refuses to match /n regexps against UTF-8 strings.
// Convert each complete byte-sequence alternative into the equivalent Unicode code point class
// ([\u{4e00}-\u{9fa5}]), which matches exactly the same characters.
namespace rx {

struct ByteSet {
    bool b[256] = {};
    bool any() const {
        for (int k = 0; k < 256; ++k)
            if (b[k]) return true;
        return false;
    }
};

struct Node {
    enum Kind { Other, Bytes, Group } kind = Other;
    std::string raw;                       // Other: verbatim text
    ByteSet set;                           // Bytes
    std::string prefix;                    // Group: "(?:", "(", "(?<n>" ...
    bool noncap = false;                   // Group: plain "(?:"
    std::vector<std::vector<Node>> alts;   // Group
    bool quantified = false;               // followed by * + ? {n,m}
    bool quant = false;                    // this Other node is a quantifier
};

inline int hexv(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// \xHH at s[k] -> value, advances k. Returns -1 if not a \xHH escape.
inline int readHexEsc(const std::string &s, size_t &k) {
    if (k + 3 < s.size() + 0 && s[k] == '\\' && s[k + 1] == 'x' && hexv(s[k + 2]) >= 0 && hexv(s[k + 3]) >= 0) {
        int v = hexv(s[k + 2]) * 16 + hexv(s[k + 3]);
        k += 4;
        return v;
    }
    return -1;
}

inline bool hasHighByteEscape(const std::string &s) {
    for (size_t k = 0; k + 3 < s.size(); ++k) {
        if (s[k] == '\\') {
            if (s[k + 1] == 'x' && hexv(s[k + 2]) >= 8 && hexv(s[k + 3]) >= 0) return true;
            ++k;  // skip escaped char
        }
    }
    return false;
}

inline std::string latin1Class(const std::string &cls) {
    static const char digits[] = "0123456789abcdef";
    std::string o;
    for (size_t k = 0; k < cls.size();) {
        if (cls[k] == '\\' && k + 3 < cls.size() && cls[k + 1] == 'x' && hexv(cls[k + 2]) >= 8 && hexv(cls[k + 3]) >= 0) {
            o += "\\u{";
            o += digits[hexv(cls[k + 2])];
            o += digits[hexv(cls[k + 3])];
            o += "}";
            k += 4;
        } else if (cls[k] == '\\' && k + 1 < cls.size()) {
            o += cls.substr(k, 2);
            k += 2;
        } else {
            o += cls[k++];
        }
    }
    return o;
}

inline bool isAllHigh(const ByteSet &s) {
    for (int b = 0; b < 256; ++b)
        if (s.b[b] != (b >= 0x80)) return false;
    return true;
}

struct Parser {
    const std::string &s;
    size_t k = 0;
    bool bad = false;
    explicit Parser(const std::string &src) : s(src) {}

    void parseClass(std::vector<Node> &seq) {
        size_t start = k;
        ++k;  // '['
        bool neg = (k < s.size() && s[k] == '^');
        ByteSet set;
        bool onlyHigh = true, sawHigh = false, sawAny = false;
        int depth = 0;
        while (k < s.size()) {
            char c = s[k];
            if (c == ']' && depth == 0) { ++k; break; }
            if (c == '[') { ++depth; onlyHigh = false; ++k; continue; }
            if (c == ']') { --depth; ++k; continue; }
            if (c == '\\') {
                size_t save = k;
                int v = readHexEsc(s, k);
                if (v >= 0) {
                    int hi = v;
                    if (k + 4 < s.size() + 1 && k < s.size() && s[k] == '-') {
                        size_t k2 = k + 1;
                        int v2 = readHexEsc(s, k2);
                        if (v2 >= 0) { hi = v2; k = k2; }
                    }
                    sawAny = true;
                    if (v >= 0x80 || hi >= 0x80) sawHigh = true;
                    if (v < 0x80 || hi < v) { onlyHigh = false; continue; }
                    for (int b = v; b <= hi; ++b) set.b[b] = true;
                    continue;
                }
                k = save + 2;
                onlyHigh = false;
                sawAny = true;
                continue;
            }
            if (!(neg && k == start + 1)) { onlyHigh = false; sawAny = true; }
            ++k;
        }
        Node n;
        if (!neg && onlyHigh && sawAny && set.any()) {
            n.kind = Node::Bytes;
            n.set = set;
        } else if (sawHigh) {
            // High bytes mixed with ASCII items (e.g. a JSON validator's [^"\\\n\r\x00-\x1f\x7f-\x9f]):
            // single bytes inside a class meant the Latin-1 / C1 range in Ruby 1.8, so \xHH -> \u{hh}.
            n.raw = latin1Class(s.substr(start, k - start));
        } else {
            n.raw = s.substr(start, k - start);
        }
        seq.push_back(n);
    }

    std::vector<std::vector<Node>> parseAlts(bool inGroup) {
        std::vector<std::vector<Node>> alts(1);
        while (k < s.size()) {
            char c = s[k];
            std::vector<Node> &seq = alts.back();
            if (c == ')') {
                if (inGroup) { ++k; return alts; }
                bad = true;
                return alts;
            }
            if (c == '|') { alts.emplace_back(); ++k; continue; }
            if (c == '\\') {
                size_t save = k;
                int v = readHexEsc(s, k);
                if (v >= 0x80) {
                    Node n;
                    n.kind = Node::Bytes;
                    n.set.b[v] = true;
                    seq.push_back(n);
                    continue;
                }
                k = save;
                size_t e = k + 2;
                if (k + 1 < s.size() && (s[k + 1] == 'u' || s[k + 1] == 'p' || s[k + 1] == 'P' || s[k + 1] == 'k' ||
                                         s[k + 1] == 'g') && k + 2 < s.size() && (s[k + 2] == '{' || s[k + 2] == '<')) {
                    char close = s[k + 2] == '{' ? '}' : '>';
                    size_t f = s.find(close, k + 3);
                    e = (f == std::string::npos) ? s.size() : f + 1;
                } else if (k + 1 < s.size() && s[k + 1] == 'x') {
                    e = k + 4;
                }
                if (e > s.size()) e = s.size();
                Node n;
                n.raw = s.substr(k, e - k);
                seq.push_back(n);
                k = e;
                continue;
            }
            if (c == '#' && k + 1 < s.size() && s[k + 1] == '{') {
                size_t e = k + 2;
                int d = 1;
                while (e < s.size() && d > 0) {
                    if (s[e] == '{') ++d;
                    else if (s[e] == '}') --d;
                    ++e;
                }
                Node n;
                n.raw = s.substr(k, e - k);
                seq.push_back(n);
                k = e;
                continue;
            }
            if (c == '[') { parseClass(seq); continue; }
            if (c == '(') {
                Node n;
                n.kind = Node::Group;
                size_t p = k + 1;
                if (p < s.size() && s[p] == '?') {
                    if (p + 1 < s.size() && s[p + 1] == '#') {  // (?# comment )
                        size_t f = s.find(')', p);
                        size_t e = (f == std::string::npos) ? s.size() : f + 1;
                        Node o;
                        o.raw = s.substr(k, e - k);
                        seq.push_back(o);
                        k = e;
                        continue;
                    }
                    if (p + 1 < s.size() && s[p + 1] == ':') {
                        p += 2;
                        n.noncap = true;
                    } else if (p + 1 < s.size() && s[p + 1] == '<' && p + 2 < s.size() && s[p + 2] != '=' &&
                               s[p + 2] != '!') {
                        size_t f = s.find('>', p);
                        p = (f == std::string::npos) ? s.size() : f + 1;
                    } else {
                        ++p;  // skip '?'
                        while (p < s.size() && std::strchr("=!<>imx-", s[p])) ++p;
                        if (p < s.size() && s[p] == ':') ++p;
                    }
                } else {
                    // plain capture
                }
                n.prefix = s.substr(k, p - k);
                k = p;
                n.alts = parseAlts(true);
                seq.push_back(n);
                continue;
            }
            Node n;
            if (c == '*' || c == '+' || c == '?' || c == '{') {
                size_t e = k + 1;
                if (c == '{') {
                    size_t f = s.find('}', k);
                    e = (f == std::string::npos) ? k + 1 : f + 1;
                }
                if (e < s.size() && (s[e] == '?' || s[e] == '+')) ++e;
                n.raw = s.substr(k, e - k);
                n.quant = true;
                if (!seq.empty()) seq.back().quantified = true;
                seq.push_back(n);
                k = e;
                continue;
            }
            n.raw = std::string(1, c);
            seq.push_back(n);
            ++k;
        }
        if (inGroup) bad = true;
        return alts;
    }
};

using ByteSeq = std::vector<ByteSet>;

// Structural expansion of a run of Bytes / unquantified "(?:...)" groups into pure byte sequences.
inline bool expand(const std::vector<Node> &run, size_t from, size_t to, std::vector<ByteSeq> &out) {
    out.assign(1, ByteSeq());
    for (size_t i = from; i < to; ++i) {
        const Node &n = run[i];
        if (n.kind == Node::Bytes) {
            for (auto &q : out) q.push_back(n.set);
        } else if (n.kind == Node::Group && n.noncap) {
            std::vector<ByteSeq> groupSeqs;
            for (const auto &alt : n.alts) {
                std::vector<ByteSeq> sub;
                if (!expand(alt, 0, alt.size(), sub)) return false;
                for (auto &q : sub) groupSeqs.push_back(q);
            }
            std::vector<ByteSeq> next;
            for (const auto &a : out)
                for (const auto &b : groupSeqs) {
                    ByteSeq c = a;
                    c.insert(c.end(), b.begin(), b.end());
                    next.push_back(c);
                }
            out.swap(next);
            if (out.size() > 4096) return false;
        } else {
            return false;
        }
    }
    return true;
}

inline bool isExpandableNode(const Node &n) {
    if (n.quantified) return false;
    if (n.kind == Node::Bytes) return true;
    if (n.kind == Node::Group && n.noncap) {
        for (const auto &alt : n.alts) {
            if (alt.empty()) return false;
            for (const auto &c : alt)
                if (!isExpandableNode(c)) return false;
        }
        return true;
    }
    return false;
}

inline int utf8Len(int lead) {
    if (lead >= 0xC2 && lead <= 0xDF) return 2;
    if (lead >= 0xE0 && lead <= 0xEF) return 3;
    if (lead >= 0xF0 && lead <= 0xF4) return 4;
    return 0;
}

struct Range { unsigned lo, hi; };

inline bool isFullCont(const ByteSet &s) {
    for (int b = 0; b < 256; ++b)
        if (s.b[b] != (b >= 0x80 && b <= 0xBF)) return false;
    return true;
}

inline bool addRanges(const ByteSeq &q, size_t from, size_t len, size_t idx, unsigned acc, std::vector<Range> &out) {
    if (idx == len) {
        out.push_back({acc, acc});
        return true;
    }
    bool allFull = true;
    for (size_t j = idx; j < len; ++j)
        if (!isFullCont(q[from + j])) { allFull = false; break; }
    if (allFull) {
        unsigned rem = (unsigned)(len - idx) * 6;
        out.push_back({acc << rem, ((acc + 1) << rem) - 1});
        return true;
    }
    const ByteSet &s = q[from + idx];
    for (int b = 0; b < 256; ++b) {
        if (!s.b[b]) continue;
        if (b < 0x80 || b > 0xBF) return false;
        if (!addRanges(q, from, len, idx + 1, (acc << 6) | (unsigned)(b & 0x3F), out)) return false;
    }
    return true;
}

// One character position starting at q[from]: returns its length (0 = invalid) and code point ranges.
inline size_t charRanges(const ByteSeq &q, size_t from, std::vector<Range> &out) {
    int len = 0;
    for (int b = 0; b < 256; ++b) {
        if (!q[from].b[b]) continue;
        int l = utf8Len(b);
        if (l == 0 || (len && l != len)) return 0;
        len = l;
    }
    if (len == 0 || from + (size_t)len > q.size()) return 0;
    int mask = len == 2 ? 0x1F : len == 3 ? 0x0F : 0x07;
    for (int b = 0; b < 256; ++b) {
        if (!q[from].b[b]) continue;
        if (!addRanges(q, from, (size_t)len, 1, (unsigned)(b & mask), out)) return 0;
    }
    return (size_t)len;
}

inline std::string hexCp(unsigned cp) {
    // (no snprintf here: Ruby's headers #define it to ruby_snprintf)
    static const char digits[] = "0123456789abcdef";
    std::string h;
    do {
        h.insert(h.begin(), digits[cp & 0xF]);
        cp >>= 4;
    } while (cp);
    return "\\u{" + h + "}";
}

inline std::string emitClass(std::vector<Range> r) {
    std::sort(r.begin(), r.end(), [](const Range &a, const Range &b) { return a.lo < b.lo; });
    std::vector<Range> m;
    for (const auto &x : r) {
        if (!m.empty() && x.lo <= m.back().hi + 1) {
            if (x.hi > m.back().hi) m.back().hi = x.hi;
        } else {
            m.push_back(x);
        }
    }
    if (m.size() == 1 && m[0].lo == m[0].hi) return hexCp(m[0].lo);
    std::string o = "[";
    for (const auto &x : m) {
        o += hexCp(x.lo);
        if (x.hi != x.lo) o += "-" + hexCp(x.hi);
    }
    return o + "]";
}

// Split one byte sequence into per-character classes; empty string on failure.
inline bool splitChars(const ByteSeq &q, std::vector<std::vector<Range>> &chars) {
    for (size_t p = 0; p < q.size();) {
        std::vector<Range> r;
        size_t l = charRanges(q, p, r);
        if (!l) return false;
        chars.push_back(r);
        p += l;
    }
    return true;
}

inline bool emitByteSeqs(const std::vector<ByteSeq> &seqs, std::string &o) {
    std::vector<std::vector<std::vector<Range>>> all;
    bool allSingle = true;
    for (const auto &q : seqs) {
        std::vector<std::vector<Range>> chars;
        if (!splitChars(q, chars) || chars.empty()) return false;
        if (chars.size() != 1) allSingle = false;
        all.push_back(chars);
    }
    if (allSingle) {
        std::vector<Range> u;
        for (auto &a : all) u.insert(u.end(), a[0].begin(), a[0].end());
        o += emitClass(u);
        return true;
    }
    if (all.size() > 1) o += "(?:";
    for (size_t i = 0; i < all.size(); ++i) {
        if (i) o += "|";
        for (auto &c : all[i]) o += emitClass(c);
    }
    if (all.size() > 1) o += ")";
    return true;
}

inline bool emitAlts(const std::vector<std::vector<Node>> &alts, std::string &o);

inline bool emitSeq(const std::vector<Node> &seq, std::string &o) {
    size_t i = 0;
    while (i < seq.size()) {
        const Node &n = seq[i];
        if (n.kind == Node::Bytes && isAllHigh(n.set)) {
            o += "[^\\x00-\\x7f]";  // "any non-ASCII byte" -> any non-ASCII character
            ++i;
            continue;
        }
        if (isExpandableNode(n)) {
            size_t j = i;
            while (j < seq.size() && isExpandableNode(seq[j])) ++j;
            std::vector<ByteSeq> seqs;
            if (expand(seq, i, j, seqs) && emitByteSeqs(seqs, o)) {
                i = j;
                continue;
            }
            // A group of complete characters on its own (e.g. HanZi = /(?:\xe4..|\xe9..)/n)
            if (n.kind == Node::Group) {
                o += n.prefix;
                if (!emitAlts(n.alts, o)) return false;
                o += ")";
                ++i;
                continue;
            }
            return false;
        }
        if (n.kind == Node::Bytes) return false;  // quantified single byte, partial character, ...
        if (n.kind == Node::Group) {
            o += n.prefix;
            if (!emitAlts(n.alts, o)) return false;
            o += ")";
        } else {
            o += n.raw;
        }
        ++i;
    }
    return true;
}

inline bool emitAlts(const std::vector<std::vector<Node>> &alts, std::string &o) {
    for (size_t i = 0; i < alts.size(); ++i) {
        if (i) o += "|";
        if (!emitSeq(alts[i], o)) return false;
    }
    return true;
}

// Returns true and fills `out` when `body` (regexp source between the slashes) was converted.
inline bool convertByteRegexBody(const std::string &body, std::string &out) {
    if (!hasHighByteEscape(body)) return false;
    Parser p(body);
    auto alts = p.parseAlts(false);
    if (p.bad) return false;
    std::string o;
    if (!emitAlts(alts, o)) return false;
    if (hasHighByteEscape(o)) return false;
    out = o;
    return true;
}

}  // namespace rx

struct Frame {
    char open = 0;
    std::vector<size_t> commas;  // positions in `out` of top-level commas
    bool content = false;        // current element has non-blank content
    bool disq = false;           // not a Ruby 1.8 comma hash
    int elemState = 0;           // 0 elem start, 1 after leading lowercase word, 2 word + blank, 3 checked
    bool anyComma = false;       // any top-level comma (all frame kinds)
    bool spaceCall = false;      // `name (` : Ruby 1.8 command call with spaced parentheses
    size_t wsStart = 0;          // start of the blanks between name and '(' in `out`
    size_t openPos = 0;          // position of '(' in `out`
};

inline bool isNoCallKeyword(const std::string &w) {
    static const char *const kws[] = {
        "if", "unless", "while", "until", "and", "or", "not", "when", "case", "elsif", "then", "else", "do",
        "in", "rescue", "ensure", "begin", "end", "return", "break", "next", "redo", "retry", "defined?",
        "nil", "true", "false", "self", nullptr,
    };
    for (int k = 0; kws[k]; ++k)
        if (w == kws[k]) return true;
    return false;
}

// One lexer pass. stripN: only drop the Ruby 1.8 /n flag from regexps without byte escapes.
inline std::string rewritePass(const std::string &src, bool stripN, int &hfOut, int &wfOut, int &rfOut,
                               int &cfOut) {
    std::string out;
    out.reserve(src.size() + 256);
    std::vector<Frame> st;
    const size_t n = src.size();
    size_t i = 0;
    char prevSig = '\n';    // last significant char ('a' = identifier/number, '"' = literal)
    std::string prevWord;
    bool space = false;     // whitespace since the last token
    bool lineStart = true;
    bool whenOn = false, whenTern = false;
    size_t whenDepth = 0;
    int hf = 0, wf = 0, rf = 0, cf = 0;

    auto valueStart = [&]() -> bool {
        if (prevSig == '\n') return true;
        if (std::strchr("(,=!~|&{[;:?+-*<>%^", prevSig)) return true;
        if (prevSig == 'a' && isValueKeyword(prevWord)) return true;
        return false;
    };
    // kind: 0 operator/punct, 1 lowercase identifier (possible command call), 2 value literal
    auto noteToken = [&](int kind) {
        if (st.empty()) return;
        Frame &f = st.back();
        f.content = true;
        if (f.open != '{' || f.disq) return;
        if (f.elemState == 0) {
            f.elemState = (kind == 1) ? 1 : 3;
        } else if (f.elemState == 2) {
            if (kind == 1 || kind == 2) f.disq = true;  // `word value` = command call -> block body
            f.elemState = 3;
        } else if (f.elemState == 1) {
            f.elemState = 3;
        }
    };
    auto noteBlank = [&]() {
        space = true;
        if (!st.empty() && st.back().elemState == 1) st.back().elemState = 2;
    };
    auto disqTop = [&]() {
        if (!st.empty() && st.back().open == '{') st.back().disq = true;
    };

    while (i < n) {
        const char c = src[i];

        if (lineStart) {
            if (src.compare(i, 6, "=begin") == 0 && (i + 6 >= n || !identChar(src[i + 6]))) {
                size_t j = i;
                while (j < n) {
                    size_t nl = src.find('\n', j);
                    size_t lineEnd = (nl == std::string::npos) ? n : nl + 1;
                    bool isEnd = src.compare(j, 4, "=end") == 0;
                    j = lineEnd;
                    if (isEnd) break;
                }
                out.append(src, i, j - i);
                i = j;
                prevSig = '\n';
                continue;
            }
            if (src.compare(i, 7, "__END__") == 0 && (i + 7 >= n || src[i + 7] == '\n')) {
                out.append(src, i, std::string::npos);
                break;
            }
        }
        lineStart = false;

        if (c == '\n') {
            if (whenOn && prevSig != ',' && prevSig != '\\') whenOn = false;
            out.push_back(c);
            ++i;
            noteBlank();
            prevSig = '\n';
            lineStart = true;
            continue;
        }
        if (c == ' ' || c == '\t' || c == '\r') {
            out.push_back(c);
            ++i;
            noteBlank();
            continue;
        }
        if (c == '#') {
            size_t nl = src.find('\n', i);
            if (nl == std::string::npos) nl = n;
            out.append(src, i, nl - i);
            i = nl;
            continue;
        }
        if (c == '\'' || c == '"' || c == '`') {
            noteToken(2);
            size_t j = skipQuoted(src, i + 1, c, 0, c != '\'');
            out.append(src, i, j - i);
            i = j;
            prevSig = '"';
            space = false;
            continue;
        }
        if (c == '$' && i + 1 < n && !identChar(src[i + 1])) {
            noteToken(2);
            out.append(src, i, 2);
            i += 2;
            prevSig = 'a';
            prevWord = "$";
            space = false;
            continue;
        }
        if (c == '?') {
            if (valueStart() && i + 1 < n && !std::isspace((unsigned char)src[i + 1])) {
                size_t len = (src[i + 1] == '\\') ? 3 : 2;
                if (i + len >= n || !identChar(src[i + len])) {
                    noteToken(2);
                    out.append(src, i, len);
                    i += len;
                    prevSig = '"';
                    space = false;
                    continue;
                }
            }
            if (whenOn) whenTern = true;
            noteToken(0);
            out.push_back(c);
            ++i;
            prevSig = '?';
            space = false;
            continue;
        }
        if (c == '/') {
            bool rx = valueStart() ||
                      (prevSig == 'a' && space && i + 1 < n && src[i + 1] != ' ' && src[i + 1] != '=' &&
                       !prevWord.empty() && !std::isdigit((unsigned char)prevWord[0]));
            if (rx) {
                noteToken(2);
                size_t j = skipQuoted(src, i + 1, '/', 0, true);
                size_t bodyEnd = (j > i + 1 && j <= n && src[j - 1] == '/') ? j - 1 : j;
                size_t k = j;
                while (k < n && std::isalpha((unsigned char)src[k])) ++k;
                std::string body = src.substr(i + 1, bodyEnd - (i + 1));
                std::string flags = src.substr(j, k - j);
                std::string flagsNoN;
                for (char fc : flags)
                    if (fc != 'n') flagsNoN.push_back(fc);
                std::string conv;
                if (bodyEnd < j && !stripN && rx::convertByteRegexBody(body, conv)) {
                    out += "/" + conv + "/" + flagsNoN;
                    ++rf;
                } else if (bodyEnd < j && stripN && flagsNoN.size() != flags.size() && !rx::hasHighByteEscape(body)) {
                    out += "/" + body + "/" + flagsNoN;
                    ++rf;
                } else {
                    out.append(src, i, k - i);
                }
                i = k;
                prevSig = '"';
                space = false;
                continue;
            }
        }
        if (c == '%' && valueStart() && i + 1 < n) {
            size_t j = i + 1;
            char t = src[j];
            bool lit = false;
            bool interp = true;
            if (std::strchr("qQwWiIrsx", t) && j + 1 < n && !std::isalnum((unsigned char)src[j + 1]) &&
                !std::isspace((unsigned char)src[j + 1])) {
                interp = !(t == 'q' || t == 'w' || t == 'i' || t == 's');
                ++j;
                lit = true;
            } else if (std::strchr("([{<|!/^", t)) {
                lit = true;
            }
            if (lit) {
                char d = src[j];
                char cl = closerOf(d);
                size_t k = skipQuoted(src, j + 1, cl, cl != d ? d : 0, interp);
                if (t == 'r') while (k < n && std::isalpha((unsigned char)src[k])) ++k;
                noteToken(2);
                out.append(src, i, k - i);
                i = k;
                prevSig = '"';
                space = false;
                continue;
            }
        }
        if (identChar(c) || c == '@' || (c == '$' && i + 1 < n && identChar(src[i + 1]))) {
            size_t j = i;
            if (c == '@') {
                ++j;
                if (j < n && src[j] == '@') ++j;
            } else if (c == '$') {
                ++j;
            }
            while (j < n && identChar(src[j])) ++j;
            if (j < n && (src[j] == '?' || src[j] == '!') && !std::isdigit((unsigned char)c) && c != '@' &&
                c != '$' && (j + 1 >= n || src[j + 1] != '=')) {
                ++j;
            }
            std::string w = src.substr(i, j - i);
            int kind = 2;
            if ((std::islower((unsigned char)c) || c == '_') && w != "nil" && w != "true" && w != "false" &&
                w != "self") {
                kind = 1;
            }
            noteToken(kind);
            if (w == "when" && prevSig != '.' && prevSig != ':') {
                whenOn = true;
                whenTern = false;
                whenDepth = st.size();
            } else if (w == "then") {
                whenOn = false;
            }
            // `key: value` label (Ruby 1.9 hash) -> leave this brace alone
            if (j < n && src[j] == ':' && (j + 1 >= n || src[j + 1] != ':') && !whenOn) disqTop();
            out.append(w);
            i = j;
            prevSig = 'a';
            prevWord = w;
            space = false;
            continue;
        }
        if (c == '(' || c == '[' || c == '{') {
            noteToken(0);
            Frame f;
            f.open = c;
            // Ruby 1.8 `obj.method (a, b)`: Ruby 1.9+ parses "(a, b)" as one (invalid) expression.
            if (c == '(' && prevSig == 'a' && space && !prevWord.empty() && !isNoCallKeyword(prevWord) &&
                !std::isdigit((unsigned char)prevWord[0]) && prevWord[0] != '@' && prevWord[0] != '$') {
                size_t ws = out.size();
                while (ws > 0 && (out[ws - 1] == ' ' || out[ws - 1] == '\t')) --ws;
                if (ws < out.size()) {
                    f.spaceCall = true;
                    f.wsStart = ws;
                    f.openPos = out.size();
                }
            }
            st.push_back(f);
            out.push_back(c);
            ++i;
            prevSig = c;
            space = false;
            continue;
        }
        if (c == ')' || c == ']' || c == '}') {
            if (!st.empty()) {
                Frame f = st.back();
                st.pop_back();
                if (!stripN && f.open == '(' && c == ')' && f.spaceCall && f.anyComma && f.openPos <= out.size()) {
                    out.erase(f.wsStart, f.openPos - f.wsStart);
                    ++cf;
                }
                if (!stripN && f.open == '{' && c == '}' && !f.disq && !f.commas.empty()) {
                    size_t count = f.commas.size() + (f.content ? 1 : 0);
                    if (count >= 2 && (count % 2) == 0) {
                        for (long k = (long)count - 2; k >= 0; k -= 2)
                            out.replace(f.commas[(size_t)k], 1, " =>");
                        ++hf;
                    }
                }
                if (whenOn && st.size() < whenDepth) whenOn = false;
            }
            noteToken(0);
            out.push_back(c);
            ++i;
            prevSig = c;
            space = false;
            continue;
        }
        if (c == ',') {
            if (!st.empty()) st.back().anyComma = true;
            if (!st.empty() && st.back().open == '{') {
                Frame &f = st.back();
                if (!f.content) f.disq = true;
                f.commas.push_back(out.size());
                f.content = false;
                f.elemState = 0;
            }
            out.push_back(c);
            ++i;
            prevSig = ',';
            space = false;
            continue;
        }
        if (c == ';') {
            disqTop();
            whenOn = false;
            out.push_back(c);
            ++i;
            prevSig = ';';
            space = false;
            continue;
        }
        if (c == '|') {
            if (!st.empty() && st.back().open == '{' && st.back().commas.empty() && !st.back().content)
                st.back().disq = true;  // { |x| ... } block parameters
            noteToken(0);
            out.push_back(c);
            ++i;
            prevSig = '|';
            space = false;
            continue;
        }
        if (c == '=' && i + 1 < n && src[i + 1] == '>') {
            disqTop();
            noteToken(0);
            out.append("=>");
            i += 2;
            prevSig = '>';
            space = false;
            continue;
        }
        if (c == '=') {
            char nx = (i + 1 < n) ? src[i + 1] : '\0';
            char pv = (i > 0) ? src[i - 1] : '\0';
            bool assign = nx != '=' && nx != '~' && !std::strchr("=!<>", pv ? pv : ' ');
            if (assign) disqTop();  // `{ a = 1, b }` is a block body with a multiple assignment
        }
        if (c == ':') {
            if (i + 1 < n && src[i + 1] == ':') {
                noteToken(0);
                out.append("::");
                i += 2;
                prevSig = ':';
                space = false;
                continue;
            }
            char nx = (i + 1 < n) ? src[i + 1] : '\n';
            if (!stripN && whenOn && !whenTern && st.size() == whenDepth &&
                (nx == ' ' || nx == '\t' || nx == '\r' || nx == '\n' || nx == ';')) {
                out.append(" then");
                ++i;
                whenOn = false;
                ++wf;
                prevSig = 'a';
                prevWord = "then";
                space = false;
                continue;
            }
            noteToken((identChar(nx) || nx == '"' || nx == '\'') ? 2 : 0);
            out.push_back(c);
            ++i;
            prevSig = ':';
            space = false;
            continue;
        }

        noteToken(0);
        out.push_back(c);
        ++i;
        prevSig = c;
        space = false;
    }

    hfOut = hf;
    cfOut = cf;
    wfOut = wf;
    rfOut = rf;
    return out;
}

// Returns the rewritten source (or `src` unchanged); the counters receive how many constructs changed.
inline std::string rewrite(const std::string &src, int *hashFixes = nullptr, int *whenFixes = nullptr,
                           int *regexFixes = nullptr, int *callFixes = nullptr) {
    int hf = 0, wf = 0, rf = 0, cf = 0;
    std::string out = rewritePass(src, false, hf, wf, rf, cf);
    if (rf > 0) {
        // Converted regexps are now UTF-8; interpolating them into a leftover /n regexp would raise
        // "encoding mismatch in dynamic regexp", so drop /n where it no longer has byte escapes.
        int h2 = 0, w2 = 0, r2 = 0;
        int c2 = 0;
        out = rewritePass(out, true, h2, w2, r2, c2);
    }
    if (hashFixes) *hashFixes = hf;
    if (whenFixes) *whenFixes = wf;
    if (regexFixes) *regexFixes = rf;
    if (callFixes) *callFixes = cf;
    return (hf + wf + rf + cf) > 0 ? out : src;
}

// Drop the Ruby 1.8 /n flag from regexps that have no byte escapes (no other rewrites).
inline std::string stripRegexN(const std::string &src, int *count = nullptr) {
    int h = 0, w = 0, r = 0, c = 0;
    std::string out = rewritePass(src, true, h, w, r, c);
    if (count) *count = r;
    return r > 0 ? out : src;
}

}  // namespace switch2_rgss18
