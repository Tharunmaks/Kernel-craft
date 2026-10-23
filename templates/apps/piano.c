/* KernelCraft app: Piano. Two octaves on the PC speaker. Play with the mouse
 * or the keyboard (A W S E D F T G Y H U J K O L P ;), Z/X shift octave,
 * and press 1 for a demo tune. */
#include "kc.h"

#define WHITE_W 44
#define KEYS_Y 50
#define WHITE_H 200

/* Frequencies (Hz) for C4..B5. */
static const u16 freqs[24] = { 262, 277, 294, 311, 330, 349, 370, 392, 415, 440, 466, 494,
                               523, 554, 587, 622, 659, 698, 740, 784, 831, 880, 932, 988 };
static const bool is_black[12] = { 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0 };
static const char *names[12] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
static const char keymap[] = "awsedftgyhujkolp;";   /* semitones 0.. from C */

typedef struct { int note, octave, release_at; const char *tune; int tune_pos; } piano_state;

static void play(kc_window *w, piano_state *p, int note, int ms)
{
    if (note < 0 || note >= 24) return;
    p->note = note;
    u32 f = freqs[note];
    if (p->octave > 0) f <<= p->octave; else if (p->octave < 0) f >>= -p->octave;
    speaker_tone(f);
    p->release_at = (int)(uptime_ms() + ms);
    w->tick_ms = 20;
    wm_invalidate(w);
}

/* White key index -> note, and note -> x position. */
static int white_note(int i) { static const int m[7] = { 0, 2, 4, 5, 7, 9, 11 }; return (i / 7) * 12 + m[i % 7]; }
static int black_x(int note)
{
    static const int after_white[12] = { 0, 0, 0, 1, 0, 0, 3, 0, 4, 0, 5, 0 };  /* index of the white key to the left */
    int oct = note / 12, n = note % 12;
    return 12 + (oct * 7 + after_white[n] + (n == 1 ? 0 : 0)) * WHITE_W + WHITE_W - 14;
}

static void paint(kc_window *w, surface *s)
{
    piano_state *p = w->state;
    fill_gradient_v(s, 0, 0, s->width, s->height, RGB(40, 30, 30), RGB(16, 12, 14));
    char top[64];
    kc_snprintf(top, sizeof top, "Octave %s%d   Now: %s", p->octave > 0 ? "+" : "", p->octave, p->note >= 0 ? names[p->note % 12] : "-");
    draw_text(s, 12, 16, top, RGB(240, 230, 220));
    draw_text(s, s->width - text_width("Keys: A..; play, Z/X octave, 1 demo") - 12, 16, "Keys: A..; play, Z/X octave, 1 demo", RGB(170, 150, 140));
    for (int i = 0; i < 14; i++) {
        int x = 12 + i * WHITE_W;
        bool down = p->note == white_note(i);
        fill_round_rect(s, x, KEYS_Y, WHITE_W - 3, WHITE_H, 5, down ? color_mix(RGB(255, 255, 255), theme.accent, 120) : RGB(250, 248, 244));
    }
    for (int n = 0; n < 24; n++) {
        if (!is_black[n % 12]) continue;
        bool down = p->note == n;
        fill_round_rect(s, black_x(n), KEYS_Y, 26, WHITE_H * 3 / 5, 4, down ? theme.accent : RGB(24, 22, 26));
    }
}

static int note_at(int x, int y)
{
    if (y < KEYS_Y || y > KEYS_Y + WHITE_H) return -1;
    if (y < KEYS_Y + WHITE_H * 3 / 5)
        for (int n = 0; n < 24; n++) if (is_black[n % 12] && x >= black_x(n) && x < black_x(n) + 26) return n;
    int i = (x - 12) / WHITE_W;
    return i >= 0 && i < 14 ? white_note(i) : -1;
}

static const char demo[] = "e2d2c2d2e2e2e4d2d2d4e2g2g4e2d2c2d2e2e2e2e2d2d2e2d2c8";

static void on_event(kc_window *w, kc_event *ev)
{
    piano_state *p = w->state;
    if (ev->type == EV_TICK) {
        if (p->note >= 0 && (int)uptime_ms() >= p->release_at) {
            speaker_off();
            p->note = -1;
            wm_invalidate(w);
        }
        if (p->tune && p->note < 0) {
            char ch = p->tune[p->tune_pos];
            if (!ch) { p->tune = NULL; w->tick_ms = 0; return; }
            static const int semis[7] = { 9, 11, 0, 2, 4, 5, 7 };   /* a..g */
            int len = p->tune[p->tune_pos + 1] - '0';
            p->tune_pos += 2;
            play(w, p, 12 + semis[ch - 'a'] - (ch >= 'a' && ch <= 'b' ? 0 : 12), len * 110);
            p->release_at -= 30;
        }
        if (p->note < 0 && !p->tune) w->tick_ms = 0;
        return;
    }
    if (ev->type == EV_MOUSE_DOWN) { play(w, p, note_at(ev->x, ev->y), 300); return; }
    if (ev->type != EV_KEY) return;
    int k = kc_tolower(ev->key);
    if (k == 'z') { p->octave = KC_MAX(-1, p->octave - 1); wm_invalidate(w); return; }
    if (k == 'x') { p->octave = KC_MIN(1, p->octave + 1); wm_invalidate(w); return; }
    if (k == '1') { p->tune = demo; p->tune_pos = 0; w->tick_ms = 20; return; }
    const char *pos = strchr(keymap, k);
    if (pos && k) play(w, p, (int)(pos - keymap), 250);
}

static void on_close(kc_window *w) { speaker_off(); kfree(w->state); }

void piano_open(void)
{
    kc_window *w = wm_create("Piano", -1, -1, 14 * WHITE_W + 24, KEYS_Y + WHITE_H + 16);
    piano_state *p = kcalloc(1, sizeof(piano_state));
    p->note = -1;
    w->state = p;
    w->on_paint = paint;
    w->on_event = on_event;
    w->on_close = on_close;
}
KC_APP(piano, "Piano", icon_music, piano_open);
