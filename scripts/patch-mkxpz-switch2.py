#!/usr/bin/env python3
"""
Apply Switch 2 (libounce + OunceVK) & Unified Game Select patches to mkxp-zSwitchPort.
"""
from pathlib import Path
import os
import sys

ROOT = Path(sys.argv[1]).resolve()


def patch_file(rel: str, marker: str, replacements: list[tuple[str, str]]) -> None:
    p = ROOT / rel
    text = p.read_text(encoding="utf-8").replace("\r\n", "\n")
    if marker in text:
        print(f"[ok] {rel} already patched ({marker})")
        return
    for old, new in replacements:
        if old not in text:
            raise RuntimeError(f"Pattern not found in {rel}:\n{old[:200]}")
        text = text.replace(old, new, 1)
    p.write_text(text, encoding="utf-8", newline="\n")
    print(f"[patched] {rel} ({marker})")


def patch_switch_main() -> None:
    patch_file(
        "switch/switch_main.cpp",
        "// [switch2-mkxpz-compat]",
        [
            (
                '#define BOOT_LOG_FILE "sdmc:/mkxpz_boot.log"',
                '// [switch2-mkxpz-compat]\n'
                '#define BOOT_LOG_FILE "sdmc:/switch/SW2RPGMGL/log/mkxpz_boot.log"',
            ),
            (
                "static void boost_cpu() {",
                "static void boost_cpu() {\n"
                "#if defined(__SWITCH2__)\n"
                "    boot_log(\"cpu: Switch 2 Cortex-A78C (skipping Switch 1 clkrst boost)\\n\");\n"
                "    return;\n"
                "#endif",
            ),
            (
                "static void restore_cpu() {",
                "static void restore_cpu() {\n"
                "#if defined(__SWITCH2__)\n"
                "    return;\n"
                "#endif",
            ),
            (
                '    int fd = open_log_fd("sdmc:/mkxpz_log.txt", O_WRONLY | O_CREAT | O_TRUNC);',
                '    mkdir("sdmc:/switch/SW2RPGMGL", 0777);\n'
                '    mkdir("sdmc:/switch/SW2RPGMGL/log", 0777);\n'
                '    int fd = open_log_fd("sdmc:/switch/SW2RPGMGL/log/mkxpz.log", O_WRONLY | O_CREAT | O_TRUNC);\n'
                '    if (fd < 0)\n'
                '        fd = open_log_fd("sdmc:/mkxpz_log.txt", O_WRONLY | O_CREAT | O_TRUNC);',
            ),
        ],
    )

    p = ROOT / "switch/switch_main.cpp"
    text = p.read_text(encoding="utf-8")
    updated = (
        text.replace("sdmc:/switch/Switch2-URPGM-Launcher/mkxpz.log", "sdmc:/switch/SW2RPGMGL/log/mkxpz.log")
            .replace("sdmc:/switch/SW2RPGMGL/mkxpz.log", "sdmc:/switch/SW2RPGMGL/log/mkxpz.log")
            .replace('mkdir("sdmc:/switch/Switch2-URPGM-Launcher"', 'mkdir("sdmc:/switch/SW2RPGMGL"')
            .replace("sdmc:/switch/switch2-MV-loader/mkxpz_boot.log", "sdmc:/switch/SW2RPGMGL/log/mkxpz_boot.log")
            .replace("sdmc:/switch/SW2RPGMGL/mkxpz_boot.log", "sdmc:/switch/SW2RPGMGL/log/mkxpz_boot.log")
    )
    if 'mkdir("sdmc:/switch/SW2RPGMGL/log", 0777);' not in updated:
        updated = updated.replace(
            '    mkdir("sdmc:/switch/SW2RPGMGL", 0777);\n',
            '    mkdir("sdmc:/switch/SW2RPGMGL", 0777);\n'
            '    mkdir("sdmc:/switch/SW2RPGMGL/log", 0777);\n',
            1,
        )
    if updated != text:
        p.write_text(updated, encoding="utf-8", newline="\n")
        print("[patched] switch/switch_main.cpp (SW2RPGMGL log/ paths)")


def patch_gamepicker() -> None:
    patch_file(
        "switch/switch_gamepicker.cpp",
        "// [switch2-external-handoff]",
        [
            (
                "    consoleExit(NULL);\n\n    if (!picked)",
                "    consoleExit(NULL);\n"
                "#if defined(__SWITCH2__)\n"
                "    nwindowReleaseVi2Layer(nwindowGetDefault());\n"
                "#endif\n\n"
                "    if (!picked)",
            ),
            (
                'extern "C" void switch_return_to_picker(const char *argv0) {',
                '// [switch2-external-handoff]\n'
                '#include <cstdlib>\n'
                'static std::string externalReturnNro;\n\n'
                'extern "C" void switch_set_return_nro(const char *path) {\n'
                '    if (path && path[0])\n'
                '        externalReturnNro = path;\n'
                '}\n\n'
                'extern "C" void switch_return_to_picker(const char *argv0) {\n'
                '    // [switch2-exit-hbmenu]\n'
                '    if (const char *hb = std::getenv("SW2RPGMGL_EXIT_HBMENU"); hb && hb[0] == \'1\') {\n'
                '        printf("mkxp-z: exiting directly to hbmenu (kaiHEN)\\n");\n'
                '        return;\n'
                '    }\n'
                '    if (!externalReturnNro.empty()) {\n'
                '        if (envHasNextLoad()) {\n'
                '            std::string args = std::string("\\"") + externalReturnNro + "\\"";\n'
                '            Result rc = envSetNextLoad(externalReturnNro.c_str(), args.c_str());\n'
                '            printf("mkxp-z: return to loader %s: 0x%x\\n", externalReturnNro.c_str(), rc);\n'
                '        }\n'
                '        return;\n'
                '    }',
            ),
        ],
    )

    p = ROOT / "switch/switch_gamepicker.cpp"
    text = p.read_text(encoding="utf-8")
    if "// [switch2-exit-hbmenu]" not in text:
        updated = text.replace(
            'static std::string externalReturnNro;\n',
            '#include <cstdlib>\nstatic std::string externalReturnNro;\n',
            1,
        ).replace(
            'extern "C" void switch_return_to_picker(const char *argv0) {\n',
            'extern "C" void switch_return_to_picker(const char *argv0) {\n'
            '    // [switch2-exit-hbmenu]\n'
            '    if (const char *hb = std::getenv("SW2RPGMGL_EXIT_HBMENU"); hb && hb[0] == \'1\') {\n'
            '        printf("mkxp-z: exiting directly to hbmenu (kaiHEN)\\n");\n'
            '        return;\n'
            '    }\n',
            1,
        )
        if updated != text:
            p.write_text(updated, encoding="utf-8", newline="\n")
            print("[patched] switch/switch_gamepicker.cpp (// [switch2-exit-hbmenu])")

    patch_file(
        "switch/switch_pickerui.cpp",
        "// [switch2-vi2-release]",
        [
            (
                "        framebufferClose(&fb);\n    }",
                "        framebufferClose(&fb);\n"
                "        // [switch2-vi2-release]\n"
                "#if defined(__SWITCH2__)\n"
                "        nwindowReleaseVi2Layer(nwindowGetDefault());\n"
                "#endif\n"
                "    }",
            ),
        ],
    )


def patch_src_main() -> None:
    patch_file(
        "src/main.cpp",
        "// [switch2-direct-game-argv]",
        [
            (
                'extern "C" void switch_return_to_picker(const char *argv0);',
                '#include <sys/stat.h>\n'
                'extern "C" void switch_return_to_picker(const char *argv0);\n'
                'extern "C" void switch_set_return_nro(const char *path);',
            ),
            (
                "    // Pick the game before SDL takes over the display\n"
                "    char switchGameDir[512]{};\n"
                "    if (!switch_pick_game(switchGameDir, sizeof(switchGameDir)))\n"
                "        return 0;",
                "    // [switch2-direct-game-argv]\n"
                "    // When launched by Switch 2 MV Loader with argv[1]=gameDir [argv[2]=returnNro],\n"
                "    // skip the internal picker completely so OunceVK gets a pristine GSV root.\n"
                "    char switchGameDir[512]{};\n"
                "    if (argc >= 2 && argv[1] && argv[1][0] && argv[1][0] != '-') {\n"
                "        std::strncpy(switchGameDir, argv[1], sizeof(switchGameDir) - 1);\n"
                "        if (argc >= 3 && argv[2] && argv[2][0])\n"
                "            switch_set_return_nro(argv[2]);\n"
                "        argc = 1;\n"
                "    } else if (!switch_pick_game(switchGameDir, sizeof(switchGameDir))) {\n"
                "        return 0;\n"
                "    }",
            ),
            (
                "    Config conf;\n    conf.read(argc, argv);",
                "    Config conf;\n    conf.read(argc, argv);\n"
                "#ifdef __SWITCH__\n"
                "    // Auto-mount shared RTP folders placed beside switch2-MV-loader.nro if present\n"
                "    {\n"
                "        const char *sharedRtps[] = {\n"
                "            \"sdmc:/switch/SW2RPGMGL/RPGVXAce\",\n"
                "            \"sdmc:/switch/SW2RPGMGL/rtp-vxace\",\n"
                "            \"sdmc:/switch/SW2RPGMGL/rtp-vx\",\n"
                "            \"sdmc:/switch/SW2RPGMGL/rtp-xp\",\n"
                "            \"sdmc:/switch/switch2-MV-loader/RPGVXAce\",\n"
                "            \"sdmc:/switch/switch2-MV-loader/rtp-vxace\",\n"
                "            \"sdmc:/switch/switch2-MV-loader/rtp-vx\",\n"
                "            \"sdmc:/switch/switch2-MV-loader/rtp-xp\",\n"
                "        };\n"
                "        for (const char *rtp : sharedRtps) {\n"
                "            struct stat st{};\n"
                "            if (stat(rtp, &st) == 0 && S_ISDIR(st.st_mode))\n"
                "                conf.rtps.push_back(rtp);\n"
                "        }\n"
                "    }\n"
                "#endif",
            ),
        ],
    )


def patch_rgssad_cp932() -> None:
    helper = """// [switch2-rgssad-cp932]
#include <iconv.h>

static bool isValidUtf8Bytes(const char *s, size_t len) {
	size_t i = 0;
	while (i < len) {
		unsigned char c = (unsigned char)s[i];
		if (c < 0x80) {
			i++;
		} else if ((c & 0xE0) == 0xC0) {
			if (i + 1 >= len || ((unsigned char)s[i + 1] & 0xC0) != 0x80 || c < 0xC2)
				return false;
			i += 2;
		} else if ((c & 0xF0) == 0xE0) {
			if (i + 2 >= len || ((unsigned char)s[i + 1] & 0xC0) != 0x80 || ((unsigned char)s[i + 2] & 0xC0) != 0x80)
				return false;
			i += 3;
		} else if ((c & 0xF8) == 0xF0) {
			if (i + 3 >= len || ((unsigned char)s[i + 1] & 0xC0) != 0x80 || ((unsigned char)s[i + 2] & 0xC0) != 0x80 || ((unsigned char)s[i + 3] & 0xC0) != 0x80)
				return false;
			i += 4;
		} else {
			return false;
		}
	}
	return true;
}

static void normalizeRgssEntryName(char *nameBuf, uint32_t &nameLen, size_t bufCap) {
	bool hasHigh = false;
	for (uint32_t i = 0; i < nameLen; ++i) {
		if ((unsigned char)nameBuf[i] >= 0x80) {
			hasHigh = true;
			break;
		}
	}
	if (!hasHigh || isValidUtf8Bytes(nameBuf, nameLen)) {
		for (uint32_t i = 0; i < nameLen; ++i)
			if (nameBuf[i] == '\\\\')
				nameBuf[i] = '/';
		nameBuf[nameLen] = '\\0';
		return;
	}
	// CP932 (Shift-JIS) filename inside RGSS archive: skip 2-byte character trail bytes
	// (which can be 0x5C '\\', e.g. katakana 'ソ' 0x83 0x5C) when replacing '\\' -> '/'
	for (uint32_t i = 0; i < nameLen; ++i) {
		unsigned char b = (unsigned char)nameBuf[i];
		if (((b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xFC)) && (i + 1 < nameLen)) {
			++i;
			continue;
		}
		if (nameBuf[i] == '\\\\')
			nameBuf[i] = '/';
	}
	nameBuf[nameLen] = '\\0';
	iconv_t cd = iconv_open("UTF-8", "CP932");
	if (cd == (iconv_t)-1)
		return;
	char outBuf[512];
	char *inPtr = nameBuf;
	size_t inLeft = nameLen;
	char *outPtr = outBuf;
	size_t outLeft = sizeof(outBuf) - 1;
	size_t res = iconv(cd, &inPtr, &inLeft, &outPtr, &outLeft);
	iconv_close(cd);
	if (res != (size_t)-1 && inLeft == 0) {
		size_t outLen = (sizeof(outBuf) - 1) - outLeft;
		if (outLen < bufCap) {
			memcpy(nameBuf, outBuf, outLen);
			nameBuf[outLen] = '\\0';
			nameLen = (uint32_t)outLen;
		}
	}
}
"""
    patch_file(
        "src/crypto/rgssad.cpp",
        "// [switch2-rgssad-cp932]",
        [
            (
                "#include <string>\n",
                "#include <string>\n" + helper,
            ),
            (
                "		static char nameBuf[512];\n"
                "		for (uint32_t i = 0; i < nameLen; ++i)\n"
                "		{\n"
                "			char c;\n"
                "			io->read(io, &c, 1);\n"
                "			nameBuf[i] = c ^ (advanceMagic(magic) & 0xFF);\n"
                "			if (nameBuf[i] == '\\\\')\n"
                "				nameBuf[i] = '/';\n"
                "		}\n"
                "\n"
                "		nameBuf[nameLen] = '\\0';",
                "		static char nameBuf[512];\n"
                "		for (uint32_t i = 0; i < nameLen; ++i)\n"
                "		{\n"
                "			char c;\n"
                "			io->read(io, &c, 1);\n"
                "			nameBuf[i] = c ^ (advanceMagic(magic) & 0xFF);\n"
                "		}\n"
                "		normalizeRgssEntryName(nameBuf, nameLen, sizeof(nameBuf));",
            ),
            (
                "		for (uint32_t i = 0; i < nameLen; ++i)\n"
                "		{\n"
                "			nameBuf[i] ^= ((baseMagic >> 8*(i%4)) & 0xFF);\n"
                "\n"
                "			if (nameBuf[i] == '\\\\')\n"
                "				nameBuf[i] = '/';\n"
                "		}\n"
                "\n"
                "		nameBuf[nameLen] = '\\0';",
                "		for (uint32_t i = 0; i < nameLen; ++i)\n"
                "		{\n"
                "			nameBuf[i] ^= ((baseMagic >> 8*(i%4)) & 0xFF);\n"
                "		}\n"
                "\n"
                "		normalizeRgssEntryName(nameBuf, nameLen, sizeof(nameBuf));",
            ),
        ],
    )


