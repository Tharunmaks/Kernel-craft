/* KernelCraft app: Paint. Brush, eraser, line, rectangle, circle and fill
 * tools, a 20-colour palette, four brush sizes, undo, and Save/Open as a
 * PPM image on the filesystem (/home/user/drawing.ppm). */
#include "kc.h"

#define TOOLBAR_W 104
#define PATH "/home/user/drawing.ppm"

enum { T_BRUSH, T_ERASER, T_LINE, T_RECT, T_CIRCLE, T_FILL, T_COUNT };
static const char *tool_names[T_COUNT] = { "Brush", "Eraser", "Line", "Rect", "Circle", "Fill" };
static const color palette[20] = {
    RGB(0, 0, 0), RGB(255, 255, 255), RGB(128, 128, 128), RGB(192, 192, 192),
    RGB(230, 50, 50), RGB(255, 140, 0), RGB(255, 215, 0), RGB(60, 200, 80),
    RGB(0, 150, 136), RGB(40, 120, 240), RGB(100, 60, 220), RGB(220, 60, 180),
    RGB(120, 70, 30), RGB(255, 190, 200), RGB(170, 230, 255), RGB(200, 255, 170),
    RGB(20, 30, 80), RGB(90, 10, 10), RGB(10, 70, 30), RGB(250, 240, 210),
};
static const int sizes[4] = { 2, 5, 10, 20 };

typedef struct {
    color *canvas, *undo;
    int cw, ch;
    int tool, size_i;
    color fg;
    bool down;
    int sx, sy, lx, ly;     /* drag start and last point (canvas coords) */
    int px, py;             /* current point while previewing shapes */
} paint_state;

static surface canvas_surface(paint_state *p)
{
    return (surface){ p->canvas, p->cw, p->ch, p->cw, { 0, 0, p->cw, p->ch } };
}

static void dab(paint_state *p, int x, int y, color c)
{
    surface s = canvas_surface(p);
    int r = sizes[p->size_i] / 2;
    if (r <= 1) fill_rect(&s, x - 1, y - 1, 2, 2, c);
    else draw_circle(&s, x, y, r, c, true);
}

static void stroke(paint_state *p, int x0, int y0, int x1, int y1, color c)
{
    int dx = x1 - x0, dy = y1 - y0;
    int steps = KC_MAX(KC_MAX(dx, -dx), KC_MAX(dy, -dy));
    if (!steps) { dab(p, x0, y0, c); return; }
    for (int i = 0; i <= steps; i++) dab(p, x0 + dx * i / steps, y0 + dy * i / steps, c);
}

static int isqrt(int v) { int r = 0; while ((r + 1) * (r + 1) <= v) r++; return r; }

static void shape(paint_state *p, surface *s, int x0, int y0, int x1, int y1)
{
    int t = sizes[p->size_i] / 3 + 1;
    if (p->tool == T_LINE) {
        for (int i = 0; i < t; i++) draw_line(s, x0, y0 + i, x1, y1 + i, p->fg);
    } else if (p->tool == T_RECT) {
        int x = KC_MIN(x0, x1), y = KC_MIN(y0, y1), w = KC_MAX(x0, x1) - x, h = KC_MAX(y0, y1) - y;
        for (int i = 0; i < t; i++) draw_rect(s, x + i, y + i, w - 2 * i, h - 2 * i, p->fg);
    } else if (p->tool == T_CIRCLE) {
        int r = isqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
        for (int i = 0; i < t && r - i > 0; i++) draw_circle(s, x0, y0, r - i, p->fg, false);
    }
}

/* Scanline flood fill with a heap stack. */
static void flood(paint_state *p, int x, int y, color c)
{
    color target = p->canvas[y * p->cw + x];
    if (target == c) return;
    int cap = p->cw * 4, n = 0;
    int *stack = kmalloc(sizeof(int) * 2 * cap);
    if (!stack) return;
    stack[n++] = x; stack[n++] = y;
    while (n) {
        int py = stack[--n], px = stack[--n];
        color *row = p->canvas + py * p->cw;
        while (px > 0 && row[px - 1] == target) px--;
        bool up = false, down = false;
        for (; px < p->cw && row[px] == target; px++) {
            row[px] = c;
            if (py > 0) {
                bool m = p->canvas[(py - 1) * p->cw + px] == target;
                if (m && !up && n + 2 <= cap * 2) { stack[n++] = px; stack[n++] = py - 1; }
                up = m;
            }
            if (py + 1 < p->ch) {
                bool m = p->canvas[(py + 1) * p->cw + px] == target;
                if (m && !down && n + 2 <= cap * 2) { stack[n++] = px; stack[n++] = py + 1; }
                down = m;
            }
        }
    }
    kfree(stack);
}

