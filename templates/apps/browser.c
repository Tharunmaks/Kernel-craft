/* KernelCraft app: Web browser with the Seek search engine.
 *
 * Browses the OS's offline web: built-in kc:// sites plus every text file
 * on the RAM filesystem (file:///path). Address bar, back/forward/home,
 * clickable links, search with ranked results, and keyboard scrolling.
 * There is no network driver yet, so the internet itself is out of reach;
 * pages are written in a tiny markup: "# heading", "- bullet",
 * "[label](url)" links on their own line, and plain paragraphs.
 */
#include "kc.h"

#define BAR_H 44
#define URL_MAX 160
#define HISTORY 32
#define MAX_LINKS 64
#define QUERY_MAX 64

typedef struct { const char *url, *title, *body; } web_page;

static const web_page sites[] = {
    { "kc://news", "KernelCraft News",
      "# Today's headlines\n"
      "- Your OS booted successfully. The kernel, window manager and every app are running from RAM.\n"
      "- New apps are one click away: open KernelCraft Studio, go to the Apps tab and press Add.\n"
      "- Hardware upgrade: the Studio's Hardware panel picks the CPU cores, RAM, graphics memory and screen resolution.\n"
      "# Tech\n"
      "Operating systems used to need teams of hundreds. Now you describe one in a sentence and an AI writes, compiles and tests it.\n"
      "[Read about kernels](kc://wiki/kernel)\n"
      "[Back to Seek](kc://home)\n" },
    { "kc://wiki/kernel", "Kernel - KernelPedia",
      "# Kernel\n"
      "The kernel is the core of an operating system. It owns the CPU, memory and devices, and gives programs a safe way to use them.\n"
      "This OS has a small monolithic kernel: interrupts, a timer, a heap allocator, a framebuffer driver, PS/2 keyboard and mouse, and a RAM filesystem all live in one image.\n"
      "# See also\n"
      "[Window managers](kc://wiki/wm)\n"
      "[Bootloaders](kc://wiki/boot)\n"
      "[Memory](kc://wiki/memory)\n" },
    { "kc://wiki/wm", "Window manager - KernelPedia",
      "# Window manager\n"
      "A window manager draws windows, the taskbar and the desktop, and routes keyboard and mouse input to the focused app.\n"
      "Here every window paints into its own buffer, and the compositor copies them onto a back buffer that is shown in one go, so nothing flickers.\n"
      "- Drag a window by its title bar.\n"
      "- Alt+Tab cycles windows, F1 opens the start menu.\n"
      "[Kernel](kc://wiki/kernel)\n" },
    { "kc://wiki/boot", "Bootloader - KernelPedia",
      "# Bootloader\n"
      "When the PC powers on, the BIOS loads the first 512 bytes of the disk to address 0x7C00 and jumps there. That boot sector loads the kernel, switches the CPU from 16-bit real mode to protected mode (and, on 64-bit builds, long mode) and starts it.\n"
      "[Kernel](kc://wiki/kernel)\n" },
    { "kc://wiki/memory", "Memory - KernelPedia",
      "# Memory\n"
      "The heap starts at 2 MB and runs to the end of RAM. kmalloc finds the first free block that fits, and kfree merges neighbouring free blocks so memory does not fragment.\n"
      "Open the Monitor app to watch heap usage live.\n"
      "[Kernel](kc://wiki/kernel)\n" },
    { "kc://games", "Arcade",
      "# Arcade\n"
      "Games for this OS are installed from the Studio's Apps tab: Snake, Mines and more. Once added, they appear on the desktop and in the start menu.\n"
      "[Back to Seek](kc://home)\n" },
    { "kc://about", "About this browser",
      "# About Web\n"
      "Web is the browser of this operating system, with Seek as its search engine.\n"
      "It reads the offline web: built-in sites and every text file on this computer. Try searching for readme.\n"
      "There is no network card driver yet. Ask the AI in KernelCraft Studio to write one!\n"
      "[Home](kc://home)\n" },
};

typedef struct { rect r; char url[URL_MAX]; } link_box;

