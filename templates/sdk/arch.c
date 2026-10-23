/* KernelCraft SDK: IDT, 8259 PIC, PIT timer, PCI, COM1 serial, CMOS clock, panic. */
#include "kc.h"

/* ----------------------------------------------------------------- IDT --- */
#ifdef __x86_64__
typedef struct __attribute__((packed)) {
    u16 off_lo, sel;
    u8 ist, flags;
    u16 off_mid;
    u32 off_hi, zero;
} idt_entry;
typedef struct __attribute__((packed)) { u16 limit; u64 base; } idt_ptr;
extern const u64 kc_isr_table[48];
#else
typedef struct __attribute__((packed)) {
    u16 off_lo, sel;
    u8 zero, flags;
    u16 off_hi;
} idt_entry;
typedef struct __attribute__((packed)) { u16 limit; u32 base; } idt_ptr;
extern const u32 kc_isr_table[48];
#endif

static idt_entry idt[48];
static kc_irq_handler irq_handlers[16];
static volatile u64 ticks;

static void idt_set(int n, uptr handler)
{
    idt[n].off_lo = handler & 0xFFFF;
    idt[n].sel = 0x08;
    idt[n].flags = 0x8E; /* present, ring 0, interrupt gate */
#ifdef __x86_64__
    idt[n].ist = 0;
    idt[n].off_mid = (handler >> 16) & 0xFFFF;
    idt[n].off_hi = (u32)(handler >> 32);
    idt[n].zero = 0;
#else
    idt[n].zero = 0;
    idt[n].off_hi = (handler >> 16) & 0xFFFF;
#endif
}

static void pic_remap(void)
{
    outb(0x20, 0x11); io_wait();
    outb(0xA0, 0x11); io_wait();
    outb(0x21, 32); io_wait();   /* master -> vectors 32-39 */
    outb(0xA1, 40); io_wait();   /* slave  -> vectors 40-47 */
    outb(0x21, 4); io_wait();
    outb(0xA1, 2); io_wait();
    outb(0x21, 1); io_wait();
    outb(0xA1, 1); io_wait();
    outb(0x21, 0xFF);            /* everything masked until a handler is installed */
    outb(0xA1, 0xFF);
}

static void pic_unmask(int irq)
{
    if (irq >= 8) {
        outb(0xA1, inb(0xA1) & ~(1 << (irq - 8)));
        irq = 2; /* cascade */
    }
    outb(0x21, inb(0x21) & ~(1 << irq));
}

void irq_install(int irq, kc_irq_handler h)
{
    irq_handlers[irq] = h;
    pic_unmask(irq);
}

static void timer_irq(kc_frame *f) { (void)f; ticks++; }

void arch_init(void)
{
    for (int i = 0; i < 48; i++) idt_set(i, kc_isr_table[i]);
    idt_ptr p = { sizeof idt - 1, (uptr)idt };
    __asm__ volatile("lidt %0" : : "m"(p));
    pic_remap();

    u16 divisor = 1193182 / KC_TIMER_HZ;
    outb(0x43, 0x36);
    outb(0x40, divisor & 0xFF);
    outb(0x40, divisor >> 8);
    irq_install(0, timer_irq);
    cpu_sti();
}

u64 timer_ticks(void) { return ticks; }
u32 uptime_ms(void) { return (u32)(ticks * (1000 / KC_TIMER_HZ)); }

void sleep_ms(u32 ms)
{
    u64 until = ticks + (ms * KC_TIMER_HZ + 999) / 1000;
    while (ticks < until) cpu_hlt();
}

const char *kc_arch_name(void)
{
#ifdef __x86_64__
    return "x86_64 long mode";
#else
    return "i386 protected mode";
#endif
}

/* ----------------------------------------------------------------- CPU --- */
static void cpuid(u32 leaf, u32 *a, u32 *b, u32 *c, u32 *d)
{
    __asm__ volatile("cpuid" : "=a"(*a), "=b"(*b), "=c"(*c), "=d"(*d) : "a"(leaf), "c"(0));
}

void cpu_brand(char *out, size_t cap)
{
    u32 r[12], a, b, c, d;
    cpuid(0x80000000u, &a, &b, &c, &d);
    if (a < 0x80000004u) {
        cpuid(0, &a, &r[0], &r[2], &r[1]);   /* vendor string: ebx, edx, ecx */
        r[3] = 0;
    } else {
        for (u32 i = 0; i < 3; i++) cpuid(0x80000002u + i, &r[i * 4], &r[i * 4 + 1], &r[i * 4 + 2], &r[i * 4 + 3]);
    }
    const char *src = (const char *)r;
    size_t n = 0;
    while (*src == ' ') src++;
    for (; n + 1 < cap && n < 47 && src[n]; n++) out[n] = src[n];
    out[n] = 0;
}

/* Logical CPUs in the package (CPUID.1:EBX[23:16]); the VM's core count. */
int cpu_count(void)
{
    u32 a, b, c, d;
    cpuid(1, &a, &b, &c, &d);
    int n = (d & (1u << 28)) ? (int)((b >> 16) & 0xFF) : 1;
    if (n < 1) n = 1;
    if (kc_hw.cpus > 0 && n > kc_hw.cpus) n = kc_hw.cpus;
    return n;
}

