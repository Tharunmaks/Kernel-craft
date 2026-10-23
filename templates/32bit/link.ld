/* KernelCraft 32-bit kernel layout: flat binary loaded at 0x10000. */
ENTRY(_start)
SECTIONS
{
    . = 0x10000;
    .text : { *(.text.entry) *(.text*) }
    .rodata : { *(.rodata*) }
    .data : { *(.data*) }
    __bss_start = .;
    .bss : { *(.bss*) *(COMMON) }
    __bss_end = .;
    /DISCARD/ : { *(.note*) *(.comment) *(.eh_frame*) }
}