typedef struct {
    char url[URL_MAX];
    char edit[URL_MAX];          /* address bar contents while editing */
    char query[QUERY_MAX];       /* search box on the home page */
    int focus;                   /* 0 page, 1 address bar, 2 search box */
    char history[HISTORY][URL_MAX];
    int hist_len, hist_pos;
    int scroll, content_h;
    link_box links[MAX_LINKS];
    int nlinks;
    bool caret;
} web_state;

/* ------------------------------------------------------------- helpers --- */
static bool starts_with(const char *s, const char *p) { return strncmp(s, p, strlen(p)) == 0; }

static bool contains_ci(const char *hay, const char *needle)
{
    size_t n = strlen(needle);
    if (!n) return true;
    for (; *hay; hay++) {
        size_t i = 0;
        while (i < n && hay[i] && kc_tolower(hay[i]) == kc_tolower(needle[i])) i++;
        if (i == n) return true;
    }
    return false;
}

static const web_page *find_site(const char *url)
{
    for (size_t i = 0; i < KC_ARRAY_LEN(sites); i++)
        if (strcmp(sites[i].url, url) == 0) return &sites[i];
    return NULL;
}

static void navigate(web_state *b, const char *url, bool push)
{
    strncpy(b->url, url, URL_MAX - 1);
    b->url[URL_MAX - 1] = 0;
    strcpy(b->edit, b->url);
    b->scroll = 0;
    b->focus = strcmp(url, "kc://home") == 0 ? 2 : 0;
    if (push) {
        if (b->hist_len && strcmp(b->history[b->hist_pos], url) == 0) return;
        b->hist_len = b->hist_len ? b->hist_pos + 1 : 0;
        if (b->hist_len == HISTORY) { memmove(b->history[0], b->history[1], (HISTORY - 1) * URL_MAX); b->hist_len--; }
        strcpy(b->history[b->hist_len], url);
        b->hist_pos = b->hist_len++;
    }
}

static void search(web_state *b, const char *q)
{
    char url[URL_MAX];
    kc_snprintf(url, sizeof url, "kc://search?q=%s", q);
    navigate(b, url, true);
}

static void go(web_state *b, const char *text)
{
    while (kc_isspace(*text)) text++;
    if (!*text) return;
    if (starts_with(text, "kc://") || starts_with(text, "file://")) navigate(b, text, true);
    else if (text[0] == '/') { char url[URL_MAX]; kc_snprintf(url, sizeof url, "file://%s", text); navigate(b, url, true); }
    else search(b, text);
}

/* --------------------------------------------------------------- layout --- */
typedef struct { surface *s; web_state *b; int x, y, w; bool draw; } flow;

static void flow_text(flow *f, const char *text, int len, color c, int scale)
{
    int max_chars = KC_MAX(8, f->w / (FONT_W * scale));
    char line[256];
    int i = 0;
    while (i < len) {
        int n = KC_MIN(len - i, max_chars);
        if (i + n < len) {               /* break at the last space */
            int sp = n;
            while (sp > 0 && text[i + sp] != ' ') sp--;
            if (sp > 0) n = sp;
        }
        int m = KC_MIN(n, (int)sizeof line - 1);
        memcpy(line, text + i, m);
        line[m] = 0;
        if (f->draw) {
            if (scale > 1) draw_text_scaled(f->s, f->x, f->y, line, c, scale);
            else draw_text(f->s, f->x, f->y, line, c);
        }
        f->y += FONT_H * scale + 4;
        i += n;
        while (i < len && text[i] == ' ') i++;
    }
}

static void flow_link(flow *f, const char *label, int llen, const char *url, int ulen, const char *snippet)
{
    char l[96];
    int n = KC_MIN(llen, (int)sizeof l - 1);
    memcpy(l, label, n);
    l[n] = 0;
    int w = text_width(l);
    if (f->draw) {
        draw_text(f->s, f->x, f->y, l, RGB(26, 13, 171));
        fill_rect(f->s, f->x, f->y + FONT_H, w, 1, RGB(26, 13, 171));
    }
    if (f->b->nlinks < MAX_LINKS) {
        link_box *lb = &f->b->links[f->b->nlinks++];
        lb->r = (rect){ f->x, f->y, w, FONT_H + 2 };
        int u = KC_MIN(ulen, URL_MAX - 1);
        memcpy(lb->url, url, u);
        lb->url[u] = 0;
    }
    f->y += FONT_H + 4;
    if (snippet) {
        char shown[URL_MAX];
        int u = KC_MIN(ulen, URL_MAX - 1);
        memcpy(shown, url, u);
        shown[u] = 0;
        if (f->draw) draw_text(f->s, f->x, f->y, shown, RGB(0, 110, 50));
        f->y += FONT_H + 2;
        char clean[161];
        int sl = KC_MIN((int)strlen(snippet), 160);
        for (int i = 0; i < sl; i++) clean[i] = (snippet[i] == '\n' || snippet[i] == '#') ? ' ' : snippet[i];
        flow_text(f, clean, sl, RGB(80, 86, 100), 1);
        f->y += 10;
    }
}

