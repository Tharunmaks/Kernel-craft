/* KernelCraft app: Clock. Analog + digital clock from the RTC, today's
 * date, and a stopwatch with laps (Space start/stop, L lap, R reset). */
#include "kc.h"

/* sin(i * 6 degrees) * 1000 */
static const i16 SIN60[60] = { 0, 105, 208, 309, 407, 500, 588, 669, 743, 809, 866, 914, 951, 978, 995, 1000, 995, 978, 951, 914, 866, 809, 743, 669, 588, 500, 407, 309, 208, 105, 0, -105, -208, -309, -407, -500, -588, -669, -743, -809, -866, -914, -951, -978, -995, -1000, -995, -978, -951, -914, -866, -809, -743, -669, -588, -500, -407, -309, -208, -105 };
static int sin60(int i) { return SIN60[((i % 60) + 60) % 60]; }
static int cos60(int i) { return sin60(i + 15); }

static const char *months[12] = { "January", "February", "March", "April", "May", "June", "July",
                                  "August", "September", "October", "November", "December" };

typedef struct { bool running; u32 started, elapsed; u32 laps[5]; int nlaps; } clock_state;

static u32 sw_now(clock_state *c) { return c->elapsed + (c->running ? uptime_ms() - c->started : 0); }

static void hand(surface *s, int cx, int cy, int pos60, int len, int width, color col)
{
    int x = cx + sin60(pos60) * len / 1000, y = cy - cos60(pos60) * len / 1000;
    for (int d = -width / 2; d <= width / 2; d++) {
        draw_line(s, cx + d, cy, x + d, y, col);
        draw_line(s, cx, cy + d, x, y + d, col);
    }
}

static void fmt_ms(char *out, size_t cap, u32 ms)
{
    kc_snprintf(out, cap, "%02u:%02u.%u", ms / 60000, (ms / 1000) % 60, (ms / 100) % 10);
}

static rect btn(int i, int y) { return (rect){ 330 + i * 92, y, 84, 30 }; }

static void paint(kc_window *w, surface *s)
{
    clock_state *c = w->state;
    kc_time t;
    rtc_read(&t);
    fill_gradient_v(s, 0, 0, s->width, s->height, RGB(24, 30, 48), RGB(10, 12, 22));
    int cx = 160, cy = 160, r = 130;
    draw_circle(s, cx, cy, r + 6, theme.accent, true);
    draw_circle(s, cx, cy, r, RGB(248, 249, 252), true);
    for (int i = 0; i < 60; i++) {
        int inner = i % 5 ? r - 8 : r - 18;
        draw_line(s, cx + sin60(i) * inner / 1000, cy - cos60(i) * inner / 1000,
                  cx + sin60(i) * (r - 3) / 1000, cy - cos60(i) * (r - 3) / 1000, i % 5 ? RGB(150, 156, 170) : RGB(30, 34, 46));
    }
    for (int h = 1; h <= 12; h++) {
        char n[3];
        kc_snprintf(n, sizeof n, "%d", h);
        int nx = cx + sin60(h * 5) * (r - 34) / 1000, ny = cy - cos60(h * 5) * (r - 34) / 1000;
        draw_text(s, nx - text_width(n) / 2, ny - FONT_H / 2, n, RGB(30, 34, 46));
    }
    hand(s, cx, cy, (t.hour % 12) * 5 + t.min / 12, r - 60, 5, RGB(30, 34, 46));
    hand(s, cx, cy, t.min, r - 30, 3, RGB(30, 34, 46));
    hand(s, cx, cy, t.sec, r - 20, 1, RGB(230, 60, 60));
    draw_circle(s, cx, cy, 6, RGB(230, 60, 60), true);

    char buf[64];
    kc_snprintf(buf, sizeof buf, "%02d:%02d:%02d", t.hour, t.min, t.sec);
    draw_text_scaled(s, 330, 30, buf, RGB(240, 244, 255), 3);
    kc_snprintf(buf, sizeof buf, "%d %s %d", t.day, t.month >= 1 && t.month <= 12 ? months[t.month - 1] : "?", t.year);
    draw_text(s, 332, 86, buf, RGB(160, 170, 195));

    draw_text(s, 330, 130, "Stopwatch", theme.accent);
    fmt_ms(buf, sizeof buf, sw_now(c));
    draw_text_scaled(s, 330, 152, buf, RGB(240, 244, 255), 3);
    const char *labels[3] = { c->running ? "Stop" : "Start", "Lap", "Reset" };
    for (int i = 0; i < 3; i++) {
        rect b = btn(i, 206);
        fill_round_rect(s, b.x, b.y, b.w, b.h, 6, i == 0 ? theme.accent : RGB(54, 60, 78));
        draw_text(s, b.x + (b.w - text_width(labels[i])) / 2, b.y + 7, labels[i], i == 0 ? theme.accent_text : RGB(230, 234, 244));
    }
    for (int i = 0; i < c->nlaps; i++) {
        char lap[32];
        fmt_ms(buf, sizeof buf, c->laps[i]);
        kc_snprintf(lap, sizeof lap, "Lap %d   %s", i + 1, buf);
        draw_text(s, 332, 250 + i * 18, lap, RGB(170, 180, 205));
    }
}

static void press(kc_window *w, clock_state *c, int i)
{
    if (i == 0) {
        if (c->running) c->elapsed += uptime_ms() - c->started;
        else c->started = uptime_ms();
        c->running = !c->running;
    } else if (i == 1 && c->running) {
        if (c->nlaps == 5) { memmove(c->laps, c->laps + 1, sizeof(u32) * 4); c->nlaps--; }
        c->laps[c->nlaps++] = sw_now(c);
    } else if (i == 2) {
        memset(c, 0, sizeof *c);
    }
    w->tick_ms = c->running ? 100 : 500;
}

static void on_event(kc_window *w, kc_event *ev)
{
    clock_state *c = w->state;
    if (ev->type == EV_KEY) {
        if (ev->key == ' ') press(w, c, 0);
        else if (ev->key == 'l' || ev->key == 'L') press(w, c, 1);
        else if (ev->key == 'r' || ev->key == 'R') press(w, c, 2);
        else return;
    } else if (ev->type == EV_MOUSE_DOWN) {
        for (int i = 0; i < 3; i++) if (rect_contains(btn(i, 206), ev->x, ev->y)) press(w, c, i);
    } else if (ev->type != EV_TICK) return;
    wm_invalidate(w);
}

static void on_close(kc_window *w) { kfree(w->state); }

void clock_open(void)
{
    kc_window *w = wm_create("Clock", -1, -1, 620, 330);
    w->state = kcalloc(1, sizeof(clock_state));
    w->tick_ms = 500;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(clock, "Clock", icon_clock, clock_open);