def patch_filesystem_mojibake() -> None:
    mojibake_helpers = """// [switch2-fs-mojibake]
#include <iconv.h>

static bool convertCodepageToBytes(const std::string &utf8, const char *cpName, std::string &rawOut) {
  iconv_t cd = iconv_open(cpName, "UTF-8");
  if (cd == (iconv_t)-1)
    return false;
  rawOut.clear();
  rawOut.reserve(utf8.size());
  const unsigned char *s = (const unsigned char *)utf8.data();
  size_t n = utf8.size();
  size_t i = 0;
  while (i < n) {
    unsigned char c = s[i];
    if (c < 0x80) {
      rawOut.push_back((char)c);
      i++;
      continue;
    }
    size_t seqLen = 0;
    uint32_t cp = 0;
    if ((c & 0xE0) == 0xC0 && i + 1 < n) {
      seqLen = 2;
      cp = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F);
    } else if ((c & 0xF0) == 0xE0 && i + 2 < n) {
      seqLen = 3;
      cp = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F);
    } else if ((c & 0xF8) == 0xF0 && i + 3 < n) {
      seqLen = 4;
      cp = ((c & 0x07) << 18) | ((s[i + 1] & 0x3F) << 12) | ((s[i + 2] & 0x3F) << 6) | (s[i + 3] & 0x3F);
    } else {
      iconv_close(cd);
      return false;
    }
    if (cp >= 0x80 && cp <= 0x9F) {
      rawOut.push_back((char)(unsigned char)cp);
      i += seqLen;
      continue;
    }
    char inBuf[4];
    memcpy(inBuf, s + i, seqLen);
    char outBuf[8];
    char *inPtr = inBuf;
    size_t inLeft = seqLen;
    char *outPtr = outBuf;
    size_t outLeft = sizeof(outBuf);
    iconv(cd, NULL, NULL, NULL, NULL);
    size_t res = iconv(cd, &inPtr, &inLeft, &outPtr, &outLeft);
    if (res == (size_t)-1 || inLeft != 0) {
      iconv_close(cd);
      return false;
    }
    rawOut.append(outBuf, sizeof(outBuf) - outLeft);
    i += seqLen;
  }
  iconv_close(cd);
  return true;
}

static bool convertCp932BytesToUtf8(std::string rawBytes, std::string &utf8Out) {
  for (size_t i = 0; i < rawBytes.size(); ++i) {
    unsigned char b = (unsigned char)rawBytes[i];
    if (((b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xFC)) && (i + 1 < rawBytes.size())) {
      if (rawBytes[i + 1] == '/')
        rawBytes[i + 1] = '\\\\';
      ++i;
    }
  }
  iconv_t cd = iconv_open("UTF-8", "CP932");
  if (cd == (iconv_t)-1)
    return false;
  utf8Out.clear();
  char outBuf[1024];
  char *inPtr = &rawBytes[0];
  size_t inLeft = rawBytes.size();
  char *outPtr = outBuf;
  size_t outLeft = sizeof(outBuf) - 1;
  size_t res = iconv(cd, &inPtr, &inLeft, &outPtr, &outLeft);
  iconv_close(cd);
  if (res == (size_t)-1 || inLeft != 0)
    return false;
  utf8Out.assign(outBuf, (sizeof(outBuf) - 1) - outLeft);
  return true;
}

static int mojibakeLogCount = 0;

static void addRecoveredPathAlias(FileSystemPrivate *p, const std::string &recPath, const std::string &actualMixedCase) {
  if (recPath.empty() || recPath == actualMixedCase)
    return;
  std::string recLower = recPath;
  strTolower(recLower);
  if (p->pathCache.contains(recLower))
    return;
  p->pathCache.insert(recLower, actualMixedCase);
  size_t slash = recLower.rfind('/');
  std::string recDir = (slash != std::string::npos) ? recLower.substr(0, slash) : "";
  std::string recFile = (slash != std::string::npos) ? recLower.substr(slash + 1) : recLower;
  std::vector<std::string> &dirList = p->fileLists[recDir];
  if (std::find(dirList.begin(), dirList.end(), recFile) == dirList.end())
    dirList.push_back(recFile);
  if (mojibakeLogCount < 12) {
    Debug() << "[fs] Recovered Japanese filename alias:" << recPath << "->" << actualMixedCase;
    ++mojibakeLogCount;
  }
}

static bool isValidUtf8Str(const std::string &str) {
  const unsigned char *s = (const unsigned char *)str.data();
  size_t len = str.size();
  size_t i = 0;
  while (i < len) {
    unsigned char c = s[i];
    if (c < 0x80) {
      i++;
    } else if ((c & 0xE0) == 0xC0) {
      if (i + 1 >= len || (s[i + 1] & 0xC0) != 0x80 || c < 0xC2) return false;
      i += 2;
    } else if ((c & 0xF0) == 0xE0) {
      if (i + 2 >= len || (s[i + 1] & 0xC0) != 0x80 || (s[i + 2] & 0xC0) != 0x80) return false;
      i += 3;
    } else if ((c & 0xF8) == 0xF0) {
      if (i + 3 >= len || (s[i + 1] & 0xC0) != 0x80 || (s[i + 2] & 0xC0) != 0x80 || (s[i + 3] & 0xC0) != 0x80) return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}

static void registerMojibakeAliases(FileSystemPrivate *p, const std::string &mixedCase) {
  bool hasHigh = false;
  for (size_t i = 0; i < mixedCase.size(); ++i) {
    if ((unsigned char)mixedCase[i] >= 0x80) {
      hasHigh = true;
      break;
    }
  }
  if (!hasHigh)
    return;

  std::string utf8Rec;
  if (!isValidUtf8Str(mixedCase) && convertCp932BytesToUtf8(mixedCase, utf8Rec))
    addRecoveredPathAlias(p, utf8Rec, mixedCase);

  const char *codepages[] = {"CP850", "CP437", "CP1252", "ISO-8859-1"};
  std::string rawBytes;
  for (const char *cp : codepages) {
    if (convertCodepageToBytes(mixedCase, cp, rawBytes) && convertCp932BytesToUtf8(rawBytes, utf8Rec)) {
      addRecoveredPathAlias(p, utf8Rec, mixedCase);
    }
  }
}

static void loadJpMapAliases(FileSystemPrivate *p) {
  FILE *f = fopen("_jp_map.txt", "rb");
  if (!f)
    return;
  char lineBuf[1024];
  int mappedCount = 0;
  while (fgets(lineBuf, sizeof(lineBuf), f)) {
    size_t len = strlen(lineBuf);
    while (len > 0 && (lineBuf[len - 1] == '\\n' || lineBuf[len - 1] == '\\r'))
      lineBuf[--len] = '\\0';
    if (len == 0 || lineBuf[0] == '#')
      continue;
    char *tab = strchr(lineBuf, '\\t');
    if (!tab || tab == lineBuf)
      continue;
    *tab = '\\0';
    std::string origPath(lineBuf);
    std::string asciiPath(tab + 1);
    for (size_t i = 0; i < origPath.size(); ++i)
      if (origPath[i] == '\\\\') origPath[i] = '/';
    for (size_t i = 0; i < asciiPath.size(); ++i)
      if (asciiPath[i] == '\\\\') asciiPath[i] = '/';
    addRecoveredPathAlias(p, origPath, asciiPath);
    ++mappedCount;
  }
  fclose(f);
  if (mappedCount > 0)
    Debug() << "[fs] Loaded" << mappedCount << "FTP-safe Japanese filename aliases from _jp_map.txt";
}

static bool isSilentProbeFilename(const char *fn) {
  if (!fn) return false;
  size_t l = strlen(fn);
  auto endsWith = [&](const char *suf) -> bool {
    size_t sl = strlen(suf);
    return l >= sl && memcmp(fn + l - sl, suf, sl) == 0;
  };
  return strstr(fn, "-X-") != NULL || endsWith("-X") ||
         endsWith("_ja") || endsWith("_en") || endsWith("_zh") ||
         endsWith("_cn") || endsWith("_tw") || endsWith("_ko") ||
         endsWith("_zh-cn") || endsWith("_zh-tw");
}
"""
    patch_file(
        "src/filesystem/filesystem.cpp",
        "// [switch2-fs-mojibake-v4]",
        [
            (
                "#ifdef __APPLE__\n#include <iconv.h>\n#endif",
                "// [switch2-fs-mojibake-v4]\n#include <iconv.h>",
            ),
            (
                "  if (allowSymlinks)\n    PHYSFS_permitSymbolicLinks(1);",
                "#ifdef __SWITCH__\n"
                "  (void)allowSymlinks;\n"
                "  PHYSFS_permitSymbolicLinks(1);\n"
                "#else\n"
                "  if (allowSymlinks)\n"
                "    PHYSFS_permitSymbolicLinks(1);\n"
                "#endif",
            ),
            (
                "struct CacheEnumData {",
                mojibake_helpers + "\nstruct CacheEnumData {",
            ),
            (
                "    closedir(d);\n  }\n#endif",
                "    closedir(d);\n  }\n\n"
                "  void scanRealDirMounted(const std::string &fsBase, const std::string &virtDir) {\n"
                "    std::string fsDir = virtDir.empty() ? fsBase : (fsBase + \"/\" + virtDir);\n"
                "    DIR *d = opendir(fsDir.c_str());\n"
                "    if (!d)\n"
                "      return;\n"
                "    if (!virtDir.empty())\n"
                "      realDirs.insert(virtDir);\n"
                "    std::string lowerDir = virtDir;\n"
                "    strTolower(lowerDir);\n"
                "    std::vector<std::string> &dirList = p->fileLists[lowerDir];\n"
                "    while (struct dirent *e = readdir(d)) {\n"
                "      if (!strcmp(e->d_name, \".\") || !strcmp(e->d_name, \"..\"))\n"
                "        continue;\n"
                "      std::string vpath = virtDir.empty() ? e->d_name : (virtDir + \"/\" + e->d_name);\n"
                "      if (e->d_type == DT_DIR) {\n"
                "        realDirs.insert(vpath);\n"
                "        scanRealDirMounted(fsBase, vpath);\n"
                "      } else {\n"
                "        realFiles.insert(vpath);\n"
                "        std::string lowerCase = vpath;\n"
                "        strTolower(lowerCase);\n"
                "        if (!p->pathCache.contains(lowerCase)) {\n"
                "          std::string lowerFile(e->d_name);\n"
                "          strTolower(lowerFile);\n"
                "          dirList.push_back(lowerFile);\n"
                "          p->pathCache.insert(lowerCase, vpath);\n"
                "        }\n"
                "        registerMojibakeAliases(p, vpath);\n"
                "      }\n"
                "    }\n"
                "    closedir(d);\n"
                "  }\n#endif",
            ),
            (
                "    std::string lowerFilename(fname);\n"
                "    strTolower(lowerFilename);\n"
                "    list.push_back(lowerFilename);\n"
                "\n"
                "    /* Add the lower -> mixed mapping of the file's full path */\n"
                "    data.p->pathCache.insert(lowerCase, mixedCase);\n"
                "  }",
                "    std::string lowerFilename(fname);\n"
                "    strTolower(lowerFilename);\n"
                "    if (!data.p->pathCache.contains(lowerCase)) {\n"
                "      list.push_back(lowerFilename);\n"
                "      /* Add the lower -> mixed mapping of the file's full path */\n"
                "      data.p->pathCache.insert(lowerCase, mixedCase);\n"
                "    }\n"
                "    registerMojibakeAliases(data.p, mixedCase);\n"
                "  }",
            ),
            (
                "  PHYSFS_enumerate(\"\", cacheEnumCB, &data);\n\n  p->havePathCache = true;",
                "  PHYSFS_enumerate(\"\", cacheEnumCB, &data);\n"
                "  loadJpMapAliases(p);\n"
                "#ifdef __SWITCH__\n"
                "  if (!p->pathCache.contains(\"graphics/system/iconset.png\")) {\n"
                "    // 1. Fast path: check dedicated RTP folders (../RPGVXAce, ../../RPGVXAce, etc.)\n"
                "    //    and populate pathCache directly via scanRealDirMounted (0 PHYSFS_enumerate calls, <50ms!).\n"
                "    const char *rtpDirs[] = {\n"
                "      \"../RPGVXAce\", \"../../RPGVXAce\",\n"
                "      \"../rtp-vxace\", \"../../rtp-vxace\",\n"
                "      \"../RTP\", \"../../RTP\",\n"
                "      \"../rtp\", \"../../rtp\"\n"
                "    };\n"
                "    for (const char *rtpDir : rtpDirs) {\n"
                "      DIR *gDir = opendir((std::string(rtpDir) + \"/Graphics\").c_str());\n"
                "      DIR *aDir = opendir((std::string(rtpDir) + \"/Audio\").c_str());\n"
                "      if (gDir || aDir) {\n"
                "        if (gDir) { closedir(gDir); data.scanRealDirMounted(rtpDir, \"Graphics\"); }\n"
                "        if (aDir) { closedir(aDir); data.scanRealDirMounted(rtpDir, \"Audio\"); }\n"
                "        PHYSFS_mount(rtpDir, 0, 1);\n"
                "        Debug() << \"[fs] Mounted dedicated VX Ace RTP folder (fast direct scan):\" << rtpDir;\n"
                "        break;\n"
                "      }\n"
                "    }\n"
                "  }\n"
                "  if (!p->pathCache.contains(\"graphics/system/iconset.png\")) {\n"
                "    // 2. Fallback: only if no dedicated RTP folder exists, check sibling VX Ace games.\n"
                "    DIR *pd = opendir(\"..\");\n"
                "    if (pd) {\n"
                "      int mountedRgssArchives = 0;\n"
                "      while (struct dirent *pe = readdir(pd)) {\n"
                "        if (!strcmp(pe->d_name, \".\") || !strcmp(pe->d_name, \"..\") || pe->d_type != DT_DIR)\n"
                "          continue;\n"
                "        std::string sibDir = std::string(\"../\") + pe->d_name;\n"
                "        std::string sibSelfIni = sibDir + \"/Game.ini\";\n"
                "        std::string sibRgss3a = sibDir + \"/Game.rgss3a\";\n"
                "        bool mountedAny = false;\n"
                "        FILE *fRgss = fopen(sibRgss3a.c_str(), \"rb\");\n"
                "        if (fRgss) {\n"
                "          fclose(fRgss);\n"
                "          if (PHYSFS_mount(sibRgss3a.c_str(), 0, 1)) {\n"
                "            mountedAny = true;\n"
                "            ++mountedRgssArchives;\n"
                "          } else {\n"
                "            try {\n"
                "              PHYSFS_Io *io = createSDLRWIo(sibRgss3a.c_str());\n"
                "              if (io && PHYSFS_mountIo(io, sibRgss3a.c_str(), 0, 1)) {\n"
                "                mountedAny = true;\n"
                "                ++mountedRgssArchives;\n"
                "              }\n"
                "            } catch (...) {}\n"
                "          }\n"
                "        }\n"
                "        FILE *fIni = fopen(sibSelfIni.c_str(), \"rb\");\n"
                "        if (fIni || mountedAny) {\n"
                "          if (fIni) fclose(fIni);\n"
                "          DIR *gDir = opendir((sibDir + \"/Graphics\").c_str());\n"
                "          DIR *aDir = opendir((sibDir + \"/Audio\").c_str());\n"
                "          if (gDir || aDir) {\n"
                "            if (gDir) { closedir(gDir); data.scanRealDirMounted(sibDir, \"Graphics\"); }\n"
                "            if (aDir) { closedir(aDir); data.scanRealDirMounted(sibDir, \"Audio\"); }\n"
                "            if (PHYSFS_mount(sibDir.c_str(), 0, 1))\n"
                "              mountedAny = true;\n"
                "          }\n"
                "        }\n"
                "        if (mountedAny) {\n"
                "          Debug() << \"[fs] Mounted sibling VX Ace RTP fallback source:\" << sibDir;\n"
                "        }\n"
                "      }\n"
                "      closedir(pd);\n"
                "      if (mountedRgssArchives > 0 && !p->pathCache.contains(\"graphics/system/iconset.png\")) {\n"
                "        data.fileLists.push(&p->fileLists[\"graphics\"]);\n"
                "        PHYSFS_enumerate(\"Graphics\", cacheEnumCB, &data);\n"
                "        data.fileLists.pop();\n"
                "      }\n"
                "    }\n"
                "  }\n"
                "#endif\n\n"
                "  p->havePathCache = true;",
            ),
            (
                "  if (data.matchCount == 0)\n"
                "    throw Exception(Exception::NoFileError, \"%s\", filename);",
                "  if (data.matchCount == 0) {\n"
                "    if (p->havePathCache && !isSilentProbeFilename(filename)) {\n"
                "      const std::vector<std::string> &fl = p->fileLists[dir];\n"
                "      std::string sample;\n"
                "      for (size_t i = 0; i < fl.size() && i < 8; ++i) {\n"
                "        if (i > 0) sample += \", \";\n"
                "        sample += fl[i];\n"
                "      }\n"
                "      Debug() << \"[fs] NoFileError:\" << filename << \"(dir=\" << dir << \"count=\" << fl.size() << \"sample=[\" << sample << \"])\";\n"
                "    }\n"
                "    throw Exception(Exception::NoFileError, \"%s\", filename);\n"
                "  }",
            ),
            (
                "void FileSystem::openReadRaw(SDL_RWops &ops, const char *filename,\n"
                "                             bool freeOnClose) {\n"
                "\n"
                "  PHYSFS_File *handle = PHYSFS_openRead(normalize(filename, 0, 0).c_str());",
                "void FileSystem::openReadRaw(SDL_RWops &ops, const char *filename,\n"
                "                             bool freeOnClose) {\n"
                "  std::string norm = normalize(filename, 0, 0);\n"
                "  PHYSFS_File *handle = PHYSFS_openRead(desensitize(norm.c_str()));\n"
                "  if (!handle)\n"
                "    handle = PHYSFS_openRead(norm.c_str());",
            ),
            (
                "bool FileSystem::exists(const char *filename) {\n"
                "  return PHYSFS_exists(normalize(filename, false, false).c_str());\n"
                "}",
                "bool FileSystem::exists(const char *filename) {\n"
                "  std::string norm = normalize(filename, false, false);\n"
                "  if (PHYSFS_exists(desensitize(norm.c_str())))\n"
                "    return true;\n"
                "  return PHYSFS_exists(norm.c_str());\n"
                "}",
            ),
        ],
    )


def patch_audio_missing_graceful() -> None:
    patch_file(
        "src/audio/audiostream.cpp",
        "// [switch2-audio-graceful-v2]",
        [
            (
                '#include "exception.h"\n',
                '#include "exception.h"\n#include "debugwriter.h"\n#include <unordered_set>\n// [switch2-audio-graceful-v2]\nstatic std::unordered_set<std::string> missingAudioStreams;\n',
            ),
            (
                "                       double offset)\n{\n	finiFadeOutInt();\n\n	lockStream();\n",
                "                       double offset)\n{\n	finiFadeOutInt();\n\n	lockStream();\n"
                "	if (missingAudioStreams.count(filename)) {\n"
                "		unlockStream();\n"
                "		return;\n"
                "	}\n",
            ),
            (
                "		catch (const Exception &e)\n"
                "		{\n"
                "			unlockStream();\n"
                "			throw e;\n"
                "		}",
                "		catch (const Exception &e)\n"
                "		{\n"
                "			if (e.type == Exception::NoFileError) {\n"
                "				missingAudioStreams.insert(filename);\n"
                "				unlockStream();\n"
                "				Debug() << \"[audio] Skipping missing audio stream:\" << filename;\n"
                "				return;\n"
                "			}\n"
                "			unlockStream();\n"
                "			throw e;\n"
                "		}",
            ),
        ],
    )

    patch_file(
        "src/audio/soundemitter.cpp",
        "// [switch2-se-graceful-v2]",
        [
            (
                '#include "exception.h"\n',
                '#include "exception.h"\n#include <unordered_set>\nstatic std::unordered_set<std::string> missingSoundEffects;\n',
            ),
            (
                "		/* Buffer not in cache, needs to be loaded */\n"
                "		SoundOpenHandler handler;\n"
                "		shState->fileSystem().openRead(handler, filename.c_str());",
                "		/* Buffer not in cache, needs to be loaded */\n"
                "		// [switch2-se-graceful-v2]\n"
                "		if (missingSoundEffects.count(filename))\n"
                "			return 0;\n"
                "		SoundOpenHandler handler;\n"
                "		try {\n"
                "			shState->fileSystem().openRead(handler, filename.c_str());\n"
                "		} catch (const Exception &e) {\n"
                "			if (e.type == Exception::NoFileError) {\n"
                "				missingSoundEffects.insert(filename);\n"
                "				Debug() << \"[audio] Skipping missing SE:\" << filename;\n"
                "				return 0;\n"
                "			}\n"
                "			throw e;\n"
                "		}",
            ),
        ],
    )


def patch_bitmap_missing_graceful() -> None:
    patch_file(
        "src/display/bitmap.cpp",
        "// [switch2-bitmap-graceful-v3]",
        [
            (
                "    } catch (const Exception &e) {\n"
                "        if (hiresBitmap)\n"
                "            delete hiresBitmap;\n"
                "        throw e;\n"
                "    }",
                "    } catch (const Exception &e) {\n"
                "        // [switch2-bitmap-graceful-v3]\n"
                "        // Let Langscore localization suffix probes (*_ja, *_en, *_zh, *_cn, *_tw, *_ko)\n"
                "        // and CanariAlternate diagonal character probes (*-X-*, *-X in KING EXIT Script #138)\n"
                "        // throw NoFileError (Errno::ENOENT) so the game script rescues it cleanly!\n"
                "        auto isProbeFilename = [](const char *fn) -> bool {\n"
                "            if (!fn) return false;\n"
                "            size_t l = strlen(fn);\n"
                "            auto endsWith = [&](const char *suf) -> bool {\n"
                "                size_t sl = strlen(suf);\n"
                "                return l >= sl && memcmp(fn + l - sl, suf, sl) == 0;\n"
                "            };\n"
                "            return strstr(fn, \"-X-\") != NULL || endsWith(\"-X\") ||\n"
                "                   endsWith(\"_ja\") || endsWith(\"_en\") || endsWith(\"_zh\") ||\n"
                "                   endsWith(\"_cn\") || endsWith(\"_tw\") || endsWith(\"_ko\") ||\n"
                "                   endsWith(\"_zh-cn\") || endsWith(\"_zh-tw\");\n"
                "        };\n"
                "        if (e.type == Exception::NoFileError && !isProbeFilename(filename)) {\n"
                "            int fbW = 128, fbH = 128;\n"
                "            if (strstr(filename, \"Titles\") || strstr(filename, \"titles\") || strstr(filename, \"Battlebacks\") || strstr(filename, \"battlebacks\")) {\n"
                "                fbW = 544; fbH = 416;\n"
                "            } else if (strstr(filename, \"Characters\") || strstr(filename, \"characters\")) {\n"
                "                fbW = 384; fbH = 256;\n"
                "            } else if (strstr(filename, \"Faces\") || strstr(filename, \"faces\")) {\n"
                "                fbW = 384; fbH = 192;\n"
                "            } else if (strstr(filename, \"IconSet\") || strstr(filename, \"iconset\")) {\n"
                "                fbW = 384; fbH = 512;\n"
                "            } else if (strstr(filename, \"Tilesets\") || strstr(filename, \"tilesets\")) {\n"
                "                fbW = 512; fbH = 512;\n"
                "            }\n"
                "            Debug() << \"[bitmap] Missing image file (creating\" << fbW << \"x\" << fbH << \"placeholder):\" << filename;\n"
                "            handler.surface = SDL_CreateRGBSurfaceWithFormat(0, fbW, fbH, 32, SDL_PIXELFORMAT_ABGR8888);\n"
                "            if (handler.surface) {\n"
                "                if (strstr(filename, \"System/Window\") || strstr(filename, \"system/window\")) {\n"
                "                    SDL_FillRect(handler.surface, NULL, SDL_MapRGBA(handler.surface->format, 24, 28, 44, 210));\n"
                "                } else {\n"
                "                    SDL_FillRect(handler.surface, NULL, 0);\n"
                "                }\n"
                "            } else {\n"
                "                if (hiresBitmap) delete hiresBitmap;\n"
                "                throw e;\n"
                "            }\n"
                "        } else {\n"
                "            if (hiresBitmap)\n"
                "                delete hiresBitmap;\n"
                "            throw e;\n"
                "        }\n"
                "    }",
            ),
        ],
    )