/* Renders the tiny page markup. */
static void flow_markup(flow *f, const char *src)
{
    while (*src) {
        const char *end = strchr(src, '\n');
        int len = end ? (int)(end - src) : (int)strlen(src);
        if (len == 0) f->y += 8;
        else if (src[0] == '#' && src[1] == ' ') { f->y += 6; flow_text(f, src + 2, len - 2, RGB(20, 24, 36), 2); f->y += 2; }
        else if (src[0] == '-' && src[1] == ' ') {
            if (f->draw) draw_circle(f->s, f->x + 4, f->y + 8, 2, RGB(90, 96, 110), true);
            f->x += 16; f->w -= 16;
            flow_text(f, src + 2, len - 2, RGB(40, 44, 56), 1);
            f->x -= 16; f->w += 16;
        } else if (src[0] == '[') {
            const char *close = strchr(src, ']');
            if (close && close < src + len && close[1] == '(') {
                const char *u = close + 2, *ue = strchr(u, ')');
                if (ue && ue < src + len) { flow_link(f, src + 1, (int)(close - src - 1), u, (int)(ue - u), NULL); src += len + (end ? 1 : 0); continue; }
            }
            flow_text(f, src, len, RGB(40, 44, 56), 1);
        } else flow_text(f, src, len, RGB(40, 44, 56), 1);
        f->y += 2;
        src += len + (end ? 1 : 0);
    }
}

static void draw_logo(surface *s, int cx, int y, int scale)
{
    static const char *letters = "Seek";
    static const color cols[] = { RGB(66, 133, 244), RGB(234, 67, 53), RGB(251, 188, 5), RGB(52, 168, 83) };
    int x = cx - (4 * FONT_W * scale) / 2;
    for (int i = 0; i < 4; i++) {
        char ch[2] = { letters[i], 0 };
        draw_text_scaled(s, x + 1, y + 1, ch, color_mix(cols[i], RGB(0, 0, 0), 60), scale);
        draw_text_scaled(s, x, y, ch, cols[i], scale);
        x += FONT_W * scale;
    }
}

static rect search_box_rect(surface *s) { int w = KC_MIN(520, s->width - 60); return (rect){ (s->width - w) / 2, 180, w, 40 }; }
static rect search_btn_rect(surface *s) { return (rect){ s->width / 2 - 130, 238, 120, 34 }; }
static rect lucky_btn_rect(surface *s) { return (rect){ s->width / 2 + 10, 238, 140, 34 }; }

