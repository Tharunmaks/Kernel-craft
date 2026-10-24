/* Boot splash: paints a gradient with a logo on /dev/fb0 for a moment. */
#include <stdio.h>
#include "kcfb.h"

int main(void)
{
    kcfb fb;
    if (kcfb_open(&fb)) return 0; /* no framebuffer: skip quietly */
    for (int y = 0; y < fb.h; y++) kcfb_fill(&fb, 0, y, fb.w, 1, kcfb_mix(0x0b1a3a, 0x02040c, y * 255 / fb.h));
    int cx = fb.w / 2, cy = fb.h / 2;
    for (int i = 0; i < 4; i++) kcfb_fill(&fb, cx - 90 + i * 48, cy - 60 + (i % 2) * 20, 36, 100 - (i % 2) * 40, kcfb_mix(0x34d3ff, 0xb48cff, i * 80));
    kcfb_fill(&fb, cx - 120, cy + 70, 240, 4, 0x34d3ff);
    kcfb_close(&fb);
    usleep(1500 * 1000);
    printf("\033[2J\033[H");
    return 0;
}