/* ------------------------------------------------------------- speaker --- */
void speaker_tone(u32 hz)
{
    if (hz < 20) { speaker_off(); return; }
    u32 div = 1193182 / hz;
    outb(0x43, 0xB6);
    outb(0x42, (u8)div);
    outb(0x42, (u8)(div >> 8));
    outb(0x61, inb(0x61) | 3);
}

void speaker_off(void) { outb(0x61, inb(0x61) & 0xFC); }

static const char *exception_names[32] = {
    "Divide by zero", "Debug", "NMI", "Breakpoint", "Overflow", "Bound range",
    "Invalid opcode", "Device not available", "Double fault", "Coprocessor overrun",
    "Invalid TSS", "Segment not present", "Stack fault", "General protection fault",
    "Page fault", "Reserved", "x87 FPU error", "Alignment check", "Machine check",
    "SIMD exception", "Virtualization", "Control protection", "Reserved", "Reserved",
    "Reserved", "Reserved", "Reserved", "Reserved", "Hypervisor injection",
    "VMM communication", "Security exception", "Reserved",
};

void kc_interrupt(kc_frame *f)
{
    if (f->int_no < 32) {
        kc_panic("CPU exception %u: %s (error 0x%x) at ip=%p",
                 (u32)f->int_no, exception_names[f->int_no], (u32)f->err_code, (void *)f->ip);
    }
    int irq = (int)f->int_no - 32;
    if (irq_handlers[irq]) irq_handlers[irq](f);
    if (irq >= 8) outb(0xA0, 0x20);
    outb(0x20, 0x20);
}

/* ----------------------------------------------------------------- PCI --- */
u32 pci_read(u8 bus, u8 dev, u8 fn, u8 off)
{
    outl(0xCF8, 0x80000000u | (bus << 16) | (dev << 11) | (fn << 8) | (off & 0xFC));
    return inl(0xCFC);
}

bool pci_find(u16 vendor, u16 device, u8 *bus, u8 *dev, u8 *fn)
{
    for (int b = 0; b < 256; b++)
        for (int d = 0; d < 32; d++)
            for (int f = 0; f < 8; f++) {
                u32 id = pci_read(b, d, f, 0);
                if ((id & 0xFFFF) == 0xFFFF) { if (f == 0) break; continue; }
                if ((id & 0xFFFF) == vendor && (id >> 16) == device) {
                    *bus = b; *dev = d; *fn = f;
                    return true;
                }
            }
    return false;
}

/* -------------------------------------------------------------- serial --- */
#define COM1 0x3F8

void serial_init(void)
{
    outb(COM1 + 1, 0x00);
    outb(COM1 + 3, 0x80);
    outb(COM1 + 0, 0x01); /* 115200 baud */
    outb(COM1 + 1, 0x00);
    outb(COM1 + 3, 0x03);
    outb(COM1 + 2, 0xC7);
    outb(COM1 + 4, 0x0B);
}

void serial_putc(char c)
{
    for (int i = 0; i < 100000 && !(inb(COM1 + 5) & 0x20); i++) {}
    outb(COM1, c);
}

void kc_log(const char *fmt, ...)
{
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    kc_vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    for (char *p = buf; *p; p++) {
        if (*p == '\n') serial_putc('\r');
        serial_putc(*p);
    }
    serial_putc('\r');
    serial_putc('\n');
}

/* ----------------------------------------------------------------- RTC --- */
static u8 cmos(u8 reg) { outb(0x70, reg); return inb(0x71); }
static u8 from_bcd(u8 v) { return (v & 0x0F) + (v >> 4) * 10; }

void rtc_read(kc_time *t)
{
    while (cmos(0x0A) & 0x80) {}
    bool bcd = !(cmos(0x0B) & 0x04);
    u8 s = cmos(0), m = cmos(2), h = cmos(4), d = cmos(7), mo = cmos(8), y = cmos(9);
    if (bcd) { s = from_bcd(s); m = from_bcd(m); h = from_bcd(h & 0x7F) | (h & 0x80); d = from_bcd(d); mo = from_bcd(mo); y = from_bcd(y); }
    t->sec = s; t->min = m; t->hour = h & 0x7F; t->day = d; t->month = mo; t->year = 2000 + y;
}

/* --------------------------------------------------------------- panic --- */
void kc_panic(const char *fmt, ...)
{
    cpu_cli();
    char msg[200];
    va_list ap;
    va_start(ap, fmt);
    kc_vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    kc_log("KERNEL PANIC: %s", msg);

    surface *s = gfx_screen();
    if (s && s->pixels) {
        fill_rect(s, 0, 0, SCREEN_W, SCREEN_H, RGB(20, 40, 140));
        draw_text_scaled(s, 60, 80, ":(", RGB(255, 255, 255), 6);
        draw_text_scaled(s, 60, 200, "Kernel panic", RGB(255, 255, 255), 2);
        draw_text(s, 60, 250, msg, RGB(255, 255, 255));
        draw_text(s, 60, 280, "The system has been halted. Details were written to COM1.", RGB(190, 200, 255));
        gfx_present();
    }
    for (;;) cpu_hlt();
}