static void home_page(surface *s, web_state *b, int top)
{
    fill_gradient_v(s, 0, top, s->width, s->height - top, RGB(255, 255, 255), RGB(240, 244, 252));
    draw_logo(s, s->width / 2, top + 60, 6);
    rect r = search_box_rect(s);
    r.y += top - BAR_H;
    fill_round_rect(s, r.x - 1, r.y - 1, r.w + 2, r.h + 2, 20, b->focus == 2 ? RGB(66, 133, 244) : RGB(200, 204, 214));
    fill_round_rect(s, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 19, RGB(255, 255, 255));
    draw_circle(s, r.x + 22, r.y + 18, 7, RGB(140, 146, 160), false);
    draw_line(s, r.x + 27, r.y + 23, r.x + 31, r.y + 27, RGB(140, 146, 160));
    int tx = draw_text(s, r.x + 42, r.y + 12, b->query[0] ? b->query : "", RGB(30, 34, 46));
    if (!b->query[0] && b->focus != 2) draw_text(s, r.x + 42, r.y + 12, "Search the offline web or type an address", RGB(150, 156, 170));
    if (b->focus == 2 && b->caret) fill_rect(s, tx + 1, r.y + 10, 2, 20, RGB(30, 34, 46));
    rect sb = search_btn_rect(s), lb = lucky_btn_rect(s);
    sb.y += top - BAR_H; lb.y += top - BAR_H;
    fill_round_rect(s, sb.x, sb.y, sb.w, sb.h, 6, RGB(241, 243, 246));
    draw_text(s, sb.x + (sb.w - text_width("Seek Search")) / 2, sb.y + 9, "Seek Search", RGB(50, 54, 64));
    fill_round_rect(s, lb.x, lb.y, lb.w, lb.h, 6, RGB(241, 243, 246));
    draw_text(s, lb.x + (lb.w - text_width("I'm Feeling Lucky")) / 2, lb.y + 9, "I'm Feeling Lucky", RGB(50, 54, 64));
    flow f = { s, b, s->width / 2 - 170, top + 300, 400, true };
    flow_link(&f, "News", 4, "kc://news", 9, NULL);
    f.x += 90; f.y -= FONT_H + 4;
    flow_link(&f, "KernelPedia", 11, "kc://wiki/kernel", 16, NULL);
    f.x += 130; f.y -= FONT_H + 4;
    flow_link(&f, "Arcade", 6, "kc://games", 10, NULL);
    f.x += 80; f.y -= FONT_H + 4;
    flow_link(&f, "About", 5, "kc://about", 10, NULL);
    draw_text(s, (s->width - text_width("Offline web: built-in sites + files on this computer")) / 2, s->height - 28,
              "Offline web: built-in sites + files on this computer", RGB(150, 156, 170));
}

/* Search results: built-in sites, then files on the filesystem. */
static void search_files(flow *f, kc_node *dir, const char *q, int *hits)
{
    for (kc_node *n = dir->child; n && *hits < 20; n = n->next) {
        if (n->is_dir) { search_files(f, n, q, hits); continue; }
        if (!contains_ci(n->name, q) && !(n->data && contains_ci(n->data, q))) continue;
        char path[160], url[URL_MAX];
        fs_path(n, path, sizeof path);
        kc_snprintf(url, sizeof url, "file://%s", path);
        char snippet[161];
        int len = n->data ? (int)KC_MIN(n->size, 160) : 0;
        for (int i = 0; i < len; i++) snippet[i] = n->data[i] == '\n' ? ' ' : n->data[i];
        snippet[len] = 0;
        flow_link(f, n->name, (int)strlen(n->name), url, (int)strlen(url), snippet[0] ? snippet : "(empty file)");
        (*hits)++;
    }
}

static void results_page(flow *f, const char *q)
{
    char head[120];
    kc_snprintf(head, sizeof head, "Results for \"%s\"", q);
    if (f->draw) draw_logo(f->s, f->x + 40, f->y, 3);
    f->y += 60;
    flow_text(f, head, (int)strlen(head), RGB(90, 96, 110), 1);
    f->y += 8;
    int hits = 0;
    for (size_t i = 0; i < KC_ARRAY_LEN(sites); i++) {
        if (!contains_ci(sites[i].title, q) && !contains_ci(sites[i].body, q) && !contains_ci(sites[i].url, q)) continue;
        const char *body = sites[i].body;
        while (*body == '#' || *body == ' ') body++;
        flow_link(f, sites[i].title, (int)strlen(sites[i].title), sites[i].url, (int)strlen(sites[i].url), body);
        hits++;
    }
    search_files(f, fs_root(), q, &hits);
    if (!hits) {
        flow_text(f, "No pages matched. Try news, kernel, memory or readme.", 54, RGB(40, 44, 56), 1);
        flow_link(f, "Back to Seek", 12, "kc://home", 9, NULL);
    }
}

