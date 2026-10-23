/*
 * KernelCraft SDK: the base layer every 32/64-bit KernelCraft OS builds on.
 *
 * Boot: boot.asm loads the kernel to 0x10000, copies the BIOS 8x16 font to
 * 0x6000 and enters protected mode; entry.asm (long mode on 64-bit) calls
 * kmain() in kernel.c, which brings up the subsystems below and runs the
 * window manager's event loop.
 *
 * Memory map: 0x6000 font | 0x10000 kernel (+bss, must end below 0x70000)
 *             0x70000 page tables (64-bit) | 0x90000 stack top
 *             0x200000.. heap (kmalloc) up to the end of RAM
 *
 * Extending the OS without touching the SDK:
 *   KC_APP(id, "Title", icon_fn, launch_fn)   adds a desktop icon + start menu entry
 *   KC_COMMAND(name, "help", fn)              adds a terminal command
 *   KC_BOOT_HOOK(fn)                          runs after the SDK is up, before the desktop
 * Each macro drops a record into a linker section the SDK walks at boot.
 */
#ifndef KC_H
#define KC_H

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef signed char i8;
typedef short i16;
typedef int i32;
typedef long long i64;
typedef unsigned long uptr;
typedef unsigned long size_t;
typedef int bool;
#define true 1
#define false 0
#define NULL ((void *)0)

#define KC_MIN(a, b) ((a) < (b) ? (a) : (b))
#define KC_MAX(a, b) ((a) > (b) ? (a) : (b))
#define KC_CLAMP(v, lo, hi) KC_MIN(KC_MAX(v, lo), hi)
#define KC_ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))

typedef __builtin_va_list va_list;
#define va_start(ap, last) __builtin_va_start(ap, last)
#define va_arg(ap, type) __builtin_va_arg(ap, type)
#define va_end(ap) __builtin_va_end(ap)

/* ---------------------------------------------------------------- arch --- */
static inline void outb(u16 port, u8 v) { __asm__ volatile("outb %0, %1" : : "a"(v), "Nd"(port)); }
static inline void outw(u16 port, u16 v) { __asm__ volatile("outw %0, %1" : : "a"(v), "Nd"(port)); }
static inline void outl(u16 port, u32 v) { __asm__ volatile("outl %0, %1" : : "a"(v), "Nd"(port)); }
static inline u8 inb(u16 port) { u8 v; __asm__ volatile("inb %1, %0" : "=a"(v) : "Nd"(port)); return v; }
static inline u16 inw(u16 port) { u16 v; __asm__ volatile("inw %1, %0" : "=a"(v) : "Nd"(port)); return v; }
static inline u32 inl(u16 port) { u32 v; __asm__ volatile("inl %1, %0" : "=a"(v) : "Nd"(port)); return v; }
static inline void io_wait(void) { outb(0x80, 0); }
static inline void cpu_sti(void) { __asm__ volatile("sti"); }
static inline void cpu_cli(void) { __asm__ volatile("cli"); }
static inline void cpu_hlt(void) { __asm__ volatile("hlt"); }

/* Register frame pushed by the ISR stubs in entry.asm. */
#ifdef __x86_64__
typedef struct {
    u64 r15, r14, r13, r12, r11, r10, r9, r8, rbp, rdi, rsi, rdx, rcx, rbx, rax;
    u64 int_no, err_code;
    u64 ip, cs, flags, sp, ss;
} kc_frame;
#else
typedef struct {
    u32 gs, fs, es, ds;
    u32 edi, esi, ebp, esp_dummy, ebx, edx, ecx, eax;
    u32 int_no, err_code;
    u32 ip, cs, flags;
} kc_frame;
#endif

typedef void (*kc_irq_handler)(kc_frame *f);
void arch_init(void);                    /* IDT, PIC remap, PIT */
void irq_install(int irq, kc_irq_handler h);
u64 timer_ticks(void);                   /* incremented at KC_TIMER_HZ */
#define KC_TIMER_HZ 100
u32 uptime_ms(void);
void sleep_ms(u32 ms);
void kc_panic(const char *fmt, ...);
const char *kc_arch_name(void);

/* The virtual machine this OS was built for (set in the Studio's Hardware
 * panel; the build engine generates kc_config.c with these values). */
typedef struct {
    int width, height;     /* screen resolution */
    int ram_mb, vram_mb;   /* RAM and graphics memory */
    int cpus;              /* CPU cores the VM has (the SDK runs on the boot CPU) */
    const char *cpu_model; /* "basic" or "modern" */
} kc_hw_config;
extern const kc_hw_config kc_hw;

/* CPUID: brand string ("QEMU Virtual CPU ...") and logical CPU count. */
void cpu_brand(char *out, size_t cap);
int cpu_count(void);

/* PC speaker (PIT channel 2). */
void speaker_tone(u32 hz);
void speaker_off(void);

/* PCI config space (mechanism #1) */
u32 pci_read(u8 bus, u8 dev, u8 fn, u8 off);
bool pci_find(u16 vendor, u16 device, u8 *bus, u8 *dev, u8 *fn);

