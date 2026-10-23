/* KernelCraft SDK: compositing window manager, desktop, taskbar, start menu. */
#include "kc.h"

kc_theme theme = {
    .desktop_top = RGB(18, 32, 74),
    .desktop_bottom = RGB(6, 10, 26),
    .accent = RGB(52, 211, 255),
    .accent_text = RGB(4, 12, 24),
    .window_bg = RGB(244, 246, 250),
    .window_text = RGB(24, 28, 38),
    .title_active = RGB(30, 64, 140),
    .title_inactive = RGB(70, 78, 96),
    .title_text = RGB(255, 255, 255),
    .taskbar = RGB(12, 16, 28),
    .taskbar_text = RGB(220, 228, 245),
    .menu_bg = RGB(22, 28, 46),
    .menu_hover = RGB(40, 70, 130),
    .radius = 6,
    .os_name = "KernelCraft OS",
    .draw_wallpaper = NULL,
};

static kc_window *windows;      /* bottom -> top; the last one has focus */
static int next_id = 1;
static color *wallpaper;
static bool dirty_all = true;
static bool start_open;
static int start_hover = -1;
static char toast[96];
static u32 toast_until;

static kc_window *dragging;
static int drag_dx, drag_dy;
static kc_window *mouse_owner;  /* window that got the mouse-down */
static u32 last_click_ms;
static int last_click_icon = -1;

#define ICON_CELL_W 88
#define ICON_CELL_H 84
#define START_W 240
/* Start menu rows shrink when many apps are installed. */
#define START_ITEM_H start_item_h()
int kc_app_count(void);
static int start_item_h(void) { return KC_CLAMP((SCREEN_H - TASKBAR_H - 70) / (kc_app_count() + 1), 18, 34); }

/* --------------------------------------------------------------- windows --- */
static rect client_rect(kc_window *w) { return (rect){ w->frame.x + 1, w->frame.y + TITLE_H, w->frame.w - 2, w->frame.h - TITLE_H - 1 }; }

static void alloc_client(kc_window *w)
{
    rect c = client_rect(w);
    kfree(w->client.pixels);
    w->client.pixels = kmalloc((size_t)c.w * c.h * sizeof(color));
    w->client.width = w->client.stride = c.w;
    w->client.height = c.h;
    w->client.clip = (rect){ 0, 0, c.w, c.h };
    w->dirty = true;
}

kc_window *wm_create(const char *title, int x, int y, int cw, int ch)
{
    kc_window *w = kcalloc(1, sizeof *w);
    w->id = next_id++;
    strncpy(w->title, title, sizeof w->title - 1);
    int fw = cw + 2, fh = ch + TITLE_H + 1;
    int count = wm_window_count();
    if (x < 0) x = KC_MAX(116, (SCREEN_W - fw) / 2) + (count % 6) * 28;
    if (y < 0) y = KC_MAX(12, (SCREEN_H - TASKBAR_H - fh) / 2 - 40) + (count % 6) * 28;
    w->frame = (rect){ KC_CLAMP(x, 0, SCREEN_W - 80), KC_CLAMP(y, 0, SCREEN_H - TASKBAR_H - TITLE_H), fw, fh };
    alloc_client(w);
    kc_window **pp = &windows;
    while (*pp) pp = &(*pp)->next;
    *pp = w;
    dirty_all = true;
    kc_log("wm: opened \"%s\" (%dx%d)", title, cw, ch);
    return w;
}

static void unlink_window(kc_window *w)
{
    for (kc_window **pp = &windows; *pp; pp = &(*pp)->next)
        if (*pp == w) { *pp = w->next; w->next = NULL; return; }
}

void wm_close(kc_window *w)
{
    if (w->on_close) w->on_close(w);
    unlink_window(w);
    if (dragging == w) dragging = NULL;
    if (mouse_owner == w) mouse_owner = NULL;
    kfree(w->client.pixels);
    kfree(w);
    dirty_all = true;
}

void wm_focus(kc_window *w)
{
    unlink_window(w);
    kc_window **pp = &windows;
    while (*pp) pp = &(*pp)->next;
    *pp = w;
    w->minimized = false;
    dirty_all = true;
}

kc_window *wm_focused(void)
{
    kc_window *top = NULL;
    for (kc_window *w = windows; w; w = w->next) if (!w->minimized) top = w;
    return top;
}