static void page_content(flow *f)
{
    web_state *b = f->b;
    if (starts_with(b->url, "kc://search?q=")) { results_page(f, b->url + 14); return; }
    const web_page *p = find_site(b->url);
    if (p) { flow_markup(f, p->body); return; }
    if (starts_with(b->url, "file://")) {
        kc_node *n = fs_lookup(b->url + 7);
        if (n && !n->is_dir) {
            flow_text(f, n->name, (int)strlen(n->name), RGB(20, 24, 36), 2);
            f->y += 6;
            const char *d = n->data ? n->data : "";
            int len = (int)n->size;
            for (int i = 0; i < len;) {
                int e = i;
                while (e < len && d[e] != '\n') e++;
                if (e == i) f->y += FONT_H; else flow_text(f, d + i, e - i, RGB(40, 44, 56), 1);
                i = e + 1;
            }
            return;
        }
        if (n && n->is_dir) {
            flow_text(f, b->url + 7, (int)strlen(b->url + 7), RGB(20, 24, 36), 2);
            for (kc_node *c = n->child; c; c = c->next) {
                char path[160], url[URL_MAX];
                fs_path(c, path, sizeof path);
                kc_snprintf(url, sizeof url, "file://%s", path);
                flow_link(f, c->name, (int)strlen(c->name), url, (int)strlen(url), NULL);
            }
            return;
        }
    }
    flow_text(f, "This page can't be reached", 26, RGB(20, 24, 36), 2);
    flow_text(f, "There is no network card driver in this OS yet, so only the offline web works.", 79, RGB(80, 86, 100), 1);
    flow_link(f, "Go to Seek", 10, "kc://home", 9, NULL);
}

/* ---------------------------------------------------------------- paint --- */
static void button(surface *s, int x, const char *label, bool enabled)
{
    fill_round_rect(s, x, 8, 30, 28, 6, RGB(232, 236, 244));
    draw_text(s, x + 11, 14, label, enabled ? RGB(40, 44, 56) : RGB(170, 174, 184));
}

static void paint(kc_window *w, surface *s)
{
    web_state *b = w->state;
    b->nlinks = 0;
    /* toolbar */
    fill_rect(s, 0, 0, s->width, BAR_H, RGB(246, 248, 252));
    fill_rect(s, 0, BAR_H - 1, s->width, 1, RGB(214, 218, 228));
    button(s, 8, "<", b->hist_pos > 0);
    button(s, 42, ">", b->hist_pos + 1 < b->hist_len);
    button(s, 76, "H", true);
    rect ab = { 114, 8, s->width - 124, 28 };
    fill_round_rect(s, ab.x, ab.y, ab.w, ab.h, 14, b->focus == 1 ? RGB(255, 255, 255) : RGB(232, 236, 244));
    if (b->focus == 1) draw_rect(s, ab.x + 6, ab.y, ab.w - 12, 1, RGB(66, 133, 244));
    int tx = draw_text(s, ab.x + 14, ab.y + 6, b->focus == 1 ? b->edit : b->url, RGB(40, 44, 56));
    if (b->focus == 1 && b->caret) fill_rect(s, tx + 1, ab.y + 5, 2, 18, RGB(40, 44, 56));

    /* page */
    surface page = *s;
    page.clip = (rect){ 0, BAR_H, s->width, s->height - BAR_H };
    if (strcmp(b->url, "kc://home") == 0) { home_page(&page, b, BAR_H); b->content_h = 0; return; }
    fill_rect(&page, 0, BAR_H, s->width, s->height - BAR_H, RGB(255, 255, 255));
    flow f = { &page, b, 28, BAR_H + 18 - b->scroll, s->width - 70, true };
    page_content(&f);
    b->content_h = f.y + b->scroll - BAR_H + 20;
    int view = s->height - BAR_H;
    if (b->content_h > view) {
        int th = KC_MAX(30, view * view / b->content_h);
        int ty = BAR_H + (view - th) * b->scroll / KC_MAX(1, b->content_h - view);
        fill_round_rect(s, s->width - 10, ty, 6, th, 3, RGB(190, 196, 208));
    }
}

/* --------------------------------------------------------------- events --- */
static void scroll_by(web_state *b, int dy, int view)
{
    b->scroll = KC_CLAMP(b->scroll + dy, 0, KC_MAX(0, b->content_h - view));
}

static void type_into(char *buf, size_t cap, int key)
{
    size_t n = strlen(buf);
    if (key == KEY_BACKSPACE) { if (n) buf[n - 1] = 0; }
    else if (key >= 32 && key < 127 && n + 1 < cap) { buf[n] = (char)key; buf[n + 1] = 0; }
}

