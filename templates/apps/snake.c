/* KernelCraft app: Snake. Arrow keys or WASD steer, P pauses, Space restarts.
 * Speeds up as you eat; best score is kept on the filesystem. */
#include "kc.h"

#define COLS 28
#define ROWS 20
#define CELL 18
#define HUD 34
#define BEST_PATH "/home/user/.snake_best"

typedef struct { i8 x, y; } cell;
typedef struct {
    cell body[COLS * ROWS];
    int len, dir, next_dir;   /* 0 right, 1 down, 2 left, 3 up */
    cell food;
    int score, best;
    bool dead, paused;
} snake_state;

static const int DX[4] = { 1, 0, -1, 0 }, DY[4] = { 0, 1, 0, -1 };

static bool on_snake(snake_state *g, int x, int y)
{
    for (int i = 0; i < g->len; i++) if (g->body[i].x == x && g->body[i].y == y) return true;
    return false;
}

static void place_food(snake_state *g)
{
    do { g->food.x = kc_rand() % COLS; g->food.y = kc_rand() % ROWS; } while (on_snake(g, g->food.x, g->food.y));
}

static void reset(snake_state *g)
{
    g->len = 4;
    for (int i = 0; i < g->len; i++) g->body[i] = (cell){ (i8)(8 - i), ROWS / 2 };
    g->dir = g->next_dir = 0;
    g->score = 0;
    g->dead = g->paused = false;
    place_food(g);
}

static u32 speed(snake_state *g) { return (u32)KC_MAX(55, 140 - g->score * 3); }

static void paint(kc_window *w, surface *s)
{
    snake_state *g = w->state;
    fill_rect(s, 0, 0, s->width, HUD, RGB(22, 26, 38));
    char hud[64];
    kc_snprintf(hud, sizeof hud, "Score %d    Best %d", g->score, g->best);
    draw_text(s, 12, 9, hud, RGB(230, 236, 250));
    draw_text(s, s->width - text_width("Arrows: move  P: pause") - 12, 9, "Arrows: move  P: pause", RGB(120, 130, 150));
    for (int y = 0; y < ROWS; y++)
        for (int x = 0; x < COLS; x++)
            fill_rect(s, x * CELL, HUD + y * CELL, CELL, CELL, ((x + y) & 1) ? RGB(28, 70, 40) : RGB(32, 78, 45));
    draw_circle(s, g->food.x * CELL + CELL / 2, HUD + g->food.y * CELL + CELL / 2, CELL / 2 - 2, RGB(240, 60, 60), true);
    fill_rect(s, g->food.x * CELL + CELL / 2, HUD + g->food.y * CELL + 1, 2, 4, RGB(90, 200, 90));
    for (int i = g->len - 1; i >= 0; i--) {
        color c = i == 0 ? RGB(250, 210, 60) : color_mix(RGB(120, 220, 255), RGB(40, 120, 220), (u8)(i * 255 / g->len));
        fill_round_rect(s, g->body[i].x * CELL + 1, HUD + g->body[i].y * CELL + 1, CELL - 2, CELL - 2, 5, c);
    }
    if (g->dead || g->paused) {
        fill_rect_alpha(s, 0, HUD, s->width, s->height - HUD, RGB(0, 0, 0), 140);
        const char *t = g->dead ? "Game over" : "Paused";
        draw_text_scaled(s, (s->width - text_width(t) * 3) / 2, s->height / 2 - 40, t, RGB(255, 255, 255), 3);
        const char *h = g->dead ? "Press Space to play again" : "Press P to continue";
        draw_text(s, (s->width - text_width(h)) / 2, s->height / 2 + 16, h, RGB(220, 224, 235));
    }
}

static void step(kc_window *w, snake_state *g)
{
    g->dir = g->next_dir;
    int nx = g->body[0].x + DX[g->dir], ny = g->body[0].y + DY[g->dir];
    bool grow = nx == g->food.x && ny == g->food.y;
    if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || (on_snake(g, nx, ny) && !(nx == g->body[g->len - 1].x && ny == g->body[g->len - 1].y && !grow))) {
        g->dead = true;
        speaker_tone(140); sleep_ms(120); speaker_off();
        if (g->score > g->best) {
            g->best = g->score;
            char b[16];
            int n = kc_snprintf(b, sizeof b, "%d", g->best);
            fs_mkdir("/home/user");
            fs_write(BEST_PATH, b, n);
            wm_notify("New Snake high score!");
        }
        return;
    }
    if (grow && g->len < COLS * ROWS) g->len++;
    memmove(&g->body[1], &g->body[0], sizeof(cell) * (g->len - 1));
    g->body[0] = (cell){ (i8)nx, (i8)ny };
    if (grow) {
        g->score++;
        speaker_tone(880); sleep_ms(20); speaker_off();
        place_food(g);
        w->tick_ms = speed(g);
    }
}

static void on_event(kc_window *w, kc_event *ev)
{
    snake_state *g = w->state;
    if (ev->type == EV_TICK) {
        if (!g->dead && !g->paused) { step(w, g); wm_invalidate(w); }
        return;
    }
    if (ev->type != EV_KEY) return;
    int k = ev->key, d = -1;
    if (k == KEY_RIGHT || k == 'd' || k == 'D') d = 0;
    else if (k == KEY_DOWN || k == 's' || k == 'S') d = 1;
    else if (k == KEY_LEFT || k == 'a' || k == 'A') d = 2;
    else if (k == KEY_UP || k == 'w' || k == 'W') d = 3;
    else if (k == 'p' || k == 'P') g->paused = !g->paused;
    else if (k == ' ' && g->dead) { reset(g); w->tick_ms = speed(g); }
    if (d >= 0 && (d + 2) % 4 != g->dir) g->next_dir = d;
    wm_invalidate(w);
}

static void on_close(kc_window *w) { speaker_off(); kfree(w->state); }

void snake_open(void)
{
    kc_window *w = wm_create("Snake", -1, -1, COLS * CELL, ROWS * CELL + HUD);
    snake_state *g = kcalloc(1, sizeof(snake_state));
    kc_node *b = fs_lookup(BEST_PATH);
    if (b && b->data) g->best = atoi(b->data);
    reset(g);
    w->state = g;
    w->tick_ms = speed(g);
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(snake, "Snake", icon_game, snake_open);