def patch_viewport_disposed_graceful() -> None:
    # Keep ViewportPrivate alive until ~Viewport() (only unlinking from the screen Scene on dispose())
    # and make disposed Viewport access non-fatal so scripts like KING EXIT's 174:テストプレー高速化
    # that touch a disposed Viewport during Graphics.transition never crash with RGSSError("disposed viewport").
    patch_file(
        "src/util/disposable.h",
        "// [switch2-disposed-viewport-graceful]",
        [
            (
                "#include <assert.h>\n",
                "#include <assert.h>\n#include <string.h>\n",
            ),
            (
                "	void guardDisposed() const\n"
                "	{\n"
                "		if (isDisposed())\n"
                "			throw Exception(Exception::RGSSError,\n"
                "		                    \"disposed %s\", klassName());\n"
                "	}",
                "	// [switch2-disposed-viewport-graceful]\n"
                "	void guardDisposed() const\n"
                "	{\n"
                "		if (isDisposed() && strcmp(klassName(), \"viewport\") != 0)\n"
                "			throw Exception(Exception::RGSSError,\n"
                "		                    \"disposed %s\", klassName());\n"
                "	}",
            ),
        ],
    )

    patch_file(
        "src/display/viewport.cpp",
        "// [switch2-viewport-keep-p-until-dtor]",
        [
            (
                "Viewport::~Viewport()\n"
                "{\n"
                "	dispose();\n"
                "}",
                "// [switch2-viewport-keep-p-until-dtor]\n"
                "Viewport::~Viewport()\n"
                "{\n"
                "	dispose();\n"
                "	delete p;\n"
                "	p = 0;\n"
                "}",
            ),
            (
                "void Viewport::releaseResources()\n"
                "{\n"
                "	unlink();\n"
                "\n"
                "	delete p;\n"
                "}",
                "void Viewport::releaseResources()\n"
                "{\n"
                "	unlink();\n"
                "}",
            ),
        ],
    )

    patch_file(
        "binding/disposable-binding.h",
        "// [switch2-checkdisposed-viewport-graceful]",
        [
            (
                "template<class C>\n"
                "inline void\n"
                "checkDisposed(VALUE self)\n"
                "{\n"
                "	if (disposableIsDisposed<C>(0, 0, self) == Qtrue)\n"
                "		raiseDisposedAccess(self);\n"
                "}",
                "// [switch2-checkdisposed-viewport-graceful]\n"
                "class Viewport;\n"
                "template<class C>\n"
                "inline void\n"
                "checkDisposed(VALUE self)\n"
                "{\n"
                "	if (disposableIsDisposed<C>(0, 0, self) == Qtrue)\n"
                "		raiseDisposedAccess(self);\n"
                "}\n"
                "template<>\n"
                "inline void\n"
                "checkDisposed<Viewport>(VALUE)\n"
                "{\n"
                "}",
            ),
        ],
    )


def patch_switch_controls_raw_keys() -> None:
    patch_file(
        "switch/switch_controls.cpp",
        "// [switch2-always-update-keystates-v2]",
        [
            (
                "    p.keys[In_A] = {SDL_SCANCODE_RETURN};",
                "    p.keys[In_A] = {SDL_SCANCODE_RETURN, SDL_SCANCODE_Z};",
            ),
            (
                'extern "C" void switch_controls_update(const bool *buttons, const int *axes, uint8_t *keyStates) {\n'
                '    if (activeProfile)\n'
                '        SwitchControls::applyKeys(*activeProfile, buttons, axes, keyStates);\n'
                '}',
                '// [switch2-always-update-keystates-v2]\n'
                'extern "C" void switch_controls_update(const bool *buttons, const int *axes, uint8_t *keyStates) {\n'
                '    const SwitchControls::Profile &prof = activeProfile ? *activeProfile : SwitchControls::defaultProfile();\n'
                '    SwitchControls::applyKeys(prof, buttons, axes, keyStates);\n'
                '}',
            ),
        ],
    )