void wm_invalidate(kc_window *w) { w->dirty = true; }
void wm_invalidate_all(void) { dirty_all = true; for (kc_window *w = windows; w; w = w->next) w->dirty = true; }
int wm_window_count(void) { int n = 0; for (kc_window *w = windows; w; w = w->next) n++; return n; }

void wm_notify(const char *text)
{
    strncpy(toast, text, sizeof toast - 1);
    toast_until = uptime_ms() + 3000;
    dirty_all = true;
}

static void toggle_maximize(kc_window *w)
{
    if (w->maximized) w->frame = w->restore_frame;
    else { w->restore_frame = w->frame; w->frame = (rect){ 0, 0, SCREEN_W, SCREEN_H - TASKBAR_H }; }
    w->maximized = !w->maximized;
    alloc_client(w);
    dirty_all = true;
}

/* ------------------------------------------------------------ app registry --- */
int kc_app_count(void) { return (int)(__kc_apps_end - __kc_apps_start); }
const kc_app *kc_app_at(int i) { return __kc_apps_start[i]; }
const kc_app *kc_app_find(const char *id)
{
    for (int i = 0; i < kc_app_count(); i++) if (!strcmp(kc_app_at(i)->id, id)) return kc_app_at(i);
    return NULL;
}
const kc_command *kc_command_find(const char *name)
{
    for (const kc_command **c = __kc_commands_start; c < __kc_commands_end; c++) if (!strcmp((*c)->name, name)) return *c;
    return NULL;
}

/* ------------------------------------------------------------------ icons --- */
void icon_terminal(surface *s, int x, int y)
{
    fill_round_rect(s, x + 2, y + 4, 28, 24, 4, RGB(20, 24, 34));
    fill_rect(s, x + 2, y + 4, 28, 5, RGB(70, 80, 100));
    draw_text(s, x + 6, y + 10, ">_", RGB(80, 240, 160));
}
void icon_folder(surface *s, int x, int y)
{
    fill_round_rect(s, x + 2, y + 6, 13, 6, 2, RGB(230, 170, 40));
    fill_round_rect(s, x + 2, y + 9, 28, 19, 3, RGB(250, 200, 70));
}
void icon_document(surface *s, int x, int y)
{
    fill_rect(s, x + 6, y + 2, 20, 28, RGB(250, 250, 250));
    draw_rect(s, x + 6, y + 2, 20, 28, RGB(140, 150, 170));
    for (int i = 0; i < 5; i++) fill_rect(s, x + 9, y + 8 + i * 4, 14, 1, RGB(120, 140, 200));
}
void icon_chart(surface *s, int x, int y)
{
    fill_round_rect(s, x + 2, y + 2, 28, 28, 4, RGB(24, 40, 70));
    fill_rect(s, x + 7, y + 18, 4, 8, RGB(80, 220, 140));
    fill_rect(s, x + 14, y + 11, 4, 15, RGB(52, 211, 255));
    fill_rect(s, x + 21, y + 7, 4, 19, RGB(255, 180, 70));
}
void icon_gear(surface *s, int x, int y)
{
    draw_circle(s, x + 16, y + 16, 12, RGB(150, 160, 180), true);
    fill_rect(s, x + 13, y + 1, 6, 30, RGB(150, 160, 180));
    fill_rect(s, x + 1, y + 13, 30, 6, RGB(150, 160, 180));
    draw_circle(s, x + 16, y + 16, 5, RGB(40, 46, 60), true);
}
void icon_info(surface *s, int x, int y)
{
    draw_circle(s, x + 16, y + 16, 14, theme.accent, true);
    draw_text_scaled(s, x + 12, y + 2, "i", theme.accent_text, 2);
}
void icon_calculator(surface *s, int x, int y)
{
    fill_round_rect(s, x + 5, y + 2, 22, 28, 3, RGB(60, 66, 84));
    fill_rect(s, x + 8, y + 5, 16, 6, RGB(170, 230, 190));
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 3; c++) fill_rect(s, x + 8 + c * 6, y + 14 + r * 5, 4, 3, RGB(220, 224, 235));
}

