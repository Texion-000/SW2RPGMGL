#!/usr/bin/env python3
"""
Apply minimal, idempotent Switch 2 (libounce + OunceVK + libkaihen) compatibility
patches to upstream/nx.js:
  1. skia_gpu.cc: On __SWITCH2__, if ES2 EGL config/context fails under OunceVK
     (Zink), automatically retry with EGL_OPENGL_ES3_BIT + ES3 context.
  2. main.cc: Allow an external override nxjs.ini next to the running NRO
     (`argv[0]` directory, e.g. `sdmc:/switch/switch2-MV-loader/nxjs.ini`) so
     users can toggle jit=off or renderer=cpu on SD card without rebuilding the NRO.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent / "upstream" / "nx.js"

def patch_skia_gpu():
    p = ROOT / "source" / "skia_gpu.cc"
    text = p.read_text(encoding="utf-8")
    marker = "// [switch2-ouncevk-es3-fallback]"
    if marker in text:
        print("[ok] skia_gpu.cc already patched")
        return

    old = """\tconst EGLint attrs[] = {EGL_RED_SIZE,   8, EGL_GREEN_SIZE,   8,
\t                        EGL_BLUE_SIZE,  8, EGL_ALPHA_SIZE,   8,
\t                        EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
\t                        EGL_NONE};
\teglChooseConfig(s_dpy, attrs, &cfg, 1, &num);
\tif (!num)
\t\treturn false;
\ts_surf = eglCreateWindowSurface(s_dpy, cfg, win, nullptr);
\tif (!s_surf)
\t\treturn false;
\tconst EGLint ca[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
\ts_ctx = eglCreateContext(s_dpy, cfg, EGL_NO_CONTEXT, ca);
\tif (!s_ctx)
\t\treturn false;"""

    new = """\t// [switch2-ouncevk-es3-fallback]
\tconst EGLint attrs[] = {EGL_RED_SIZE,   8, EGL_GREEN_SIZE,   8,
\t                        EGL_BLUE_SIZE,  8, EGL_ALPHA_SIZE,   8,
\t                        EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
\t                        EGL_NONE};
\teglChooseConfig(s_dpy, attrs, &cfg, 1, &num);
#if defined(__SWITCH2__)
\tif (!num) {
\t\tconst EGLint attrs_es3[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
\t\t                            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
\t\t                            EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
\t\t                            EGL_NONE};
\t\teglChooseConfig(s_dpy, attrs_es3, &cfg, 1, &num);
\t}
#endif
\tif (!num)
\t\treturn false;
\ts_surf = eglCreateWindowSurface(s_dpy, cfg, win, nullptr);
\tif (!s_surf)
\t\treturn false;
\tconst EGLint ca2[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
\ts_ctx = eglCreateContext(s_dpy, cfg, EGL_NO_CONTEXT, ca2);
#if defined(__SWITCH2__)
\tif (!s_ctx) {
\t\tconst EGLint ca3[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
\t\ts_ctx = eglCreateContext(s_dpy, cfg, EGL_NO_CONTEXT, ca3);
\t}
#endif
\tif (!s_ctx)
\t\treturn false;"""

    # Handle CRLF vs LF cleanly
    norm = text.replace("\r\n", "\n")
    if old not in norm:
        print("[warn] skia_gpu.cc pattern not found — skipping (check upstream changes)", file=sys.stderr)
        return
    p.write_text(norm.replace(old, new, 1), encoding="utf-8", newline="\n")
    print("[patched] skia_gpu.cc")

def patch_main_cc():
    p = ROOT / "source" / "main.cc"
    text = p.read_text(encoding="utf-8")
    marker = "// [switch2-sd-nxjs-ini-override]"
    if marker in text:
        print("[ok] main.cc already patched")
        return

    old = """\tnx_config_defaults(&nx_ctx->config);
\tif (user_code_path) {
\t\tchar *ini_path = nx_config_ini_path_for(user_code_path);
\t\tif (ini_path) {
\t\t\tnx_config_load(&nx_ctx->config, ini_path);
\t\t\tfree(ini_path);
\t\t}
\t}"""

    new = """\tnx_config_defaults(&nx_ctx->config);
\tif (user_code_path) {
\t\tchar *ini_path = nx_config_ini_path_for(user_code_path);
\t\tif (ini_path) {
\t\t\tnx_config_load(&nx_ctx->config, ini_path);
\t\t\tfree(ini_path);
\t\t}
\t}
\t// [switch2-sd-nxjs-ini-override]
\t// Allow SD-card overrides (e.g. jit=off or renderer=cpu) next to the running NRO without rebuilding.
\tif (argc > 0 && argv[0] && argv[0][0]) {
\t\tchar *nro_ini = nx_config_ini_path_for(argv[0]);
\t\tif (nro_ini) {
\t\t\tnx_config_load(&nx_ctx->config, nro_ini);
\t\t\tfree(nro_ini);
\t\t}
\t}
\tnx_config_load(&nx_ctx->config, "sdmc:/switch/switch2-MV-loader/nxjs.ini");"""

    norm = text.replace("\r\n", "\n")
    if old not in norm:
        print("[warn] main.cc pattern not found — skipping", file=sys.stderr)
        return
    p.write_text(norm.replace(old, new, 1), encoding="utf-8", newline="\n")
    print("[patched] main.cc")

def patch_main_boot_logs():
    p = ROOT / "source" / "main.cc"
    text = p.read_text(encoding="utf-8")
    marker = "// [switch2-boot-milestones]"
    if marker in text:
        print("[ok] main.cc boot milestones already patched")
        return

    norm = text.replace("\r\n", "\n")
    old1 = "\tIsolate *iso = Isolate::New(create_params);"
    new1 = (
        "\t// [switch2-boot-milestones]\n"
        "\tfprintf(stderr, \"[boot] calling Isolate::New...\\n\"); fflush(stderr);\n"
        "\tIsolate *iso = Isolate::New(create_params);\n"
        "\tfprintf(stderr, \"[boot] Isolate::New OK (%p)\\n\", (void *)iso); fflush(stderr);"
    )
    old2 = "\t\t\tif (!run_script(iso, context,"
    new2 = (
        "\t\t\tfprintf(stderr, \"[boot] evaluating runtime.js (%u bytes)...\\n\", nxjs_runtime_js_len); fflush(stderr);\n"
        "\t\t\tif (!run_script(iso, context,"
    )
    old3 = "\t\t\t\tnx_run_entry_module(iso, context, user_code, user_code_size,"
    new3 = (
        "\t\t\t\tfprintf(stderr, \"[boot] runtime.js OK; running entry %s (%zu bytes)...\\n\", user_code_path, user_code_size); fflush(stderr);\n"
        "\t\t\t\tnx_run_entry_module(iso, context, user_code, user_code_size,"
    )
    if old1 not in norm or old2 not in norm or old3 not in norm:
        print("[warn] main.cc boot milestone patterns not found — skipping", file=sys.stderr)
        return
    norm = norm.replace(old1, new1, 1).replace(old2, new2, 1).replace(old3, new3, 1)
    p.write_text(norm, encoding="utf-8", newline="\n")
    print("[patched] main.cc boot milestones")

def patch_main_switch2_gsv():
    """
    On Switch 2 (libounce + OunceVK), the process GSV root only allows ONE
    gsvOpenNvServices delegation (see libounce default_window.c:336-350).
    Skip Switch 1's early nvInitialize() hack and eager consoleInit() before
    runtime.js so OunceVK (NVK + Zink) gets a clean first-use GSV root & NWindow.
    """
    p = ROOT / "source" / "main.cc"
    text = p.read_text(encoding="utf-8")
    marker = "// [switch2-clean-gsv-root]"
    if marker in text:
        print("[ok] main.cc Switch 2 GSV fix already patched")
        return

    norm = text.replace("\r\n", "\n")

    old_nv = """\t{
\t\tResult nvrc = nvInitialize();
\t\tif (R_SUCCEEDED(nvrc)) {
\t\t\tg_nv_early_ref = true;
\t\t} else {
\t\t\tfprintf(stderr, "[fb] early nvInitialize failed: 0x%x\\n", nvrc);
\t\t\tfflush(stderr);
\t\t}
\t}"""
    new_nv = """\t// [switch2-clean-gsv-root]
#if !defined(__SWITCH2__)
\t{
\t\tResult nvrc = nvInitialize();
\t\tif (R_SUCCEEDED(nvrc)) {
\t\t\tg_nv_early_ref = true;
\t\t} else {
\t\t\tfprintf(stderr, "[fb] early nvInitialize failed: 0x%x\\n", nvrc);
\t\t\tfflush(stderr);
\t\t}
\t}
#endif"""

    old_console_exit = """void nx_console_exit() {
\tif (print_console != NULL) {
\t\tconsoleExit(print_console);
\t\tprint_console = NULL;
\t}
}"""
    new_console_exit = """void nx_console_exit() {
\tif (print_console != NULL) {
\t\tconsoleExit(print_console);
\t\tprint_console = NULL;
#if defined(__SWITCH2__)
\t\tnwindowReleaseVi2Layer(nwindowGetDefault());
#endif
\t}
}"""

    old_eager_console = """\t\t\tnx_console_init(nx_ctx);
\t\t\tfprintf(stderr, "[boot] evaluating runtime.js"""
    new_eager_console = """#if !defined(__SWITCH2__)
\t\t\tnx_console_init(nx_ctx);
#endif
\t\t\tfprintf(stderr, "[boot] evaluating runtime.js"""

    if old_nv not in norm or old_console_exit not in norm or old_eager_console not in norm:
        print("[warn] main.cc GSV patterns not found — skipping", file=sys.stderr)
        return
    norm = (norm
            .replace(old_nv, new_nv, 1)
            .replace(old_console_exit, new_console_exit, 1)
            .replace(old_eager_console, new_eager_console, 1))
    p.write_text(norm, encoding="utf-8", newline="\n")
    print("[patched] main.cc Switch 2 GSV root fix")

def patch_webgl_cc():
    p = ROOT / "source" / "webgl.cc"
    text = p.read_text(encoding="utf-8")
    marker = "// [switch2-ouncevk-getinternalformativ]"
    if marker in text:
        print("[ok] webgl.cc already patched")
        return

    old = """\tGLint count = 0;
\tglGetInternalformativ(target, internalformat, GL_NUM_SAMPLE_COUNTS, 1,
\t                      &count);
\tstd::vector<GLint> samples((size_t)count);
\tif (count > 0)
\t\tglGetInternalformativ(target, internalformat, GL_SAMPLES, count,
\t\t                      samples.data());"""

    new = """\t// [switch2-ouncevk-getinternalformativ]
\t// Resolve glGetInternalformativ dynamically under OunceVK so static linking succeeds.
\ttypedef void (*PFN_glGetInternalformativ)(GLenum, GLenum, GLenum, GLsizei, GLint *);
\tauto fnGetInternalformativ = (PFN_glGetInternalformativ)eglGetProcAddress("glGetInternalformativ");
\tGLint count = 0;
\tif (fnGetInternalformativ)
\t\tfnGetInternalformativ(target, internalformat, GL_NUM_SAMPLE_COUNTS, 1, &count);
\tstd::vector<GLint> samples((size_t)count);
\tif (count > 0 && fnGetInternalformativ)
\t\tfnGetInternalformativ(target, internalformat, GL_SAMPLES, count, samples.data());"""

    norm = text.replace("\r\n", "\n")
    if old not in norm:
        print("[warn] webgl.cc pattern not found — skipping", file=sys.stderr)
        return
    p.write_text(norm.replace(old, new, 1), encoding="utf-8", newline="\n")
    print("[patched] webgl.cc")

def patch_image_cc():
    """
    Fix libpng color-type conversion in upstream/nx.js/source/image.cc so palette+tRNS,
    grayscale, grayscale+alpha, and 16-bit PNGs decode cleanly into premultiplied BGRA8.
    """
    p = ROOT / "source" / "image.cc"
    text = p.read_text(encoding="utf-8")
    marker = "// [switch2-png-full-color-convert]"
    if marker in text:
        print("[ok] image.cc already patched")
        return

    old = """\tpng_set_bgr(png_ptr);
\tpng_set_expand(png_ptr);
\tbool has_alpha =
\t    png_get_color_type(png_ptr, info_ptr) == PNG_COLOR_TYPE_RGBA;
\tif (!has_alpha)
\t\tpng_set_add_alpha(png_ptr, 0xff, PNG_FILLER_AFTER);"""

    new = """\t// [switch2-png-full-color-convert]
\tpng_byte color_type = png_get_color_type(png_ptr, info_ptr);
\tpng_byte bit_depth = png_get_bit_depth(png_ptr, info_ptr);
\tif (bit_depth == 16)
\t\tpng_set_strip_16(png_ptr);
\tif (color_type == PNG_COLOR_TYPE_PALETTE)
\t\tpng_set_palette_to_rgb(png_ptr);
\tif (color_type == PNG_COLOR_TYPE_GRAY && bit_depth < 8)
\t\tpng_set_expand_gray_1_2_4_to_8(png_ptr);
\tif (png_get_valid(png_ptr, info_ptr, PNG_INFO_tRNS))
\t\tpng_set_tRNS_to_alpha(png_ptr);
\tif (color_type == PNG_COLOR_TYPE_GRAY || color_type == PNG_COLOR_TYPE_GRAY_ALPHA)
\t\tpng_set_gray_to_rgb(png_ptr);
\tpng_set_bgr(png_ptr);
\tbool has_alpha =
\t    (color_type & PNG_COLOR_MASK_ALPHA) != 0 ||
\t    png_get_valid(png_ptr, info_ptr, PNG_INFO_tRNS) != 0;
\tif (!has_alpha)
\t\tpng_set_add_alpha(png_ptr, 0xff, PNG_FILLER_AFTER);
\tpng_read_update_info(png_ptr, info_ptr);"""

    norm = text.replace("\r\n", "\n")
    if old not in norm:
        print("[warn] image.cc pattern not found — skipping", file=sys.stderr)
        return
    p.write_text(norm.replace(old, new, 1), encoding="utf-8", newline="\n")
    print("[patched] image.cc")


def patch_image_avif():
    """Add native libavif + dav1d AVIF image decoding to nx.js (source/image.h & source/image.cc)."""
    h_path = ROOT / "source" / "image.h"
    h_text = h_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    if "FORMAT_AVIF" not in h_text:
        h_text = h_text.replace(
            "enum ImageFormat { FORMAT_PNG, FORMAT_JPEG, FORMAT_WEBP, FORMAT_UNKNOWN };",
            "enum ImageFormat { FORMAT_PNG, FORMAT_JPEG, FORMAT_WEBP, FORMAT_AVIF, FORMAT_UNKNOWN };",
            1,
        )
        h_path.write_text(h_text, encoding="utf-8", newline="\n")
        print("[patched] image.h (FORMAT_AVIF)")

    c_path = ROOT / "source" / "image.cc"
    c_text = c_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    if "decode_avif" not in c_text:
        c_text = c_text.replace("#include <png.h>", "#include <avif/avif.h>\n#include <png.h>", 1)
        c_text = c_text.replace(
            '\tif (size >= 12 && !memcmp(data, "RIFF", 4) && !memcmp(data + 8, "WEBP", 4))\n'
            '\t\treturn FORMAT_WEBP;\n'
            '\treturn FORMAT_UNKNOWN;',
            '\tif (size >= 12 && !memcmp(data, "RIFF", 4) && !memcmp(data + 8, "WEBP", 4))\n'
            '\t\treturn FORMAT_WEBP;\n'
            '\tif (size >= 12) {\n'
            '\t\tavifROData ro = { data, size };\n'
            '\t\tif (avifPeekCompatibleFileType(&ro))\n'
            '\t\t\treturn FORMAT_AVIF;\n'
            '\t}\n'
            '\treturn FORMAT_UNKNOWN;',
            1,
        )
        c_text = c_text.replace(
            '\tpremultiply_alpha(bgra_data, *width, *height);\n'
            '\treturn bgra_data;\n'
            '}',
            '\tpremultiply_alpha(bgra_data, *width, *height);\n'
            '\treturn bgra_data;\n'
            '}\n\n'
            'uint8_t *decode_avif(uint8_t *avif_data, size_t data_size, u32 *width,\n'
            '                     u32 *height) {\n'
            '\tavifDecoder *decoder = avifDecoderCreate();\n'
            '\tif (!decoder)\n'
            '\t\treturn NULL;\n'
            '\tdecoder->maxThreads = 2;\n'
            '\tdecoder->strictFlags = AVIF_STRICT_DISABLED;\n'
            '\tif (avifDecoderSetIOMemory(decoder, avif_data, data_size) != AVIF_RESULT_OK ||\n'
            '\t    avifDecoderParse(decoder) != AVIF_RESULT_OK ||\n'
            '\t    avifDecoderNextImage(decoder) != AVIF_RESULT_OK) {\n'
            '\t\tavifDecoderDestroy(decoder);\n'
            '\t\treturn NULL;\n'
            '\t}\n'
            '\tavifImage *img = decoder->image;\n'
            '\tif (!img || img->width == 0 || img->height == 0 ||\n'
            '\t    img->width > 16384 || img->height > 16384 ||\n'
            '\t    (size_t)img->width > SIZE_MAX / 4 / (size_t)img->height) {\n'
            '\t\tavifDecoderDestroy(decoder);\n'
            '\t\treturn NULL;\n'
            '\t}\n'
            '\t*width = img->width;\n'
            '\t*height = img->height;\n'
            '\tsize_t stride = (size_t)(*width) * 4;\n'
            '\tuint8_t *bgra_data = (uint8_t *)malloc(stride * (size_t)(*height));\n'
            '\tif (!bgra_data) {\n'
            '\t\tavifDecoderDestroy(decoder);\n'
            '\t\treturn NULL;\n'
            '\t}\n'
            '\tavifRGBImage rgb;\n'
            '\tavifRGBImageSetDefaults(&rgb, img);\n'
            '\trgb.format = AVIF_RGB_FORMAT_BGRA;\n'
            '\trgb.depth = 8;\n'
            '\trgb.alphaPremultiplied = AVIF_TRUE;\n'
            '\trgb.pixels = bgra_data;\n'
            '\trgb.rowBytes = (uint32_t)stride;\n'
            '\tif (avifImageYUVToRGB(img, &rgb) != AVIF_RESULT_OK) {\n'
            '\t\tfree(bgra_data);\n'
            '\t\tavifDecoderDestroy(decoder);\n'
            '\t\treturn NULL;\n'
            '\t}\n'
            '\tavifDecoderDestroy(decoder);\n'
            '\treturn bgra_data;\n'
            '}',
            1,
        )
        c_text = c_text.replace(
            '\t} else if (data->image->format == FORMAT_WEBP) {\n'
            '\t\tdata->image->data = decode_webp(data->input, data->input_size,\n'
            '\t\t                                (int *)&data->image->width,\n'
            '\t\t                                (int *)&data->image->height);\n'
            '\t} else {',
            '\t} else if (data->image->format == FORMAT_WEBP) {\n'
            '\t\tdata->image->data = decode_webp(data->input, data->input_size,\n'
            '\t\t                                (int *)&data->image->width,\n'
            '\t\t                                (int *)&data->image->height);\n'
            '\t} else if (data->image->format == FORMAT_AVIF) {\n'
            '\t\tdata->image->data = decode_avif(data->input, data->input_size,\n'
            '\t\t                                &data->image->width,\n'
            '\t\t                                &data->image->height);\n'
            '\t} else {',
            1,
        )
        c_path.write_text(c_text, encoding="utf-8", newline="\n")
        print("[patched] image.cc (libavif)")


if __name__ == "__main__":
    patch_skia_gpu()
    patch_main_cc()
    patch_main_boot_logs()
    patch_main_switch2_gsv()
    patch_webgl_cc()
    patch_image_cc()
    patch_image_avif()
