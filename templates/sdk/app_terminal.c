/* KernelCraft SDK app: Terminal (scrollback, line editing, history). */
#include "kc.h"

#define TERM_LINES 300
#define TERM_COLS 96

typedef struct {
    char lines[TERM_LINES][TERM_COLS + 1];
    int count;            /* lines used */
    char input[TERM_COLS];
    int len;
    char history[16][TERM_COLS];
    int hist_n, hist_i;
    bool cursor_on;
} term_state;

static term_state *printing; /* terminal receiving shell output */

static void term_newline(term_state *t)
{
    if (t->count < TERM_LINES) { t->count++; return; }
    memmove(t->lines[0], t->lines[1], sizeof t->lines[0] * (TERM_LINES - 1));
    t->lines[TERM_LINES - 1][0] = 0;
}

static void term_write(term_state *t, const char *s)
{
    if (!t->count) t->count = 1;
    for (; *s; s++) {
        char *line = t->lines[t->count - 1];
        int len = (int)strlen(line);
        if (*s == '\n' || len >= TERM_COLS) {
            term_newline(t);
            t->lines[t->count - 1][0] = 0;
            if (*s == '\n') continue;
            line = t->lines[t->count - 1];
            len = 0;
        }
        line[len] = *s;
        line[len + 1] = 0;
    }
}

static void print_cb(const char *s) { if (printing) term_write(printing, s); }

static void prompt(term_state *t)
{
    char p[300];
    kc_snprintf(p, sizeof p, "user@kc:%s$ ", shell_cwd());
    term_write(t, p);
}

static void paint(kc_window *w, surface *s)
{
    term_state *t = w->state;
    fill_rect(s, 0, 0, s->width, s->height, RGB(12, 14, 22));
    int rows = (s->height - 8) / FONT_H;
    int first = KC_MAX(0, t->count - rows);
    int y = 4;
    for (int i = first; i < t->count; i++, y += FONT_H) {
        int x = draw_text(s, 6, y, t->lines[i], RGB(170, 240, 200));
        if (i == t->count - 1) {
            x = draw_text(s, x, y, t->input, RGB(255, 255, 255));
            if (t->cursor_on) fill_rect(s, x, y + 2, FONT_W, FONT_H - 3, theme.accent);
        }
    }
}

static void on_event(kc_window *w, kc_event *ev)
{
    term_state *t = w->state;
    if (ev->type == EV_TICK) { t->cursor_on = !t->cursor_on; wm_invalidate(w); return; }
    if (ev->type != EV_KEY) return;
    if (ev->key == KEY_ENTER) {
        t->input[t->len] = 0;
        term_write(t, t->input);
        term_write(t, "\n");
        if (t->len) {
            memcpy(t->history[t->hist_n % 16], t->input, TERM_COLS);
            t->hist_n++;
        }
        t->hist_i = t->hist_n;
        if (!strcmp(t->input, "clear")) { t->count = 0; }
        else if (!strcmp(t->input, "exit")) { wm_close(w); return; }
        else { printing = t; shell_execute(t->input, print_cb); printing = NULL; }
        t->len = 0;
        t->input[0] = 0;
        prompt(t);
    } else if (ev->key == KEY_BACKSPACE) {
        if (t->len) t->input[--t->len] = 0;
    } else if (ev->key == KEY_UP || ev->key == KEY_DOWN) {
        int i = t->hist_i + (ev->key == KEY_UP ? -1 : 1);
        if (i >= 0 && i >= t->hist_n - 16 && i < t->hist_n) {
            t->hist_i = i;
            memcpy(t->input, t->history[i % 16], TERM_COLS);
            t->len = (int)strlen(t->input);
        }
    } else if (ev->key >= 32 && ev->key < 127 && t->len < TERM_COLS - 40) {
        t->input[t->len++] = (char)ev->key;
        t->input[t->len] = 0;
    }
    t->cursor_on = true;
    wm_invalidate(w);
}

static void on_close(kc_window *w) { kfree(w->state); }

void terminal_open(void)
{
    kc_window *w = wm_create("Terminal", -1, -1, 600, 360);
    term_state *t = kcalloc(1, sizeof *t);
    w->state = t;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
    term_write(t, theme.os_name);
    term_write(t, " terminal. Type 'help' for commands.\n");
    prompt(t);
}
KC_APP(terminal, "Terminal", icon_terminal, terminal_open);
