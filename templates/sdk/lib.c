/* KernelCraft SDK: heap allocator, string functions, formatted printing. */
#include "kc.h"

/* ---------------------------------------------------------------- heap --- */
/* First-fit free list with coalescing. Heap spans 2MB .. end of RAM. */
typedef struct block {
    size_t size;          /* payload bytes */
    bool free;
    struct block *next;
} block;

#define HEAP_START 0x200000u
#define ALIGN16(n) (((n) + 15) & ~(size_t)15)

static block *heap_head;
static size_t heap_size, heap_used;

static size_t detect_ram(void)
{
    /* CMOS 0x34/0x35: RAM above 16MB in 64KB blocks; 0x30/0x31: 1MB-16MB in KB. */
    outb(0x70, 0x34); u32 lo = inb(0x71);
    outb(0x70, 0x35); u32 hi = inb(0x71);
    size_t above16 = ((hi << 8) | lo) * 64 * 1024;
    if (above16) return 16 * 1024 * 1024 + above16;
    outb(0x70, 0x30); lo = inb(0x71);
    outb(0x70, 0x31); hi = inb(0x71);
    return 1024 * 1024 + ((hi << 8) | lo) * 1024;
}

void mem_init(void)
{
    size_t ram = detect_ram();
    if (ram > 0xC0000000u) ram = 0xC0000000u; /* stay clear of MMIO */
    if (ram < HEAP_START + 4 * 1024 * 1024) ram = HEAP_START + 4 * 1024 * 1024;
    heap_size = ram - HEAP_START;
    heap_head = (block *)(uptr)HEAP_START;
    heap_head->size = heap_size - sizeof(block);
    heap_head->free = true;
    heap_head->next = NULL;
    kc_log("mem: %u MB RAM, heap %u KB at 0x%x", (u32)(ram >> 20), (u32)(heap_size >> 10), HEAP_START);
}

void *kmalloc(size_t n)
{
    n = ALIGN16(n ? n : 1);
    for (block *b = heap_head; b; b = b->next) {
        if (!b->free || b->size < n) continue;
        if (b->size >= n + sizeof(block) + 64) {
            block *rest = (block *)((u8 *)(b + 1) + n);
            rest->size = b->size - n - sizeof(block);
            rest->free = true;
            rest->next = b->next;
            b->next = rest;
            b->size = n;
        }
        b->free = false;
        heap_used += b->size + sizeof(block);
        return b + 1;
    }
    kc_panic("kmalloc: out of memory (%u bytes requested, %u KB used)", (u32)n, (u32)(heap_used >> 10));
    return NULL;
}

void *kcalloc(size_t n, size_t size)
{
    void *p = kmalloc(n * size);
    memset(p, 0, n * size);
    return p;
}

void kfree(void *p)
{
    if (!p) return;
    block *b = (block *)p - 1;
    if (b->free) return;
    b->free = true;
    heap_used -= b->size + sizeof(block);
    for (block *c = heap_head; c; c = c->next) {
        while (c->free && c->next && c->next->free && (u8 *)(c + 1) + c->size == (u8 *)c->next) {
            c->size += sizeof(block) + c->next->size;
            c->next = c->next->next;
        }
    }
}

void *krealloc(void *p, size_t n)
{
    if (!p) return kmalloc(n);
    block *b = (block *)p - 1;
    if (b->size >= n) return p;
    void *q = kmalloc(n);
    memcpy(q, p, b->size);
    kfree(p);
    return q;
}

size_t mem_total(void) { return heap_size; }
size_t mem_used(void) { return heap_used; }

/* -------------------------------------------------------------- string --- */
void *memset(void *d, int c, size_t n)
{
    u8 *p = d;
    while (n--) *p++ = (u8)c;
    return d;
}

void *memcpy(void *d, const void *s, size_t n)
{
    u8 *p = d;
    const u8 *q = s;
    while (n--) *p++ = *q++;
    return d;
}

void *memmove(void *d, const void *s, size_t n)
{
    u8 *p = d;
    const u8 *q = s;
    if (p < q) while (n--) *p++ = *q++;
    else { p += n; q += n; while (n--) *--p = *--q; }
    return d;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const u8 *p = a, *q = b;
    for (; n; n--, p++, q++) if (*p != *q) return *p - *q;
    return 0;
}

