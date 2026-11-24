#---------------------------------------------------------------------------------
# SW2RPGMGL — Switch 2 RPG Maker Game Launcher (Native C++ / libounce) Makefile
#---------------------------------------------------------------------------------
.SUFFIXES:

ifeq ($(strip $(DEVKITPRO)),)
$(error "Please set DEVKITPRO in your environment. export DEVKITPRO=/opt/devkitpro")
endif

export PATH := $(DEVKITPRO)/portlibs/switch2/bin:$(DEVKITPRO)/portlibs/switch/bin:$(DEVKITPRO)/devkitA64/bin:$(DEVKITPRO)/tools/bin:$(PATH)

TOPDIR ?= $(CURDIR)
include $(DEVKITPRO)/libounce/switch2_rules

APP_TITLE   := SW2RPGMGL
APP_AUTHOR  := Switch 2 RPG Maker Game Launcher
APP_VERSION := 0.3.1
APP_ICON    := ../loader/icon.jpg

TARGET      := SW2RPGMGL
BUILD       := build-switch2

CXX         := aarch64-none-elf-g++
OBJDUMP     := aarch64-none-elf-objdump

ARCH        := $(SWITCH2_CPU) -mtp=soft -fPIE -ftls-model=local-exec

CXXFLAGS    := -O2 -Wall -Wextra -std=c++20 -ffunction-sections -fdata-sections \
               $(ARCH) -D__SWITCH__ -D__SWITCH2__ -D_DEFAULT_SOURCE \
               -I$(DEVKITPRO)/portlibs/switch2/include \
               -I$(DEVKITPRO)/portlibs/switch/include \
               -I$(DEVKITPRO)/portlibs/switch/include/freetype2 \
               -isystem $(DEVKITPRO)/libounce/include

LDFLAGS     := -specs=$(DEVKITPRO)/libounce/switch.specs $(ARCH) \
               -Wl,--gc-sections \
               -L$(DEVKITPRO)/portlibs/switch2/lib \
               -L$(DEVKITPRO)/portlibs/switch/lib \
               -L$(DEVKITPRO)/libounce/lib

LIBS        := -lfreetype -lharfbuzz -lbz2 -lpng -ljpeg -lz -lm -lnx

SRCS        := src/main.cpp
OBJS        := $(BUILD)/main.o

.PHONY: all clean

all: $(BUILD)/$(TARGET).nro

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/main.o: src/main.cpp | $(BUILD)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/$(TARGET).elf: $(OBJS)
	$(CXX) $(LDFLAGS) $(OBJS) $(LIBS) -o $@

$(BUILD)/$(TARGET).nacp: Makefile | $(BUILD)
	nacptool --create "$(APP_TITLE)" "$(APP_AUTHOR)" "$(APP_VERSION)" $@

$(BUILD)/$(TARGET).nro: $(BUILD)/$(TARGET).elf $(BUILD)/$(TARGET).nacp $(APP_ICON)
	elf2nro $< $@ --icon=$(APP_ICON) --nacp=$(BUILD)/$(TARGET).nacp

clean:
	rm -rf $(BUILD)
