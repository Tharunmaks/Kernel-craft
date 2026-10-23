/* KernelCraft SDK: BGA framebuffer, back buffer, 2D primitives, text, cursor. */
#include "kc.h"

#define FONT ((const u8 *)0x6000)   /* 8x16 BIOS font copied by boot.asm */

int SCREEN_W, SCREEN_H;
static volatile u32 *lfb;
static surface screen;

/* -------------------------------------------------------- BGA / VBE DISPI --- */
#define VBE_INDEX 0x01CE
#define VBE_DATA 0x01CF
static void vbe_write(u16 index, u16 value) { outw(VBE_INDEX, index); outw(VBE_DATA, value); }

void gfx_init(int w, int h)
{
    u8 bus, dev, fn;
    uptr base = 0xE0000000u; /* v86 default */
    if (pci_find(0x1234, 0x1111, &bus, &dev, &fn)) base = pci_read(bus, dev, fn, 0x10) & 0xFFFFFFF0u;
    vbe_write(4, 0);          /* disable */
    vbe_write(1, (u16)w);
    vbe_write(2, (u16)h);
    vbe_write(3, 32);
    vbe_write(4, 0x41);       /* enable | linear framebuffer */
    lfb = (volatile u32 *)base;
    SCREEN_W = w;
    SCREEN_H = h;
    screen.pixels = kmalloc((size_t)w * h * sizeof(color));
    screen.width = screen.stride = w;
    screen.height = h;
    screen.clip = (rect){ 0, 0, w, h };
    memset(screen.pixels, 0, (size_t)w * h * sizeof(color));
    kc_log("gfx: %dx%dx32 framebuffer at %p", w, h, (void *)base);
}

surface *gfx_screen(void) { return &screen; }

/* ----------------------------------------------------------------- cursor --- */
#define CUR_W 12
#define CUR_H 19
static const char *cursor_shape[CUR_H] = {
    "X           ", "XX          ", "X.X         ", "X..X        ", "X...X       ",
    "X....X      ", "X.....X     ", "X......X    ", "X.......X   ", "X........X  ",
    "X.........X ", "X......XXXXX", "X...X..X    ", "X..XX..X    ", "X.X  X..X   ",
    "XX   X..X   ", "X     X..X  ", "      X..X  ", "       XX   ",
};
static color under[CUR_W * CUR_H];
static int cur_x = -100, cur_y = -100;
static bool cur_saved;

static void cursor_hide(void)
{
    if (!cur_saved) return;
    for (int j = 0; j < CUR_H; j++)
        for (int i = 0; i < CUR_W; i++) {
            int x = cur_x + i, y = cur_y + j;
            if (x < SCREEN_W && y < SCREEN_H) lfb[y * SCREEN_W + x] = under[j * CUR_W + i];
        }
    cur_saved = false;
}

static void cursor_show(void)
{
    for (int j = 0; j < CUR_H; j++)
        for (int i = 0; i < CUR_W; i++) {
            int x = cur_x + i, y = cur_y + j;
            if (x >= SCREEN_W || y >= SCREEN_H || x < 0 || y < 0) continue;
            under[j * CUR_W + i] = lfb[y * SCREEN_W + x];
            char c = cursor_shape[j][i];
            if (c == 'X') lfb[y * SCREEN_W + x] = 0x000000;
            else if (c == '.') lfb[y * SCREEN_W + x] = 0xFFFFFF;
        }
    cur_saved = true;
}

void gfx_move_cursor(int x, int y)
{
    if (!lfb) return;
    cursor_hide();
    cur_x = x;
    cur_y = y;
    cursor_show();
}

void gfx_present_rect(rect r)
{
    if (!lfb) return;
    int x0 = KC_MAX(r.x, 0), y0 = KC_MAX(r.y, 0);
    int x1 = KC_MIN(r.x + r.w, SCREEN_W), y1 = KC_MIN(r.y + r.h, SCREEN_H);
    if (x0 >= x1 || y0 >= y1) return;
    cursor_hide();
    for (int y = y0; y < y1; y++) {
        const color *src = screen.pixels + y * SCREEN_W + x0;
        volatile u32 *dst = lfb + y * SCREEN_W + x0;
        for (int x = x0; x < x1; x++) *dst++ = *src++;
    }
    cursor_show();
}

void gfx_present(void) { gfx_present_rect((rect){ 0, 0, SCREEN_W, SCREEN_H }); }