void icon_globe(surface *s, int x, int y)
{
    draw_circle(s, x + 16, y + 16, 14, RGB(40, 120, 230), true);
    fill_round_rect(s, x + 7, y + 8, 9, 7, 3, RGB(90, 200, 120));
    fill_round_rect(s, x + 17, y + 16, 8, 9, 3, RGB(90, 200, 120));
    draw_circle(s, x + 16, y + 16, 14, RGB(200, 230, 255), false);
}
void icon_brush(surface *s, int x, int y)
{
    fill_round_rect(s, x + 2, y + 4, 28, 24, 6, RGB(245, 240, 230));
    draw_circle(s, x + 9, y + 12, 3, RGB(230, 60, 60), true);
    draw_circle(s, x + 16, y + 9, 3, RGB(60, 160, 240), true);
    draw_circle(s, x + 23, y + 12, 3, RGB(250, 200, 50), true);
    draw_circle(s, x + 10, y + 20, 3, RGB(70, 200, 110), true);
    draw_line(s, x + 17, y + 26, x + 28, y + 15, RGB(120, 80, 40));
}
void icon_game(surface *s, int x, int y)
{
    fill_round_rect(s, x + 2, y + 9, 28, 16, 7, RGB(120, 90, 220));
    fill_rect(s, x + 7, y + 16, 8, 2, RGB(255, 255, 255));
    fill_rect(s, x + 10, y + 13, 2, 8, RGB(255, 255, 255));
    draw_circle(s, x + 22, y + 15, 2, RGB(255, 210, 80), true);
    draw_circle(s, x + 25, y + 19, 2, RGB(90, 230, 160), true);
}
void icon_clock(surface *s, int x, int y)
{
    draw_circle(s, x + 16, y + 16, 14, RGB(245, 246, 250), true);
    draw_circle(s, x + 16, y + 16, 14, theme.accent, false);
    draw_line(s, x + 16, y + 16, x + 16, y + 7, RGB(30, 34, 46));
    draw_line(s, x + 16, y + 16, x + 23, y + 19, RGB(30, 34, 46));
}
void icon_calendar(surface *s, int x, int y)
{
    fill_round_rect(s, x + 3, y + 4, 26, 25, 3, RGB(250, 250, 252));
    fill_rect(s, x + 3, y + 4, 26, 7, RGB(230, 70, 70));
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 4; c++) fill_rect(s, x + 6 + c * 6, y + 14 + r * 5, 4, 3, RGB(150, 160, 180));
}
void icon_music(surface *s, int x, int y)
{
    fill_round_rect(s, x + 2, y + 8, 28, 18, 3, RGB(250, 250, 252));
    for (int i = 1; i < 7; i++) fill_rect(s, x + 2 + i * 4, y + 8, 1, 18, RGB(120, 120, 130));
    for (int i = 0; i < 6; i++) if (i != 2) fill_rect(s, x + 5 + i * 4, y + 8, 3, 10, RGB(20, 20, 24));
}

/* ------------------------------------------------------------- compositing --- */
static void build_wallpaper(void)
{
    surface s = { wallpaper, SCREEN_W, SCREEN_H - TASKBAR_H, SCREEN_W, { 0, 0, SCREEN_W, SCREEN_H - TASKBAR_H } };
    if (theme.draw_wallpaper) { theme.draw_wallpaper(&s); return; }
    fill_gradient_v(&s, 0, 0, SCREEN_W, s.height, theme.desktop_top, theme.desktop_bottom);
    /* soft glow + grid for a bit of depth */
    for (int r = 260; r > 0; r -= 4)
        draw_circle(&s, SCREEN_W - 160, 120, r, color_mix(theme.desktop_top, theme.accent, (u8)((260 - r) / 10)), false);
    for (int x = 0; x < SCREEN_W; x += 40) fill_rect_alpha(&s, x, 0, 1, s.height, theme.accent, 10);
    for (int y = 0; y < s.height; y += 40) fill_rect_alpha(&s, 0, y, SCREEN_W, 1, theme.accent, 10);
    draw_text_scaled(&s, SCREEN_W - 24 - text_width(theme.os_name) * 2, s.height - 52, theme.os_name, color_mix(theme.desktop_bottom, RGB(255, 255, 255), 90), 2);
}

static rect icon_rect(int i)
{
    int per_col = (SCREEN_H - TASKBAR_H - 16) / ICON_CELL_H;
    return (rect){ 12 + (i / per_col) * ICON_CELL_W, 12 + (i % per_col) * ICON_CELL_H, ICON_CELL_W, ICON_CELL_H };
}

