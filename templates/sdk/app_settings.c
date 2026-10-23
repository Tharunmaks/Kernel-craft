/* KernelCraft SDK app: Settings (accent colour and wallpaper presets). */
#include "kc.h"

typedef struct { const char *name; color top, bottom, accent, title; } preset;
static const preset presets[] = {
    { "Midnight", RGB(18, 32, 74), RGB(6, 10, 26), RGB(52, 211, 255), RGB(30, 64, 140) },
    { "Aurora", RGB(10, 60, 60), RGB(4, 16, 30), RGB(80, 240, 160), RGB(16, 100, 90) },
    { "Sunset", RGB(120, 40, 70), RGB(30, 10, 30), RGB(255, 170, 80), RGB(150, 50, 80) },
    { "Violet", RGB(60, 30, 110), RGB(14, 8, 34), RGB(200, 140, 255), RGB(90, 50, 160) },
    { "Graphite", RGB(60, 64, 72), RGB(18, 20, 24), RGB(240, 240, 240), RGB(50, 54, 62) },
};

static void paint(kc_window *w, surface *s)
{
    (void)w;
    draw_text(s, 16, 12, "Theme", theme.window_text);
    for (int i = 0; i < (int)KC_ARRAY_LEN(presets); i++) {
        int x = 16 + i * 92, y = 40;
        fill_gradient_v(s, x, y, 80, 60, presets[i].top, presets[i].bottom);
        fill_rect(s, x, y + 50, 80, 10, presets[i].accent);
        if (presets[i].accent == theme.accent) draw_rect(s, x - 3, y - 3, 86, 66, theme.window_text);
        draw_text(s, x, y + 68, presets[i].name, theme.window_text);
    }
    char info[128], brand[48];
    cpu_brand(brand, sizeof brand);
    draw_text(s, 16, 150, "About this computer", theme.window_text);
    kc_snprintf(info, sizeof info, "Display   %dx%d, 32-bit colour, %u MB graphics memory", SCREEN_W, SCREEN_H, gfx_vram_kb() / 1024);
    draw_text(s, 16, 172, info, RGB(100, 108, 125));
    kc_snprintf(info, sizeof info, "Processor %s x%d", brand, cpu_count());
    draw_text(s, 16, 190, info, RGB(100, 108, 125));
    kc_snprintf(info, sizeof info, "Memory    %u MB", (u32)((mem_total() >> 20) + 2));
    draw_text(s, 16, 208, info, RGB(100, 108, 125));
}

static void on_event(kc_window *w, kc_event *ev)
{
    if (ev->type != EV_MOUSE_DOWN || ev->y < 40 || ev->y > 100) return;
    int i = (ev->x - 16) / 92;
    if (i < 0 || i >= (int)KC_ARRAY_LEN(presets)) return;
    theme.desktop_top = presets[i].top;
    theme.desktop_bottom = presets[i].bottom;
    theme.accent = presets[i].accent;
    theme.title_active = presets[i].title;
    wm_rebuild_wallpaper();
    wm_invalidate_all();
    (void)w;
}

void settings_open(void)
{
    kc_window *w = wm_create("Settings", -1, -1, 490, 236);
    w->on_paint = paint;
    w->on_event = on_event;
}
KC_APP(settings, "Settings", icon_gear, settings_open);