def patch_ruby_preloads() -> None:
    win32api_stub = ROOT / "switch" / "romfs-root" / "preload" / "win32api_stub.rb"
    win32api_stub.write_text(
        """# win32api_stub.rb
# [switch2-dl-and-win32-compat]
# Provides Win32API base stub, Ruby 1.9 DL / DL::CPtr / Fiddle memory buffer
# emulation (used by Cidiomar Input and other RGSS3 Win32 scripts), and classic
# Ruby 1.8/1.9 compatibility helpers.

class Hash
	alias_method :index, :key unless method_defined?(:index)
end

class Object
	TRUE = true unless const_defined?("TRUE")
	FALSE = false unless const_defined?("FALSE")
	NIL = nil unless const_defined?("NIL")

	alias_method :id, :object_id unless method_defined?(:id)
	alias_method :type, :class unless method_defined?(:type)
end

if defined?(BasicObject) && BasicObject.instance_method(:initialize).arity == 0
	class BasicObject
		def initialize(*args)
		end
	end
end

module MKXP
	class << self
		def data_directory(*args)
			System::data_directory(*args)
		end
		def puts(*args)
			System::puts(*args)
		end
		def raw_key_states(*args)
			states = Input.__mkxp_raw_key_states(*args)
			class << states
				def getbyte(byte)
					self[byte] ? 1 : 0
				end
				def setbyte(byte, val)
					self[byte] = val == 0 ? false : true
				end
			end
			states
		end
		def mouse_in_window(*args)
			Input::mouse_in_window(*args)
		end
	end
end

# Preserve native C++ Input methods and constants before any game script (e.g.
# Cidiomar Input) overwrites the Input module methods or constants.
# Track $mkxp_raw_input_updated_this_frame so Win32API polling (e.g. KING EXIT's
# HZM_VXA::ScreenShot GetKeyState inside Scene_Base#update_basic) NEVER calls
# native Input.update a second time in the same frame and wipes out Input.trigger?!
$mkxp_raw_input_updated_this_frame = false

module Input
	class << self
		alias_method :__mkxp_raw_press?, :press? unless method_defined?(:__mkxp_raw_press?)
		alias_method :__mkxp_raw_trigger?, :trigger? unless method_defined?(:__mkxp_raw_trigger?)
		alias_method :__mkxp_raw_repeat?, :repeat? unless method_defined?(:__mkxp_raw_repeat?)
		alias_method :__mkxp_raw_release?, :release? unless method_defined?(:__mkxp_raw_release?)
		alias_method :__mkxp_raw_dir4, :dir4 unless method_defined?(:__mkxp_raw_dir4)
		alias_method :__mkxp_raw_dir8, :dir8 unless method_defined?(:__mkxp_raw_dir8)
		alias_method :__mkxp_c_update, :update unless method_defined?(:__mkxp_c_update)
		alias_method :__mkxp_raw_key_states, :raw_key_states unless method_defined?(:__mkxp_raw_key_states)

		def __mkxp_raw_update(*args)
			$mkxp_raw_input_updated_this_frame = true
			__mkxp_c_update(*args)
		end
		alias_method :update, :__mkxp_raw_update
	end
	MKXP_MOUSELEFT = MOUSELEFT unless const_defined?(:MKXP_MOUSELEFT)
	MKXP_MOUSERIGHT = MOUSERIGHT unless const_defined?(:MKXP_MOUSERIGHT)
	MKXP_MOUSEMIDDLE = MOUSEMIDDLE unless const_defined?(:MKXP_MOUSEMIDDLE)
end

# Ruby 1.9 DL & CPtr emulation backed by Virtual Address -> Byte String table
$mkxp_dl_buffers = {}
$mkxp_dl_next_addr = 0x10000000

module DL
	SIZEOF_VOIDP = 4
	SIZEOF_CHAR = 1
	SIZEOF_SHORT = 2
	SIZEOF_INT = 4
	SIZEOF_LONG = 4
	SIZEOF_LONG_LONG = 8
	SIZEOF_FLOAT = 4
	SIZEOF_DOUBLE = 8

	def self.malloc(size)
		sz = [size.to_i, 1].max
		addr = $mkxp_dl_next_addr
		$mkxp_dl_next_addr += ((sz + 16) & ~15)
		$mkxp_dl_buffers[addr] = ("\\x00".b * sz)
		addr
	end

	def self.realloc(addr, size)
		sz = [size.to_i, 1].max
		old = $mkxp_dl_buffers[addr.to_i] || "".b
		if old.bytesize < sz
			$mkxp_dl_buffers[addr.to_i] = old + ("\\x00".b * (sz - old.bytesize))
		else
			$mkxp_dl_buffers[addr.to_i] = old.byteslice(0, sz)
		end
		addr.to_i
	end

	def self.free(addr)
		$mkxp_dl_buffers.delete(addr.to_i)
		nil
	end

	class CPtr
		attr_accessor :size

		def self.malloc(size, free = nil)
			addr = DL.malloc(size)
			new(addr, size, free)
		end

		def self.to_ptr(val)
			new(val)
		end

		def self.[](val)
			new(val)
		end

		def initialize(addr_or_val, size = nil, free = nil)
			@offset = 0
			if addr_or_val.is_a?(String)
				@buf = addr_or_val
				@size = size ? size.to_i : @buf.bytesize
				@addr = $mkxp_dl_next_addr
				$mkxp_dl_next_addr += (([@size, 16].max + 16) & ~15)
				$mkxp_dl_buffers[@addr] = @buf
			elsif addr_or_val.is_a?(CPtr)
				@addr = addr_or_val.to_i
				@buf = $mkxp_dl_buffers[@addr] ||= ("\\x00".b * (size || addr_or_val.size || 256).to_i)
				@size = size ? size.to_i : @buf.bytesize
			else
				n = addr_or_val.to_i
				if n == 0 && size.nil?
					@addr = 0
					@size = 0
					@buf = "".b
				elsif $mkxp_dl_buffers.key?(n)
					@addr = n
					@buf = $mkxp_dl_buffers[@addr]
					@size = size ? size.to_i : @buf.bytesize
				elsif size.nil? && n > 0 && n <= 0x100000
					# Called as DL::CPtr.new(256) where 256 is buffer size
					@size = n
					@addr = DL.malloc(@size)
					@buf = $mkxp_dl_buffers[@addr]
				else
					@size = (size || 256).to_i
					@addr = n >= 0x10000000 ? n : DL.malloc(@size)
					@buf = $mkxp_dl_buffers[@addr] ||= ("\\x00".b * @size)
				end
			end
		end

		def to_i
			@addr + @offset
		end
		alias_method :to_int, :to_i

		def to_s(len = nil)
			if len
				@buf.byteslice(@offset, len.to_i) || "".b
			elsif @offset == 0
				@buf
			else
				@buf.byteslice(@offset, @buf.bytesize - @offset) || "".b
			end
		end
		alias_method :to_str, :to_s
		alias_method :to_value, :to_s

		def null?
			to_i == 0
		end

		def ptr
			self
		end
		alias_method :+@, :ptr

		def ref
			self
		end
		alias_method :-@, :ref

		def +(delta)
			copy = self.dup
			copy.instance_variable_set(:@offset, @offset + delta.to_i)
			copy
		end

		def -(delta)
			self + (-delta.to_i)
		end

		def [](idx, len = nil)
			pos = @offset + idx.to_i
			if len.nil?
				@buf.getbyte(pos) || 0
			else
				@buf.byteslice(pos, len.to_i) || "".b
			end
		end

		def []=(idx, len_or_val, val = nil)
			pos = @offset + idx.to_i
			if val.nil?
				if len_or_val.is_a?(String)
					len_or_val.each_byte.with_index { |b, i| @buf.setbyte(pos + i, b) }
				else
					@buf.setbyte(pos, len_or_val.to_i & 0xFF)
				end
			else
				str = val.to_s
				(0...len_or_val.to_i).each do |i|
					@buf.setbyte(pos + i, str.getbyte(i) || 0)
				end
			end
		end
	end

	Pointer = CPtr
	NULL = CPtr.new(0)

	class Handle
		def initialize(*args); end
		def [](sym); 0; end
		def sym(s); 0; end
	end

	class Function
		def initialize(*args); end
		def call(*args); 0; end
	end

	class CFunc
		def initialize(*args); end
		def call(*args); 0; end
	end

	module Importer
		def dlload(*libs); end
		def extern(*args); end
		def typealias(*args); end
	end

	def self.dlopen(*args)
		Handle.new(*args)
	end
end

Object.const_set(:Fiddle, DL) unless Object.const_defined?(:Fiddle)

# Filter already-disposed RGSS objects (Viewport, Sprite, Window, Plane, Tilemap)
# out of ObjectSpace.each_object so scripts iterating over live viewports/sprites
# before Ruby 3.1's incremental GC sweeps them do not touch disposed objects.
if defined?(ObjectSpace) && ObjectSpace.respond_to?(:each_object)
	module ObjectSpace
		class << self
			alias_method :__mkxp_orig_each_object, :each_object unless method_defined?(:__mkxp_orig_each_object)
			def each_object(*args, &block)
				return __mkxp_orig_each_object(*args) unless block_given?
				count = 0
				__mkxp_orig_each_object(*args) do |obj|
					next if (obj.respond_to?(:disposed?) && obj.disposed? rescue false)
					block.call(obj)
					count += 1
				end
				count
			end
		end
	end
end

# Emulate Windows Ruby O_TEXT newline translation (\\r\\n -> \\n) on text-mode file reads.
# Many Windows RPG Maker VX Ace scripts (e.g. LonaRPG's 101_jsonEnDecoder.rb) rely on
# File.open(path, 'r') / File.read(path) stripping '\\r' from CRLF files (which Windows
# Ruby does automatically, while POSIX / Switch Ruby leaves '\\r' intact).
module Switch2TextModeCompat
	def self.strip_crlf(str)
		return str unless str.is_a?(String) && str.bytesize >= 2
		if str.valid_encoding?
			return str unless str.include?("\\r\\n")
			return str.gsub("\\r\\n", "\\n")
		else
			enc = str.encoding
			bin = str.dup.force_encoding(Encoding::BINARY)
			return str unless bin.include?("\\r\\n".b)
			return bin.gsub!("\\r\\n".b, "\\n".b).force_encoding(enc)
		end
	end

	def self.binary_opts?(args, kwargs)
		return true if kwargs && (kwargs[:binmode] || kwargs[:mode].to_s.include?('b'))
		args.each do |a|
			if a.is_a?(Hash)
				return true if a[:binmode] || a[:mode].to_s.include?('b')
			end
		end
		false
	end
end

class File
	unless method_defined?(:__sw2_orig_read)
		alias_method :__sw2_orig_read, :read
		def read(length = nil, outbuf = nil)
			res = outbuf.nil? ? __sw2_orig_read(length) : __sw2_orig_read(length, outbuf)
			if length.nil? && !binmode? && res.is_a?(String)
				cleaned = Switch2TextModeCompat.strip_crlf(res)
				if !cleaned.equal?(res)
					if outbuf.is_a?(String)
						outbuf.replace(cleaned)
						return outbuf
					end
					return cleaned
				end
			end
			res
		end
	end

	unless method_defined?(:__sw2_orig_gets)
		alias_method :__sw2_orig_gets, :gets
		def gets(*args, **kwargs)
			res = __sw2_orig_gets(*args, **kwargs)
			(!binmode? && res.is_a?(String)) ? Switch2TextModeCompat.strip_crlf(res) : res
		end
	end

	unless method_defined?(:__sw2_orig_readline)
		alias_method :__sw2_orig_readline, :readline
		def readline(*args, **kwargs)
			res = __sw2_orig_readline(*args, **kwargs)
			(!binmode? && res.is_a?(String)) ? Switch2TextModeCompat.strip_crlf(res) : res
		end
	end

	unless method_defined?(:__sw2_orig_readlines)
		alias_method :__sw2_orig_readlines, :readlines
		def readlines(*args, **kwargs)
			res = __sw2_orig_readlines(*args, **kwargs)
			if !binmode? && res.is_a?(Array)
				res.map! { |l| l.is_a?(String) ? Switch2TextModeCompat.strip_crlf(l) : l }
			end
			res
		end
	end

	unless method_defined?(:__sw2_orig_each_line)
		alias_method :__sw2_orig_each_line, :each_line
		def each_line(*args, **kwargs, &block)
			return __sw2_orig_each_line(*args, **kwargs) unless block_given?
			return __sw2_orig_each_line(*args, **kwargs, &block) if binmode?
			__sw2_orig_each_line(*args, **kwargs) do |line|
				block.call(line.is_a?(String) ? Switch2TextModeCompat.strip_crlf(line) : line)
			end
		end
		alias_method :each, :each_line
	end

	unless method_defined?(:__sw2_orig_write)
		alias_method :__sw2_orig_write, :write
		def write(*args)
			__sw2_orig_write(*args)
		rescue Encoding::UndefinedConversionError, Encoding::InvalidByteSequenceError
			fixed = args.map do |a|
				if a.is_a?(String) && a.encoding == Encoding::BINARY
					s = a.dup.force_encoding(Encoding::UTF_8)
					s.valid_encoding? ? s : a.encode(Encoding::UTF_8, Encoding::BINARY, invalid: :replace, undef: :replace)
				else
					a
				end
			end
			__sw2_orig_write(*fixed)
		end
	end
end

class << IO
	unless method_defined?(:__sw2_orig_s_read)
		alias_method :__sw2_orig_s_read, :read
		def read(name, *args, **kwargs)
			res = __sw2_orig_s_read(name, *args, **kwargs)
			if res.is_a?(String) && !(args[0].is_a?(Integer)) && !Switch2TextModeCompat.binary_opts?(args, kwargs)
				return Switch2TextModeCompat.strip_crlf(res)
			end
			res
		end
	end

	unless method_defined?(:__sw2_orig_s_readlines)
		alias_method :__sw2_orig_s_readlines, :readlines
		def readlines(name, *args, **kwargs)
			res = __sw2_orig_s_readlines(name, *args, **kwargs)
			if res.is_a?(Array) && !Switch2TextModeCompat.binary_opts?(args, kwargs)
				res.map! { |l| l.is_a?(String) ? Switch2TextModeCompat.strip_crlf(l) : l }
			end
			res
		end
	end

	unless method_defined?(:__sw2_orig_s_foreach)
		alias_method :__sw2_orig_s_foreach, :foreach
		def foreach(name, *args, **kwargs, &block)
			return __sw2_orig_s_foreach(name, *args, **kwargs) unless block_given?
			return __sw2_orig_s_foreach(name, *args, **kwargs, &block) if Switch2TextModeCompat.binary_opts?(args, kwargs)
			__sw2_orig_s_foreach(name, *args, **kwargs) do |line|
				block.call(line.is_a?(String) ? Switch2TextModeCompat.strip_crlf(line) : line)
			end
		end
	end
end

# Always mirror RGSS msgbox / msgbox_p output to stderr (mkxpz.log) so games that
# catch exceptions and show them via msgbox (e.g. LonaRPG's 102_ScriptImport.rb)
# still leave the full error message and backtrace in mkxpz.log on Switch.
module Kernel
	if method_defined?(:msgbox) || private_method_defined?(:msgbox)
		alias_method :__sw2_orig_msgbox, :msgbox unless method_defined?(:__sw2_orig_msgbox) || private_method_defined?(:__sw2_orig_msgbox)
		def msgbox(*args)
			begin
				$stderr.puts("[msgbox] " + args.map(&:to_s).join(" "))
				$stderr.flush
			rescue
			end
			__sw2_orig_msgbox(*args)
		end
		module_function :msgbox
	end
	if method_defined?(:msgbox_p) || private_method_defined?(:msgbox_p)
		alias_method :__sw2_orig_msgbox_p, :msgbox_p unless method_defined?(:__sw2_orig_msgbox_p) || private_method_defined?(:__sw2_orig_msgbox_p)
		def msgbox_p(*args)
			begin
				$stderr.puts("[msgbox_p] " + args.map(&:inspect).join(" "))
				$stderr.flush
			rescue
			end
			__sw2_orig_msgbox_p(*args)
		end
		module_function :msgbox_p
	end
end

class Win32API
	def initialize(dll, func, *args)
		raise RuntimeError, "Win32API is unavailable on Switch (#{dll}:#{func})"
	end

	def call(*args)
		return 0
	end

	def Call(*args)
		return call(*args)
	end
end
""",
        encoding="utf-8",
        newline="\n",
    )
    print(f"[wrote] {win32api_stub}")

    # Patch switch_controls.rb so poll_soft_reset uses saved __mkxp_raw_press? instead of game-overridden Input.press?,
    # and only apply the Pokemon Essentials B-to-run / Start-for-menu Input override when pbCanRun? exists.
    patch_file(
        "switch/romfs-root/preload/switch_controls.rb",
        "# [switch2-safe-soft-reset-v2]",
        [
            (
                "	def self.poll_soft_reset\n"
                "		down = Input.press?(SOFT_RESET)",
                "	# [switch2-safe-soft-reset-v2]\n"
                "	def self.poll_soft_reset\n"
                "		down = Input.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(:F5) : Input.press?(SOFT_RESET)",
            ),
            (
                "	def self.map_menu_check?\n"
                "		return false unless defined?(Scene_Map) && $scene.is_a?(Scene_Map)",
                "	def self.map_menu_check?\n"
                "		return false unless defined?(pbCanRun?) && defined?(Scene_Map) && $scene.is_a?(Scene_Map)",
            ),
            (
                "	def self.run_check?\n"
                "		loc = caller_locations(2, 1)[0]",
                "	def self.run_check?\n"
                "		return false unless defined?(pbCanRun?)\n"
                "		loc = caller_locations(2, 1)[0]",
            ),
        ],
    )

    # Patch scripts/preload/win32_wrap.rb to support DL::CPtr integer pointers,
    # saved native Input methods (including pumping Input.__mkxp_raw_update ONLY when
    # a script like Cidiomar Input overwrites Input.update and didn't call native update),
    # XInputGetState for Rachnera Mixed Input, GetPrivateProfileInt, and case-insensitive DLL/func matching.
    patch_file(
        "scripts/preload/win32_wrap.rb",
        "# [switch2-win32wrap-dl-compat-v3]",
        [
            (
                "		def update\n"
                "			win32wrap_update\n"
                "			$win32KeyStates = nil\n"
                "		end",
                "		def update\n"
                "			win32wrap_update\n"
                "			$win32KeyStates = nil\n"
                "			$mkxp_raw_input_updated_this_frame = false\n"
                "		end",
            ),
            (
                "def get_raw_keystates\n"
                "	if $win32KeyStates == nil\n"
                "		$win32KeyStates = Input.raw_key_states\n"
                "	end\n"
                "\n"
                "	return $win32KeyStates\n"
                "end\n"
                "\n"
                "def common_keystate(vkey)\n"
                "	vkey_name = Scancodes::WIN32INV[vkey]\n"
                "\n"
                "	states = get_raw_keystates\n"
                "	pressed = false\n"
                "\n"
                "	if vkey_name == :LBUTTON\n"
                "		pressed = Input.press?(Input::MOUSELEFT)\n"
                "	elsif vkey_name == :RBUTTON\n"
                "		pressed = Input.press?(Input::MOUSERIGHT)\n"
                "	elsif vkey_name == :MBUTTON\n"
                "		pressed = Input.press?(Input::MOUSEMIDDLE)",
                "# [switch2-win32wrap-dl-compat-v3]\n"
                "def resolve_win32_buffer(dst)\n"
                "	return $mkxp_dl_buffers[dst] if dst.is_a?(Integer) && defined?($mkxp_dl_buffers) && $mkxp_dl_buffers[dst]\n"
                "	return dst.to_s if defined?(DL::CPtr) && dst.is_a?(DL::CPtr)\n"
                "	dst\n"
                "end\n"
                "\n"
                "def pump_mkxp_raw_input_once_per_frame\n"
                "	if $win32KeyStates == nil\n"
                "		if !$mkxp_raw_input_updated_this_frame && Input.respond_to?(:__mkxp_raw_update)\n"
                "			Input.__mkxp_raw_update\n"
                "		end\n"
                "		$win32KeyStates = Input.respond_to?(:__mkxp_raw_key_states) ? Input.__mkxp_raw_key_states : Input.raw_key_states\n"
                "	end\n"
                "end\n"
                "\n"
                "def get_raw_keystates\n"
                "	pump_mkxp_raw_input_once_per_frame\n"
                "	return $win32KeyStates\n"
                "end\n"
                "\n"
                "def common_keystate(vkey)\n"
                "	vkey_name = Scancodes::WIN32INV[vkey]\n"
                "\n"
                "	states = get_raw_keystates\n"
                "	pressed = false\n"
                "\n"
                "	if vkey_name == :LBUTTON\n"
                "		pressed = Input.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(Input::MKXP_MOUSELEFT) : Input.press?(Input::MOUSELEFT)\n"
                "	elsif vkey_name == :RBUTTON\n"
                "		pressed = Input.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(Input::MKXP_MOUSERIGHT) : Input.press?(Input::MOUSERIGHT)\n"
                "	elsif vkey_name == :MBUTTON\n"
                "		pressed = Input.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(Input::MKXP_MOUSEMIDDLE) : Input.press?(Input::MOUSEMIDDLE)",
            ),
            (
                "def memcpy_string(dst, src)\n"
                "	i = 0\n"
                "	src.each_byte do |b|\n"
                "		dst.setbyte(i, b)\n"
                "		i += 1\n"
                "	end\n"
                "end",
                "def memcpy_string(dst, src)\n"
                "	buf = resolve_win32_buffer(dst)\n"
                "	return unless buf.respond_to?(:setbyte)\n"
                "	i = 0\n"
                "	src.each_byte do |b|\n"
                "		buf.setbyte(i, b)\n"
                "		i += 1\n"
                "	end\n"
                "end",
            ),
            (
                "		class GetKeyboardState\n"
                "			PRESSED_BIT = 0x80\n"
                "			def call(args)\n"
                "				out_states = args[0]\n"
                "\n"
                "				Scancodes::WIN32.each do |name, val|\n"
                "					pressed = common_keystate(val) == 1\n"
                "\n"
                "					out_states.setbyte(val, pressed ? PRESSED_BIT : 0)\n"
                "				end\n"
                "				return 1\n"
                "			end\n"
                "		end",
                "		class GetKeyboardState\n"
                "			PRESSED_BIT = 0x80\n"
                "			def call(args)\n"
                "				out_states = resolve_win32_buffer(args[0])\n"
                "				return 0 unless out_states.respond_to?(:setbyte)\n"
                "\n"
                "				Scancodes::WIN32.each do |name, val|\n"
                "					pressed = common_keystate(val) == 1\n"
                "\n"
                "					out_states.setbyte(val, pressed ? PRESSED_BIT : 0)\n"
                "				end\n"
                "				return 1\n"
                "			end\n"
                "		end\n"
                "		class GetKeyboardLayout\n"
                "			def call(args)\n"
                "				return 0x04090409\n"
                "			end\n"
                "		end\n"
                "		class MapVirtualKeyEx\n"
                "			def call(args)\n"
                "				vk = args[0].to_i\n"
                "				map_type = args[1].to_i\n"
                "				if map_type == 2\n"
                "					return vk if (vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A) || vk == 0x20\n"
                "				end\n"
                "				return 0\n"
                "			end\n"
                "		end\n"
                "		class MapVirtualKey < MapVirtualKeyEx; end\n"
                "		class ToUnicodeEx\n"
                "			def call(args)\n"
                "				return 0\n"
                "			end\n"
                "		end\n"
                "		class GetSystemMetrics\n"
                "			def call(args)\n"
                "				idx = args[0].to_i\n"
                "				return (Graphics.width rescue 640) if idx == 0\n"
                "				return (Graphics.height rescue 480) if idx == 1\n"
                "				return 0\n"
                "			end\n"
                "		end\n"
                "		class SystemParametersInfoA\n"
                "			def call(args)\n"
                "				action = args[0].to_i\n"
                "				if action == 48\n"
                "					w = (Graphics.width rescue 640)\n"
                "					h = (Graphics.height rescue 480)\n"
                "					w = 640 if w <= 0\n"
                "					h = 480 if h <= 0\n"
                "					memcpy_string(args[2], [0, 0, w, h].pack('l4'))\n"
                "					return 1\n"
                "				end\n"
                "				return 1\n"
                "			end\n"
                "		end\n"
                "		class SystemParametersInfo < SystemParametersInfoA; end",
            ),
            (
                "		class FindWindowA\n"
                "			def call(args)\n"
                "				if args[0] == \"RGSS Player\"\n"
                "					return 42\n"
                "				else\n"
                "					return 0\n"
                "				end\n"
                "			end\n"
                "		end\n"
                "	end\n"
                "end",
                "		class GetWindowRect < GetClientRect; end\n"
                "		class FindWindowA\n"
                "			def call(args)\n"
                "				if args[0] == \"RGSS Player\"\n"
                "					return 42\n"
                "				else\n"
                "					return 0\n"
                "				end\n"
                "			end\n"
                "		end\n"
                "		class FindWindow < FindWindowA; end\n"
                "	end\n"
                "	module Kernel32\n"
                "		class GetPrivateProfileStringA\n"
                "			def call(args)\n"
                "				default_str = (args[2] || \"\").to_s\n"
                "				dst = resolve_win32_buffer(args[3])\n"
                "				max_len = (args[4] || 256).to_i\n"
                "				if dst.respond_to?(:setbyte) && max_len > 0\n"
                "					bytes = default_str.bytes[0, [max_len - 1, 0].max] || []\n"
                "					bytes.each_with_index { |b, i| dst.setbyte(i, b) }\n"
                "					dst.setbyte(bytes.length, 0) if dst.respond_to?(:bytesize) && bytes.length < dst.bytesize\n"
                "					return bytes.length\n"
                "				end\n"
                "				return 0\n"
                "			end\n"
                "		end\n"
                "		class GetPrivateProfileString < GetPrivateProfileStringA; end\n"
                "		class GetPrivateProfileIntA\n"
                "			def call(args)\n"
                "				return (args[2] || 0).to_i\n"
                "			end\n"
                "		end\n"
                "		class GetPrivateProfileInt < GetPrivateProfileIntA; end\n"
                "		class GetCommandLineA\n"
                "			def call(args)\n"
                "				return \"Game.exe\"\n"
                "			end\n"
                "		end\n"
                "		class GetCommandLine < GetCommandLineA; end\n"
                "	end\n"
                "	module Xinput1_3\n"
                "		class XInputGetState\n"
                "			def initialize\n"
                "				@packet = 0\n"
                "			end\n"
                "			def call(args)\n"
                "				user_idx = args[0].to_i\n"
                "				return 1167 if user_idx != 0\n"
                "				pump_mkxp_raw_input_once_per_frame\n"
                "				btns = (Input::Controller.raw_button_states rescue [])\n"
                "				axes = (Input::Controller.raw_axes rescue [])\n"
                "				w_buttons = 0\n"
                "				w_buttons |= 0x0001 if btns[11] # DPAD_UP\n"
                "				w_buttons |= 0x0002 if btns[12] # DPAD_DOWN\n"
                "				w_buttons |= 0x0004 if btns[13] # DPAD_LEFT\n"
                "				w_buttons |= 0x0008 if btns[14] # DPAD_RIGHT\n"
                "				w_buttons |= 0x0010 if btns[6]  # START (+)\n"
                "				w_buttons |= 0x0020 if btns[4]  # BACK (-)\n"
                "				w_buttons |= 0x0040 if btns[7]  # L3\n"
                "				w_buttons |= 0x0080 if btns[8]  # R3\n"
                "				w_buttons |= 0x0100 if btns[9]  # L\n"
                "				w_buttons |= 0x0200 if btns[10] # R\n"
                "				w_buttons |= 0x1000 if btns[1]  # Switch A -> XInput A (Confirm)\n"
                "				w_buttons |= 0x2000 if btns[0]  # Switch B -> XInput B (Cancel)\n"
                "				w_buttons |= 0x4000 if btns[3]  # Switch X -> XInput X\n"
                "				w_buttons |= 0x8000 if btns[2]  # Switch Y -> XInput Y\n"
                "				lt = [[(axes[4].to_i / 128), 0].max, 255].min\n"
                "				rt = [[(axes[5].to_i / 128), 0].max, 255].min\n"
                "				lx = [[axes[0].to_i, -32768].max, 32767].min\n"
                "				ly = [[-(axes[1].to_i), -32767].max, 32767].min\n"
                "				rx = [[axes[2].to_i, -32768].max, 32767].min\n"
                "				ry = [[-(axes[3].to_i), -32767].max, 32767].min\n"
                "				@packet = (@packet + 1) & 0xFFFFFFFF\n"
                "				packed = [@packet, w_buttons, lt, rt, lx, ly, rx, ry].pack('LSCCs<s<s<s<')\n"
                "				memcpy_string(args[1], packed)\n"
                "				return 0\n"
                "			end\n"
                "		end\n"
                "	end\n"
                "	Xinput1_4 = Xinput1_3\n"
                "	Xinput9_1_0 = Xinput1_3\n"
                "end",
            ),
            (
                "		dll = kappatalize(dll.chomp(\".dll\"))\n"
                "		func = kappatalize(func)\n"
                "\n"
                "		if !System.is_windows? or !NATIVE_ON_WINDOWS\n"
                "			if Win32API_Impl.const_defined?(dll)\n"
                "				dll_impl = Win32API_Impl.const_get(dll)\n"
                "				if dll_impl.const_defined?(func)\n"
                "					@mkxp_wrap_impl = dll_impl.const_get(func).new\n"
                "					return\n"
                "				end\n"
                "			end\n"
                "		end",
                "		dll_clean = @dll.to_s.sub(/\\.dll\\z/i, '')\n"
                "		func_clean = @func.to_s\n"
                "\n"
                "		if !System.is_windows? or !NATIVE_ON_WINDOWS\n"
                "			dll_sym = Win32API_Impl.constants.find { |c| c.to_s.casecmp(dll_clean) == 0 }\n"
                "			if dll_sym\n"
                "				dll_impl = Win32API_Impl.const_get(dll_sym)\n"
                "				func_sym = dll_impl.constants.find do |c|\n"
                "					cs = c.to_s\n"
                "					cs.casecmp(func_clean) == 0 || cs.casecmp(func_clean + 'A') == 0 || (func_clean =~ /A\\z/i && cs.casecmp(func_clean[0...-1]) == 0)\n"
                "				end\n"
                "				if func_sym\n"
                "					@mkxp_wrap_impl = dll_impl.const_get(func_sym).new\n"
                "					return\n"
                "				end\n"
                "			end\n"
                "		end",
            ),
        ],
    )

    for rel_w in ("scripts/preload/win32_wrap.rb", "switch/romfs-root/preload/win32_wrap.rb"):
        wp = ROOT / rel_w
        if not wp.exists():
            continue
        wtext = wp.read_text(encoding="utf-8")
        wupd = wtext
        if "class SystemParametersInfoA" not in wupd:
            wupd = wupd.replace(
                "		class GetSystemMetrics\n"
                "			def call(args)\n"
                "				idx = args[0].to_i\n"
                "				return (Graphics.width rescue 640) if idx == 0\n"
                "				return (Graphics.height rescue 480) if idx == 1\n"
                "				return 0\n"
                "			end\n"
                "		end\n",
                "		class GetSystemMetrics\n"
                "			def call(args)\n"
                "				idx = args[0].to_i\n"
                "				return (Graphics.width rescue 640) if idx == 0\n"
                "				return (Graphics.height rescue 480) if idx == 1\n"
                "				return 0\n"
                "			end\n"
                "		end\n"
                "		class SystemParametersInfoA\n"
                "			def call(args)\n"
                "				action = args[0].to_i\n"
                "				if action == 48\n"
                "					w = (Graphics.width rescue 640)\n"
                "					h = (Graphics.height rescue 480)\n"
                "					w = 640 if w <= 0\n"
                "					h = 480 if h <= 0\n"
                "					memcpy_string(args[2], [0, 0, w, h].pack('l4'))\n"
                "					return 1\n"
                "				end\n"
                "				return 1\n"
                "			end\n"
                "		end\n"
                "		class SystemParametersInfo < SystemParametersInfoA; end\n",
                1,
            )
        if "class GetCommandLineA" not in wupd:
            wupd = wupd.replace(
                "		class GetPrivateProfileInt < GetPrivateProfileIntA; end\n",
                "		class GetPrivateProfileInt < GetPrivateProfileIntA; end\n"
                "		class GetCommandLineA\n"
                "			def call(args)\n"
                "				return \"Game.exe\"\n"
                "			end\n"
                "		end\n"
                "		class GetCommandLine < GetCommandLineA; end\n",
                1,
            )
        if wupd != wtext:
            wp.write_text(wupd, encoding="utf-8", newline="\n")
            print(f"[patched] {rel_w} (SystemParametersInfo + GetCommandLine)")


