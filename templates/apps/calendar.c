/* KernelCraft app: Calendar. Month view starting on today's date from the
 * RTC; arrows or the < > buttons change month, T jumps back to today.
 * Click a day to write a note for it (saved in /home/user/calendar/). */
#include "kc.h"

static const char *months[12] = { "January", "February", "March", "April", "May", "June", "July",
                                  "August", "September", "October", "November", "December" };
static const char *wdays[7] = { "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" };

typedef struct {
    int year, month;             /* month 1..12 */
    int today_y, today_m, today_d;
    int sel;                     /* selected day, 0 none */
    char note[120];
    bool editing, caret;
} cal_state;

#define GRID_Y 70
#define CELL_W 70
#define CELL_H 52

static bool leap(int y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }
static int days_in(int y, int m) { static const int d[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }; return m == 2 && leap(y) ? 29 : d[m - 1]; }
/* 0 = Monday (Sakamoto's algorithm, shifted) */
static int weekday(int y, int m, int d)
{
    static const int t[12] = { 0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4 };
    if (m < 3) y--;
    int w = (y + y / 4 - y / 100 + y / 400 + t[m - 1] + d) % 7;  /* 0 = Sunday */
    return (w + 6) % 7;
}

static void note_path(cal_state *c, char *out, size_t cap, int day)
{
    kc_snprintf(out, cap, "/home/user/calendar/%d-%02d-%02d.txt", c->year, c->month, day);
}

static void load_note(cal_state *c)
{
    char p[64];
    note_path(c, p, sizeof p, c->sel);
    kc_node *n = fs_lookup(p);
    size_t len = n && n->data ? KC_MIN(n->size, sizeof c->note - 1) : 0;
    if (len) memcpy(c->note, n->data, len);
    c->note[len] = 0;
}

static void save_note(cal_state *c)
{
    char p[64];
    note_path(c, p, sizeof p, c->sel);
    fs_mkdir("/home/user/calendar");
    if (c->note[0]) fs_write(p, c->note, strlen(c->note));
    else fs_remove(p);
}

static bool has_note(cal_state *c, int day)
{
    char p[64];
    note_path(c, p, sizeof p, day);
    return fs_lookup(p) != NULL;
}

static void paint(kc_window *w, surface *s)
{
    cal_state *c = w->state;
    fill_rect(s, 0, 0, s->width, s->height, theme.window_bg);
    char title[40];
    kc_snprintf(title, sizeof title, "%s %d", months[c->month - 1], c->year);
    draw_text_scaled(s, 16, 14, title, theme.window_text, 2);
    fill_round_rect(s, s->width - 112, 14, 30, 28, 6, theme.accent);
    draw_text(s, s->width - 101, 20, "<", theme.accent_text);
    fill_round_rect(s, s->width - 76, 14, 30, 28, 6, theme.accent);
    draw_text(s, s->width - 65, 20, ">", theme.accent_text);
    fill_round_rect(s, s->width - 40, 14, 30, 28, 6, RGB(200, 206, 220));
    draw_text(s, s->width - 29, 20, "T", RGB(40, 44, 56));
    for (int i = 0; i < 7; i++) draw_text(s, 16 + i * CELL_W + 4, GRID_Y - 20, wdays[i], i >= 5 ? RGB(220, 70, 70) : RGB(110, 118, 135));
    int first = weekday(c->year, c->month, 1), n = days_in(c->year, c->month);
    for (int d = 1; d <= n; d++) {
        int i = first + d - 1, x = 16 + (i % 7) * CELL_W, y = GRID_Y + (i / 7) * CELL_H;
        bool today = c->year == c->today_y && c->month == c->today_m && d == c->today_d;
        color bg = d == c->sel ? color_mix(theme.window_bg, theme.accent, 90) : color_mix(theme.window_bg, RGB(128, 128, 128), 20);
        fill_round_rect(s, x + 2, y + 2, CELL_W - 4, CELL_H - 4, 6, bg);
        char num[4];
        kc_snprintf(num, sizeof num, "%d", d);
        if (today) draw_circle(s, x + 18, y + 16, 12, theme.accent, true);
        draw_text(s, x + 18 - text_width(num) / 2, y + 8, num, today ? theme.accent_text : theme.window_text);
        if (has_note(c, d)) fill_round_rect(s, x + 10, y + CELL_H - 14, CELL_W - 20, 5, 2, RGB(250, 180, 60));
    }
    int ny = GRID_Y + 6 * CELL_H + 6;
    if (c->sel) {
        char head[48];
        kc_snprintf(head, sizeof head, "Note for %d %s:", c->sel, months[c->month - 1]);
        draw_text(s, 16, ny, head, RGB(110, 118, 135));
        fill_round_rect(s, 16, ny + 20, s->width - 32, 30, 6, c->editing ? RGB(255, 255, 255) : color_mix(theme.window_bg, RGB(128, 128, 128), 20));
        int tx = draw_text(s, 26, ny + 27, c->note[0] || c->editing ? c->note : "Click here and type, Enter to save", c->note[0] || c->editing ? RGB(30, 34, 46) : RGB(150, 156, 170));
        if (c->editing && c->caret) fill_rect(s, tx + 1, ny + 25, 2, 20, RGB(30, 34, 46));
    } else draw_text(s, 16, ny, "Click a day to add a note.", RGB(110, 118, 135));
}

