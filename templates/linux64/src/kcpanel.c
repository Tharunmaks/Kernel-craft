/* Forge OS dashboard: a full-screen text UI with live system info and a
 * launcher. Arrow keys + Enter; q drops to the shell. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/sysinfo.h>
#include <sys/utsname.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static struct termios saved;

static void raw_mode(int on)
{
    if (on) {
        struct termios t;
        tcgetattr(0, &saved);
        t = saved;
        t.c_lflag &= ~(ICANON | ECHO);
        t.c_cc[VMIN] = 0;
        t.c_cc[VTIME] = 5; /* 0.5s read timeout so the clock ticks */
        tcsetattr(0, TCSANOW, &t);
        printf("\033[?25l");
    } else {
        tcsetattr(0, TCSANOW, &saved);
        printf("\033[0m\033[?25h\033[2J\033[H");
    }
    fflush(stdout);
}

static const char *items[][2] = {
    { "Shell", "/bin/sh -l" },
    { "Processes (top)", "top" },
    { "Disk usage", "df -h; echo; read -p 'Press Enter' x" },
    { "Read the welcome note", "cat /home/user/readme.txt; read -p 'Press Enter' x" },
    { "Reboot", "reboot -f" },
};
#define N_ITEMS (int)(sizeof items / sizeof items[0])

static void box(int row, int col, int w, int h, const char *title)
{
    printf("\033[%d;%dH\033[36m+", row, col);
    for (int i = 0; i < w - 2; i++) putchar('-');
    printf("+");
    for (int r = 1; r < h - 1; r++) printf("\033[%d;%dH|\033[%d;%dH|", row + r, col, row + r, col + w - 1);
    printf("\033[%d;%dH+", row + h - 1, col);
    for (int i = 0; i < w - 2; i++) putchar('-');
    printf("+\033[%d;%dH\033[1;37m %s \033[0m", row, col + 2, title);
}

static void draw(int sel)
{
    struct winsize ws = { 0 };
    ioctl(1, TIOCGWINSZ, &ws);
    int cols = ws.ws_col ? ws.ws_col : 80;
    struct sysinfo si;
    sysinfo(&si);
    struct utsname u;
    uname(&u);
    time_t now = time(0);
    char clock[64];
    strftime(clock, sizeof clock, "%H:%M:%S  %d %b %Y", localtime(&now));

    printf("\033[2J\033[H\033[44;97m");
    printf(" %-*s", cols - 1, "Forge OS  -  KernelCraft Linux Forge");
    printf("\033[1;%dH%s \033[0m", cols - (int)strlen(clock), clock);

    box(3, 3, 44, 9, "System");
    printf("\033[5;6HKernel   %s", u.release);
    printf("\033[6;6HArch     %s", u.machine);
    printf("\033[7;6HUptime   %ld min %ld s", si.uptime / 60, si.uptime % 60);
    printf("\033[8;6HMemory   %lu / %lu MB", (si.totalram - si.freeram) * si.mem_unit >> 20, si.totalram * si.mem_unit >> 20);
    printf("\033[9;6HProcs    %d", si.procs);

    box(3, 50, 34, N_ITEMS + 4, "Launcher");
    for (int i = 0; i < N_ITEMS; i++)
        printf("\033[%d;53H%s %-26s\033[0m", 5 + i, i == sel ? "\033[46;30m>" : " ", items[i][0]);
    printf("\033[%d;3H\033[90mUp/Down to choose, Enter to run, q for a shell\033[0m", N_ITEMS + 10);
    fflush(stdout);
}

int main(void)
{
    int sel = 0;
    raw_mode(1);
    for (;;) {
        draw(sel);
        char c;
        if (read(0, &c, 1) != 1) continue;
        if (c == 'q') break;
        if (c == '\033') {
            char seq[2];
            if (read(0, seq, 2) == 2 && seq[0] == '[') {
                if (seq[1] == 'A' && sel > 0) sel--;
                if (seq[1] == 'B' && sel < N_ITEMS - 1) sel++;
            }
        } else if (c == '\n' || c == '\r') {
            raw_mode(0);
            system(items[sel][1]);
            raw_mode(1);
        }
    }
    raw_mode(0);
    return 0;
}
