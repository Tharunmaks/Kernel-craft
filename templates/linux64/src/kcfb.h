/* KernelCraft Linux Forge: tiny /dev/fb0 helper for pixel graphics.
 * Usage: kcfb fb; if (kcfb_open(&fb) == 0) { kcfb_fill(&fb, 0,0,fb.w,fb.h, 0x102040); kcfb_close(&fb); } */
#ifndef KCFB_H
#define KCFB_H
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

typedef struct { int fd, w, h, bpp, stride; uint8_t *mem; size_t size; } kcfb;

static inline int kcfb_open(kcfb *fb)
{
    struct fb_var_screeninfo v;
    struct fb_fix_screeninfo f;
    fb->fd = open("/dev/fb0", O_RDWR);
    if (fb->fd < 0) return -1;
    if (ioctl(fb->fd, FBIOGET_VSCREENINFO, &v) || ioctl(fb->fd, FBIOGET_FSCREENINFO, &f)) { close(fb->fd); return -1; }
    fb->w = v.xres; fb->h = v.yres; fb->bpp = v.bits_per_pixel; fb->stride = f.line_length;
    fb->size = (size_t)f.line_length * v.yres;
    fb->mem = mmap(0, fb->size, PROT_READ | PROT_WRITE, MAP_SHARED, fb->fd, 0);
    if (fb->mem == MAP_FAILED) { close(fb->fd); return -1; }
    return 0;
}

static inline void kcfb_pixel(kcfb *fb, int x, int y, uint32_t rgb)
{
    if (x < 0 || y < 0 || x >= fb->w || y >= fb->h) return;
    uint8_t *p = fb->mem + y * fb->stride + x * (fb->bpp / 8);
    p[0] = rgb & 0xFF; p[1] = (rgb >> 8) & 0xFF; p[2] = (rgb >> 16) & 0xFF;
    if (fb->bpp == 32) p[3] = 0;
}

static inline void kcfb_fill(kcfb *fb, int x, int y, int w, int h, uint32_t rgb)
{
    for (int j = y; j < y + h; j++) for (int i = x; i < x + w; i++) kcfb_pixel(fb, i, j, rgb);
}

static inline uint32_t kcfb_mix(uint32_t a, uint32_t b, int t) /* t: 0..255 */
{
    int r = (((a >> 16) & 255) * (255 - t) + ((b >> 16) & 255) * t) / 255;
    int g = (((a >> 8) & 255) * (255 - t) + ((b >> 8) & 255) * t) / 255;
    int bl = ((a & 255) * (255 - t) + (b & 255) * t) / 255;
    return (uint32_t)(r << 16 | g << 8 | bl);
}

static inline void kcfb_close(kcfb *fb) { munmap(fb->mem, fb->size); close(fb->fd); }
#endif
