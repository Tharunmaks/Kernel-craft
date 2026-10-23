/*
 * KernelCraft 32-bit protected-mode kernel (template)
 *
 * Runs at 0x10000 after boot.asm has set VGA mode 13h (320x200x256, linear
 * framebuffer at 0xA0000) and copied the BIOS 8x8 font to 0x6000.
 * Freestanding: no libc, no interrupts. Draws a desktop with a taskbar,
 * an "About" window and a terminal window that accepts PS/2 keyboard input
 * by polling port 0x60.
 */

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define SCREEN_W 320
#define SCREEN_H 200
#define VGA ((volatile u8 *)0xA0000)
#define FONT ((const u8 *)0x6000)

/* Palette slots we reprogram (indices 0-15 keep the classic EGA colours). */
enum {
    C_DESK_TOP = 32, C_DESK_BOT = 47, /* 16-step gradient 32..47 */
    C_BAR = 48, C_BAR_HI, C_ACCENT, C_WIN, C_WIN_TITLE, C_TEXT, C_TERM_BG, C_TERM_FG, C_SHADOW
};

static u8 backbuf[SCREEN_W * SCREEN_H];

/* ------------------------------------------------------------------ io --- */
static inline void outb(u16 port, u8 v) { __asm__ volatile("outb %0, %1" : : "a"(v), "Nd"(port)); }
static inline u8 inb(u16 port) { u8 v; __asm__ volatile("inb %1, %0" : "=a"(v) : "Nd"(port)); return v; }

void *memset(void *d, int c, u32 n) { u8 *p = d; while (n--) *p++ = (u8)c; return d; }
void *memcpy(void *d, const void *s, u32 n) { u8 *p = d; const u8 *q = s; while (n--) *p++ = *q++; return d; }

static void set_palette(u8 idx, u8 r, u8 g, u8 b) /* 0-63 per channel */
{
    outb(0x3C8, idx);
    outb(0x3C9, r);
    outb(0x3C9, g);
    outb(0x3C9, b);
}

/* ------------------------------------------------------------- drawing --- */
static void fill_rect(int x, int y, int w, int h, u8 c)
{
    for (int j = y; j < y + h; j++) {
        if (j < 0 || j >= SCREEN_H) continue;
        for (int i = x; i < x + w; i++)
            if (i >= 0 && i < SCREEN_W) backbuf[j * SCREEN_W + i] = c;
    }
}

static void draw_char(int x, int y, char ch, u8 c)
{
    const u8 *glyph = FONT + (u8)ch * 8;
    for (int row = 0; row < 8; row++)
        for (int col = 0; col < 8; col++)
            if (glyph[row] & (0x80 >> col)) {
                int px = x + col, py = y + row;
                if (px >= 0 && px < SCREEN_W && py >= 0 && py < SCREEN_H)
                    backbuf[py * SCREEN_W + px] = c;
            }
}

static void draw_text(int x, int y, const char *s, u8 c)
{
    for (; *s; s++, x += 8) draw_char(x, y, *s, c);
}

static void present(void)
{
    for (u32 i = 0; i < SCREEN_W * SCREEN_H; i++) VGA[i] = backbuf[i];
}

static void draw_window(int x, int y, int w, int h, const char *title, u8 body)
{
    fill_rect(x + 3, y + 3, w, h, C_SHADOW);
    fill_rect(x, y, w, h, body);
    fill_rect(x, y, w, 11, C_WIN_TITLE);
    draw_text(x + 4, y + 2, title, 15);
    fill_rect(x + w - 10, y + 2, 7, 7, 12); /* close button */
}

/* ---------------------------------------------------------------- clock --- */
static u8 cmos(u8 reg) { outb(0x70, reg); return inb(0x71); }
static u8 bcd(u8 v) { return (v & 0x0F) + (v >> 4) * 10; }

static void clock_text(char *out)
{
    u8 h = bcd(cmos(4)), m = bcd(cmos(2));
    out[0] = '0' + h / 10; out[1] = '0' + h % 10; out[2] = ':';
    out[3] = '0' + m / 10; out[4] = '0' + m % 10; out[5] = 0;
}

/* ------------------------------------------------------------- terminal --- */
#define TERM_X 20
#define TERM_Y 92
#define TERM_W 200
#define TERM_H 84
#define TERM_COLS ((TERM_W - 8) / 8)
#define TERM_ROWS ((TERM_H - 16) / 9)

static char term[TERM_ROWS][TERM_COLS + 1];
static int term_row;
static char line[TERM_COLS + 1];
static int line_len;

static void term_newline(void)
{
    if (term_row < TERM_ROWS - 1) { term_row++; return; }
    for (int r = 0; r < TERM_ROWS - 1; r++) memcpy(term[r], term[r + 1], TERM_COLS + 1);
    memset(term[TERM_ROWS - 1], 0, TERM_COLS + 1);
}

static void term_print(const char *s)
{
    int col = 0;
    while (term[term_row][col]) col++;
    for (; *s; s++) {
        if (*s == '\n' || col >= TERM_COLS) { term_newline(); col = 0; if (*s == '\n') continue; }
        term[term_row][col++] = *s;
        term[term_row][col] = 0;
    }
}