static void shift_month(cal_state *c, int delta)
{
    c->month += delta;
    if (c->month < 1) { c->month = 12; c->year--; }
    if (c->month > 12) { c->month = 1; c->year++; }
    c->sel = 0;
    c->editing = false;
}

static void on_event(kc_window *w, kc_event *ev)
{
    cal_state *c = w->state;
    if (ev->type == EV_TICK) { if (c->editing) { c->caret = !c->caret; wm_invalidate(w); } return; }
    if (ev->type == EV_KEY) {
        int k = ev->key;
        if (c->editing) {
            size_t n = strlen(c->note);
            if (k == KEY_ENTER || k == KEY_ESC) { c->editing = false; save_note(c); if (k == KEY_ENTER) wm_notify("Note saved"); }
            else if (k == KEY_BACKSPACE) { if (n) c->note[n - 1] = 0; }
            else if (k >= 32 && k < 127 && n + 1 < sizeof c->note) { c->note[n] = (char)k; c->note[n + 1] = 0; }
        } else if (k == KEY_LEFT) shift_month(c, -1);
        else if (k == KEY_RIGHT) shift_month(c, 1);
        else if (k == 't' || k == 'T') { c->year = c->today_y; c->month = c->today_m; c->sel = c->today_d; load_note(c); }
        else return;
        wm_invalidate(w);
        return;
    }
    if (ev->type != EV_MOUSE_DOWN) return;
    int W = w->client.width, ny = GRID_Y + 6 * CELL_H + 6;
    if (ev->y >= 14 && ev->y < 42) {
        if (ev->x >= W - 112 && ev->x < W - 82) shift_month(c, -1);
        else if (ev->x >= W - 76 && ev->x < W - 46) shift_month(c, 1);
        else if (ev->x >= W - 40) { c->year = c->today_y; c->month = c->today_m; c->sel = c->today_d; load_note(c); }
    } else if (ev->y >= GRID_Y && ev->y < GRID_Y + 6 * CELL_H && ev->x >= 16) {
        int i = ((ev->y - GRID_Y) / CELL_H) * 7 + (ev->x - 16) / CELL_W;
        int d = i - weekday(c->year, c->month, 1) + 1;
        if ((ev->x - 16) / CELL_W < 7 && d >= 1 && d <= days_in(c->year, c->month)) {
            if (c->editing) save_note(c);
            c->sel = d;
            c->editing = false;
            load_note(c);
        }
    } else if (c->sel && ev->y >= ny + 20 && ev->y < ny + 50) c->editing = true;
    wm_invalidate(w);
}

static void on_close(kc_window *w)
{
    cal_state *c = w->state;
    if (c->editing) save_note(c);
    kfree(c);
}

void calendar_open(void)
{
    kc_window *w = wm_create("Calendar", -1, -1, 7 * CELL_W + 32, GRID_Y + 6 * CELL_H + 64);
    cal_state *c = kcalloc(1, sizeof(cal_state));
    kc_time t;
    rtc_read(&t);
    c->year = c->today_y = t.year;
    c->month = c->today_m = KC_CLAMP(t.month, 1, 12);
    c->today_d = t.day;
    w->state = c;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(calendar, "Calendar", icon_calendar, calendar_open);
