/* KernelCraft SDK: command shell used by the Terminal app. Commands are
 * registered with KC_COMMAND, so generated apps can add their own. */
#include "kc.h"

static char cwd[256] = "/home/user";

const char *shell_cwd(void) { return cwd; }

void shell_resolve(const char *path, char *out, size_t cap)
{
    char tmp[256];
    if (path[0] == '/') strncpy(tmp, path, sizeof tmp - 1);
    else kc_snprintf(tmp, sizeof tmp, "%s/%s", strcmp(cwd, "/") ? cwd : "", path);
    tmp[sizeof tmp - 1] = 0;
    /* normalise . and .. */
    char *parts[32];
    int n = 0;
    for (char *p = tmp; *p;) {
        while (*p == '/') *p++ = 0;
        if (!*p) break;
        char *start = p;
        while (*p && *p != '/') p++;
        if (*p) *p++ = 0;
        if (!strcmp(start, ".")) continue;
        if (!strcmp(start, "..")) { if (n) n--; continue; }
        if (n < 32) parts[n++] = start;
    }
    out[0] = 0;
    if (!n) { strncpy(out, "/", cap); return; }
    for (int i = 0; i < n; i++) {
        size_t len = strlen(out);
        kc_snprintf(out + len, cap - len, "/%s", parts[i]);
    }
}

static void printf_to(void (*print)(const char *), const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    kc_vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    print(buf);
}

static char redirect_path[256];
static void capture_to_file(const char *s) { fs_append(redirect_path, s, strlen(s)); }

void shell_execute(const char *line, void (*print)(const char *))
{
    char buf[256];
    strncpy(buf, line, sizeof buf - 1);
    buf[sizeof buf - 1] = 0;

    /* "cmd args > file" redirects output to a file */
    char *redirect = NULL;
    char *gt = strchr(buf, '>');
    if (gt) {
        *gt = 0;
        redirect = gt + 1;
        while (kc_isspace(*redirect)) redirect++;
        char *end = redirect + strlen(redirect);
        while (end > redirect && kc_isspace(end[-1])) *--end = 0;
    }

    char *argv[16];
    int argc = 0;
    for (char *p = buf; *p && argc < 16;) {
        while (kc_isspace(*p)) *p++ = 0;
        if (!*p) break;
        if (*p == '"') {
            argv[argc++] = ++p;
            while (*p && *p != '"') p++;
            if (*p) *p++ = 0;
        } else {
            argv[argc++] = p;
            while (*p && !kc_isspace(*p)) p++;
        }
    }
    if (!argc) return;

    const kc_command *cmd = kc_command_find(argv[0]);
    if (!cmd) {
        const kc_app *app = kc_app_find(argv[0]);
        if (app) { app->launch(); return; }
        printf_to(print, "%s: command not found (try 'help')\n", argv[0]);
        return;
    }
    if (!redirect) { cmd->run(argc, argv, print); return; }

    /* capture output into the redirect file */
    shell_resolve(redirect, redirect_path, sizeof redirect_path);
    fs_write(redirect_path, "", 0);
    cmd->run(argc, argv, capture_to_file);
}

/* ------------------------------------------------------------- commands --- */
static void cmd_help(int argc, char **argv, void (*print)(const char *))
{
    (void)argc; (void)argv;
    print("Commands:\n");
    for (const kc_command **c = __kc_commands_start; c < __kc_commands_end; c++) printf_to(print, "  %-10s %s\n", (*c)->name, (*c)->help);
    print("Apps (type the name to open):");
    for (int i = 0; i < kc_app_count(); i++) printf_to(print, " %s", kc_app_at(i)->id);
    print("\n");
}
KC_COMMAND(help, "list commands", cmd_help);

static void cmd_ls(int argc, char **argv, void (*print)(const char *))
{
    char path[256];
    shell_resolve(argc > 1 ? argv[1] : ".", path, sizeof path);
    kc_node *d = fs_lookup(path);
    if (!d) { printf_to(print, "ls: %s: no such file or directory\n", path); return; }
    if (!d->is_dir) { printf_to(print, "%s\n", d->name); return; }
    for (kc_node *c = d->child; c; c = c->next) {
        if (c->is_dir) printf_to(print, "  %s/\n", c->name);
        else printf_to(print, "  %-24s %u bytes\n", c->name, (u32)c->size);
    }
}
KC_COMMAND(ls, "list a directory", cmd_ls);