static void on_event(kc_window *w, kc_event *ev)
{
    web_state *b = w->state;
    int view = w->client.height - BAR_H;
    if (ev->type == EV_TICK) { if (b->focus) { b->caret = !b->caret; wm_invalidate(w); } return; }
    if (ev->type == EV_KEY) {
        int k = ev->key;
        if ((ev->mods & MOD_CTRL) && (k == 'l' || k == 'L')) { b->focus = 1; b->edit[0] = 0; }
        else if (b->focus == 1) {
            if (k == KEY_ENTER) { char t[URL_MAX]; strcpy(t, b->edit); go(b, t); }
            else if (k == KEY_ESC) { b->focus = 0; strcpy(b->edit, b->url); }
            else type_into(b->edit, URL_MAX, k);
        } else if (b->focus == 2) {
            if (k == KEY_ENTER && b->query[0]) search(b, b->query);
            else type_into(b->query, QUERY_MAX, k);
        } else if (k == KEY_DOWN) scroll_by(b, 40, view);
        else if (k == KEY_UP) scroll_by(b, -40, view);
        else if (k == KEY_PGDN || k == ' ') scroll_by(b, view - 40, view);
        else if (k == KEY_PGUP) scroll_by(b, -(view - 40), view);
        else if (k == KEY_HOME) b->scroll = 0;
        else if (k == KEY_BACKSPACE && b->hist_pos > 0) navigate(b, b->history[--b->hist_pos], false);
        else return;
        wm_invalidate(w);
        return;
    }
    if (ev->type != EV_MOUSE_DOWN) return;
    int x = ev->x, y = ev->y;
    if (y < BAR_H) {
        if (x >= 8 && x < 38 && b->hist_pos > 0) navigate(b, b->history[--b->hist_pos], false);
        else if (x >= 42 && x < 72 && b->hist_pos + 1 < b->hist_len) navigate(b, b->history[++b->hist_pos], false);
        else if (x >= 76 && x < 106) navigate(b, "kc://home", true);
        else if (x >= 114) { b->focus = 1; strcpy(b->edit, b->url); }
        wm_invalidate(w);
        return;
    }
    for (int i = 0; i < b->nlinks; i++) {
        if (rect_contains(b->links[i].r, x, y)) { char t[URL_MAX]; strcpy(t, b->links[i].url); navigate(b, t, true); wm_invalidate(w); return; }
    }
    if (strcmp(b->url, "kc://home") == 0) {
        surface *s = &w->client;
        if (rect_contains(search_box_rect(s), x, y)) b->focus = 2;
        else if (rect_contains(search_btn_rect(s), x, y) && b->query[0]) search(b, b->query);
        else if (rect_contains(lucky_btn_rect(s), x, y)) navigate(b, sites[kc_rand() % KC_ARRAY_LEN(sites)].url, true);
        else b->focus = 0;
    } else if (x > w->client.width - 14 && b->content_h > view) {
        b->scroll = KC_CLAMP((y - BAR_H) * b->content_h / view - view / 2, 0, b->content_h - view);
    } else b->focus = 0;
    wm_invalidate(w);
}

static void on_close(kc_window *w) { kfree(w->state); }

void browser_open(void)
{
    kc_window *w = wm_create("Web", -1, -1, KC_MIN(760, SCREEN_W - 140), KC_MIN(520, SCREEN_H - TASKBAR_H - 60));
    web_state *b = kcalloc(1, sizeof(web_state));
    w->state = b;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
    navigate(b, "kc://home", true);
}
KC_APP(browser, "Web", icon_globe, browser_open);

static void cmd_web(int argc, char **argv, void (*print)(const char *))
{
    browser_open();
    if (argc > 1) {
        kc_window *w = wm_focused();
        if (w && w->state) {
            char q[QUERY_MAX] = "";
            for (int i = 1; i < argc; i++) {
                if (i > 1) strcat(q, " ");
                if (strlen(q) + strlen(argv[i]) + 2 < sizeof q) strcat(q, argv[i]);
            }
            go(w->state, q);
        }
    }
    print("Opening Web\n");
}
KC_COMMAND(web, "open the web browser (web <search or address>)", cmd_web);
