/* KernelCraft OS kernel entry: bring up the SDK, run boot hooks, start the desktop. */
#include "kc.h"

void terminal_open(void);

void kmain(void)
{
    serial_init();
    kc_log("%s booting (%s)", theme.os_name, kc_arch_name());
    mem_init();
    arch_init();
    gfx_init(800, 600);
    fs_init();
    input_init();
    wm_init();

    for (const kc_hook *h = __kc_hooks_start; h < __kc_hooks_end; h++) (*h)();
    wm_rebuild_wallpaper(); /* hooks may have changed the theme */

    terminal_open();
    wm_notify("Welcome! Double-click an icon, or press F1 for the menu.");
    kc_log("desktop ready");
    wm_run();
}