def patch_binding_mri_syntax() -> None:
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-ruby-syntax-compat-v2]",
        [
            (
                "        rb_ary_store(script, 3, rb_utf8_str_new_cstr(decodeBuffer.c_str()));",
                "        // [switch2-ruby-syntax-compat-v2]\n"
                "        // 1. Normalize CR/CRLF line endings so lone '\\r' after comments never comments out the next line in Ruby 3.1.\n"
                "        // 2. Strip trailing commas before 'end'/'else'/'elsif'/'when' (e.g. 'return \"foo\",\\n end' in The Last Sovereign).\n"
                "        {\n"
                "            std::string norm;\n"
                "            norm.reserve(bufferLen);\n"
                "            for (unsigned long k = 0; k < bufferLen; ++k) {\n"
                "                char ch = decodeBuffer[k];\n"
                "                if (ch == '\\r') {\n"
                "                    norm.push_back('\\n');\n"
                "                    if (k + 1 < bufferLen && decodeBuffer[k + 1] == '\\n')\n"
                "                        ++k;\n"
                "                } else {\n"
                "                    norm.push_back(ch);\n"
                "                }\n"
                "            }\n"
                "            // Check for lines ending with ',' followed on the next non-blank line by 'end'/'else'/'elsif'/'when'\n"
                "            for (size_t pos = 0; pos < norm.size(); ) {\n"
                "                size_t nl = norm.find('\\n', pos);\n"
                "                if (nl == std::string::npos) break;\n"
                "                size_t lastNonWs = nl;\n"
                "                while (lastNonWs > pos && (norm[lastNonWs - 1] == ' ' || norm[lastNonWs - 1] == '\\t'))\n"
                "                    --lastNonWs;\n"
                "                if (lastNonWs > pos && norm[lastNonWs - 1] == ',') {\n"
                "                    // Check the first token on the following line\n"
                "                    size_t nextStart = nl + 1;\n"
                "                    while (nextStart < norm.size() && (norm[nextStart] == ' ' || norm[nextStart] == '\\t'))\n"
                "                        ++nextStart;\n"
                "                    auto matchKw = [&](const char *kw, size_t kwLen) -> bool {\n"
                "                        if (nextStart + kwLen > norm.size()) return false;\n"
                "                        if (memcmp(&norm[nextStart], kw, kwLen) != 0) return false;\n"
                "                        char after = (nextStart + kwLen < norm.size()) ? norm[nextStart + kwLen] : '\\n';\n"
                "                        return after == ' ' || after == '\\t' || after == '\\n' || after == ';' || after == '#';\n"
                "                    };\n"
                "                    if (matchKw(\"end\", 3) || matchKw(\"else\", 4) || matchKw(\"elsif\", 5) || matchKw(\"when\", 4)) {\n"
                "                        norm[lastNonWs - 1] = ' ';\n"
                "                    }\n"
                "                }\n"
                "                pos = nl + 1;\n"
                "            }\n"
                "            rb_ary_store(script, 3, rb_utf8_str_new(norm.c_str(), norm.size()));\n"
                "        }",
            ),
            (
                "            evalString(string, fname, &state);\n"
                "            if (state)\n"
                "                break;",
                "            evalString(string, fname, &state);\n"
                "            if (state) {\n"
                "                VALUE err = rb_errinfo();\n"
                "                if (!NIL_P(err) && rb_obj_is_kind_of(err, rb_eSyntaxError)) {\n"
                "                    VALUE emsg = rb_funcall2(err, rb_intern(\"message\"), 0, NULL);\n"
                "                    const char *mptr = RSTRING_PTR(emsg);\n"
                "                    long errLine = 0;\n"
                "                    const char *colon = strstr(mptr, buf);\n"
                "                    if (colon) {\n"
                "                        const char *p = colon + strlen(buf);\n"
                "                        if (*p == ':') errLine = strtol(p + 1, NULL, 10);\n"
                "                    }\n"
                "                    if (errLine > 0) {\n"
                "                        const char *src = RSTRING_PTR(string);\n"
                "                        long srclen = RSTRING_LEN(string);\n"
                "                        long startL = errLine > 35 ? errLine - 35 : 1;\n"
                "                        long endL = errLine + 15;\n"
                "                        Debug() << \"--- SyntaxError context in\" << buf << \"around line\" << errLine << \"---\";\n"
                "                        long curL = 1;\n"
                "                        long pos = 0;\n"
                "                        while (pos < srclen && curL <= endL) {\n"
                "                            long nl = pos;\n"
                "                            while (nl < srclen && src[nl] != '\\n') ++nl;\n"
                "                            if (curL >= startL) {\n"
                "                                std::string lineStr(src + pos, nl - pos);\n"
                "                                Debug() << curL << \":\" << lineStr;\n"
                "                            }\n"
                "                            pos = nl + 1;\n"
                "                            ++curL;\n"
                "                        }\n"
                "                        Debug() << \"--- End SyntaxError context ---\";\n"
                "                    }\n"
                "                }\n"
                "                break;\n"
                "            }",
            ),
        ],
    )


def patch_binding_rgss18_retry() -> None:
    # Ruby 1.8 (RPG Maker XP) syntax that Ruby 3.1 rejects, e.g. UMS's `{'\.', '\p[4]', ...}` hash literal
    # or `when 1: foo`. On SyntaxError, rewrite the section and evaluate it once more (a SyntaxError means
    # nothing in that section ran yet, so the retry is side-effect free).
    header_src = Path(__file__).resolve().parent / "mkxpz" / "switch2-rgss18-compat.h"
    write_if_changed(ROOT / "binding" / "switch2-rgss18-compat.h", header_src.read_text(encoding="utf-8"))
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss18-retry]",
        [
            (
                '#include "binding-util.h"\n',
                '#include "binding-util.h"\n'
                '#include "switch2-rgss18-compat.h" // [switch2-rgss18-retry]\n',
            ),
            (
                "            evalString(string, fname, &state);\n"
                "            if (state) {\n"
                "                VALUE err = rb_errinfo();",
                "            evalString(string, fname, &state);\n"
                "            if (state) {\n"
                "                VALUE err0 = rb_errinfo();\n"
                "                if (!NIL_P(err0) && rb_obj_is_kind_of(err0, rb_eSyntaxError)) {\n"
                "                    std::string src0(RSTRING_PTR(string), RSTRING_LEN(string));\n"
                "                    int hashFixes = 0, whenFixes = 0;\n"
                "                    std::string fixed = switch2_rgss18::rewrite(src0, &hashFixes, &whenFixes);\n"
                "                    if (hashFixes + whenFixes > 0) {\n"
                "                        Debug() << \"[rgss18] Ruby 1.8 syntax in\" << buf << \"-> retrying with\"\n"
                "                                << hashFixes << \"hash literal(s) and\" << whenFixes << \"`when x:` rewrite(s)\";\n"
                "                        VALUE string2 = newStringUTF8(fixed.c_str(), fixed.size());\n"
                "                        rb_set_errinfo(Qnil);\n"
                "                        int state2 = 0;\n"
                "                        evalString(string2, fname, &state2);\n"
                "                        state = state2;\n"
                "                        string = string2;\n"
                "                        if (!state)\n"
                "                            rb_ary_store(script, 3, string2);\n"
                "                    }\n"
                "                }\n"
                "            }\n"
                "            if (state) {\n"
                "                VALUE err = rb_errinfo();",
            ),
        ],
    )
    # v2: also count byte-level UTF-8 regexp conversions (Pokemon Uranium's CJK Utilities word wrap)
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss18-retry-v2]",
        [
            (
                "                    int hashFixes = 0, whenFixes = 0;\n"
                "                    std::string fixed = switch2_rgss18::rewrite(src0, &hashFixes, &whenFixes);\n"
                "                    if (hashFixes + whenFixes > 0) {\n"
                "                        Debug() << \"[rgss18] Ruby 1.8 syntax in\" << buf << \"-> retrying with\"\n"
                "                                << hashFixes << \"hash literal(s) and\" << whenFixes << \"`when x:` rewrite(s)\";\n",
                "                    // [switch2-rgss18-retry-v2]\n"
                "                    int hashFixes = 0, whenFixes = 0, regexFixes = 0;\n"
                "                    std::string fixed = switch2_rgss18::rewrite(src0, &hashFixes, &whenFixes, &regexFixes);\n"
                "                    if (hashFixes + whenFixes + regexFixes > 0) {\n"
                "                        Debug() << \"[rgss18] Ruby 1.8 syntax in\" << buf << \"-> retrying with\"\n"
                "                                << hashFixes << \"hash literal(s),\" << whenFixes << \"`when x:` and\"\n"
                "                                << regexFixes << \"byte regexp rewrite(s)\";\n",
            ),
        ],
    )


def patch_binding_rgss18_retry_v3() -> None:
    # v3: also count Ruby 1.8 `obj.method (a, b)` spaced-paren call rewrites (To the Moon's Mouse /
    # paragraph formatter scripts), which alone must trigger the retry as well.
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss18-retry-v3]",
        [
            (
                "                    int hashFixes = 0, whenFixes = 0, regexFixes = 0;\n"
                "                    std::string fixed = switch2_rgss18::rewrite(src0, &hashFixes, &whenFixes, &regexFixes);\n"
                "                    if (hashFixes + whenFixes + regexFixes > 0) {\n",
                "                    // [switch2-rgss18-retry-v3]\n"
                "                    int hashFixes = 0, whenFixes = 0, regexFixes = 0, callFixes = 0;\n"
                "                    std::string fixed = switch2_rgss18::rewrite(src0, &hashFixes, &whenFixes, &regexFixes, &callFixes);\n"
                "                    if (hashFixes + whenFixes + regexFixes + callFixes > 0) {\n"
                "                        if (callFixes > 0)\n"
                "                            Debug() << \"[rgss18]\" << buf << \":\" << callFixes << \"spaced-paren call rewrite(s)\";\n",
            ),
        ],
    )


def patch_binding_runtime_error_context() -> None:
    # When a script section dies with a runtime error (NoMethodError etc.), print the failing source lines
    # of the section named in the first backtrace frame, like the SyntaxError context dump does.
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-runtime-error-context]",
        [
            (
                "                        Debug() << \"--- End SyntaxError context ---\";\n"
                "                    }\n"
                "                }\n"
                "                break;\n",
                "                        Debug() << \"--- End SyntaxError context ---\";\n"
                "                    }\n"
                "                } else if (!NIL_P(err) && !rb_obj_is_kind_of(err, rb_eSystemExit) &&\n"
                "                           !rb_obj_is_kind_of(err, getRbData()->exc[Reset])) {\n"
                "                    // [switch2-runtime-error-context]\n"
                "                    VALUE bt = rb_funcall2(err, rb_intern(\"backtrace\"), 0, NULL);\n"
                "                    if (RB_TYPE_P(bt, T_ARRAY) && RARRAY_LEN(bt) > 0 && RB_TYPE_P(rb_ary_entry(bt, 0), T_STRING)) {\n"
                "                        VALUE f0 = rb_ary_entry(bt, 0);\n"
                "                        std::string fr(RSTRING_PTR(f0), RSTRING_LEN(f0));\n"
                "                        size_t inPos = fr.rfind(\":in \");\n"
                "                        if (inPos == std::string::npos) inPos = fr.size();\n"
                "                        size_t lc = fr.rfind(':', inPos ? inPos - 1 : 0);\n"
                "                        char *endp = NULL;\n"
                "                        long secIdx = strtol(fr.c_str(), &endp, 10);\n"
                "                        long errLine = (lc != std::string::npos) ? strtol(fr.c_str() + lc + 1, NULL, 10) : 0;\n"
                "                        if (endp && *endp == ':' && endp != fr.c_str() && secIdx >= 0 && secIdx < scriptCount && errLine > 0) {\n"
                "                            VALUE sec = rb_ary_entry(scriptArray, secIdx);\n"
                "                            VALUE secSrc = rb_ary_entry(sec, 3);\n"
                "                            if (RB_TYPE_P(secSrc, T_STRING)) {\n"
                "                                const char *src = RSTRING_PTR(secSrc);\n"
                "                                long srclen = RSTRING_LEN(secSrc);\n"
                "                                long startL = errLine > 12 ? errLine - 12 : 1;\n"
                "                                long endL = errLine + 6;\n"
                "                                Debug() << \"--- Runtime error context in\" << fr.substr(0, inPos) << \"---\";\n"
                "                                long curL = 1, pos = 0;\n"
                "                                while (pos < srclen && curL <= endL) {\n"
                "                                    long nl = pos;\n"
                "                                    while (nl < srclen && src[nl] != '\\n') ++nl;\n"
                "                                    if (curL >= startL) {\n"
                "                                        std::string lineStr(src + pos, nl - pos);\n"
                "                                        Debug() << (curL == errLine ? \">>\" : \"  \") << curL << \":\" << lineStr;\n"
                "                                    }\n"
                "                                    pos = nl + 1;\n"
                "                                    ++curL;\n"
                "                                }\n"
                "                                Debug() << \"--- End runtime error context ---\";\n"
                "                            }\n"
                "                        }\n"
                "                    }\n"
                "                }\n"
                "                break;\n",
            ),
        ],
    )


def patch_preload_stdlib_env_shims() -> None:
    # 1. `require 'timeout'` (Pokemon Reborn & other Essentials forks): mkxp-z ships no Ruby stdlib, and a
    #    real Timeout needs a preemptive timer thread (unavailable here: "pipe creation failed for timer").
    #    Provide a run-to-completion Timeout and mark it loaded so `require` succeeds.
    # 2. Windows environment variables (APPDATA, USERPROFILE, ...) that XP/VX save & launcher scripts read
    #    with ENV[...]; on Switch they are nil, which crashes scripts calling e.g. `.rstrip` on them.
    stub_p = ROOT / "switch/romfs-root/preload/win32api_stub.rb"
    stext = stub_p.read_text(encoding="utf-8")
    marker = "# [switch2-stdlib-env-shims-v1]"
    if marker in stext:
        print(f"[ok] {stub_p} already patched ({marker})")
        return
    addition = r'''
# [switch2-stdlib-env-shims-v1]
unless defined?(Timeout) && Timeout.respond_to?(:timeout)
	module Timeout
		class Error < RuntimeError; end
		ExitException = Error unless const_defined?(:ExitException)
		# No preemptive timer thread on Switch: run the block to completion.
		def self.timeout(sec = nil, klass = nil, message = nil)
			yield(sec)
		end
	end
end
unless $LOADED_FEATURES.any? { |f| f == "timeout.rb" || f.end_with?("/timeout.rb") }
	$LOADED_FEATURES << "timeout.rb"
end

begin
	__sw2_home = File.join(Dir.pwd, "userdata")
	__sw2_env = {
		"USERPROFILE" => __sw2_home,
		"HOME" => __sw2_home,
		"HOMEDRIVE" => "",
		"HOMEPATH" => __sw2_home,
		"APPDATA" => File.join(__sw2_home, "AppData", "Roaming"),
		"LOCALAPPDATA" => File.join(__sw2_home, "AppData", "Local"),
		"TEMP" => File.join(__sw2_home, "Temp"),
		"TMP" => File.join(__sw2_home, "Temp"),
		"USERNAME" => "Player",
		"COMPUTERNAME" => "SWITCH2",
		"OS" => "Windows_NT",
	}
	__sw2_set = []
	__sw2_env.each do |k, v|
		cur = ENV[k]
		next if cur && !cur.empty?
		ENV[k] = v
		__sw2_set << k
	end
	["APPDATA", "LOCALAPPDATA", "TEMP"].each do |k|
		next unless __sw2_set.include?(k)
		path = ""
		ENV[k].split("/").each do |part|
			next if part.empty?
			path = path.empty? && ENV[k].start_with?("/") ? "/" + part : (path.empty? ? part : path + "/" + part)
			Dir.mkdir(path) unless File.directory?(path) rescue nil
		end
	end
rescue StandardError
end
'''
    stub_p.write_text(stext + addition, encoding="utf-8", newline="\n")
    print(f"[patched] {stub_p} ({marker})")


STDLIB_FILES = [
    # pure-Ruby, no C-extension dependencies in Ruby 3.1
    "set.rb", "ostruct.rb", "singleton.rb", "observer.rb", "forwardable.rb", "forwardable/impl.rb",
    "delegate.rb", "weakref.rb", "English.rb", "abbrev.rb", "base64.rb", "shellwords.rb", "fileutils.rb",
    "pp.rb", "prettyprint.rb", "tsort.rb", "find.rb", "benchmark.rb", "matrix.rb", "prime.rb",
    "uri.rb", "uri/",
]


def patch_preload_compat_v2() -> None:
    # Thread.critical, Windows '\' paths, To the Moon's Utils.dll AVSetEnv, rubygems stub, and a
    # romfs:/stdlib fallback for `require` (see scripts/mkxpz/preload-compat-v2.rb).
    src = (Path(__file__).resolve().parent / "mkxpz" / "preload-compat-v2.rb").read_text(encoding="utf-8")
    stub_p = ROOT / "switch/romfs-root/preload/win32api_stub.rb"
    stext = stub_p.read_text(encoding="utf-8")
    marker = "# [switch2-preload-compat-v2]"
    if marker in stext:
        head, _, _ = stext.partition("\n" + marker)
        stext = head
    stub_p.write_text(stext + src, encoding="utf-8", newline="\n")
    print(f"[patched] {stub_p} ({marker})")

    libs = sorted(ROOT.glob("subprojects/ruby-*/lib"))
    if not libs:
        print("[warn] Ruby stdlib source not found; romfs:/stdlib fallback will be empty")
        return
    lib = libs[-1]
    out = ROOT / "switch/romfs-root/stdlib"
    copied = 0
    for rel in STDLIB_FILES:
        s = lib / rel
        files = sorted(s.rglob("*.rb")) if rel.endswith("/") and s.is_dir() else ([s] if s.is_file() else [])
        for f in files:
            dst = out / f.relative_to(lib)
            dst.parent.mkdir(parents=True, exist_ok=True)
            write_if_changed(dst, f.read_text(encoding="utf-8"))
            copied += 1
    print(f"[ok] {copied} stdlib file(s) staged in romfs:/stdlib")


def patch_skip_game_win32_wrap() -> None:
    # Games that shipped for desktop mkxp bring their own (older) preload/win32_wrap.rb, e.g. the GOG release of
    # To the Moon ("preloadScript=mkxp/preload/win32_wrap.rb" in mkxp.conf). Loading it after our RomFS copy
    # re-runs its `alias update` on top of the Switch controls hook and Graphics.update then recurses forever
    # (SystemStackError). Our RomFS win32_wrap.rb is a superset, so drop the game's copy.
    patch_file(
        "src/main.cpp",
        "// [switch2-skip-game-win32-wrap]",
        [
            (
                '        "romfs:/preload/perf_trace.rb",\n'
                "    });\n"
                "#endif\n",
                '        "romfs:/preload/perf_trace.rb",\n'
                "    });\n"
                "    // [switch2-skip-game-win32-wrap]\n"
                "    for (auto it = conf.preloadScripts.begin(); it != conf.preloadScripts.end();) {\n"
                "        const std::string &s = *it;\n"
                "        size_t sep = s.find_last_of(\"/\\\\\");\n"
                "        std::string base = sep == std::string::npos ? s : s.substr(sep + 1);\n"
                "        for (auto &ch : base) ch = (char)tolower((unsigned char)ch);\n"
                "        if (s.rfind(\"romfs:\", 0) != 0 && base == \"win32_wrap.rb\") {\n"
                "            Debug() << \"[preload] skipping game-provided\" << s << \"(built-in Switch win32_wrap.rb is used instead)\";\n"
                "            it = conf.preloadScripts.erase(it);\n"
                "        } else {\n"
                "            ++it;\n"
                "        }\n"
                "    }\n"
                "#endif\n",
            ),
        ],
    )


def patch_fs_uncached_dir_fallback() -> None:
    # Directories that only exist inside an archive RTP (To the Moon: RTP=lang.dat, a ZIP holding
    # lang/<code>/Graphics/...) can be missing from the Switch fast path cache. When the cache has no entry
    # at all for a directory, ask PhysFS directly (original case) before reporting NoFileError.
    patch_file(
        "src/filesystem/filesystem.cpp",
        "// [switch2-fs-uncached-dir-fallback]",
        [
            (
                "  if (data.matchCount == 0) {\n"
                "    if (p->havePathCache && !isSilentProbeFilename(filename)) {\n",
                "  // [switch2-fs-uncached-dir-fallback]\n"
                "  if (data.matchCount == 0 && p->havePathCache && p->fileLists[dir].empty()) {\n"
                "    static std::vector<std::string> knownEmptyDirs;\n"
                "    const size_t sl = filename_nm.find_last_of('/');\n"
                "    const std::string odir = sl == std::string::npos ? std::string() : filename_nm.substr(0, sl);\n"
                "    const std::string ofile = sl == std::string::npos ? filename_nm : filename_nm.substr(sl + 1);\n"
                "    bool knownEmpty = false;\n"
                "    for (const auto &d : knownEmptyDirs) if (d == odir) { knownEmpty = true; break; }\n"
                "    if (!knownEmpty) {\n"
                "      OpenReadEnumData d2(handler, ofile.c_str(), ofile.size(), 0);\n"
                "      PHYSFS_enumerate(odir.c_str(), openReadEnumCB, &d2);\n"
                "      if (d2.physfsError)\n"
                "        throw Exception(Exception::PHYSFSError, \"PhysFS: %s\", d2.physfsError);\n"
                "      if (d2.matchCount > 0)\n"
                "        return;\n"
                "      char **lst = PHYSFS_enumerateFiles(odir.c_str());\n"
                "      const bool any = lst && lst[0];\n"
                "      if (lst) PHYSFS_freeList(lst);\n"
                "      if (!any && knownEmptyDirs.size() < 4096) knownEmptyDirs.push_back(odir);\n"
                "    }\n"
                "  }\n"
                "  if (data.matchCount == 0) {\n"
                "    if (p->havePathCache && !isSilentProbeFilename(filename)) {\n",
            ),
        ],
    )


