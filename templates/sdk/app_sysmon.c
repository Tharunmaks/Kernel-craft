/* KernelCraft SDK app: System Monitor: hardware summary plus live timer and memory graphs. */
#include "kc.h"

#define SAMPLES 60
typedef struct { u8 mem[SAMPLES]; u8 load[SAMPLES]; int n; u64 last_ticks; u32 last_ms; } mon_state;

static void graph(surface *s, int x, int y, int w, int h, const u8 *v, int n, color c, const char *label)
{
    fill_round_rect(s, x, y, w, h, 6, RGB(20, 26, 40));
    draw_text(s, x + 8, y + 6, label, RGB(200, 210, 230));
    int gx = x + 8, gy = y + 28, gw = w - 16, gh = h - 36;
    for (int i = 0; i < 4; i++) fill_rect(s, gx, gy + i * gh / 4, gw, 1, RGB(40, 48, 66));
    for (int i = 1; i < n; i++) {
        int x0 = gx + (i - 1) * gw / (SAMPLES - 1), x1 = gx + i * gw / (SAMPLES - 1);
        draw_line(s, x0, gy + gh - v[i - 1] * gh / 100, x1, gy + gh - v[i] * gh / 100, c);
    }
}

static void paint(kc_window *w, surface *s)
{
    mon_state *m = w->state;
    fill_rect(s, 0, 0, s->width, s->height, RGB(12, 16, 26));
    char line[128], brand[48];
    cpu_brand(brand, sizeof brand);
    fill_round_rect(s, 12, 10, s->width - 24, 96, 6, RGB(20, 26, 40));
    draw_text(s, 24, 18, "Hardware", theme.accent);
    kc_snprintf(line, sizeof line, "CPU       %s, %d core%s (%s)", brand, cpu_count(), cpu_count() == 1 ? "" : "s", kc_arch_name());
    draw_text(s, 24, 38, line, RGB(230, 236, 250));
    kc_snprintf(line, sizeof line, "Memory    %u MB RAM, heap %u / %u KB used", (u32)((mem_total() >> 20) + 2), (u32)(mem_used() >> 10), (u32)(mem_total() >> 10));
    draw_text(s, 24, 56, line, RGB(230, 236, 250));
    kc_snprintf(line, sizeof line, "Graphics  %s, %u MB VRAM, %dx%d 32-bit", gfx_adapter_name(), gfx_vram_kb() / 1024, SCREEN_W, SCREEN_H);
    draw_text(s, 24, 74, line, RGB(230, 236, 250));
    kc_snprintf(line, sizeof line, "%s  |  up %u s  |  %d windows  |  %d apps", theme.os_name, uptime_ms() / 1000, wm_window_count(), kc_app_count());
    draw_text(s, 12, 114, line, RGB(150, 160, 185));
    int gy = 138, gh = (s->height - gy - 20) / 2;
    graph(s, 12, gy, s->width - 24, gh, m->load, m->n, RGB(255, 180, 70), "CPU timer activity (ticks/s vs expected)");
    graph(s, 12, gy + gh + 8, s->width - 24, gh, m->mem, m->n, theme.accent, "Heap usage %");
}

static void on_event(kc_window *w, kc_event *ev)
{
    if (ev->type != EV_TICK) return;
    mon_state *m = w->state;
    u32 now = uptime_ms();
    u64 t = timer_ticks();
    u32 dt = now - m->last_ms;
    u32 load = dt ? (u32)((t - m->last_ticks) * 1000 * 100 / (dt * KC_TIMER_HZ)) : 100;
    m->last_ms = now;
    m->last_ticks = t;
    if (m->n == SAMPLES) { memmove(m->mem, m->mem + 1, SAMPLES - 1); memmove(m->load, m->load + 1, SAMPLES - 1); m->n--; }
    m->mem[m->n] = (u8)(mem_used() * 100 / KC_MAX(mem_total(), 1));
    m->load[m->n] = (u8)KC_MIN(load, 100);
    m->n++;
    wm_invalidate(w);
}

static void on_close(kc_window *w) { kfree(w->state); }

void sysmon_open(void)
{
    kc_window *w = wm_create("System Monitor", -1, -1, 600, 420);
    w->state = kcalloc(1, sizeof(mon_state));
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(sysmon, "Monitor", icon_chart, sysmon_open);
