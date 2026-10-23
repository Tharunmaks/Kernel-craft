/* KernelCraft app: Mines. Left click reveals, right click (or F, then click)
 * flags. The level button switches Easy/Medium/Hard, the face or N starts
 * a new game, and the first click is always safe. */
#include "kc.h"

#define MAXW 24
#define MAXH 16
#define CELL 24
#define HUD 40

typedef struct { int w, h, mines; const char *name; } level;
static const level levels[3] = { { 9, 9, 10, "Easy" }, { 16, 16, 40, "Medium" }, { 24, 16, 70, "Hard" } };

typedef struct {
    u8 mine[MAXH][MAXW], open[MAXH][MAXW], flag[MAXH][MAXW], near[MAXH][MAXW];
    int lv, opened, flags;
    bool started, lost, won, flag_mode;
    u32 start_ms, end_ms;
} mines_state;

static const level *L(mines_state *m) { return &levels[m->lv]; }

static void reset(mines_state *m)
{
    int lv = m->lv;
    memset(m, 0, sizeof *m);
    m->lv = lv;
}

/* The window fits the largest board; smaller boards are centred. */
static int OX(mines_state *m) { return (MAXW - L(m)->w) * CELL / 2; }
static int OY(mines_state *m) { return HUD + (MAXH - L(m)->h) * CELL / 2; }

static void seed(mines_state *m, int sx, int sy)
{
    int placed = 0;
    while (placed < L(m)->mines) {
        int x = kc_rand() % L(m)->w, y = kc_rand() % L(m)->h;
        if (m->mine[y][x] || (x >= sx - 1 && x <= sx + 1 && y >= sy - 1 && y <= sy + 1)) continue;
        m->mine[y][x] = 1;
        placed++;
    }
    for (int y = 0; y < L(m)->h; y++)
        for (int x = 0; x < L(m)->w; x++) {
            int n = 0;
            for (int dy = -1; dy <= 1; dy++)
                for (int dx = -1; dx <= 1; dx++) {
                    int nx = x + dx, ny = y + dy;
                    if (nx >= 0 && ny >= 0 && nx < L(m)->w && ny < L(m)->h) n += m->mine[ny][nx];
                }
            m->near[y][x] = (u8)n;
        }
    m->started = true;
    m->start_ms = uptime_ms();
}

static void reveal(mines_state *m, int x, int y)
{
    if (x < 0 || y < 0 || x >= L(m)->w || y >= L(m)->h || m->open[y][x] || m->flag[y][x]) return;
    m->open[y][x] = 1;
    m->opened++;
    if (m->mine[y][x]) { m->lost = true; m->end_ms = uptime_ms(); return; }
    if (m->near[y][x] == 0)
        for (int dy = -1; dy <= 1; dy++)
            for (int dx = -1; dx <= 1; dx++) reveal(m, x + dx, y + dy);
}

static const color num_colors[9] = { 0, RGB(30, 90, 230), RGB(30, 150, 60), RGB(220, 40, 40), RGB(20, 30, 140),
                                     RGB(140, 30, 30), RGB(20, 140, 140), RGB(20, 20, 20), RGB(120, 120, 120) };