/* ------------------------------------------------------------- primitives --- */
bool rect_contains(rect r, int x, int y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }
bool rect_intersects(rect a, rect b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

color color_mix(color a, color b, u8 t)
{
    u32 ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
    u32 br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
    return RGB((ar * (255 - t) + br * t) / 255, (ag * (255 - t) + bg * t) / 255, (ab * (255 - t) + bb * t) / 255);
}

void draw_pixel(surface *s, int x, int y, color c)
{
    if (rect_contains(s->clip, x, y)) s->pixels[y * s->stride + x] = c;
}

void fill_rect(surface *s, int x, int y, int w, int h, color c)
{
    int x0 = KC_MAX(x, s->clip.x), y0 = KC_MAX(y, s->clip.y);
    int x1 = KC_MIN(x + w, s->clip.x + s->clip.w), y1 = KC_MIN(y + h, s->clip.y + s->clip.h);
    for (int j = y0; j < y1; j++) {
        color *p = s->pixels + j * s->stride + x0;
        for (int i = x0; i < x1; i++) *p++ = c;
    }
}

void fill_rect_alpha(surface *s, int x, int y, int w, int h, color c, u8 alpha)
{
    int x0 = KC_MAX(x, s->clip.x), y0 = KC_MAX(y, s->clip.y);
    int x1 = KC_MIN(x + w, s->clip.x + s->clip.w), y1 = KC_MIN(y + h, s->clip.y + s->clip.h);
    for (int j = y0; j < y1; j++) {
        color *p = s->pixels + j * s->stride + x0;
        for (int i = x0; i < x1; i++, p++) *p = color_mix(*p, c, alpha);
    }
}

void draw_rect(surface *s, int x, int y, int w, int h, color c)
{
    fill_rect(s, x, y, w, 1, c);
    fill_rect(s, x, y + h - 1, w, 1, c);
    fill_rect(s, x, y, 1, h, c);
    fill_rect(s, x + w - 1, y, 1, h, c);
}

void fill_round_rect(surface *s, int x, int y, int w, int h, int r, color c)
{
    r = KC_MIN(r, KC_MIN(w, h) / 2);
    if (r <= 0) { fill_rect(s, x, y, w, h, c); return; }
    fill_rect(s, x, y + r, w, h - 2 * r, c);
    for (int j = 0; j < r; j++) {
        int dy = r - j;
        int dx = 0;
        while ((dx + 1) * (dx + 1) + dy * dy <= r * r) dx++;
        int inset = r - dx;
        fill_rect(s, x + inset, y + j, w - 2 * inset, 1, c);
        fill_rect(s, x + inset, y + h - 1 - j, w - 2 * inset, 1, c);
    }
}

void draw_line(surface *s, int x0, int y0, int x1, int y1, color c)
{
    int dx = x1 > x0 ? x1 - x0 : x0 - x1, sx = x0 < x1 ? 1 : -1;
    int dy = y1 > y0 ? y0 - y1 : y1 - y0, sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        draw_pixel(s, x0, y0, c);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

void draw_circle(surface *s, int cx, int cy, int r, color c, bool filled)
{
    for (int y = -r; y <= r; y++)
        for (int x = -r; x <= r; x++) {
            int d = x * x + y * y;
            if (filled ? d <= r * r : (d <= r * r && d >= (r - 1) * (r - 1))) draw_pixel(s, cx + x, cy + y, c);
        }
}

void fill_gradient_v(surface *s, int x, int y, int w, int h, color top, color bottom)
{
    for (int j = 0; j < h; j++) fill_rect(s, x, y + j, w, 1, color_mix(top, bottom, (u8)(j * 255 / KC_MAX(h - 1, 1))));
}

void blit(surface *dst, int x, int y, const color *src, int w, int h, int src_stride)
{
    for (int j = 0; j < h; j++) {
        int dy = y + j;
        if (dy < dst->clip.y || dy >= dst->clip.y + dst->clip.h) continue;
        for (int i = 0; i < w; i++) {
            int dx = x + i;
            if (dx >= dst->clip.x && dx < dst->clip.x + dst->clip.w) dst->pixels[dy * dst->stride + dx] = src[j * src_stride + i];
        }
    }
}

/* ------------------------------------------------------------------- text --- */
void draw_char(surface *s, int x, int y, char ch, color c)
{
    const u8 *g = FONT + (u8)ch * FONT_H;
    for (int row = 0; row < FONT_H; row++) {
        u8 bits = g[row];
        if (!bits) continue;
        for (int col = 0; col < FONT_W; col++)
            if (bits & (0x80 >> col)) draw_pixel(s, x + col, y + row, c);
    }
}

int draw_text(surface *s, int x, int y, const char *text, color c)
{
    for (; *text; text++, x += FONT_W) draw_char(s, x, y, *text, c);
    return x;
}

void draw_text_scaled(surface *s, int x, int y, const char *text, color c, int scale)
{
    for (; *text; text++, x += FONT_W * scale) {
        const u8 *g = FONT + (u8)*text * FONT_H;
        for (int row = 0; row < FONT_H; row++)
            for (int col = 0; col < FONT_W; col++)
                if (g[row] & (0x80 >> col)) fill_rect(s, x + col * scale, y + row * scale, scale, scale, c);
    }
}

int text_width(const char *text) { return (int)strlen(text) * FONT_W; }