static void save_ppm(paint_state *p)
{
    char head[32];
    int hl = kc_snprintf(head, sizeof head, "P6\n%d %d\n255\n", p->cw, p->ch);
    size_t n = (size_t)hl + (size_t)p->cw * p->ch * 3;
    char *buf = kmalloc(n);
    if (!buf) { wm_notify("Not enough memory to save"); return; }
    memcpy(buf, head, hl);
    u8 *o = (u8 *)buf + hl;
    for (int i = 0; i < p->cw * p->ch; i++) { color c = p->canvas[i]; *o++ = c >> 16; *o++ = c >> 8; *o++ = c; }
    fs_mkdir("/home/user");
    fs_write(PATH, buf, n);
    kfree(buf);
    wm_notify("Saved " PATH);
}

static void open_ppm(paint_state *p)
{
    kc_node *f = fs_lookup(PATH);
    if (!f || f->size < 16 || f->data[0] != 'P' || f->data[1] != '6') { wm_notify("No saved drawing yet"); return; }
    const char *d = f->data + 2;
    int vals[3], vi = 0;
    while (vi < 3) {
        while (kc_isspace(*d)) d++;
        vals[vi++] = atoi(d);
        while (kc_isdigit(*d)) d++;
    }
    d++;
    const u8 *px = (const u8 *)d;
    int w = vals[0], h = vals[1];
    if ((size_t)(d - f->data) + (size_t)w * h * 3 > f->size) { wm_notify("Drawing is damaged"); return; }
    memcpy(p->undo, p->canvas, sizeof(color) * p->cw * p->ch);
    for (int y = 0; y < KC_MIN(h, p->ch); y++)
        for (int x = 0; x < KC_MIN(w, p->cw); x++) {
            const u8 *q = px + (y * w + x) * 3;
            p->canvas[y * p->cw + x] = RGB(q[0], q[1], q[2]);
        }
    wm_notify("Opened " PATH);
}

/* --------------------------------------------------------------- paint --- */
static rect tool_rect(int i) { return (rect){ 8, 6 + i * 28, TOOLBAR_W - 16, 24 }; }
static rect size_rect(int i) { return (rect){ 8 + (i % 2) * 46, 180 + (i / 2) * 28, 42, 24 }; }
static rect swatch_rect(int i) { return (rect){ 10 + (i % 4) * 22, 240 + (i / 4) * 19, 19, 17 }; }
static rect action_rect(int i) { return (rect){ 8 + (i % 2) * 46, 362 + (i / 2) * 30, 42, 26 }; }
static const char *actions[4] = { "Undo", "Clear", "Save", "Open" };

static void paint(kc_window *w, surface *s)
{
    paint_state *p = w->state;
    fill_rect(s, 0, 0, TOOLBAR_W, s->height, RGB(36, 40, 54));
    for (int i = 0; i < T_COUNT; i++) {
        rect r = tool_rect(i);
        fill_round_rect(s, r.x, r.y, r.w, r.h, 5, i == p->tool ? theme.accent : RGB(54, 60, 78));
        draw_text(s, r.x + 8, r.y + 4, tool_names[i], i == p->tool ? theme.accent_text : RGB(230, 234, 244));
    }
    for (int i = 0; i < 4; i++) {
        rect r = size_rect(i);
        fill_round_rect(s, r.x, r.y, r.w, r.h, 5, i == p->size_i ? theme.accent : RGB(54, 60, 78));
        draw_circle(s, r.x + r.w / 2, r.y + r.h / 2, KC_MAX(1, sizes[i] / 2), RGB(240, 240, 240), true);
    }
    for (int i = 0; i < 20; i++) {
        rect r = swatch_rect(i);
        fill_rect(s, r.x, r.y, r.w, r.h, palette[i]);
        if (palette[i] == p->fg) draw_rect(s, r.x - 2, r.y - 2, r.w + 4, r.h + 4, RGB(255, 255, 255));
    }
    fill_round_rect(s, 10, 337, TOOLBAR_W - 20, 16, 4, p->fg);
    for (int i = 0; i < 4; i++) {
        rect r = action_rect(i);
        if (r.y + r.h > s->height) break;
        fill_round_rect(s, r.x, r.y, r.w, r.h, 5, RGB(54, 60, 78));
        draw_text(s, r.x + (r.w - text_width(actions[i])) / 2, r.y + 5, actions[i], RGB(230, 234, 244));
    }
    blit(s, TOOLBAR_W, 0, p->canvas, p->cw, p->ch, p->cw);
    if (p->down && (p->tool == T_LINE || p->tool == T_RECT || p->tool == T_CIRCLE)) {
        surface c = *s;
        c.clip = (rect){ TOOLBAR_W, 0, p->cw, p->ch };
        shape(p, &c, p->sx + TOOLBAR_W, p->sy, p->px + TOOLBAR_W, p->py);
    }
}

