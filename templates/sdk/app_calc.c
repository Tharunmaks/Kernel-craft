/* KernelCraft SDK app: Calculator (integer, mouse or keyboard). */
#include "kc.h"

typedef struct { i64 acc, cur; char op; bool fresh; } calc_state;

static const char *keys[] = { "7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "C", "0", "=", "+" };
#define DISPLAY_H 64

static void paint(kc_window *w, surface *s)
{
    calc_state *c = w->state;
    fill_rect(s, 0, 0, s->width, s->height, RGB(30, 34, 46));
    fill_round_rect(s, 8, 8, s->width - 16, DISPLAY_H - 12, 6, RGB(16, 20, 28));
    char num[32];
    kc_snprintf(num, sizeof num, "%ld", c->cur);
    draw_text_scaled(s, s->width - 20 - text_width(num) * 2, 18, num, RGB(230, 255, 240), 2);
    int bw = (s->width - 16) / 4, bh = (s->height - DISPLAY_H - 8) / 4;
    for (int i = 0; i < 16; i++) {
        int x = 8 + (i % 4) * bw, y = DISPLAY_H + (i / 4) * bh;
        bool op = (i % 4) == 3 || i == 14;
        fill_round_rect(s, x + 3, y + 3, bw - 6, bh - 6, 6, op ? theme.accent : RGB(58, 64, 82));
        draw_text_scaled(s, x + bw / 2 - 8, y + bh / 2 - 16, keys[i], op ? theme.accent_text : RGB(240, 242, 248), 2);
    }
}

static void apply(calc_state *c)
{
    switch (c->op) {
    case '+': c->acc += c->cur; break;
    case '-': c->acc -= c->cur; break;
    case '*': c->acc *= c->cur; break;
    case '/': c->acc = c->cur ? c->acc / c->cur : 0; break;
    default: c->acc = c->cur; break;
    }
    c->cur = c->acc;
}

static void press(calc_state *c, char k)
{
    if (k >= '0' && k <= '9') {
        if (c->fresh) { c->cur = 0; c->fresh = false; }
        c->cur = c->cur * 10 + (k - '0');
    } else if (k == 'C' || k == 'c') { c->acc = c->cur = 0; c->op = 0; }
    else if (k == '=' || k == '\n') { apply(c); c->op = 0; c->fresh = true; }
    else if (k == '+' || k == '-' || k == '*' || k == '/') { apply(c); c->op = k; c->fresh = true; }
}

static void on_event(kc_window *w, kc_event *ev)
{
    calc_state *c = w->state;
    if (ev->type == EV_KEY) press(c, ev->key == KEY_ENTER ? '=' : (char)ev->key);
    else if (ev->type == EV_MOUSE_DOWN && ev->y >= DISPLAY_H) {
        int bw = (w->client.width - 16) / 4, bh = (w->client.height - DISPLAY_H - 8) / 4;
        int col = (ev->x - 8) / bw, row = (ev->y - DISPLAY_H) / bh;
        if (col >= 0 && col < 4 && row >= 0 && row < 4) press(c, keys[row * 4 + col][0]);
    } else return;
    wm_invalidate(w);
}

static void on_close(kc_window *w) { kfree(w->state); }

void calc_open(void)
{
    kc_window *w = wm_create("Calculator", -1, -1, 280, 340);
    w->state = kcalloc(1, sizeof(calc_state));
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(calc, "Calculator", icon_calculator, calc_open);
