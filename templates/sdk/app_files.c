/* KernelCraft SDK app: File Explorer for the RAM filesystem. */
#include "kc.h"

typedef struct {
    kc_node *dir;
    int selected;
    int scroll;
} files_state;

void notepad_open_path(const char *path);

#define ROW_H 24
#define TOOLBAR_H 34

static kc_node *nth_child(kc_node *dir, int i)
{
    kc_node *c = dir->child;
    while (c && i-- > 0) c = c->next;
    return c;
}

static void paint(kc_window *w, surface *s)
{
    files_state *f = w->state;
    char path[256];
    fs_path(f->dir, path, sizeof path);
    fill_rect(s, 0, 0, s->width, TOOLBAR_H, RGB(228, 233, 242));
    fill_round_rect(s, 6, 6, 50, 22, 4, RGB(205, 212, 226));
    draw_text(s, 14, 9, "Up", theme.window_text);
    fill_round_rect(s, 62, 6, 90, 22, 4, RGB(205, 212, 226));
    draw_text(s, 70, 9, "New file", theme.window_text);
    fill_round_rect(s, 158, 6, 100, 22, 4, RGB(205, 212, 226));
    draw_text(s, 166, 9, "New folder", theme.window_text);
    draw_text(s, 270, 9, path, RGB(80, 90, 110));

    int y = TOOLBAR_H + 4, i = 0;
    for (kc_node *c = f->dir->child; c; c = c->next, i++) {
        if (i < f->scroll) continue;
        if (y > s->height - ROW_H) break;
        if (i == f->selected) fill_round_rect(s, 4, y, s->width - 8, ROW_H - 2, 4, color_mix(theme.window_bg, theme.accent, 70));
        surface icon = *s;
        if (c->is_dir) { fill_round_rect(s, 10, y + 5, 7, 4, 1, RGB(230, 170, 40)); fill_round_rect(s, 10, y + 7, 16, 11, 2, RGB(250, 200, 70)); }
        else { fill_rect(s, 12, y + 3, 12, 16, RGB(255, 255, 255)); draw_rect(s, 12, y + 3, 12, 16, RGB(140, 150, 170)); }
        (void)icon;
        draw_text(s, 34, y + 4, c->name, theme.window_text);
        if (!c->is_dir) {
            char size[24];
            kc_snprintf(size, sizeof size, "%u B", (u32)c->size);
            draw_text(s, s->width - 100, y + 4, size, RGB(110, 118, 135));
        }
        y += ROW_H;
    }
    if (!f->dir->child) draw_text(s, 34, TOOLBAR_H + 10, "(empty folder)", RGB(130, 136, 150));
}

static void open_node(kc_window *w, kc_node *n)
{
    files_state *f = w->state;
    if (n->is_dir) { f->dir = n; f->selected = -1; f->scroll = 0; }
    else {
        char path[256];
        fs_path(n, path, sizeof path);
        notepad_open_path(path);
    }
}

static void on_event(kc_window *w, kc_event *ev)
{
    files_state *f = w->state;
    if (ev->type == EV_MOUSE_DOWN) {
        if (ev->y < TOOLBAR_H) {
            char base[256], path[300];
            fs_path(f->dir, base, sizeof base);
            if (ev->x < 56 && f->dir->parent) { f->dir = f->dir->parent; f->selected = -1; }
            else if (ev->x >= 62 && ev->x < 152) {
                kc_snprintf(path, sizeof path, "%s/new-%u.txt", strcmp(base, "/") ? base : "", (u32)fs_count(f->dir) + 1);
                fs_write(path, "", 0);
            } else if (ev->x >= 158 && ev->x < 258) {
                kc_snprintf(path, sizeof path, "%s/folder-%u", strcmp(base, "/") ? base : "", (u32)fs_count(f->dir) + 1);
                fs_mkdir(path);
            }
        } else {
            int i = (ev->y - TOOLBAR_H - 4) / ROW_H + f->scroll;
            kc_node *n = nth_child(f->dir, i);
            if (n && i == f->selected) open_node(w, n);
            else f->selected = n ? i : -1;
        }
        wm_invalidate(w);
    } else if (ev->type == EV_KEY) {
        int count = fs_count(f->dir);
        if (ev->key == KEY_DOWN && f->selected < count - 1) f->selected++;
        else if (ev->key == KEY_UP && f->selected > 0) f->selected--;
        else if (ev->key == KEY_ENTER && f->selected >= 0) open_node(w, nth_child(f->dir, f->selected));
        else if (ev->key == KEY_BACKSPACE && f->dir->parent) { f->dir = f->dir->parent; f->selected = -1; }
        else if (ev->key == KEY_DELETE && f->selected >= 0) {
            char path[256];
            fs_path(nth_child(f->dir, f->selected), path, sizeof path);
            fs_remove(path);
            f->selected = -1;
        }
        int visible = (w->client.height - TOOLBAR_H) / ROW_H - 1;
        if (f->selected >= f->scroll + visible) f->scroll = f->selected - visible + 1;
        if (f->selected >= 0 && f->selected < f->scroll) f->scroll = f->selected;
        wm_invalidate(w);
    } else if (ev->type == EV_TICK) {
        wm_invalidate(w); /* pick up changes made by other apps */
    }
}

static void on_close(kc_window *w) { kfree(w->state); }

void files_open(void)
{
    kc_window *w = wm_create("Files", -1, -1, 520, 380);
    files_state *f = kcalloc(1, sizeof *f);
    f->dir = fs_lookup("/home/user");
    f->selected = -1;
    w->state = f;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(files, "Files", icon_folder, files_open);