/* COM1 serial: kc_log() lines show up in the IDE's serial console and the
 * build engine's critic, so log generously. */
void serial_init(void);
void serial_putc(char c);
void kc_log(const char *fmt, ...);

/* CMOS real-time clock */
typedef struct { u8 sec, min, hour, day, month; u16 year; } kc_time;
void rtc_read(kc_time *t);

/* -------------------------------------------------------------- memory --- */
void mem_init(void);
void *kmalloc(size_t n);
void *kcalloc(size_t n, size_t size);
void *krealloc(void *p, size_t n);
void kfree(void *p);
size_t mem_total(void);
size_t mem_used(void);

/* -------------------------------------------------------------- string --- */
void *memset(void *d, int c, size_t n);
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t n);
char *strcpy(char *d, const char *s);
char *strncpy(char *d, const char *s, size_t n);
char *strcat(char *d, const char *s);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strdup(const char *s);
int atoi(const char *s);
int kc_isspace(int c);
int kc_isdigit(int c);
int kc_isalpha(int c);
int kc_toupper(int c);
int kc_tolower(int c);
int kc_vsnprintf(char *buf, size_t n, const char *fmt, va_list ap);
int kc_snprintf(char *buf, size_t n, const char *fmt, ...);  /* %d %u %x %p %s %c %% and widths */
u32 kc_rand(void);

/* ------------------------------------------------------------ graphics --- */
typedef u32 color;   /* 0x00RRGGBB */
#define RGB(r, g, b) ((color)(((r) << 16) | ((g) << 8) | (b)))

typedef struct { int x, y, w, h; } rect;
bool rect_contains(rect r, int x, int y);
bool rect_intersects(rect a, rect b);

/* A drawing surface: the screen back buffer or a window's client area. */
typedef struct {
    color *pixels;
    int width, height, stride;   /* stride in pixels */
    rect clip;                    /* in surface coordinates */
} surface;

extern int SCREEN_W, SCREEN_H;
void gfx_init(int w, int h);      /* Bochs/QEMU/v86 BGA linear framebuffer, 32bpp */
surface *gfx_screen(void);        /* back buffer */
void gfx_present(void);           /* back buffer -> LFB (cursor drawn on top) */
void gfx_present_rect(rect r);
void gfx_move_cursor(int x, int y);  /* hardware-style cursor drawn over the LFB */
u32 gfx_vram_kb(void);            /* graphics memory reported by the adapter */
const char *gfx_adapter_name(void);

void draw_pixel(surface *s, int x, int y, color c);
void fill_rect(surface *s, int x, int y, int w, int h, color c);
void draw_rect(surface *s, int x, int y, int w, int h, color c);
void fill_round_rect(surface *s, int x, int y, int w, int h, int radius, color c);
void draw_line(surface *s, int x0, int y0, int x1, int y1, color c);
void draw_circle(surface *s, int cx, int cy, int r, color c, bool filled);
void fill_gradient_v(surface *s, int x, int y, int w, int h, color top, color bottom);
void fill_rect_alpha(surface *s, int x, int y, int w, int h, color c, u8 alpha);
void blit(surface *dst, int x, int y, const color *src, int w, int h, int src_stride);
color color_mix(color a, color b, u8 t); /* t=0 -> a, 255 -> b */

#define FONT_W 8
#define FONT_H 16
void draw_char(surface *s, int x, int y, char ch, color c);
int draw_text(surface *s, int x, int y, const char *text, color c);      /* returns end x */
void draw_text_scaled(surface *s, int x, int y, const char *text, color c, int scale);
int text_width(const char *text);

/* --------------------------------------------------------------- input --- */
enum {
    KEY_ESC = 27, KEY_BACKSPACE = 8, KEY_TAB = 9, KEY_ENTER = 10,
    KEY_UP = 0x100, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_HOME, KEY_END,
    KEY_PGUP, KEY_PGDN, KEY_DELETE, KEY_F1, KEY_F2, KEY_F3, KEY_F4,
    KEY_F5, KEY_F6, KEY_F7, KEY_F8, KEY_F9, KEY_F10, KEY_F11, KEY_F12,
};
#define MOD_SHIFT 1
#define MOD_CTRL 2
#define MOD_ALT 4

typedef enum { EV_NONE, EV_KEY, EV_MOUSE_MOVE, EV_MOUSE_DOWN, EV_MOUSE_UP, EV_TICK } kc_event_type;
typedef struct {
    kc_event_type type;
    int key;            /* EV_KEY: ASCII or KEY_* */
    int mods;           /* MOD_* */
    int x, y;           /* mouse position (screen coords; window-relative when delivered to a window) */
    int buttons;        /* bit0 left, bit1 right, bit2 middle */
} kc_event;

void input_init(void);
bool input_poll(kc_event *ev);      /* pops one queued event */
int mouse_x(void);
int mouse_y(void);