static void cmd_cd(int argc, char **argv, void (*print)(const char *))
{
    char path[256];
    shell_resolve(argc > 1 ? argv[1] : "/home/user", path, sizeof path);
    kc_node *d = fs_lookup(path);
    if (!d || !d->is_dir) { printf_to(print, "cd: %s: not a directory\n", path); return; }
    strcpy(cwd, path);
}
KC_COMMAND(cd, "change directory", cmd_cd);

static void cmd_pwd(int argc, char **argv, void (*print)(const char *)) { (void)argc; (void)argv; printf_to(print, "%s\n", cwd); }
KC_COMMAND(pwd, "print working directory", cmd_pwd);

static void cmd_cat(int argc, char **argv, void (*print)(const char *))
{
    for (int i = 1; i < argc; i++) {
        char path[256];
        shell_resolve(argv[i], path, sizeof path);
        kc_node *f = fs_lookup(path);
        if (!f || f->is_dir) { printf_to(print, "cat: %s: not a file\n", argv[i]); continue; }
        if (f->data) print(f->data);
        if (f->size && f->data[f->size - 1] != '\n') print("\n");
    }
}
KC_COMMAND(cat, "print files", cmd_cat);

static void cmd_echo(int argc, char **argv, void (*print)(const char *))
{
    for (int i = 1; i < argc; i++) { print(argv[i]); if (i + 1 < argc) print(" "); }
    print("\n");
}
KC_COMMAND(echo, "print text (echo hi > file)", cmd_echo);

static void cmd_mkdir(int argc, char **argv, void (*print)(const char *))
{
    for (int i = 1; i < argc; i++) {
        char path[256];
        shell_resolve(argv[i], path, sizeof path);
        if (!fs_mkdir(path)) printf_to(print, "mkdir: cannot create %s\n", path);
    }
}
KC_COMMAND(mkdir, "make directories", cmd_mkdir);

static void cmd_touch(int argc, char **argv, void (*print)(const char *))
{
    (void)print;
    for (int i = 1; i < argc; i++) {
        char path[256];
        shell_resolve(argv[i], path, sizeof path);
        if (!fs_lookup(path)) fs_write(path, "", 0);
    }
}
KC_COMMAND(touch, "create empty files", cmd_touch);

static void cmd_rm(int argc, char **argv, void (*print)(const char *))
{
    for (int i = 1; i < argc; i++) {
        char path[256];
        shell_resolve(argv[i], path, sizeof path);
        if (!fs_remove(path)) printf_to(print, "rm: cannot remove %s\n", path);
    }
}
KC_COMMAND(rm, "remove files or directories", cmd_rm);

static void cmd_uptime(int argc, char **argv, void (*print)(const char *))
{
    (void)argc; (void)argv;
    u32 s = uptime_ms() / 1000;
    printf_to(print, "up %u min %u s\n", s / 60, s % 60);
}
KC_COMMAND(uptime, "time since boot", cmd_uptime);

static void cmd_mem(int argc, char **argv, void (*print)(const char *))
{
    (void)argc; (void)argv;
    printf_to(print, "heap: %u KB used of %u KB\n", (u32)(mem_used() >> 10), (u32)(mem_total() >> 10));
}
KC_COMMAND(mem, "memory usage", cmd_mem);

static void cmd_date(int argc, char **argv, void (*print)(const char *))
{
    (void)argc; (void)argv;
    kc_time t;
    rtc_read(&t);
    printf_to(print, "%u-%02u-%02u %02u:%02u:%02u\n", t.year, t.month, t.day, t.hour, t.min, t.sec);
}
KC_COMMAND(date, "current date and time", cmd_date);

static void cmd_uname(int argc, char **argv, void (*print)(const char *))
{
    (void)argc; (void)argv;
    printf_to(print, "%s (%s, %dx%d)\n", theme.os_name, kc_arch_name(), SCREEN_W, SCREEN_H);
}
KC_COMMAND(uname, "system information", cmd_uname);

static void cmd_reboot(int argc, char **argv, void (*print)(const char *))
{
    (void)argc; (void)argv; (void)print;
    outb(0x64, 0xFE);
}
KC_COMMAND(reboot, "restart the machine", cmd_reboot);