static void draw_desktop_icons(surface *s)
{
    for (int i = 0; i < kc_app_count(); i++) {
        const kc_app *a = kc_app_at(i);
        rect r = icon_rect(i);
        if (rect_contains(r, mouse_x(), mouse_y())) fill_round_rect(s, r.x + 4, r.y, r.w - 8, r.h - 6, 6, color_mix(theme.desktop_top, RGB(255, 255, 255), 40));
        if (a->icon) a->icon(s, r.x + (r.w - 32) / 2, r.y + 8);
        int tw = text_width(a->title);
        if (tw > r.w - 4) tw = r.w - 4;
        char label[12];
        strncpy(label, a->title, sizeof label - 1);
        label[sizeof label - 1] = 0;
        int lx = r.x + (r.w - text_width(label)) / 2;
        draw_text(s, lx + 1, r.y + 49, label, RGB(0, 0, 0));
        draw_text(s, lx, r.y + 48, label, RGB(245, 248, 255));
    }
}

static void draw_window(surface *s, kc_window *w, bool focused)
{
    rect f = w->frame;
    fill_rect_alpha(s, f.x + 4, f.y + 6, f.w, f.h, RGB(0, 0, 0), 70);   /* shadow */
    fill_round_rect(s, f.x, f.y, f.w, f.h, theme.radius, focused ? theme.title_active : theme.title_inactive);
    draw_text(s, f.x + 10, f.y + 5, w->title, theme.title_text);
    /* buttons: minimise, maximise, close */
    int bx = f.x + f.w - 26;
    fill_round_rect(s, bx, f.y + 5, 18, 16, 3, RGB(232, 72, 85));
    draw_text(s, bx + 5, f.y + 5, "x", RGB(255, 255, 255));
    fill_round_rect(s, bx - 22, f.y + 5, 18, 16, 3, color_mix(theme.title_active, RGB(255, 255, 255), 50));
    draw_rect(s, bx - 18, f.y + 9, 10, 8, RGB(255, 255, 255));
    fill_round_rect(s, bx - 44, f.y + 5, 18, 16, 3, color_mix(theme.title_active, RGB(255, 255, 255), 50));
    fill_rect(s, bx - 40, f.y + 16, 10, 2, RGB(255, 255, 255));

    if (w->dirty) {
        fill_rect(&w->client, 0, 0, w->client.width, w->client.height, theme.window_bg);
        if (w->on_paint) w->on_paint(w, &w->client);
        w->dirty = false;
    }
    rect c = client_rect(w);
    blit(s, c.x, c.y, w->client.pixels, c.w, c.h, w->client.stride);
}

static void draw_taskbar(surface *s)
{
    int y = SCREEN_H - TASKBAR_H;
    fill_rect(s, 0, y, SCREEN_W, TASKBAR_H, theme.taskbar);
    fill_rect(s, 0, y, SCREEN_W, 1, color_mix(theme.taskbar, theme.accent, 90));
    fill_round_rect(s, 6, y + 5, 86, TASKBAR_H - 10, 5, start_open ? color_mix(theme.accent, RGB(255, 255, 255), 60) : theme.accent);
    draw_text(s, 18, y + 10, "Start", theme.accent_text);

    int x = 104;
    kc_window *focus = wm_focused();
    for (kc_window *w = windows; w; w = w->next) {
        char label[18];
        strncpy(label, w->title, 16);
        label[16] = 0;
        fill_round_rect(s, x, y + 5, 150, TASKBAR_H - 10, 4, w == focus ? color_mix(theme.taskbar, theme.accent, 80) : color_mix(theme.taskbar, RGB(255, 255, 255), 20));
        draw_text(s, x + 8, y + 10, label, theme.taskbar_text);
        x += 156;
        if (x > SCREEN_W - 260) break;
    }

    kc_time t;
    rtc_read(&t);
    char clock[32];
    kc_snprintf(clock, sizeof clock, "%02u:%02u  %02u/%02u/%u", t.hour, t.min, t.day, t.month, t.year);
    draw_text(s, SCREEN_W - text_width(clock) - 12, y + 10, clock, theme.taskbar_text);
}

static rect start_rect(void)
{
    int h = 48 + kc_app_count() * START_ITEM_H + START_ITEM_H + 8;
    return (rect){ 6, SCREEN_H - TASKBAR_H - h - 4, START_W, h };
}