static void paint(kc_window *w, surface *s)
{
    mines_state *m = w->state;
    fill_rect(s, 0, 0, s->width, HUD, RGB(30, 36, 50));
    char hud[64];
    u32 t = m->started ? ((m->lost || m->won ? m->end_ms : uptime_ms()) - m->start_ms) / 1000 : 0;
    kc_snprintf(hud, sizeof hud, "Mines %d  Time %u", L(m)->mines - m->flags, t);
    draw_text(s, 8, 12, hud, RGB(230, 236, 250));
    fill_round_rect(s, s->width - 76, 8, 68, 24, 5, theme.accent);
    draw_text(s, s->width - 76 + (68 - text_width(L(m)->name)) / 2, 12, L(m)->name, theme.accent_text);
    const char *face = m->lost ? "X(" : m->won ? "B)" : m->flag_mode ? "F" : ":)";
    fill_round_rect(s, s->width / 2 + 20, 8, 36, 24, 5, RGB(250, 210, 60));
    draw_text(s, s->width / 2 + 38 - text_width(face) / 2, 12, face, RGB(40, 30, 0));
    fill_rect(s, 0, HUD, s->width, s->height - HUD, RGB(46, 54, 72));
    for (int y = 0; y < L(m)->h; y++)
        for (int x = 0; x < L(m)->w; x++) {
            int px = OX(m) + x * CELL, py = OY(m) + y * CELL;
            if (!m->open[y][x] && !(m->lost && m->mine[y][x])) {
                fill_rect(s, px, py, CELL, CELL, RGB(150, 160, 180));
                fill_rect(s, px + 1, py + 1, CELL - 3, CELL - 3, RGB(196, 204, 220));
                if (m->flag[y][x]) {
                    fill_rect(s, px + 10, py + 5, 2, 14, RGB(40, 40, 40));
                    fill_rect(s, px + 12, py + 5, 7, 6, RGB(230, 40, 40));
                }
                continue;
            }
            fill_rect(s, px, py, CELL, CELL, RGB(170, 176, 190));
            fill_rect(s, px + 1, py + 1, CELL - 1, CELL - 1, m->mine[y][x] && m->open[y][x] ? RGB(240, 80, 80) : RGB(232, 236, 244));
            if (m->mine[y][x]) draw_circle(s, px + CELL / 2, py + CELL / 2, 6, RGB(20, 20, 20), true);
            else if (m->near[y][x]) {
                char n[2] = { (char)('0' + m->near[y][x]), 0 };
                draw_text(s, px + 8, py + 4, n, num_colors[m->near[y][x]]);
            }
        }
    if (m->won || m->lost) {
        const char *msg = m->won ? "You win!" : "Boom!";
        fill_rect_alpha(s, 0, s->height / 2 - 24, s->width, 48, RGB(0, 0, 0), 150);
        draw_text_scaled(s, (s->width - text_width(msg) * 2) / 2, s->height / 2 - 16, msg, RGB(255, 255, 255), 2);
    }
}

static void on_event(kc_window *w, kc_event *ev)
{
    mines_state *m = w->state;
    if (ev->type == EV_TICK) { if (m->started && !m->lost && !m->won) wm_invalidate(w); return; }
    if (ev->type == EV_KEY) {
        if (ev->key == 'f' || ev->key == 'F') m->flag_mode = !m->flag_mode;
        else if (ev->key == 'n' || ev->key == 'N' || ev->key == KEY_F2) reset(m);
        else return;
        wm_invalidate(w);
        return;
    }
    if (ev->type != EV_MOUSE_DOWN) return;
    if (ev->y < HUD) {
        if (ev->x >= w->client.width - 76) m->lv = (m->lv + 1) % 3;   /* difficulty button */
        reset(m);                                                    /* face (or anywhere): new game */
        wm_invalidate(w);
        return;
    }
    if (ev->x < OX(m) || ev->y < OY(m)) return;
    int x = (ev->x - OX(m)) / CELL, y = (ev->y - OY(m)) / CELL;
    if (x >= L(m)->w || y >= L(m)->h || m->lost || m->won) return;
    if ((ev->buttons & 2) || m->flag_mode) {
        if (!m->open[y][x]) { m->flag[y][x] = !m->flag[y][x]; m->flags += m->flag[y][x] ? 1 : -1; }
    } else {
        if (!m->started) seed(m, x, y);
        reveal(m, x, y);
        if (!m->lost && m->opened == L(m)->w * L(m)->h - L(m)->mines) { m->won = true; m->end_ms = uptime_ms(); wm_notify("Mines cleared!"); }
    }
    wm_invalidate(w);
}

static void on_close(kc_window *w) { kfree(w->state); }

void mines_open(void)
{
    mines_state *m = kcalloc(1, sizeof(mines_state));
    kc_window *w = wm_create("Mines", -1, -1, MAXW * CELL, MAXH * CELL + HUD);
    w->state = m;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}

KC_APP(mines, "Mines", icon_game, mines_open);