size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return (u8)*a - (u8)*b; }
int strncmp(const char *a, const char *b, size_t n)
{
    for (; n; n--, a++, b++) {
        if (*a != *b) return (u8)*a - (u8)*b;
        if (!*a) return 0;
    }
    return 0;
}
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)) {} return r; }
char *strncpy(char *d, const char *s, size_t n)
{
    size_t i = 0;
    for (; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = 0;
    return d;
}
char *strcat(char *d, const char *s) { strcpy(d + strlen(d), s); return d; }
char *strchr(const char *s, int c) { for (; *s; s++) if (*s == (char)c) return (char *)s; return c ? NULL : (char *)s; }
char *strrchr(const char *s, int c) { const char *r = NULL; for (; *s; s++) if (*s == (char)c) r = s; return (char *)r; }
char *strdup(const char *s) { char *d = kmalloc(strlen(s) + 1); return strcpy(d, s); }
int kc_isspace(int c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
int kc_isdigit(int c) { return c >= '0' && c <= '9'; }
int kc_isalpha(int c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
int kc_toupper(int c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }
int kc_tolower(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

int atoi(const char *s)
{
    int sign = 1, v = 0;
    while (kc_isspace(*s)) s++;
    if (*s == '-') { sign = -1; s++; }
    while (kc_isdigit(*s)) v = v * 10 + (*s++ - '0');
    return v * sign;
}

static u32 rand_state = 0x12345678;
u32 kc_rand(void)
{
    rand_state ^= rand_state << 13;
    rand_state ^= rand_state >> 17;
    rand_state ^= rand_state << 5;
    return rand_state;
}

/* ----------------------------------------------------------- vsnprintf --- */
typedef struct { char *buf; size_t cap, len; } outbuf;

static void put(outbuf *o, char c)
{
    if (o->len + 1 < o->cap) o->buf[o->len] = c;
    o->len++;
}

static void put_num(outbuf *o, u64 v, int base, bool neg, int width, char pad)
{
    char tmp[24];
    int n = 0;
    do { tmp[n++] = "0123456789abcdef"[v % base]; v /= base; } while (v);
    if (neg) tmp[n++] = '-';
    for (int i = n; i < width; i++) put(o, pad);
    while (n) put(o, tmp[--n]);
}

int kc_vsnprintf(char *buf, size_t cap, const char *fmt, va_list ap)
{
    outbuf o = { buf, cap, 0 };
    for (; *fmt; fmt++) {
        if (*fmt != '%') { put(&o, *fmt); continue; }
        fmt++;
        char pad = ' ';
        int width = 0;
        bool left = false, is_long = false;
        if (*fmt == '-') { left = true; fmt++; }
        if (*fmt == '0') { pad = '0'; fmt++; }
        while (kc_isdigit(*fmt)) width = width * 10 + (*fmt++ - '0');
        while (*fmt == 'l') { is_long = true; fmt++; }
        switch (*fmt) {
        case 'd': {
            i64 v = is_long ? va_arg(ap, i64) : va_arg(ap, int);
            put_num(&o, v < 0 ? -v : v, 10, v < 0, width, pad);
            break;
        }
        case 'u': put_num(&o, is_long ? va_arg(ap, u64) : va_arg(ap, u32), 10, false, width, pad); break;
        case 'x': put_num(&o, is_long ? va_arg(ap, u64) : va_arg(ap, u32), 16, false, width, pad); break;
        case 'p': put(&o, '0'); put(&o, 'x'); put_num(&o, (uptr)va_arg(ap, void *), 16, false, 0, ' '); break;
        case 'c': put(&o, (char)va_arg(ap, int)); break;
        case 's': {
            const char *s = va_arg(ap, const char *);
            if (!s) s = "(null)";
            int len = (int)strlen(s);
            if (!left) for (int i = len; i < width; i++) put(&o, ' ');
            while (*s) put(&o, *s++);
            if (left) for (int i = len; i < width; i++) put(&o, ' ');
            break;
        }
        case '%': put(&o, '%'); break;
        default: put(&o, '%'); put(&o, *fmt); break;
        }
    }
    if (cap) buf[o.len < cap ? o.len : cap - 1] = 0;
    return (int)o.len;
}

int kc_snprintf(char *buf, size_t n, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int r = kc_vsnprintf(buf, n, fmt, ap);
    va_end(ap);
    return r;
}

/* ------------------------------------------------- 64-bit division (i386) --- */
#ifndef __x86_64__
/* gcc emits calls to these for u64 / and % on 32-bit targets; libgcc is not linked. */
static u64 udivmod64(u64 n, u64 d, u64 *rem)
{
    u64 q = 0, r = 0;
    if (!d) { if (rem) *rem = 0; return 0; }
    for (int i = 63; i >= 0; i--) {
        r = (r << 1) | ((n >> i) & 1);
        if (r >= d) { r -= d; q |= 1ULL << i; }
    }
    if (rem) *rem = r;
    return q;
}
u64 __udivmoddi4(u64 n, u64 d, u64 *rem) { return udivmod64(n, d, rem); }
u64 __udivdi3(u64 n, u64 d) { return udivmod64(n, d, NULL); }
u64 __umoddi3(u64 n, u64 d) { u64 r; udivmod64(n, d, &r); return r; }
i64 __divdi3(i64 n, i64 d)
{
    bool neg = (n < 0) != (d < 0);
    u64 q = udivmod64(n < 0 ? -(u64)n : (u64)n, d < 0 ? -(u64)d : (u64)d, NULL);
    return neg ? -(i64)q : (i64)q;
}
i64 __divmoddi4(i64 n, i64 d, i64 *rem)
{
    i64 q = __divdi3(n, d);
    if (rem) *rem = n - q * d;
    return q;
}
i64 __moddi3(i64 n, i64 d)
{
    u64 r;
    udivmod64(n < 0 ? -(u64)n : (u64)n, d < 0 ? -(u64)d : (u64)d, &r);
    return n < 0 ? -(i64)r : (i64)r;
}
#endif