static void draw_start_menu(surface *s)
{
    rect r = start_rect();
    fill_rect_alpha(s, r.x + 4, r.y + 6, r.w, r.h, RGB(0, 0, 0), 90);
    fill_round_rect(s, r.x, r.y, r.w, r.h, 8, theme.menu_bg);
    draw_text(s, r.x + 14, r.y + 14, theme.os_name, theme.accent);
    int n = kc_app_count();
    for (int i = 0; i <= n; i++) {
        int iy = r.y + 44 + i * START_ITEM_H;
        if (i == start_hover) fill_round_rect(s, r.x + 6, iy, r.w - 12, START_ITEM_H - 2, 5, theme.menu_hover);
        if (i < n) {
            const kc_app *a = kc_app_at(i);
            draw_text(s, r.x + 18, iy + (START_ITEM_H - FONT_H) / 2, a->title, theme.taskbar_text);
        } else {
            draw_text(s, r.x + 18, iy + (START_ITEM_H - FONT_H) / 2, "Restart", RGB(255, 140, 150));
        }
    }
}

static void compose(void)
{
    surface *s = gfx_screen();
    int desk_h = SCREEN_H - TASKBAR_H;
    memcpy(s->pixels, wallpaper, (size_t)SCREEN_W * desk_h * sizeof(color));
    draw_desktop_icons(s);
    kc_window *focus = wm_focused();
    for (kc_window *w = windows; w; w = w->next) if (!w->minimized) draw_window(s, w, w == focus);
    draw_taskbar(s);
    if (start_open) draw_start_menu(s);
    if (toast[0] && uptime_ms() < toast_until) {
        int tw = text_width(toast) + 28;
        int tx = SCREEN_W - tw - 14, ty = SCREEN_H - TASKBAR_H - 54;
        fill_round_rect(s, tx, ty, tw, 40, 8, theme.menu_bg);
        fill_rect(s, tx, ty + 8, 3, 24, theme.accent);
        draw_text(s, tx + 14, ty + 12, toast, theme.taskbar_text);
    }
    gfx_present();
}

/* ------------------------------------------------------------------ events --- */
static kc_window *window_at(int x, int y)
{
    kc_window *hit = NULL;
    for (kc_window *w = windows; w; w = w->next) if (!w->minimized && rect_contains(w->frame, x, y)) hit = w;
    return hit;
}

static void deliver(kc_window *w, kc_event *ev)
{
    if (!w || !w->on_event) return;
    kc_event local = *ev;
    rect c = client_rect(w);
    local.x -= c.x;
    local.y -= c.y;
    w->on_event(w, &local);
}

static void reboot(void)
{
    kc_log("wm: restart requested");
    while (inb(0x64) & 2) {}
    outb(0x64, 0xFE);
    for (;;) cpu_hlt();
}

static void launch(const kc_app *a)
{
    kc_log("wm: launching %s", a->id);
    if (a->launch) a->launch();
    dirty_all = true;
}

static void handle_mouse_down(kc_event *ev)
{
    int x = ev->x, y = ev->y;
    if (start_open) {
        rect r = start_rect();
        start_open = false;
        dirty_all = true;
        if (rect_contains(r, x, y)) {
            int i = (y - r.y - 44) / START_ITEM_H;
            if (i >= 0 && i < kc_app_count()) launch(kc_app_at(i));
            else if (i == kc_app_count()) reboot();
            return;
        }
    }
    if (y >= SCREEN_H - TASKBAR_H) {
        if (x < 96) { start_open = true; start_hover = -1; dirty_all = true; return; }
        int i = (x - 104) / 156;
        kc_window *w = windows;
        while (w && i-- > 0) w = w->next;
        if (w) {
            if (w == wm_focused()) w->minimized = true;
            else wm_focus(w);
            dirty_all = true;
        }
        return;
    }
    kc_window *w = window_at(x, y);
    if (w) {
        if (w != wm_focused()) wm_focus(w);
        rect f = w->frame;
        if (y < f.y + TITLE_H) {
            int bx = f.x + f.w - 26;
            if (x >= bx && x < bx + 18) { wm_close(w); return; }
            if (x >= bx - 22 && x < bx - 4) { toggle_maximize(w); return; }
            if (x >= bx - 44 && x < bx - 26) { w->minimized = true; dirty_all = true; return; }
            if (!w->maximized) { dragging = w; drag_dx = x - f.x; drag_dy = y - f.y; }
            return;
        }
        mouse_owner = w;
        deliver(w, ev);
        dirty_all = true;
        return;
    }
    for (int i = 0; i < kc_app_count(); i++) {
        if (!rect_contains(icon_rect(i), x, y)) continue;
        u32 now = uptime_ms();
        if (last_click_icon == i && now - last_click_ms < 600) launch(kc_app_at(i));
        last_click_icon = i;
        last_click_ms = now;
        return;
    }
}

