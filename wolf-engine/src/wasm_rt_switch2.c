#include "wasm-rt.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WASM_PAGE_SIZE 65536ULL
/* Pre-reserve a contiguous 512 MiB arena (8192 Wasm pages) so memory.grow never
 * relocates mem->data during active C++/GL/FS host calls on Switch 2. */
#define SWITCH2_MAX_WASM_PAGES 8192ULL

static bool g_wasm_rt_inited = false;

/* Optional host trap hook implemented in main.cpp */
extern void wolf_on_wasm_trap(wasm_rt_trap_t code);

void wasm_rt_init(void) {
  g_wasm_rt_inited = true;
}

bool wasm_rt_is_initialized(void) {
  return g_wasm_rt_inited;
}

void wasm_rt_free(void) {
  g_wasm_rt_inited = false;
}

void wasm_rt_init_thread(void) {}
void wasm_rt_free_thread(void) {}

const char* wasm_rt_strerror(wasm_rt_trap_t trap) {
  switch (trap) {
    case WASM_RT_TRAP_NONE: return "No error";
    case WASM_RT_TRAP_OOB: return "Out-of-bounds access in linear memory or table";
    case WASM_RT_TRAP_INT_OVERFLOW: return "Integer overflow";
    case WASM_RT_TRAP_DIV_BY_ZERO: return "Integer divide by zero";
    case WASM_RT_TRAP_INVALID_CONVERSION: return "Invalid float-to-int conversion";
    case WASM_RT_TRAP_UNREACHABLE: return "Unreachable instruction executed";
    case WASM_RT_TRAP_CALL_INDIRECT: return "Invalid call_indirect";
    case WASM_RT_TRAP_UNCAUGHT_EXCEPTION: return "Uncaught Wasm exception";
    case WASM_RT_TRAP_UNALIGNED: return "Unaligned atomic access";
    case WASM_RT_TRAP_EXHAUSTION: return "Call stack exhausted";
  }
  return "Unknown trap";
}

WASM_RT_NO_RETURN void wasm_rt_trap(wasm_rt_trap_t code) {
  wolf_on_wasm_trap(code);
  abort();
}

void wasm_rt_allocate_memory(wasm_rt_memory_t* memory,
                             uint64_t initial_pages,
                             uint64_t max_pages,
                             bool is64) {
  uint64_t cap_pages = SWITCH2_MAX_WASM_PAGES;
  if (max_pages > 0 && max_pages < cap_pages) {
    cap_pages = max_pages;
  }
  if (initial_pages > cap_pages) {
    cap_pages = initial_pages;
  }
  uint64_t reserve_bytes = cap_pages * WASM_PAGE_SIZE;
  uint8_t* ptr = (uint8_t*)malloc((size_t)reserve_bytes);
  if (!ptr && cap_pages > 4096ULL && initial_pages <= 4096ULL) {
    /* Fallback to 256 MiB if running in tighter memory */
    cap_pages = 4096ULL;
    reserve_bytes = cap_pages * WASM_PAGE_SIZE;
    ptr = (uint8_t*)malloc((size_t)reserve_bytes);
  }
  if (!ptr) {
    abort();
  }
  uint64_t init_bytes = initial_pages * WASM_PAGE_SIZE;
  if (init_bytes > 0) {
    memset(ptr, 0, (size_t)init_bytes);
  }
  memory->data = ptr;
  memory->pages = initial_pages;
  memory->max_pages = cap_pages;
  memory->size = init_bytes;
  memory->is64 = is64;
}

uint64_t wasm_rt_grow_memory(wasm_rt_memory_t* memory, uint64_t delta) {
  uint64_t old_pages = memory->pages;
  if (delta == 0) {
    return old_pages;
  }
  uint64_t new_pages = old_pages + delta;
  if (new_pages < old_pages || new_pages > memory->max_pages) {
    return (uint64_t)UINT32_MAX;
  }
  uint64_t old_size = memory->size;
  uint64_t add_bytes = delta * WASM_PAGE_SIZE;
  memset(memory->data + old_size, 0, (size_t)add_bytes);
  memory->pages = new_pages;
  memory->size = old_size + add_bytes;
  return old_pages;
}

void wasm_rt_free_memory(wasm_rt_memory_t* memory) {
  if (memory->data) {
    free(memory->data);
    memory->data = NULL;
  }
  memory->pages = 0;
  memory->size = 0;
}

void wasm_rt_allocate_funcref_table(wasm_rt_funcref_table_t* table,
                                    uint32_t elements,
                                    uint32_t max_elements) {
  table->size = elements;
  table->max_size = max_elements;
  table->data = elements > 0
      ? (wasm_rt_funcref_t*)calloc(elements, sizeof(wasm_rt_funcref_t))
      : NULL;
}

void wasm_rt_free_funcref_table(wasm_rt_funcref_table_t* table) {
  free(table->data);
  table->data = NULL;
  table->size = 0;
}

uint32_t wasm_rt_grow_funcref_table(wasm_rt_funcref_table_t* table,
                                    uint32_t delta,
                                    wasm_rt_funcref_t init) {
  uint32_t old_elems = table->size;
  uint64_t new_elems = (uint64_t)old_elems + (uint64_t)delta;
  if (new_elems > table->max_size) {
    return UINT32_MAX;
  }
  if (delta == 0) {
    return old_elems;
  }
  wasm_rt_funcref_t* new_data = (wasm_rt_funcref_t*)realloc(
      table->data, (size_t)new_elems * sizeof(wasm_rt_funcref_t));
  if (!new_data) {
    return UINT32_MAX;
  }
  for (uint32_t i = old_elems; i < (uint32_t)new_elems; i++) {
    new_data[i] = init;
  }
  table->data = new_data;
  table->size = (uint32_t)new_elems;
  return old_elems;
}

void wasm_rt_allocate_externref_table(wasm_rt_externref_table_t* table,
                                      uint32_t elements,
                                      uint32_t max_elements) {
  table->size = elements;
  table->max_size = max_elements;
  table->data = elements > 0
      ? (wasm_rt_externref_t*)calloc(elements, sizeof(wasm_rt_externref_t))
      : NULL;
}

void wasm_rt_free_externref_table(wasm_rt_externref_table_t* table) {
  free(table->data);
  table->data = NULL;
  table->size = 0;
}

uint32_t wasm_rt_grow_externref_table(wasm_rt_externref_table_t* table,
                                      uint32_t delta,
                                      wasm_rt_externref_t init) {
  uint32_t old_elems = table->size;
  uint64_t new_elems = (uint64_t)old_elems + (uint64_t)delta;
  if (new_elems > table->max_size) {
    return UINT32_MAX;
  }
  if (delta == 0) {
    return old_elems;
  }
  wasm_rt_externref_t* new_data = (wasm_rt_externref_t*)realloc(
      table->data, (size_t)new_elems * sizeof(wasm_rt_externref_t));
  if (!new_data) {
    return UINT32_MAX;
  }
  for (uint32_t i = old_elems; i < (uint32_t)new_elems; i++) {
    new_data[i] = init;
  }
  table->data = new_data;
  table->size = (uint32_t)new_elems;
  return old_elems;
}