static int streq(const char *a, const char *b)
{
    while (*a && *a == *b) a++, b++;
    return *a == *b;
}

static void run_command(void)
{
    if (streq(line, "help"))       term_print("help clear about ls\n");
    else if (streq(line, "about")) term_print("KernelCraft 32-bit PM\n");
    else if (streq(line, "ls"))    term_print("boot.bin kernel.bin\n");
    else if (streq(line, "clear")) { memset(term, 0, sizeof term); term_row = 0; }
    else if (line_len)             term_print("unknown command\n");
    term_print("> ");
}

/* scancode set 1 -> ASCII (unshifted) */
static const char keymap[58] = {
    0, 27, '1','2','3','4','5','6','7','8','9','0','-','=', 8, 9,
    'q','w','e','r','t','y','u','i','o','p','[',']','\n', 0,
    'a','s','d','f','g','h','j','k','l',';','\'','`', 0,'\\',
    'z','x','c','v','b','n','m',',','.','/', 0, '*', 0, ' '
};

static void handle_key(char c)
{
    char echo[2] = { c, 0 };
    if (c == '\n') {
        term_print("\n");
        line[line_len] = 0;
        run_command();
        line_len = 0;
    } else if (c == 8) {
        if (line_len) {
            int col = 0;
            while (term[term_row][col]) col++;
            if (col) term[term_row][col - 1] = 0;
            line_len--;
        }
    } else if (line_len < TERM_COLS - 3) {
        line[line_len++] = c;
        term_print(echo);
    }
}

/* ---------------------------------------------------------------- scene --- */
static void render(int cursor_on)
{
    /* desktop gradient */
    for (int y = 0; y < SCREEN_H - 14; y++)
        fill_rect(0, y, SCREEN_W, 1, C_DESK_TOP + (y * 16) / (SCREEN_H - 14));

    /* desktop icons */
    const char *icons[] = { "Files", "Term", "Disk" };
    for (int i = 0; i < 3; i++) {
        fill_rect(270, 10 + i * 36, 20, 16, C_ACCENT);
        fill_rect(272, 12 + i * 36, 16, 12, C_BAR);
        draw_text(260, 28 + i * 36, icons[i], 15);
    }

    /* about window */
    draw_window(40, 14, 200, 66, "About KernelCraft", C_WIN);
    draw_text(48, 30, "32-bit Protected Mode", C_TEXT);
    draw_text(48, 42, "VGA 320x200x256", C_TEXT);
    draw_text(48, 54, "Kernel @ 0x00010000", C_TEXT);
    fill_rect(48, 66, 60, 1, C_ACCENT);

    /* terminal window */
    draw_window(TERM_X, TERM_Y, TERM_W, TERM_H, "Terminal", C_TERM_BG);
    for (int r = 0; r < TERM_ROWS; r++)
        draw_text(TERM_X + 4, TERM_Y + 14 + r * 9, term[r], C_TERM_FG);
    if (cursor_on) {
        int col = 0;
        while (term[term_row][col]) col++;
        fill_rect(TERM_X + 4 + col * 8, TERM_Y + 14 + term_row * 9 + 7, 7, 1, C_TERM_FG);
    }

    /* taskbar */
    fill_rect(0, SCREEN_H - 14, SCREEN_W, 14, C_BAR);
    fill_rect(0, SCREEN_H - 14, SCREEN_W, 1, C_BAR_HI);
    fill_rect(2, SCREEN_H - 12, 44, 10, C_ACCENT);
    draw_text(6, SCREEN_H - 11, "Start", 0);
    fill_rect(52, SCREEN_H - 12, 70, 10, C_BAR_HI);
    draw_text(56, SCREEN_H - 11, "Terminal", 15);
    char clk[6];
    clock_text(clk);
    draw_text(SCREEN_W - 46, SCREEN_H - 11, clk, 15);

    present();
}

void kmain(void)
{
    for (int i = 0; i < 16; i++) /* deep navy -> neon blue gradient */
        set_palette(C_DESK_TOP + i, 2 + i / 2, 4 + i, 14 + i * 2);
    set_palette(C_BAR, 4, 6, 14);
    set_palette(C_BAR_HI, 10, 14, 28);
    set_palette(C_ACCENT, 0, 50, 63);
    set_palette(C_WIN, 52, 54, 58);
    set_palette(C_WIN_TITLE, 6, 20, 44);
    set_palette(C_TEXT, 4, 6, 12);
    set_palette(C_TERM_BG, 2, 3, 6);
    set_palette(C_TERM_FG, 10, 63, 40);
    set_palette(C_SHADOW, 1, 2, 6);

    term_print("KernelCraft shell ready\n> ");

    u32 ticks = 0;
    int dirty = 1, cursor_on = 1;
    for (;;) {
        if (inb(0x64) & 1) {
            u8 sc = inb(0x60);
            if (sc < sizeof keymap && keymap[sc]) { handle_key(keymap[sc]); dirty = 1; }
        }
        if (++ticks % 400000 == 0) { cursor_on = !cursor_on; dirty = 1; }
        if (dirty) { render(cursor_on); dirty = 0; }
    }
}