def patch_switch_controls_guards() -> None:
    # The Quick Menu's "safe to return to title?" check assumed Pokemon Essentials' Game_Temp#in_menu;
    # plain RGSS1 games (To the Moon) don't have it -> NoMethodError when pressing "-".
    patch_file(
        "switch/romfs-root/preload/switch_controls.rb",
        "# [switch2-quickmenu-gametemp-guards]",
        [
            (
                "\t\treturn false if $game_temp.in_battle || $game_temp.in_menu ||\n"
                "\t\t                $game_temp.message_window_showing\n",
                "\t\t# [switch2-quickmenu-gametemp-guards]\n"
                "\t\tt = $game_temp\n"
                "\t\treturn false if (t.respond_to?(:in_battle) && t.in_battle) ||\n"
                "\t\t                (t.respond_to?(:in_menu) && t.in_menu) ||\n"
                "\t\t                (t.respond_to?(:message_window_showing) && t.message_window_showing)\n",
            ),
        ],
    )


def patch_rgss1_source_fixups() -> None:
    # Deterministic Ruby 1.8 -> 3 fixups applied to RGSS1 script sections before they are evaluated.
    # Pokemon Essentials' StringInput#getc returns `@string[@pos]`, a byte (Integer) in Ruby 1.8 but a
    # 1-char String in Ruby 3, which breaks every binary reader built on it (fgetdw -> TypeError while
    # loading Data/items.dat in Pokemon Uranium). String#getbyte is the exact Ruby 1.8 equivalent.
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss1-source-fixups]",
        [
            (
                "            int state;\n"
                "            \n"
                "            evalString(string, fname, &state);\n",
                "            int state;\n"
                "            \n"
                "            // [switch2-rgss1-source-fixups]\n"
                "            if (rgssVer == 1) {\n"
                "                std::string fx(RSTRING_PTR(string), RSTRING_LEN(string));\n"
                "                const size_t cls = fx.find(\"class StringInput\");\n"
                "                if (cls != std::string::npos) {\n"
                "                    int n = 0;\n"
                "                    for (size_t at = fx.find(\"@string[@pos]\", cls); at != std::string::npos;\n"
                "                         at = fx.find(\"@string[@pos]\", at + 21)) {\n"
                "                        fx.replace(at, 13, \"@string.getbyte(@pos)\");\n"
                "                        ++n;\n"
                "                    }\n"
                "                    if (n > 0) {\n"
                "                        Debug() << \"[rgss18]\" << buf << \": StringInput byte read fix x\" << n;\n"
                "                        string = newStringUTF8(fx.c_str(), fx.size());\n"
                "                        rb_ary_store(script, 3, string);\n"
                "                    }\n"
                "                }\n"
                "            }\n"
                "            evalString(string, fname, &state);\n",
            ),
        ],
    )


def patch_rgss1_source_fixups_v2() -> None:
    # Essentials' FileInputMixin readers (fgetb/fgetw/fgetdw) assume each_byte yields Integers (Ruby 1.8).
    # Convert a String byte with .ord right where it's used, and log once which getc produced it.
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss1-source-fixups-v2]",
        [
            (
                "            evalString(string, fname, &state);\n",
                "            // [switch2-rgss1-source-fixups-v2]\n"
                "            if (rgssVer == 1) {\n"
                "                std::string fx(RSTRING_PTR(string), RSTRING_LEN(string));\n"
                "                if (fx.find(\"module FileInputMixin\") != std::string::npos) {\n"
                "                    int n = 0;\n"
                "                    const char *from[] = {\"ret|=(i<<x)\", \"ret=i || 0\"};\n"
                "                    const char *to[] = {\"ret|=(SW2Diag.byte(self, i)<<x)\", \"ret=SW2Diag.byte(self, i) || 0\"};\n"
                "                    for (int r = 0; r < 2; ++r) {\n"
                "                        const size_t fl = strlen(from[r]);\n"
                "                        for (size_t at = fx.find(from[r]); at != std::string::npos; at = fx.find(from[r], at + strlen(to[r]))) {\n"
                "                            fx.replace(at, fl, to[r]);\n"
                "                            ++n;\n"
                "                        }\n"
                "                    }\n"
                "                    if (n > 0) {\n"
                "                        Debug() << \"[rgss18]\" << buf << \": FileInputMixin byte read fix x\" << n;\n"
                "                        string = newStringUTF8(fx.c_str(), fx.size());\n"
                "                        rb_ary_store(script, 3, string);\n"
                "                    }\n"
                "                }\n"
                "            }\n"
                "            evalString(string, fname, &state);\n",
            ),
        ],
    )


def patch_rgss1_source_fixups_v3() -> None:
    # More Ruby 1.8 byte-indexing idioms (str[i] was the byte value in 1.8, a 1-char String in Ruby 3):
    #  * `x.read(1)[0]` - "read one byte" everywhere in XP-era code
    #  * Pokemon Essentials' AudioUtilities MP3 header parser (getPlayTime2): rstr[0] / rstr[1]
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss1-source-fixups-v3]",
        [
            (
                "            // [switch2-rgss1-source-fixups-v2]\n",
                "            // [switch2-rgss1-source-fixups-v3]\n"
                "            if (rgssVer == 1) {\n"
                "                struct Fix { const char *trigger; const char *from; const char *to; };\n"
                "                static const Fix fixes[] = {\n"
                "                    {nullptr, \".read(1)[0]\", \".read(1).getbyte(0)\"},\n"
                "                    {\"def getPlayTime2\", \"rstr[0]\", \"rstr.getbyte(0)\"},\n"
                "                    {\"def getPlayTime2\", \"rstr[1]\", \"rstr.getbyte(1)\"},\n"
                "                };\n"
                "                std::string fx(RSTRING_PTR(string), RSTRING_LEN(string));\n"
                "                int n = 0;\n"
                "                for (const Fix &f : fixes) {\n"
                "                    if (f.trigger && fx.find(f.trigger) == std::string::npos) continue;\n"
                "                    const size_t fl = strlen(f.from), tl = strlen(f.to);\n"
                "                    for (size_t at = fx.find(f.from); at != std::string::npos; at = fx.find(f.from, at + tl)) {\n"
                "                        fx.replace(at, fl, f.to);\n"
                "                        ++n;\n"
                "                    }\n"
                "                }\n"
                "                if (n > 0) {\n"
                "                    Debug() << \"[rgss18]\" << buf << \": byte index fix x\" << n;\n"
                "                    string = newStringUTF8(fx.c_str(), fx.size());\n"
                "                    rb_ary_store(script, 3, string);\n"
                "                }\n"
                "            }\n"
                "            // [switch2-rgss1-source-fixups-v2]\n",
            ),
        ],
    )


def patch_font_win_metrics() -> None:
    # The Pokemon "Power ..." pixel fonts (pkmnem.ttf etc., used by Pokemon Essentials games) store a
    # POSITIVE hhea descender. FreeType/SDL_ttf derive the line height from hhea -> 14px at size 29, which
    # cuts every glyph in half. Windows GDI (and thus RGSS on PC) uses the OS/2 usWin metrics instead, so
    # do the same for fonts whose hhea metrics are clearly broken.
    patch_file(
        "src/display/font.cpp",
        "// [switch2-font-win-metrics]",
        [
            (
                "\t\tFT_Face face = TTF_FONT_TO_FT_FACE(font);\n",
                "\t\tFT_Face face = TTF_FONT_TO_FT_FACE(font);\n"
                "\t\t// [switch2-font-win-metrics]\n"
                "\t\tif (face && face->descender > 0) {\n"
                "\t\t\tTT_OS2 *os2 = (TT_OS2 *)FT_Get_Sfnt_Table(face, FT_SFNT_OS2);\n"
                "\t\t\tif (os2 && os2->usWinAscent > 0) {\n"
                "\t\t\t\tface->ascender = (FT_Short)os2->usWinAscent;\n"
                "\t\t\t\tface->descender = (FT_Short)-(int)os2->usWinDescent;\n"
                "\t\t\t\tface->height = (FT_Short)(face->ascender - face->descender);\n"
                "\t\t\t}\n"
                "\t\t}\n",
            ),
        ],
    )


def patch_resize_screen_recalc() -> None:
    # Graphics.resize_screen relies on the window-resize event to recompute the output scale and offset.
    # The Switch display never resizes, so the old ratio stayed (Pokemon Uranium: 512x384 drawn at the
    # 640x480 scale, off-centre in the top-left). Recompute immediately on Switch.
    patch_file(
        "src/display/graphics.cpp",
        "// [switch2-resize-screen-recalc]",
        [
            (
                "    glState.scissorBox.set(IntRect(0, 0, p->scRes.x, p->scRes.y));\n"
                "    \n"
                "    shState->eThread().requestWindowResize(width, height);\n",
                "    glState.scissorBox.set(IntRect(0, 0, p->scRes.x, p->scRes.y));\n"
                "    \n"
                "#ifdef __SWITCH__\n"
                "    // [switch2-resize-screen-recalc]\n"
                "    if (p->integerScaleActive && p->findHighestIntegerScale())\n"
                "        p->rebuildIntegerScaleBuffer();\n"
                "    glState.viewport.refresh();\n"
                "    p->recalculateScreenSize(shState->config().fixedAspectRatio);\n"
                "    p->updateScreenResoRatio(p->threadData);\n"
                "#endif\n"
                "    shState->eThread().requestWindowResize(width, height);\n",
            ),
        ],
    )


def patch_resize_screen_log() -> None:
    # Logs the output geometry whenever the game resolution changes, to diagnose games drawn
    # off-centre after Graphics.resize_screen (Pokemon Uranium, 512x384).
    patch_file(
        "src/display/graphics.cpp",
        "// [switch2-resize-screen-log]",
        [
            (
                "    p->checkResize();\n"
                "    p->redrawScreen();\n"
                "}\n",
                "    p->checkResize();\n"
                "    // [switch2-resize-screen-log]\n"
                "    {\n"
                "        static Vec2i loggedRes(-1, -1), loggedWin(-1, -1), loggedSize(-1, -1);\n"
                "        TEXFBO &fb = p->screen.getPP().frontBuffer();\n"
                "        if (!(loggedRes == p->scRes) || !(loggedWin == p->winSize) || !(loggedSize == p->scSize)) {\n"
                "            loggedRes = p->scRes; loggedWin = p->winSize; loggedSize = p->scSize;\n"
                "            Debug() << \"[screen] res\" << p->scRes.x << \"x\" << p->scRes.y\n"
                "                    << \"win\" << p->winSize.x << \"x\" << p->winSize.y\n"
                "                    << \"out\" << p->scSize.x << \"x\" << p->scSize.y\n"
                "                    << \"at\" << p->scOffset.x << \",\" << p->scOffset.y\n"
                "                    << \"fb\" << fb.width << \"x\" << fb.height\n"
                "                    << \"int\" << p->integerScaleActive << \"fixed\" << shState->config().fixedAspectRatio;\n"
                "        }\n"
                "    }\n"
                "    p->redrawScreen();\n"
                "}\n",
            ),
            (
                "void Graphics::resizeScreen(int width, int height) {\n",
                "void Graphics::resizeScreen(int width, int height) {\n"
                "    Debug() << \"[screen] resize_screen\" << width << height;\n",
            ),
        ],
    )
    # v2: the loading screen resizes to 1280x720 for every frame it draws; keep the log short.
    patch_file(
        "src/display/graphics.cpp",
        "// [switch2-resize-screen-log-v2]",
        [
            (
                "        static Vec2i loggedRes(-1, -1), loggedWin(-1, -1), loggedSize(-1, -1);\n"
                "        TEXFBO &fb = p->screen.getPP().frontBuffer();\n"
                "        if (!(loggedRes == p->scRes) || !(loggedWin == p->winSize) || !(loggedSize == p->scSize)) {\n",
                "        // [switch2-resize-screen-log-v2]\n"
                "        static Vec2i loggedRes(-1, -1), loggedWin(-1, -1), loggedSize(-1, -1);\n"
                "        static int loggedCount = 0;\n"
                "        TEXFBO &fb = p->screen.getPP().frontBuffer();\n"
                "        if (loggedCount < 8 && (!(loggedRes == p->scRes) || !(loggedWin == p->winSize) || !(loggedSize == p->scSize))) {\n"
                "            ++loggedCount;\n",
            ),
            (
                "    Debug() << \"[screen] resize_screen\" << width << height;\n",
                "",
            ),
        ],
    )


def patch_essentials_xp_resolution() -> None:
    # Pokemon Essentials XP games (Pokemon Uranium) declare DEFAULTSCREENWIDTH/HEIGHT (512x384) and relied on
    # a patched RGSS player for that window size; RGSS1 has no resize_screen. Right after the script that
    # declares the size, let SW2EssentialsResolution (win32_wrap.rb) resize the screen. Done from the script
    # loop because Switch preloads (fast_forward.rb) replace Graphics.update.
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-essentials-resolution]",
        [
            (
                "            if (state) {\n"
                "                VALUE err = rb_errinfo();\n"
                "                if (!NIL_P(err) && rb_obj_is_kind_of(err, rb_eSyntaxError)) {\n"
                "                    VALUE emsg",
                "            // [switch2-essentials-resolution]\n"
                "            if (!state && rgssVer == 1) {\n"
                "                static bool sw2ResDone = false;\n"
                "                if (!sw2ResDone && rb_const_defined(rb_cObject, rb_intern(\"DEFAULTSCREENWIDTH\")) &&\n"
                "                    rb_const_defined(rb_cObject, rb_intern(\"DEFAULTSCREENHEIGHT\"))) {\n"
                "                    sw2ResDone = true;\n"
                "                    int resState = 0;\n"
                "                    rb_eval_string_protect(\"if defined?(SW2EssentialsResolution) then SW2EssentialsResolution.check \"\n"
                "                                           \"else System.puts('[screen] SW2EssentialsResolution missing') end\", &resState);\n"
                "                    if (resState) {\n"
                "                        Debug() << \"[screen] resolution check raised after\" << buf;\n"
                "                        rb_set_errinfo(Qnil);\n"
                "                    }\n"
                "                }\n"
                "            }\n"
                "            if (state) {\n"
                "                VALUE err = rb_errinfo();\n"
                "                if (!NIL_P(err) && rb_obj_is_kind_of(err, rb_eSyntaxError)) {\n"
                "                    VALUE emsg",
            ),
        ],
    )


def patch_loading_screen_progress() -> None:
    # MV/MZ-style loading screen for mkxp-z games: the preload draws it, and the script loader advances
    # its progress bar before each game script (throttled in Ruby to a few frames per second).
    src = (Path(__file__).resolve().parent / "mkxpz" / "loading-screen.rb").read_text(encoding="utf-8")
    write_if_changed(ROOT / "switch/romfs-root/preload/loading_screen.rb", src)
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-loading-progress]",
        [
            (
                "            int state;\n"
                "            \n"
                "            // [switch2-rgss1-source-fixups]\n",
                "            int state;\n"
                "            \n"
                "            // [switch2-loading-progress]\n"
                "            {\n"
                "                static bool sw2LoadDone = false;\n"
                "                if (!sw2LoadDone) {\n"
                "                    if (i >= scriptCount - 1)\n"
                "                        sw2LoadDone = true;\n"
                "                    rb_gv_set(\"$__sw2_script_name\", rb_str_new_cstr(scriptName));\n"
                "                    char call[192];\n"
                "                    snprintf(call, sizeof(call),\n"
                "                             \"SW2Loading.step(%ld, %ld, $__sw2_script_name, %d) if defined?(SW2Loading)\",\n"
                "                             i, scriptCount, rgssVer);\n"
                "                    int loadState = 0;\n"
                "                    rb_eval_string_protect(call, &loadState);\n"
                "                    if (loadState)\n"
                "                        rb_set_errinfo(Qnil);\n"
                "                    rb_gv_set(\"$__sw2_script_name\", Qnil);\n"
                "                }\n"
                "            }\n"
                "            // [switch2-rgss1-source-fixups]\n",
            ),
        ],
    )


def patch_rgss1_source_fixups_v4() -> None:
    # Drop the Ruby 1.8 /n flag from regexps without byte escapes in RGSS1 scripts: in Ruby 3 a /n regexp
    # that contains (or interpolates) non-ASCII characters raises RegexpError at runtime (Pokemon Uranium
    # DrawText: /(?:...#{CJKUtils::WordRegexp::WordRegexp}...)/n). For ASCII-only patterns /n is a no-op.
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-rgss1-source-fixups-v4]",
        [
            (
                "            // [switch2-rgss1-source-fixups-v3]\n",
                "            // [switch2-rgss1-source-fixups-v4]\n"
                "            if (rgssVer == 1) {\n"
                "                std::string fx(RSTRING_PTR(string), RSTRING_LEN(string));\n"
                "                if (fx.find(\"/n\") != std::string::npos) {\n"
                "                    int nFixes = 0;\n"
                "                    std::string out = switch2_rgss18::stripRegexN(fx, &nFixes);\n"
                "                    if (nFixes > 0) {\n"
                "                        Debug() << \"[rgss18]\" << buf << \": dropped /n from\" << nFixes << \"regexp(s)\";\n"
                "                        string = newStringUTF8(out.c_str(), out.size());\n"
                "                        rb_ary_store(script, 3, string);\n"
                "                    }\n"
                "                }\n"
                "            }\n"
                "            // [switch2-rgss1-source-fixups-v3]\n",
            ),
        ],
    )


def patch_switch_controls_keyboard() -> None:
    # Quick Menu "Open Keyboard": the Switch software keyboard is shown when a game switches text input on;
    # if it's dismissed while the game still waits for text (Pokemon Reborn's name entry), there was no way
    # to bring it back. Shown only while text input is active.
    patch_file(
        "switch/romfs-root/preload/switch_controls.rb",
        "# [switch2-quickmenu-keyboard]",
        [
            (
                "\t\t\titems << [:launcher, \"Return to Game Select\"]\n",
                "\t\t\titems << [:keyboard, \"Open Keyboard\"] if SwitchControls.text_input_active? # [switch2-quickmenu-keyboard]\n"
                "\t\t\titems << [:launcher, \"Return to Game Select\"]\n",
            ),
            (
                "\t\telsif action == :launcher\n",
                "\t\telsif action == :keyboard\n"
                "\t\t\tSwitchControls.reopen_keyboard\n"
                "\t\telsif action == :launcher\n",
            ),
        ],
    )


