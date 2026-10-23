/* KernelCraft SDK: PS/2 keyboard (IRQ1) and mouse (IRQ12) into an event queue. */
#include "kc.h"

#define QUEUE_LEN 256
static kc_event queue[QUEUE_LEN];
static volatile int q_head, q_tail;
static int mods;
static bool caps, extended;
static int mx, my, mbuttons;

static void push(kc_event ev)
{
    int next = (q_head + 1) % QUEUE_LEN;
    if (next == q_tail) return; /* full: drop */
    queue[q_head] = ev;
    q_head = next;
}

bool input_poll(kc_event *ev)
{
    cpu_cli();
    bool have = q_tail != q_head;
    if (have) {
        *ev = queue[q_tail];
        q_tail = (q_tail + 1) % QUEUE_LEN;
    }
    cpu_sti();
    return have;
}

int mouse_x(void) { return mx; }
int mouse_y(void) { return my; }

/* ---------------------------------------------------------------- keyboard --- */
static const char map_lower[128] = {
    0, 27, '1','2','3','4','5','6','7','8','9','0','-','=', 8, 9,
    'q','w','e','r','t','y','u','i','o','p','[',']', 10, 0,
    'a','s','d','f','g','h','j','k','l',';','\'','`', 0, '\\',
    'z','x','c','v','b','n','m',',','.','/', 0, '*', 0, ' ',
};
static const char map_upper[128] = {
    0, 27, '!','@','#','$','%','^','&','*','(',')','_','+', 8, 9,
    'Q','W','E','R','T','Y','U','I','O','P','{','}', 10, 0,
    'A','S','D','F','G','H','J','K','L',':','"','~', 0, '|',
    'Z','X','C','V','B','N','M','<','>','?', 0, '*', 0, ' ',
};

static void keyboard_irq(kc_frame *f)
{
    (void)f;
    u8 sc = inb(0x60);
    if (sc == 0xE0) { extended = true; return; }
    bool release = sc & 0x80;
    sc &= 0x7F;

    if (sc == 0x2A || sc == 0x36) { mods = release ? mods & ~MOD_SHIFT : mods | MOD_SHIFT; extended = false; return; }
    if (sc == 0x1D) { mods = release ? mods & ~MOD_CTRL : mods | MOD_CTRL; extended = false; return; }
    if (sc == 0x38) { mods = release ? mods & ~MOD_ALT : mods | MOD_ALT; extended = false; return; }
    if (release) { extended = false; return; }
    if (sc == 0x3A) { caps = !caps; return; }

    int key = 0;
    if (extended) {
        switch (sc) {
        case 0x48: key = KEY_UP; break;
        case 0x50: key = KEY_DOWN; break;
        case 0x4B: key = KEY_LEFT; break;
        case 0x4D: key = KEY_RIGHT; break;
        case 0x47: key = KEY_HOME; break;
        case 0x4F: key = KEY_END; break;
        case 0x49: key = KEY_PGUP; break;
        case 0x51: key = KEY_PGDN; break;
        case 0x53: key = KEY_DELETE; break;
        case 0x1C: key = KEY_ENTER; break;
        case 0x35: key = '/'; break;
        }
        extended = false;
    } else if (sc >= 0x3B && sc <= 0x44) {
        key = KEY_F1 + (sc - 0x3B);
    } else if (sc == 0x57 || sc == 0x58) {
        key = sc == 0x57 ? KEY_F11 : KEY_F12;
    } else if (sc < 128) {
        bool shift = (mods & MOD_SHIFT) != 0;
        char c = shift ? map_upper[sc] : map_lower[sc];
        if (caps && kc_isalpha(c)) c = shift ? kc_tolower(c) : kc_toupper(c);
        key = c;
    }
    if (key) push((kc_event){ .type = EV_KEY, .key = key, .mods = mods, .x = mx, .y = my, .buttons = mbuttons });
}

/* ------------------------------------------------------------------- mouse --- */
static void ps2_wait_write(void) { for (int i = 0; i < 100000 && (inb(0x64) & 2); i++) {} }
static void ps2_wait_read(void) { for (int i = 0; i < 100000 && !(inb(0x64) & 1); i++) {} }

static void mouse_write(u8 v)
{
    ps2_wait_write();
    outb(0x64, 0xD4);
    ps2_wait_write();
    outb(0x60, v);
    ps2_wait_read();
    inb(0x60); /* ACK */
}

static u8 packet[3];
static int packet_i;

static void mouse_irq(kc_frame *f)
{
    (void)f;
    u8 b = inb(0x60);
    if (packet_i == 0 && !(b & 0x08)) return; /* resync: bit 3 is always set in byte 0 */
    packet[packet_i++] = b;
    if (packet_i < 3) return;
    packet_i = 0;

    int dx = packet[1] - ((packet[0] & 0x10) ? 256 : 0);
    int dy = packet[2] - ((packet[0] & 0x20) ? 256 : 0);
    int buttons = packet[0] & 7;
    mx = KC_CLAMP(mx + dx, 0, SCREEN_W - 1);
    my = KC_CLAMP(my - dy, 0, SCREEN_H - 1);

    if (dx || dy) push((kc_event){ .type = EV_MOUSE_MOVE, .x = mx, .y = my, .buttons = buttons, .mods = mods });
    int changed = buttons ^ mbuttons;
    mbuttons = buttons;
    if (changed) push((kc_event){ .type = (buttons & changed) ? EV_MOUSE_DOWN : EV_MOUSE_UP, .x = mx, .y = my, .buttons = changed, .mods = mods });
}

void input_init(void)
{
    mx = SCREEN_W / 2;
    my = SCREEN_H / 2;
    while (inb(0x64) & 1) inb(0x60);   /* flush */

    ps2_wait_write();
    outb(0x64, 0xA8);                  /* enable aux port */
    ps2_wait_write();
    outb(0x64, 0x20);                  /* read controller config */
    ps2_wait_read();
    u8 cfg = inb(0x60) | 0x03;         /* enable IRQ1 + IRQ12 */
    cfg &= ~0x20;                      /* enable mouse clock */
    ps2_wait_write();
    outb(0x64, 0x60);
    ps2_wait_write();
    outb(0x60, cfg);

    mouse_write(0xF6);                 /* defaults */
    mouse_write(0xF4);                 /* enable streaming */

    irq_install(1, keyboard_irq);
    irq_install(12, mouse_irq);
    kc_log("input: PS/2 keyboard + mouse ready");
}
