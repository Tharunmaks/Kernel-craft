/* KernelCraft SDK app: Notepad, a multi-line text editor with save (Ctrl+S). */
#include "kc.h"

typedef struct {
    char path[256];
    char *text;
    size_t len, cap;
    size_t cursor;
    int scroll;
    bool modified, cursor_on;
} pad_state;

#define STATUS_H 22

static void ensure(pad_state *p, size_t extra)
{
    if (p->len + extra + 1 <= p->cap) return;
    p->cap = (p->len + extra + 1) * 2;
    p->text = krealloc(p->text, p->cap);
}

static void title_for(kc_window *w)
{
    pad_state *p = w->state;
    const char *name = strrchr(p->path, '/');
    kc_snprintf(w->title, sizeof w->title, "%s%s - Notepad", p->modified ? "*" : "", name ? name + 1 : "untitled");
}

static void paint(kc_window *w, surface *s)
{
    pad_state *p = w->state;
    fill_rect(s, 0, 0, s->width, s->height, RGB(255, 255, 255));
    int cols = (s->width - 12) / FONT_W;
    int line = 0, col = 0, cx = -1, cy = -1;
    for (size_t i = 0; i <= p->len; i++) {
        if (i == p->cursor) { cx = col; cy = line; }
        if (i == p->len) break;
        char c = p->text[i];
        if (c == '\n' || col >= cols) { line++; col = 0; if (c == '\n') continue; }
        int y = (line - p->scroll) * FONT_H + 4;
        if (y >= 0 && y < s->height - STATUS_H - FONT_H) draw_char(s, 6 + col * FONT_W, y, c, theme.window_text);
        col++;
    }
    int y = (cy - p->scroll) * FONT_H + 4;
    if (p->cursor_on && y >= 0) fill_rect(s, 6 + cx * FONT_W, y, 2, FONT_H, theme.accent);
    fill_rect(s, 0, s->height - STATUS_H, s->width, STATUS_H, RGB(232, 236, 244));
    char status[300];
    kc_snprintf(status, sizeof status, "%s  |  %u chars  |  Ctrl+S save", p->path[0] ? p->path : "unsaved", (u32)p->len);
    draw_text(s, 6, s->height - STATUS_H + 3, status, RGB(90, 98, 115));
}

static void save(kc_window *w)
{
    pad_state *p = w->state;
    if (!p->path[0]) kc_snprintf(p->path, sizeof p->path, "/home/user/Documents/note-%u.txt", uptime_ms() / 1000);
    fs_write(p->path, p->text, p->len);
    p->modified = false;
    title_for(w);
    wm_notify("Saved");
}

static void on_event(kc_window *w, kc_event *ev)
{
    pad_state *p = w->state;
    if (ev->type == EV_TICK) { p->cursor_on = !p->cursor_on; wm_invalidate(w); return; }
    if (ev->type != EV_KEY) return;
    int k = ev->key;
    if ((ev->mods & MOD_CTRL) && (k == 's' || k == 'S')) { save(w); }
    else if (k == KEY_LEFT && p->cursor) p->cursor--;
    else if (k == KEY_RIGHT && p->cursor < p->len) p->cursor++;
    else if (k == KEY_HOME) { while (p->cursor && p->text[p->cursor - 1] != '\n') p->cursor--; }
    else if (k == KEY_END) { while (p->cursor < p->len && p->text[p->cursor] != '\n') p->cursor++; }
    else if (k == KEY_UP) { while (p->cursor && p->text[--p->cursor] != '\n') {} }
    else if (k == KEY_DOWN) { while (p->cursor < p->len && p->text[p->cursor++] != '\n') {} }
    else if (k == KEY_BACKSPACE && p->cursor) {
        memmove(p->text + p->cursor - 1, p->text + p->cursor, p->len - p->cursor);
        p->cursor--; p->len--; p->modified = true;
    } else if (k == KEY_DELETE && p->cursor < p->len) {
        memmove(p->text + p->cursor, p->text + p->cursor + 1, p->len - p->cursor - 1);
        p->len--; p->modified = true;
    } else if ((k >= 32 && k < 127) || k == KEY_ENTER || k == KEY_TAB) {
        char c = k == KEY_ENTER ? '\n' : k == KEY_TAB ? ' ' : (char)k;
        ensure(p, 1);
        memmove(p->text + p->cursor + 1, p->text + p->cursor, p->len - p->cursor);
        p->text[p->cursor++] = c;
        p->len++;
        p->modified = true;
    }
    p->text[p->len] = 0;
    /* keep cursor line visible */
    int line = 0;
    for (size_t i = 0; i < p->cursor; i++) if (p->text[i] == '\n') line++;
    int rows = (w->client.height - STATUS_H - 8) / FONT_H;
    if (line < p->scroll) p->scroll = line;
    if (line >= p->scroll + rows) p->scroll = line - rows + 1;
    p->cursor_on = true;
    title_for(w);
    wm_invalidate(w);
}

static void on_close(kc_window *w)
{
    pad_state *p = w->state;
    kfree(p->text);
    kfree(p);
}

void notepad_open_path(const char *path)
{
    kc_window *w = wm_create("Notepad", -1, -1, 560, 380);
    pad_state *p = kcalloc(1, sizeof *p);
    w->state = p;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
    ensure(p, 256);
    kc_node *f = path ? fs_lookup(path) : NULL;
    if (path) strncpy(p->path, path, sizeof p->path - 1);
    if (f && !f->is_dir && f->size) {
        ensure(p, f->size);
        memcpy(p->text, f->data, f->size);
        p->len = f->size;
    }
    p->text[p->len] = 0;
    title_for(w);
}

static void notepad_open(void) { notepad_open_path(NULL); }
KC_APP(notepad, "Notepad", icon_document, notepad_open);