def patch_win32_hooks() -> None:
    # Hooks for native DLLs whose names aren't valid Ruby constants (RGSS Linker / RGSS FmodEx) must be
    # installed after Win32API exists, so they go at the end of the wrapper preload.
    src = (Path(__file__).resolve().parent / "mkxpz" / "win32-hooks.rb").read_text(encoding="utf-8")
    wrap_p = ROOT / "scripts/preload/win32_wrap.rb"
    text = wrap_p.read_text(encoding="utf-8")
    marker = "# [switch2-win32-hooks-v1]"
    if marker in text:
        text = text.partition("\n" + marker)[0]
    write_if_changed(wrap_p, text.rstrip("\n") + "\n" + src)


def write_if_changed(p: Path, content: str, mode: int | None = None) -> None:
    if p.exists() and p.read_text(encoding="utf-8") == content:
        print(f"[ok] {p} unchanged")
        return
    p.write_text(content, encoding="utf-8", newline="\n")
    if mode is not None:
        os.chmod(p, mode)
    print(f"[wrote] {p}")


def write_switch2_cross_files() -> None:
    pkg_wrapper = ROOT / "switch" / "pkg-config-switch2.sh"
    write_if_changed(
        pkg_wrapper,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "export PKG_CONFIG_PATH=/opt/devkitpro/portlibs/switch2/lib/pkgconfig:/opt/devkitpro/portlibs/switch/lib/pkgconfig\n"
        "out=$(/opt/devkitpro/portlibs/switch/bin/aarch64-none-elf-pkg-config \"$@\")\n"
        "# Ensure Switch 2 OunceVK (portlibs/switch2/lib) and libounce come BEFORE Switch 1 portlibs/switch/lib\n"
        "# so Meson resolves -lEGL/-lGLESv2/-lglapi/-ldrm_nouveau to OunceVK (Zink+NVK) instead of Switch 1 nouveau!\n"
        "out=$(printf '%s' \"$out\" | sed "
        "'s|-L/opt/devkitpro/portlibs/switch/lib|-L/opt/devkitpro/portlibs/switch2/lib -L/opt/devkitpro/libounce/lib -L/opt/devkitpro/portlibs/switch/lib|g; "
        "s|-L/opt/devkitpro/libnx/lib|-L/opt/devkitpro/portlibs/switch2/lib -L/opt/devkitpro/libounce/lib|g; "
        "s|/opt/devkitpro/libnx/include|/opt/devkitpro/libounce/include|g')\n"
        "printf '%s\\n' \"$out\"\n",
        0o755,
    )

    cross = ROOT / "switch" / "switch2.ini"
    write_if_changed(
        cross,
        f"""# Meson cross file for Nintendo Switch 2 homebrew (devkitA64 + libounce + OunceVK)
[binaries]
c = '/opt/devkitpro/devkitA64/bin/aarch64-none-elf-gcc'
cpp = '/opt/devkitpro/devkitA64/bin/aarch64-none-elf-g++'
ar = '/opt/devkitpro/devkitA64/bin/aarch64-none-elf-gcc-ar'
strip = '/opt/devkitpro/devkitA64/bin/aarch64-none-elf-strip'
cmake = 'cmake'
pkg-config = '{pkg_wrapper}'
nacptool = '/opt/devkitpro/tools/bin/nacptool'
elf2nro = '/opt/devkitpro/tools/bin/elf2nro'

[properties]
needs_exe_wrapper = true

[built-in options]
c_args = ['-D__SWITCH__', '-D__SWITCH2__', '-mcpu=cortex-a78c+crypto', '-mtp=soft', '-fPIE', '-ftls-model=local-exec', '-I/opt/devkitpro/portlibs/switch2/include', '-I/opt/devkitpro/portlibs/switch/include', '-isystem', '/opt/devkitpro/libounce/include']
cpp_args = ['-D__SWITCH__', '-D__SWITCH2__', '-mcpu=cortex-a78c+crypto', '-mtp=soft', '-fPIE', '-ftls-model=local-exec', '-I/opt/devkitpro/portlibs/switch2/include', '-I/opt/devkitpro/portlibs/switch/include', '-isystem', '/opt/devkitpro/libounce/include', '-Wno-template-body']
c_link_args = ['-specs=/opt/devkitpro/libounce/switch.specs', '-mcpu=cortex-a78c+crypto', '-mtp=soft', '-fPIE', '-L/opt/devkitpro/portlibs/switch2/lib', '-L/opt/devkitpro/portlibs/switch/lib', '-L/opt/devkitpro/libounce/lib']
cpp_link_args = ['-specs=/opt/devkitpro/libounce/switch.specs', '-mcpu=cortex-a78c+crypto', '-mtp=soft', '-fPIE', '-L/opt/devkitpro/portlibs/switch2/lib', '-L/opt/devkitpro/portlibs/switch/lib', '-L/opt/devkitpro/libounce/lib']

[project options]
sdl_system = 'enabled'
openal_system = 'enabled'
gl_system = 'disabled'
use_miniffi = false
openssl = 'disabled'

[cmake]
CMAKE_SYSTEM_NAME = 'Generic'

[host_machine]
system = 'switch'
cpu_family = 'aarch64'
cpu = 'cortex-a78c'
endian = 'little'
""",
    )


def patch_minus_quick_menu() -> None:
    # 1. Bind Switch Minus (-) button (SDL_CONTROLLER_BUTTON_BACK) to dedicated Input::F8
    patch_file(
        "src/input/keybindings.cpp",
        "// [switch2-minus-quick-menu]",
        [
            (
                "\t{ SDL_CONTROLLER_BUTTON_BACK, Input::A  },  /* - : Select */\n"
                "\t{ SDL_CONTROLLER_BUTTON_BACK, Input::Z  },",
                "\t// [switch2-minus-quick-menu]\n"
                "\t{ SDL_CONTROLLER_BUTTON_BACK, Input::F8 },  /* - : SW2RPGMGL Quick Menu */",
            ),
        ],
    )

    # 2. Add SW2RPGMGL (-) Quick Menu & Performance HUD into preload/switch_controls.rb
    patch_file(
        "switch/romfs-root/preload/switch_controls.rb",
        "# [switch2-minus-quick-menu-v1]",
        [
            (
                "\tdef update\n"
                "\t\t__switch_update\n"
                "\t\tSwitchControls.poll_soft_reset\n"
                "\tend",
                "\tdef update\n"
                "\t\t__switch_update\n"
                "\t\tSwitchControls.poll_soft_reset\n"
                "\t\tSwitchControls.poll_quick_menu\n"
                "\t\tSwitchControls.update_fps_hud\n"
                "\tend\n"
                "end\n\n"
                "# [switch2-minus-quick-menu-v1]\n"
                "module SwitchControls\n"
                "\tQUICK_MENU = Input::F8\n"
                "\t@menu_down = false\n"
                "\t@menu_open = false\n"
                "\t@show_hud = false\n"
                "\t@hud_frames = 0\n"
                "\t@hud_last_t = Time.now.to_f\n"
                "\t@hud_fps = 60\n"
                "\t@hud_vp = nil\n"
                "\t@hud_sprite = nil\n"
                "\t@hud_bmp = nil\n\n"
                "\tdef self.raw_down?(sym, fallback_const)\n"
                "\t\tInput.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(sym) : Input.press?(fallback_const)\n"
                "\tend\n\n"
                "\tdef self.raw_trigger?(sym, fallback_const)\n"
                "\t\tInput.respond_to?(:__mkxp_raw_trigger?) ? Input.__mkxp_raw_trigger?(sym) : Input.trigger?(fallback_const)\n"
                "\tend\n\n"
                "\tdef self.raw_repeat?(sym, fallback_const)\n"
                "\t\tInput.respond_to?(:__mkxp_raw_repeat?) ? Input.__mkxp_raw_repeat?(sym) : Input.repeat?(fallback_const)\n"
                "\tend\n\n"
                "\tdef self.raw_update\n"
                "\t\tInput.respond_to?(:__mkxp_raw_update) ? Input.__mkxp_raw_update : Input.update\n"
                "\tend\n\n"
                "\tdef self.update_fps_hud\n"
                "\t\t@hud_frames += 1\n"
                "\t\tnow = Time.now.to_f\n"
                "\t\tdt = now - @hud_last_t\n"
                "\t\tif dt >= 0.5\n"
                "\t\t\t@hud_fps = (@hud_frames / dt).round\n"
                "\t\t\t@hud_frames = 0\n"
                "\t\t\t@hud_last_t = now\n"
                "\t\t\tredraw_hud if @show_hud\n"
                "\t\tend\n"
                "\t\tif !@show_hud && @hud_sprite\n"
                "\t\t\tdispose_hud\n"
                "\t\tend\n"
                "\tend\n\n"
                "\tdef self.dispose_hud\n"
                "\t\t@hud_bmp.dispose if @hud_bmp && !@hud_bmp.disposed?\n"
                "\t\t@hud_sprite.dispose if @hud_sprite && !@hud_sprite.disposed?\n"
                "\t\t@hud_vp.dispose if @hud_vp && !@hud_vp.disposed?\n"
                "\t\t@hud_bmp = nil\n"
                "\t\t@hud_sprite = nil\n"
                "\t\t@hud_vp = nil\n"
                "\tend\n\n"
                "\tdef self.redraw_hud\n"
                "\t\tif !@hud_vp || @hud_vp.disposed?\n"
                "\t\t\t@hud_vp = Viewport.new(0, 0, Graphics.width, Graphics.height)\n"
                "\t\t\t@hud_vp.z = 999_999\n"
                "\t\t\t@hud_sprite = Sprite.new(@hud_vp)\n"
                "\t\t\t@hud_bmp = Bitmap.new(250, 28)\n"
                "\t\t\t@hud_sprite.bitmap = @hud_bmp\n"
                "\t\t\t@hud_sprite.x = 8\n"
                "\t\t\t@hud_sprite.y = 8\n"
                "\t\tend\n"
                "\t\t@hud_bmp.clear\n"
                "\t\t@hud_bmp.fill_rect(0, 0, 250, 28, Color.new(0, 0, 0, 175))\n"
                "\t\t@hud_bmp.font.color = Color.new(240, 181, 255)\n"
                "\t\t@hud_bmp.font.size = 16\n"
                "\t\t@hud_bmp.draw_text(8, 2, 234, 24, \"SW2RPGMGL (VX) | #{@hud_fps} FPS\")\n"
                "\tend\n\n"
                "\tdef self.poll_quick_menu\n"
                "\t\tdown = raw_down?(:F8, QUICK_MENU)\n"
                "\t\tpressed = down && !@menu_down\n"
                "\t\t@menu_down = down\n"
                "\t\treturn unless pressed && !@menu_open && !@prompting\n"
                "\t\t@menu_open = true\n"
                "\t\taction = nil\n"
                "\t\tbegin\n"
                "\t\t\taction = run_quick_menu\n"
                "\t\tensure\n"
                "\t\t\t@menu_open = false\n"
                "\t\t\t@menu_down = raw_down?(:F8, QUICK_MENU)\n"
                "\t\tend\n"
                "\t\tif action == :reset\n"
                "\t\t\tif map_reset_possible?\n"
                "\t\t\t\t$game_temp.to_title = true\n"
                "\t\t\telse\n"
                "\t\t\t\tshow_resetting\n"
                "\t\t\t\traise reset_exception\n"
                "\t\t\tend\n"
                "\t\telsif action == :launcher\n"
                "\t\t\tdispose_hud\n"
                "\t\t\tKernel.exit(0)\n"
                "\t\telsif action == :hbmenu\n"
                "\t\t\tdispose_hud\n"
                "\t\t\tENV[\"SW2RPGMGL_EXIT_HBMENU\"] = \"1\"\n"
                "\t\t\tKernel.exit(0)\n"
                "\t\tend\n"
                "\tend\n\n"
                "\tdef self.run_quick_menu\n"
                "\t\tvp = Viewport.new(0, 0, Graphics.width, Graphics.height)\n"
                "\t\tvp.z = 1_000_000\n"
                "\t\tsprite = Sprite.new(vp)\n"
                "\t\tbmp = Bitmap.new(Graphics.width, Graphics.height)\n"
                "\t\tsprite.bitmap = bmp\n"
                "\t\tsupported_reset = map_reset_possible? || engine_reset_allowed?\n"
                "\t\tslot = 0\n"
                "\t\tprev_minus = true\n"
                "\t\tdraw_menu = lambda do\n"
                "\t\t\titems = [\n"
                "\t\t\t\t[:resume, \"Resume Game\"],\n"
                "\t\t\t\t[:hud, \"Performance HUD: #{@show_hud ? 'ON' : 'OFF'}\"],\n"
                "\t\t\t]\n"
                "\t\t\titems << [:reset, \"Soft Reset (Title Screen)\"] if supported_reset\n"
                "\t\t\titems << [:launcher, \"Return to Game Select\"]\n"
                "\t\t\titems << [:hbmenu, \"Exit to hbmenu (kaiHEN)\"]\n"
                "\t\t\tbmp.clear\n"
                "\t\t\tbmp.fill_rect(0, 0, bmp.width, bmp.height, Color.new(0, 0, 0, 175))\n"
                "\t\t\tw = [bmp.width - 48, 380].min\n"
                "\t\t\trow_h = 34\n"
                "\t\t\th = 84 + items.length * row_h + 24\n"
                "\t\t\tx = (bmp.width - w) / 2\n"
                "\t\t\ty = (bmp.height - h) / 2\n"
                "\t\t\tbmp.fill_rect(x, y, w, h, Color.new(20, 25, 38, 245))\n"
                "\t\t\tbmp.fill_rect(x, y, w, 3, Color.new(176, 108, 255))\n"
                "\t\t\tbmp.fill_rect(x, y + h - 2, w, 2, Color.new(176, 108, 255))\n"
                "\t\t\tbmp.font.color = Color.new(255, 255, 255)\n"
                "\t\t\tbmp.font.size = 22\n"
                "\t\t\tbmp.draw_text(x + 18, y + 12, w - 36, 28, \"SW2RPGMGL (VX Ace)\")\n"
                "\t\t\tbmp.font.color = Color.new(154, 168, 199)\n"
                "\t\t\tbmp.font.size = 14\n"
                "\t\t\tbmp.draw_text(x + 18, y + 42, w - 36, 20, \"A: Confirm   B / Minus: Resume\")\n"
                "\t\t\titems.each_with_index do |pair, idx|\n"
                "\t\t\t\try = y + 72 + idx * row_h\n"
                "\t\t\t\tif idx == slot\n"
                "\t\t\t\t\tbmp.fill_rect(x + 14, ry - 2, w - 28, 28, Color.new(130, 80, 210, 100))\n"
                "\t\t\t\t\tbmp.font.color = Color.new(255, 255, 255)\n"
                "\t\t\t\telse\n"
                "\t\t\t\t\tbmp.font.color = Color.new(199, 209, 232)\n"
                "\t\t\t\tend\n"
                "\t\t\t\tbmp.font.size = 18\n"
                "\t\t\t\tprefix = idx == slot ? \"> \" : \"  \"\n"
                "\t\t\t\tbmp.draw_text(x + 22, ry, w - 44, 24, \"#{prefix}#{pair[1]}\")\n"
                "\t\t\tend\n"
                "\t\t\titems\n"
                "\t\tend\n"
                "\t\titems = draw_menu.call\n"
                "\t\tloop do\n"
                "\t\t\tGraphics.__switch_update\n"
                "\t\t\traw_update\n"
                "\t\t\tm_down = raw_down?(:F8, QUICK_MENU)\n"
                "\t\t\tif (m_down && !prev_minus) || raw_trigger?(:B, Input::B)\n"
                "\t\t\t\treturn :resume\n"
                "\t\t\tend\n"
                "\t\t\tprev_minus = m_down\n"
                "\t\t\tif raw_repeat?(:UP, Input::UP)\n"
                "\t\t\t\tslot = (slot - 1) % items.length\n"
                "\t\t\t\titems = draw_menu.call\n"
                "\t\t\telsif raw_repeat?(:DOWN, Input::DOWN)\n"
                "\t\t\t\tslot = (slot + 1) % items.length\n"
                "\t\t\t\titems = draw_menu.call\n"
                "\t\t\telsif raw_trigger?(:C, Input::C)\n"
                "\t\t\t\tchosen = items[slot][0]\n"
                "\t\t\t\tif chosen == :hud\n"
                "\t\t\t\t\t@show_hud = !@show_hud\n"
                "\t\t\t\t\t@show_hud ? redraw_hud : dispose_hud\n"
                "\t\t\t\t\titems = draw_menu.call\n"
                "\t\t\t\telse\n"
                "\t\t\t\t\treturn chosen\n"
                "\t\t\t\tend\n"
                "\t\t\tend\n"
                "\t\tend\n"
                "\tensure\n"
                "\t\tbmp.dispose if bmp && !bmp.disposed?\n"
                "\t\tsprite.dispose if sprite && !sprite.disposed?\n"
                "\t\tvp.dispose if vp && !vp.disposed?\n"
                "\tend\n"
                "end\n\n"
                "class << Graphics",
            ),
        ],
    )

    p = ROOT / "switch/romfs-root/preload/switch_controls.rb"
    text = p.read_text(encoding="utf-8")
    if "SW2RPGMGL_EXIT_HBMENU" not in text:
        updated = text.replace(
            "\t\telsif action == :launcher\n"
            "\t\t\tdispose_hud\n"
            "\t\t\tKernel.exit(0)\n"
            "\t\tend\n",
            "\t\telsif action == :launcher\n"
            "\t\t\tdispose_hud\n"
            "\t\t\tKernel.exit(0)\n"
            "\t\telsif action == :hbmenu\n"
            "\t\t\tdispose_hud\n"
            "\t\t\tENV[\"SW2RPGMGL_EXIT_HBMENU\"] = \"1\"\n"
            "\t\t\tKernel.exit(0)\n"
            "\t\tend\n",
            1,
        ).replace(
            "\t\t\titems << [:launcher, \"Return to Game Select\"]\n",
            "\t\t\titems << [:launcher, \"Return to Game Select\"]\n"
            "\t\t\titems << [:hbmenu, \"Exit to hbmenu (kaiHEN)\"]\n",
            1,
        )
        if updated != text:
            p.write_text(updated, encoding="utf-8", newline="\n")
            print("[patched] switch/romfs-root/preload/switch_controls.rb (Exit to hbmenu)")

    # Ensure both confirm() and run_quick_menu() use mkxp-z's native __mkxp_raw_* Input methods
    # so games that overwrite Input (e.g. LonaRPG's 1000_Hime_AllKey.rb) never crash the overlay.
    text = p.read_text(encoding="utf-8")
    updated = text
    if "def self.raw_trigger?" not in updated:
        updated = updated.replace(
            "\tdef self.raw_down?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(sym) : Input.press?(fallback_const)\n"
            "\tend\n",
            "\tdef self.raw_down?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(sym) : Input.press?(fallback_const)\n"
            "\tend\n\n"
            "\tdef self.raw_trigger?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_trigger?) ? Input.__mkxp_raw_trigger?(sym) : Input.trigger?(fallback_const)\n"
            "\tend\n\n"
            "\tdef self.raw_repeat?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_repeat?) ? Input.__mkxp_raw_repeat?(sym) : Input.repeat?(fallback_const)\n"
            "\tend\n\n"
            "\tdef self.raw_update\n"
            "\t\tInput.respond_to?(:__mkxp_raw_update) ? Input.__mkxp_raw_update : Input.update\n"
            "\tend\n",
            1,
        )
    updated = (
        updated.replace(
            "\t\t\tGraphics.update\n"
            "\t\t\tInput.update\n"
            "\t\t\tif Input.trigger?(Input::C)\n"
            "\t\t\t\tanswer = true\n"
            "\t\t\telsif Input.trigger?(Input::B) || Input.trigger?(SOFT_RESET)\n"
            "\t\t\t\tanswer = false\n"
            "\t\t\tend",
            "\t\t\tGraphics.__switch_update\n"
            "\t\t\traw_update\n"
            "\t\t\tif raw_trigger?(:C, Input::C)\n"
            "\t\t\t\tanswer = true\n"
            "\t\t\telsif raw_trigger?(:B, Input::B) || raw_trigger?(:F5, SOFT_RESET)\n"
            "\t\t\t\tanswer = false\n"
            "\t\t\tend",
        )
        .replace(
            "\t\t\tGraphics.__switch_update\n"
            "\t\t\tInput.update\n"
            "\t\t\tm_down = raw_down?(:F8, QUICK_MENU)\n"
            "\t\t\tif (m_down && !prev_minus) || Input.trigger?(Input::B)",
            "\t\t\tGraphics.__switch_update\n"
            "\t\t\traw_update\n"
            "\t\t\tm_down = raw_down?(:F8, QUICK_MENU)\n"
            "\t\t\tif (m_down && !prev_minus) || raw_trigger?(:B, Input::B)",
        )
        .replace("\t\t\tif Input.repeat?(Input::UP)", "\t\t\tif raw_repeat?(:UP, Input::UP)")
        .replace("\t\t\telsif Input.repeat?(Input::DOWN)", "\t\t\telsif raw_repeat?(:DOWN, Input::DOWN)")
        .replace("\t\t\telsif Input.trigger?(Input::C)", "\t\t\telsif raw_trigger?(:C, Input::C)")
    )
    if updated != text:
        p.write_text(updated, encoding="utf-8", newline="\n")
        print("[patched] switch/romfs-root/preload/switch_controls.rb (raw Input for menus)")

    # Ensure raw Input button polling works on RGSS1 (XP) and RGSS2 (VX) as well as RGSS3 (VX Ace)!
    # In mkxp-z binding/input-binding.cpp, getButtonArg() only accepts Symbol arguments when rgssVer >= 3;
    # on RGSS1/RGSS2 Input::F8 / Input::F5 / Input::UP / etc. are Fixnum constants, so passing :F8 returned 0!
    # Capture the preload-time Input::* constants (Integer on XP/VX, Symbol on VX Ace) before any game script runs.
    text = p.read_text(encoding="utf-8")
    if "# [switch2-rgss12-raw-buttons-v1]" not in text:
        updated = text
        updated = updated.replace(
            "\tQUICK_MENU = Input::F8\n",
            "\t# [switch2-rgss12-raw-buttons-v1]\n"
            "\tQUICK_MENU = Input::F8\n"
            "\tRAW_KEYS = {\n"
            "\t\tF5: Input::F5,\n"
            "\t\tF8: Input::F8,\n"
            "\t\tUP: Input::UP,\n"
            "\t\tDOWN: Input::DOWN,\n"
            "\t\tC: Input::C,\n"
            "\t\tB: Input::B,\n"
            "\t}\n"
            "\tENGINE_LABEL = Object.const_defined?(:RGSSReset) ? (Input::C.is_a?(Symbol) ? \"VX Ace\" : \"VX\") : \"XP\"\n\n"
            "\tdef self.raw_btn(sym, fallback_const)\n"
            "\t\tRAW_KEYS[sym] || fallback_const\n"
            "\tend\n",
            1,
        )
        updated = updated.replace(
            "\t\tdown = Input.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(:F5) : Input.press?(SOFT_RESET)\n",
            "\t\tdown = raw_down?(:F5, SOFT_RESET)\n",
        )
        updated = updated.replace(
            "\tdef self.raw_down?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(sym) : Input.press?(fallback_const)\n"
            "\tend\n",
            "\tdef self.raw_down?(sym, fallback_const)\n"
            "\t\tbtn = raw_btn(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_press?) ? Input.__mkxp_raw_press?(btn) : Input.press?(btn)\n"
            "\tend\n",
        )
        updated = updated.replace(
            "\tdef self.raw_trigger?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_trigger?) ? Input.__mkxp_raw_trigger?(sym) : Input.trigger?(fallback_const)\n"
            "\tend\n",
            "\tdef self.raw_trigger?(sym, fallback_const)\n"
            "\t\tbtn = raw_btn(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_trigger?) ? Input.__mkxp_raw_trigger?(btn) : Input.trigger?(btn)\n"
            "\tend\n",
        )
        updated = updated.replace(
            "\tdef self.raw_repeat?(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_repeat?) ? Input.__mkxp_raw_repeat?(sym) : Input.repeat?(fallback_const)\n"
            "\tend\n",
            "\tdef self.raw_repeat?(sym, fallback_const)\n"
            "\t\tbtn = raw_btn(sym, fallback_const)\n"
            "\t\tInput.respond_to?(:__mkxp_raw_repeat?) ? Input.__mkxp_raw_repeat?(btn) : Input.repeat?(btn)\n"
            "\tend\n",
        )
        updated = updated.replace(
            '"SW2RPGMGL (VX) | #{@hud_fps} FPS"',
            '"SW2RPGMGL (#{ENGINE_LABEL}) | #{@hud_fps} FPS"',
        ).replace(
            '"SW2RPGMGL (VX Ace)"',
            '"SW2RPGMGL (#{ENGINE_LABEL})"',
        )
        if updated != text:
            p.write_text(updated, encoding="utf-8", newline="\n")
            print("[patched] switch/romfs-root/preload/switch_controls.rb (RGSS1/2/3 raw buttons + engine label)")