/* -------------------------------------------------------------- events --- */
static void on_event(kc_window *w, kc_event *ev)
{
    paint_state *p = w->state;
    if (ev->type == EV_KEY) {
        if ((ev->mods & MOD_CTRL) && (ev->key == 'z' || ev->key == 'Z')) { color *t = p->canvas; p->canvas = p->undo; p->undo = t; }
        else if ((ev->mods & MOD_CTRL) && (ev->key == 's' || ev->key == 'S')) save_ppm(p);
        else if (ev->key >= '1' && ev->key <= '6') p->tool = ev->key - '1';
        else return;
        wm_invalidate(w);
        return;
    }
    int cx = ev->x - TOOLBAR_W, cy = ev->y;
    bool in_canvas = cx >= 0 && cy >= 0 && cx < p->cw && cy < p->ch;
    if (ev->type == EV_MOUSE_DOWN) {
        if (ev->x < TOOLBAR_W) {
            for (int i = 0; i < T_COUNT; i++) if (rect_contains(tool_rect(i), ev->x, ev->y)) p->tool = i;
            for (int i = 0; i < 4; i++) if (rect_contains(size_rect(i), ev->x, ev->y)) p->size_i = i;
            for (int i = 0; i < 20; i++) if (rect_contains(swatch_rect(i), ev->x, ev->y)) p->fg = palette[i];
            for (int i = 0; i < 4; i++) {
                if (!rect_contains(action_rect(i), ev->x, ev->y)) continue;
                if (i == 0) { color *t = p->canvas; p->canvas = p->undo; p->undo = t; }
                else if (i == 1) { memcpy(p->undo, p->canvas, sizeof(color) * p->cw * p->ch); for (int k = 0; k < p->cw * p->ch; k++) p->canvas[k] = RGB(255, 255, 255); }
                else if (i == 2) save_ppm(p);
                else open_ppm(p);
            }
        } else if (in_canvas) {
            memcpy(p->undo, p->canvas, sizeof(color) * p->cw * p->ch);
            color c = p->tool == T_ERASER ? RGB(255, 255, 255) : p->fg;
            if (ev->buttons & 2) { p->fg = p->canvas[cy * p->cw + cx]; wm_invalidate(w); return; } /* right click picks */
            if (p->tool == T_FILL) flood(p, cx, cy, c);
            else {
                p->down = true;
                p->sx = p->lx = p->px = cx;
                p->sy = p->ly = p->py = cy;
                if (p->tool == T_BRUSH || p->tool == T_ERASER) dab(p, cx, cy, c);
            }
        }
        wm_invalidate(w);
    } else if (ev->type == EV_MOUSE_MOVE && p->down) {
        cx = KC_CLAMP(cx, 0, p->cw - 1);
        cy = KC_CLAMP(cy, 0, p->ch - 1);
        if (p->tool == T_BRUSH || p->tool == T_ERASER) {
            stroke(p, p->lx, p->ly, cx, cy, p->tool == T_ERASER ? RGB(255, 255, 255) : p->fg);
            p->lx = cx; p->ly = cy;
        }
        p->px = cx; p->py = cy;
        wm_invalidate(w);
    } else if (ev->type == EV_MOUSE_UP && p->down) {
        p->down = false;
        if (p->tool == T_LINE || p->tool == T_RECT || p->tool == T_CIRCLE) {
            surface s = canvas_surface(p);
            shape(p, &s, p->sx, p->sy, p->px, p->py);
        }
        wm_invalidate(w);
    }
}

static void on_close(kc_window *w)
{
    paint_state *p = w->state;
    kfree(p->canvas);
    kfree(p->undo);
    kfree(p);
}

void paint_open(void)
{
    int cw = KC_MIN(640, SCREEN_W - 260), ch = KC_MAX(420, KC_MIN(440, SCREEN_H - TASKBAR_H - 70));
    kc_window *w = wm_create("Paint", -1, -1, cw + TOOLBAR_W, ch);
    paint_state *p = kcalloc(1, sizeof(paint_state));
    p->cw = cw;
    p->ch = ch;
    p->canvas = kmalloc(sizeof(color) * cw * ch);
    p->undo = kmalloc(sizeof(color) * cw * ch);
    for (int i = 0; i < cw * ch; i++) p->canvas[i] = p->undo[i] = RGB(255, 255, 255);
    p->fg = palette[9];
    p->size_i = 1;
    w->state = p;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(paint, "Paint", icon_brush, paint_open);
