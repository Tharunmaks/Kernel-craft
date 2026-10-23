/* KernelCraft SDK 32-bit layout: flat binary loaded at 0x10000. The image
 * plus .bss must end below 0x70000 (page tables / stack live above it). */
ENTRY(_start)
SECTIONS
{
    . = 0x10000;
    .text : { *(.text.entry) *(.text*) }
    .rodata : {
        *(.rodata*)
        . = ALIGN(8);
        __kc_apps_start = .;     KEEP(*(.kc_apps))     __kc_apps_end = .;
        __kc_commands_start = .; KEEP(*(.kc_commands)) __kc_commands_end = .;
        __kc_hooks_start = .;    KEEP(*(.kc_hooks))    __kc_hooks_end = .;
    }
    .data : { *(.data*) }
    __bss_start = .;
    .bss : { *(.bss*) *(COMMON) }
    __bss_end = .;
    ASSERT(__bss_end <= 0x70000, "kernel + bss too large: must end below 0x70000; move big buffers to kmalloc")
    /DISCARD/ : { *(.note*) *(.comment) *(.eh_frame*) }
}