def patch_ruby_stdlib_and_discord() -> None:
    # 1. Automatically add game-local Ruby library directories (./stdlib, ./lib, ./gems, ./gems/*/lib)
    #    to Ruby's $LOAD_PATH ($:) so games shipping their own Ruby stdlib/gems (e.g. Pokemon Reborn's
    #    stdlib/timeout.rb and gems/zip.rb) resolve `require` / `gem` out of the box!
    patch_file(
        "binding/binding-mri.cpp",
        "// [switch2-ruby-local-stdlib-v1]",
        [
            (
                "    RbData rbData;\n"
                "    shState->setBindingData(&rbData);",
                "    // [switch2-ruby-local-stdlib-v1]\n"
                "    {\n"
                "        std::string cwd = mkxp_fs::getCurrentDirectory();\n"
                "        auto pushIfDir = [&](const std::string &dirPath) {\n"
                "            struct stat st{};\n"
                "            if (stat(dirPath.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {\n"
                "                rb_ary_push(lpaths, rb_utf8_str_new(dirPath.c_str(), dirPath.size()));\n"
                "            }\n"
                "        };\n"
                "        pushIfDir(cwd + \"/stdlib\");\n"
                "        pushIfDir(cwd + \"/lib\");\n"
                "        std::string gemsDir = cwd + \"/gems\";\n"
                "        struct stat gst{};\n"
                "        if (stat(gemsDir.c_str(), &gst) == 0 && S_ISDIR(gst.st_mode)) {\n"
                "            rb_ary_push(lpaths, rb_utf8_str_new(gemsDir.c_str(), gemsDir.size()));\n"
                "            DIR *gd = opendir(gemsDir.c_str());\n"
                "            if (gd) {\n"
                "                while (struct dirent *ent = readdir(gd)) {\n"
                "                    if (!strcmp(ent->d_name, \".\") || !strcmp(ent->d_name, \"..\"))\n"
                "                        continue;\n"
                "                    pushIfDir(gemsDir + \"/\" + ent->d_name + \"/lib\");\n"
                "                }\n"
                "                closedir(gd);\n"
                "            }\n"
                "        }\n"
                "    }\n\n"
                "    RbData rbData;\n"
                "    shState->setBindingData(&rbData);",
            ),
        ],
    )

    # 2. Ensure <dirent.h> and <sys/stat.h> are included in binding/binding-mri.cpp
    bp = ROOT / "binding/binding-mri.cpp"
    btext = bp.read_text(encoding="utf-8")
    if "#include <dirent.h>" not in btext:
        btext = "#include <dirent.h>\n#include <sys/stat.h>\n" + btext
        bp.write_text(btext, encoding="utf-8", newline="\n")
        print("[patched] binding/binding-mri.cpp (include dirent.h/sys/stat.h)")

    # 3. Pre-define safe offline Discord RPC stub + RGSS1 Ruby 1.8 helpers in win32api_stub.rb
    #    so games shipping Windows x86_64 gems/discord.so (e.g. Pokemon Reborn) don't crash on `require 'discord'`.
    stub_p = ROOT / "switch/romfs-root/preload/win32api_stub.rb"
    stext = stub_p.read_text(encoding="utf-8")
    if "# [switch2-discord-and-rgss1-compat-v1]" not in stext:
        addition = (
            "\n# [switch2-discord-and-rgss1-compat-v1]\n"
            "module Discord\n"
            "\tdef self.connected?; false; end\n"
            "\tdef self.connect(*); false; end\n"
            "\tdef self.disconnect(*); nil; end\n"
            "\tdef self.update(*); nil; end\n"
            "\tdef self.update_presence(*); nil; end\n"
            "\tdef self.set_activity(*); nil; end\n"
            "\tdef self.method_missing(*); nil; end\n"
            "\tdef self.respond_to_missing?(*); true; end\n"
            "end\n"
            "$LOADED_FEATURES << 'discord.rb' unless $LOADED_FEATURES.include?('discord.rb')\n"
            "$LOADED_FEATURES << 'discord.so' unless $LOADED_FEATURES.include?('discord.so')\n"
            "unless Hash.method_defined?(:index)\n"
            "\tclass Hash\n"
            "\t\tdef index(*args); key(*args); end\n"
            "\tend\n"
            "end\n"
        )
        stub_p.write_text(stext + addition, encoding="utf-8", newline="\n")
        print("[patched] switch/romfs-root/preload/win32api_stub.rb (Discord stub + RGSS1 Hash#index)")


def patch_legacy_conf_and_autodetect_ini() -> None:
    # 1. Support legacy mkxp.conf (e.g. To the Moon: execName=To the Moon, RTP=lang.dat, fontSub=...)
    #    when mkxp.json is absent.
    # 2. Auto-detect non-"Game" .rgssad/.rgss2a/.rgss3a archives and matching .ini files
    #    (e.g. Pokemon Uranium's Uranium.ini + Uranium.rgssad, To the Moon's To the Moon.rgssad)
    #    when Game.ini or Game.rgss* is absent, deprioritizing Launcher.rgssad when another archive exists.
    cp = ROOT / "src/config.cpp"
    ctext = cp.read_text(encoding="utf-8")
    if "#include <dirent.h>" not in ctext:
        ctext = "#include <dirent.h>\n#include <sys/stat.h>\n#include <algorithm>\n#include <fstream>\n" + ctext
        cp.write_text(ctext, encoding="utf-8", newline="\n")
        print("[patched] src/config.cpp (include dirent.h/sys/stat.h/algorithm/fstream)")

    patch_file(
        "src/config.cpp",
        "// [switch2-legacy-conf-and-autodetect-v1]",
        [
            (
                "    json::value baseConf = readConfFile(CONF_FILE);\n"
                "    copyObject(optsJ, baseConf);",
                "    json::value baseConf = readConfFile(CONF_FILE);\n"
                "    copyObject(optsJ, baseConf);\n"
                "    // [switch2-legacy-conf-and-autodetect-v1]\n"
                "    {\n"
                "        struct stat stJson{}, stConf{};\n"
                "        if (stat(CONF_FILE, &stJson) != 0 && stat(\"mkxp.conf\", &stConf) == 0 && S_ISREG(stConf.st_mode)) {\n"
                "            std::ifstream cf(\"mkxp.conf\");\n"
                "            std::string line;\n"
                "            auto &rootObj = optsJ.as_object();\n"
                "            auto trimStr = [](std::string s) {\n"
                "                while (!s.empty() && (s.back() == '\\r' || s.back() == '\\n' || s.back() == ' ' || s.back() == '\\t')) s.pop_back();\n"
                "                size_t i = 0;\n"
                "                while (i < s.size() && (s[i] == ' ' || s[i] == '\\t')) ++i;\n"
                "                return s.substr(i);\n"
                "            };\n"
                "            while (std::getline(cf, line)) {\n"
                "                line = trimStr(line);\n"
                "                if (line.empty() || line[0] == '#') continue;\n"
                "                size_t eq = line.find('=');\n"
                "                if (eq == std::string::npos) continue;\n"
                "                std::string k = trimStr(line.substr(0, eq));\n"
                "                std::string v = trimStr(line.substr(eq + 1));\n"
                "                if (k.empty()) continue;\n"
                "                if (k == \"RGSSVersion\") k = \"rgssVersion\";\n"
                "                if (k == \"RTP\" || k == \"fontSub\" || k == \"preloadScript\" || k == \"postloadScript\" || k == \"solidFonts\" || k == \"patches\" || k == \"rubyLoadpath\") {\n"
                "                    if (!rootObj[k].is_array()) rootObj[k] = json::array({});\n"
                "                    if (!v.empty()) rootObj[k].as_array().push_back(json::value(v));\n"
                "                } else if (k == \"rgssVersion\" || k == \"defScreenW\" || k == \"defScreenH\" || k == \"fixedFramerate\") {\n"
                "                    try { rootObj[k] = json::value(std::stoi(v)); } catch (...) {}\n"
                "                } else if (v == \"true\" || v == \"false\") {\n"
                "                    rootObj[k] = json::value(v == \"true\");\n"
                "                } else {\n"
                "                    rootObj[k] = json::value(v);\n"
                "                }\n"
                "            }\n"
                "            Debug() << \"[config] Loaded legacy mkxp.conf\";\n"
                "        }\n"
                "    }",
            ),
            (
                "    std::string iniFileName(execName + \".ini\");\n"
                "    SDLRWStream iniFile(iniFileName.c_str(), \"r\");",
                "    // Auto-detect non-Game .rgssad/.rgss2a/.rgss3a and .ini (e.g. Uranium.ini / Uranium.rgssad, To the Moon.rgssad)\n"
                "    {\n"
                "        auto fileExists = [](const std::string &path) -> bool {\n"
                "            struct stat st{};\n"
                "            return stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);\n"
                "        };\n"
                "        auto hasLooseScripts = [&]() -> bool {\n"
                "            return fileExists(\"Data/Scripts.rxdata\") || fileExists(\"Data/Scripts.rvdata\") ||\n"
                "                   fileExists(\"Data/Scripts.rvdata2\") || fileExists(\"data/Scripts.rxdata\") ||\n"
                "                   fileExists(\"data/Scripts.rvdata\") || fileExists(\"data/Scripts.rvdata2\");\n"
                "        };\n"
                "        auto hasExecArchive = [&](const std::string &stem) -> bool {\n"
                "            return fileExists(stem + \".rgssad\") || fileExists(stem + \".rgss2a\") || fileExists(stem + \".rgss3a\");\n"
                "        };\n"
                "        bool curIniOk = fileExists(execName + \".ini\");\n"
                "        bool curDataOk = hasLooseScripts() || hasExecArchive(execName);\n"
                "        if (!curIniOk || !curDataOk) {\n"
                "            std::vector<std::string> archStems;\n"
                "            std::vector<std::string> iniStems;\n"
                "            DIR *d = opendir(\".\");\n"
                "            if (d) {\n"
                "                while (struct dirent *e = readdir(d)) {\n"
                "                    std::string name(e->d_name);\n"
                "                    std::string low = name;\n"
                "                    std::transform(low.begin(), low.end(), low.begin(), [](unsigned char c) { return std::tolower(c); });\n"
                "                    if (low.size() > 7 && (low.compare(low.size() - 7, 7, \".rgssad\") == 0 ||\n"
                "                                           low.compare(low.size() - 7, 7, \".rgss2a\") == 0 ||\n"
                "                                           low.compare(low.size() - 7, 7, \".rgss3a\") == 0)) {\n"
                "                        archStems.push_back(name.substr(0, name.size() - 7));\n"
                "                    } else if (low.size() > 4 && low.compare(low.size() - 4, 4, \".ini\") == 0) {\n"
                "                        iniStems.push_back(name.substr(0, name.size() - 4));\n"
                "                    }\n"
                "                }\n"
                "                closedir(d);\n"
                "            }\n"
                "            auto pickBest = [](std::vector<std::string> &v) -> std::string {\n"
                "                if (v.empty()) return \"\";\n"
                "                std::sort(v.begin(), v.end());\n"
                "                for (const auto &s : v) {\n"
                "                    std::string low = s;\n"
                "                    std::transform(low.begin(), low.end(), low.begin(), [](unsigned char c) { return std::tolower(c); });\n"
                "                    if (low != \"launcher\" && low != \"steam_emu\") return s;\n"
                "                }\n"
                "                return v.front();\n"
                "            };\n"
                "            std::string chosen = pickBest(archStems);\n"
                "            if (chosen.empty() && !curIniOk) chosen = pickBest(iniStems);\n"
                "            if (!chosen.empty() && chosen != execName) {\n"
                "                Debug() << \"[config] Auto-detected execName:\" << chosen << \"(was\" << execName << \")\";\n"
                "                execName = chosen;\n"
                "            }\n"
                "        }\n"
                "    }\n"
                "    std::string iniFileName(execName + \".ini\");\n"
                "    SDLRWStream iniFile(iniFileName.c_str(), \"r\");",
            ),
        ],
    )


def patch_rgss_bool_truthiness() -> None:
    # Match Windows RGSS1/2/3 truthiness for boolean setters (e.g. @sprite.visible = @sprite
    # in LonaRPG's 460_KHAS_LightLib.rb:1334): false/nil -> false, any other object -> true.
    patch_file(
        "binding/binding-util.h",
        "// [switch2-rgss-bool-truthiness]",
        [
            (
                "        default:\n"
                "            throw Exception(Exception::TypeError, \"Argument %d: Expected bool\", argPos);",
                "        // [switch2-rgss-bool-truthiness]\n"
                "        default:\n"
                "            (void)argPos;\n"
                "            *out = true;\n"
                "            break;",
            ),
        ],
    )


if __name__ == "__main__":
    patch_switch_main()
    patch_gamepicker()
    patch_src_main()
    patch_rgssad_cp932()
    patch_filesystem_mojibake()
    patch_audio_missing_graceful()
    patch_bitmap_missing_graceful()
    patch_viewport_disposed_graceful()
    patch_rgss_bool_truthiness()
    patch_switch_controls_raw_keys()
    patch_ruby_preloads()
    patch_minus_quick_menu()
    patch_ruby_stdlib_and_discord()
    patch_legacy_conf_and_autodetect_ini()
    patch_binding_mri_syntax()
    patch_binding_rgss18_retry()
    patch_binding_rgss18_retry_v3()
    patch_binding_runtime_error_context()
    patch_preload_stdlib_env_shims()
    patch_preload_compat_v2()
    patch_win32_hooks()
    patch_skip_game_win32_wrap()
    patch_fs_uncached_dir_fallback()
    patch_switch_controls_guards()
    patch_rgss1_source_fixups()
    patch_rgss1_source_fixups_v2()
    patch_rgss1_source_fixups_v3()
    patch_rgss1_source_fixups_v4()
    patch_font_win_metrics()
    patch_resize_screen_recalc()
    patch_resize_screen_log()
    patch_essentials_xp_resolution()
    patch_loading_screen_progress()
    patch_switch_controls_keyboard()
    write_switch2_cross_files()
    print("[done] mkxp-z Switch 2 patches applied cleanly")