/* --------------------------------------------------------- filesystem --- */
/* In-memory hierarchical filesystem. Paths are absolute ("/home/readme.txt"). */
typedef struct kc_node kc_node;
struct kc_node {
    char name[48];
    bool is_dir;
    char *data;
    size_t size, cap;
    kc_node *parent, *child, *next;
};
void fs_init(void);
kc_node *fs_root(void);
kc_node *fs_lookup(const char *path);
kc_node *fs_mkdir(const char *path);           /* creates parents */
kc_node *fs_write(const char *path, const char *data, size_t n);   /* create or replace */
kc_node *fs_append(const char *path, const char *data, size_t n);
bool fs_remove(const char *path);
void fs_path(kc_node *n, char *out, size_t cap);
int fs_count(kc_node *dir);

/* -------------------------------------------------------- window manager --- */
typedef struct kc_window kc_window;
typedef void (*kc_paint_fn)(kc_window *w, surface *s);
typedef void (*kc_event_fn)(kc_window *w, kc_event *ev);
typedef void (*kc_close_fn)(kc_window *w);

struct kc_window {
    int id;
    char title[64];
    rect frame;            /* outer rect in screen coords */
    surface client;        /* client area surface, own pixel buffer */
    kc_paint_fn on_paint;  /* draw the client area */
    kc_event_fn on_event;  /* key + mouse events (client coordinates) */
    kc_close_fn on_close;  /* free your state; window memory is freed by the WM */
    void *state;           /* app data */
    u32 tick_ms;           /* >0: EV_TICK every tick_ms (games, clocks); 0: every 500 ms */
    u32 next_tick;
    bool minimized, maximized, dirty;
    rect restore_frame;
    kc_window *next;       /* z-order list, bottom to top */
};

typedef struct {
    color desktop_top, desktop_bottom;  /* wallpaper gradient */
    color accent, accent_text;
    color window_bg, window_text, title_active, title_inactive, title_text;
    color taskbar, taskbar_text, menu_bg, menu_hover;
    int radius;                         /* window corner radius */
    const char *os_name;
    void (*draw_wallpaper)(surface *s); /* optional: replaces the gradient */
} kc_theme;
extern kc_theme theme;

#define TITLE_H 26
#define TASKBAR_H 36

void wm_init(void);
kc_window *wm_create(const char *title, int x, int y, int client_w, int client_h);
void wm_close(kc_window *w);
void wm_focus(kc_window *w);
kc_window *wm_focused(void);
void wm_invalidate(kc_window *w);   /* repaint this window soon */
void wm_invalidate_all(void);
void wm_run(void);                  /* never returns */
void wm_notify(const char *text);   /* toast message */
void wm_rebuild_wallpaper(void);    /* call after changing theme colours */
int wm_window_count(void);

/* ---------------------------------------------------- extension points --- */
typedef void (*kc_icon_fn)(surface *s, int x, int y);   /* draw a 32x32 icon */
typedef struct {
    const char *id;
    const char *title;
    kc_icon_fn icon;
    void (*launch)(void);
} kc_app;

typedef struct {
    const char *name;
    const char *help;
    void (*run)(int argc, char **argv, void (*print)(const char *));
} kc_command;

typedef void (*kc_hook)(void);

#define KC_USED __attribute__((used))
#define KC_APP(ident, title, icon_fn, launch_fn) \
    static const kc_app kc_app_##ident = { #ident, title, icon_fn, launch_fn }; \
    static const kc_app *kc_app_ptr_##ident KC_USED __attribute__((section(".kc_apps"))) = &kc_app_##ident
#define KC_COMMAND(ident, help_text, fn) \
    static const kc_command kc_cmd_##ident = { #ident, help_text, fn }; \
    static const kc_command *kc_cmd_ptr_##ident KC_USED __attribute__((section(".kc_commands"))) = &kc_cmd_##ident
#define KC_BOOT_HOOK(fn) \
    static const kc_hook kc_hook_ptr_##fn KC_USED __attribute__((section(".kc_hooks"))) = fn

extern const kc_app *__kc_apps_start[], *__kc_apps_end[];
extern const kc_command *__kc_commands_start[], *__kc_commands_end[];
extern const kc_hook __kc_hooks_start[], __kc_hooks_end[];

int kc_app_count(void);
const kc_app *kc_app_at(int i);
const kc_app *kc_app_find(const char *id);
const kc_command *kc_command_find(const char *name);

/* Built-in icon painters apps can reuse. */
void icon_terminal(surface *s, int x, int y);
void icon_folder(surface *s, int x, int y);
void icon_document(surface *s, int x, int y);
void icon_chart(surface *s, int x, int y);
void icon_gear(surface *s, int x, int y);
void icon_info(surface *s, int x, int y);
void icon_calculator(surface *s, int x, int y);
void icon_globe(surface *s, int x, int y);
void icon_brush(surface *s, int x, int y);
void icon_game(surface *s, int x, int y);
void icon_clock(surface *s, int x, int y);
void icon_calendar(surface *s, int x, int y);
void icon_music(surface *s, int x, int y);

/* Shell: run a command line, output via print. cwd is shared by all terminals. */
void shell_execute(const char *line, void (*print)(const char *));
const char *shell_cwd(void);
void shell_resolve(const char *path, char *out, size_t cap);  /* relative -> absolute */

#endif