static void handle_event(kc_event *ev)
{
    switch (ev->type) {
    case EV_MOUSE_MOVE:
        gfx_move_cursor(ev->x, ev->y);
        if (dragging) {
            dragging->frame.x = KC_CLAMP(ev->x - drag_dx, -dragging->frame.w + 60, SCREEN_W - 60);
            dragging->frame.y = KC_CLAMP(ev->y - drag_dy, 0, SCREEN_H - TASKBAR_H - TITLE_H);
            dirty_all = true;
        } else if (mouse_owner && (ev->buttons & 1)) {
            deliver(mouse_owner, ev);
        } else if (start_open) {
            rect r = start_rect();
            int hover = rect_contains(r, ev->x, ev->y) ? (ev->y - r.y - 44) / START_ITEM_H : -1;
            if (hover != start_hover) { start_hover = hover; dirty_all = true; }
        } else if (ev->y < SCREEN_H - TASKBAR_H && !window_at(ev->x, ev->y)) {
            /* desktop icon hover highlight */
            static int last_hover = -2;
            int hover = -1;
            for (int i = 0; i < kc_app_count(); i++) if (rect_contains(icon_rect(i), ev->x, ev->y)) hover = i;
            if (hover != last_hover) { last_hover = hover; dirty_all = true; }
        }
        break;
    case EV_MOUSE_DOWN:
        if (ev->buttons & 1) handle_mouse_down(ev);
        else deliver(window_at(ev->x, ev->y), ev);
        break;
    case EV_MOUSE_UP:
        if (dragging) dragging = NULL;
        else if (mouse_owner) deliver(mouse_owner, ev);
        mouse_owner = NULL;
        break;
    case EV_KEY:
        if ((ev->mods & MOD_ALT) && ev->key == KEY_TAB && windows) { wm_focus(windows); break; }
        if (ev->key == KEY_F1 || ((ev->mods & MOD_CTRL) && ev->key == KEY_ESC)) { start_open = !start_open; dirty_all = true; break; }
        if (start_open && ev->key == KEY_ESC) { start_open = false; dirty_all = true; break; }
        deliver(wm_focused(), ev);
        break;
    default:
        break;
    }
}

void wm_init(void)
{
    wallpaper = kmalloc((size_t)SCREEN_W * SCREEN_H * sizeof(color));
    build_wallpaper();
    kc_log("wm: %d apps registered", kc_app_count());
}

void wm_run(void)
{
    u32 last_tick = 0, last_minute = 0xFFFFFFFF;
    bool toast_visible = false;
    for (;;) {
        kc_event ev;
        int handled = 0;
        while (input_poll(&ev) && handled < 64) { handle_event(&ev); handled++; }

        u32 now = uptime_ms();
        bool slow_tick = now - last_tick >= 500;
        kc_event tick = { .type = EV_TICK };
        for (kc_window *w = windows, *next; w; w = next) {
            next = w->next;
            if (!w->on_event) continue;
            if (w->tick_ms ? (i32)(now - w->next_tick) >= 0 : slow_tick) {
                if (w->tick_ms) w->next_tick = now + w->tick_ms;
                w->on_event(w, &tick);
            }
        }
        if (slow_tick) {
            last_tick = now;
            kc_time t;
            rtc_read(&t);
            if (t.min != last_minute) { last_minute = t.min; dirty_all = true; }
        }
        bool toast_now = toast[0] && now < toast_until;
        if (toast_now != toast_visible) { toast_visible = toast_now; dirty_all = true; }

        bool any_dirty = dirty_all;
        for (kc_window *w = windows; w; w = w->next) if (w->dirty && !w->minimized) any_dirty = true;
        if (any_dirty) {
            compose();
            dirty_all = false;
        }
        if (!handled) cpu_hlt();
    }
}

void wm_rebuild_wallpaper(void) { build_wallpaper(); dirty_all = true; }
