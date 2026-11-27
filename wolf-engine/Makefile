#---------------------------------------------------------------------------------
# SW2RPGMGL — WOLF RPG Editor Companion Engine (Switch 2 / libounce + OunceVK)
#---------------------------------------------------------------------------------
.SUFFIXES:

ifeq ($(strip $(DEVKITPRO)),)
$(error "Please set DEVKITPRO in your environment. export DEVKITPRO=/opt/devkitpro")
endif

export PATH := $(DEVKITPRO)/portlibs/switch2/bin:$(DEVKITPRO)/portlibs/switch/bin:$(DEVKITPRO)/devkitA64/bin:$(DEVKITPRO)/tools/bin:$(PATH)

TOPDIR ?= $(CURDIR)
include $(DEVKITPRO)/libounce/switch2_rules

APP_TITLE   := SW2RPGMGL WOLF Engine
APP_AUTHOR  := Switch 2 RPG Maker Game Launcher
APP_VERSION := 0.3.2
APP_ICON    := ../loader/icon.jpg

TARGET      := wolf-engine-switch2
BUILD       := /var/tmp/wolf-sw2-build
WASM2C_DIR  ?= /var/tmp/wolf-sw2-gen
ROMFS_DIR   := romfs

CC          := aarch64-none-elf-gcc
CXX         := aarch64-none-elf-g++

ARCH        := $(SWITCH2_CPU) -mtp=soft -fPIE -ftls-model=local-exec

COMMON_INC  := -Iinclude \
               -I$(WASM2C_DIR) \
               -I$(DEVKITPRO)/portlibs/switch2/include \
               -I$(DEVKITPRO)/portlibs/switch/include \
               -I$(DEVKITPRO)/portlibs/switch/include/freetype2 \
               -isystem $(DEVKITPRO)/libounce/include

COMMON_DEFS := -D__SWITCH__ -D__SWITCH2__ -D_DEFAULT_SOURCE -DAL_LIBTYPE_STATIC -DSW2RPGMGL_VERSION=\"$(APP_VERSION)\"

# Host C/C++ flags (-O2)
CFLAGS_HOST := -O2 -Wall -ffunction-sections -fdata-sections $(ARCH) $(COMMON_DEFS) $(COMMON_INC)
CXXFLAGS    := -O2 -Wall -Wextra -Wno-unused-parameter -std=c++20 -pthread \
               -ffunction-sections -fdata-sections $(ARCH) $(COMMON_DEFS) $(COMMON_INC)

# Generated wasm2c shards (~15 MB C each): -O1 compiles ~5x faster than -O2 with full ARM64 speed
CFLAGS_W2C  := -std=gnu11 -O1 -w -fno-var-tracking -ffunction-sections -fdata-sections \
               $(ARCH) $(COMMON_DEFS) $(COMMON_INC)

LDFLAGS     := -specs=$(DEVKITPRO)/libounce/switch.specs $(ARCH) -pthread \
               -Wl,--gc-sections \
               -L$(DEVKITPRO)/portlibs/switch2/lib \
               -L$(DEVKITPRO)/portlibs/switch/lib \
               -L$(DEVKITPRO)/libounce/lib

LIBS        := -lEGL -lGLESv2 -lglapi -ldrm_nouveau \
               -lopenal -lSDL2 \
               -Wl,--start-group -lfreetype -lharfbuzz -Wl,--end-group \
               -lbz2 -lpng16 -lz -lm -lpthread -lnx

W2C_SHARDS  := 0 1 2 3 4 5 6 7
W2C_OBJS    := $(foreach n,$(W2C_SHARDS),$(BUILD)/woditor_wasm_$(n).o)
HOST_OBJS   := $(BUILD)/main.o $(BUILD)/wolf_archive.o $(BUILD)/wasm_rt_switch2.o
OBJS        := $(HOST_OBJS) $(W2C_OBJS)

.PHONY: all clean

all: $(BUILD)/$(TARGET).nro

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/main.o: src/main.cpp src/wolf_archive.h include/wasm-rt.h $(WASM2C_DIR)/woditor_wasm.h | $(BUILD)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/wolf_archive.o: src/wolf_archive.cpp src/wolf_archive.h include/sjis_table.h | $(BUILD)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/wasm_rt_switch2.o: src/wasm_rt_switch2.c include/wasm-rt.h | $(BUILD)
	$(CC) $(CFLAGS_HOST) -c $< -o $@

$(BUILD)/woditor_wasm_%.o: $(WASM2C_DIR)/woditor_wasm_%.c $(WASM2C_DIR)/woditor_wasm.h $(WASM2C_DIR)/woditor_wasm-impl.h include/wasm-rt.h | $(BUILD)
	$(CC) $(CFLAGS_W2C) -c $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJS)
	$(CXX) $(LDFLAGS) $(OBJS) $(LIBS) -o $@

$(BUILD)/$(TARGET).nacp: Makefile | $(BUILD)
	nacptool --create "$(APP_TITLE)" "$(APP_AUTHOR)" "$(APP_VERSION)" $@

$(BUILD)/$(TARGET).nro: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).nacp $(APP_ICON)
	elf2nro $< $@ --icon=$(APP_ICON) --nacp=$(BUILD)/$(TARGET).nacp --romfsdir=$(ROMFS_DIR)

clean:
	rm -rf $(BUILD)
