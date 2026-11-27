#pragma once

#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace wolf {

struct VfsStat {
  uint32_t dev = 1;
  uint64_t ino = 1;
  bool isDir = false;
  uint64_t size = 0;
  int64_t mtime = 1700000000;
};

struct VfsDirEntry {
  std::string name;
  bool isDir = false;
  uint64_t ino = 1;
};

/**
 * Direct-mount WOLF RPG Editor Virtual Filesystem (`WolfVfs`).
 *
 * Mounts `.wolf` / `.wolfx` / `.dxa` archives (DXArchive v1-v5, v6, v8, WolfCrypt 3.31/3.50+,
 * ChaCha20) directly in memory without extracting thousands of loose Japanese/symbol filenames
 * onto the Switch 2 FAT32 SD card, while persisting saves directly to `<gameDir>/Save/`.
 */
class WolfVfs {
public:
  WolfVfs();
  WolfVfs(const WolfVfs&) = delete;
  WolfVfs& operator=(const WolfVfs&) = delete;
  ~WolfVfs();

  bool init(const std::string& gameDir, const std::string& romfsDir, const std::string& projectId);
  void shutdown();

  // Flush any in-memory working `/Save/*` files to persistent `<gameDir>/Save/`
  void syncWorkingSavesToDisk();

  bool statPath(const std::string& normVPath, VfsStat& out);
  bool listDirectory(const std::string& normVPath, std::vector<VfsDirEntry>& out);

  // Read an entire virtual file into a shared byte buffer (cached for hot archive entries)
  std::shared_ptr<std::vector<uint8_t>> readFile(const std::string& normVPath);

  // Open a real host path if backed by persistent `<gameDir>/Save`, else empty
  bool isPersistentSavePath(const std::string& normVPath, std::string& outHostPath) const;

  // Writable overlay operations (for working `/Save/*` and runtime temp files like `Game.ini.wolfx`)
  bool writeMemFile(const std::string& normVPath, const uint8_t* data, size_t len);
  bool ensureDir(const std::string& normVPath);
  bool removePath(const std::string& normVPath, bool isDirFlag);
  bool renamePath(const std::string& oldNormVPath, const std::string& newNormVPath);

  int indexedArchiveFiles() const { return indexedFilesCount_; }
  int ftpSafeAliases() const { return ftpSafeAliasCount_; }

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  int indexedFilesCount_ = 0;
  int ftpSafeAliasCount_ = 0;
};

uint64_t fnv1a64(const std::string& s);

} // namespace wolf
