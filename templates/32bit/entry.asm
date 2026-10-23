; KernelCraft 32-bit kernel entry (template)
; Linked first, at 0x10000. Zeroes .bss then calls kmain().
[bits 32]
section .text.entry
global _start
extern kmain
extern __bss_start
extern __bss_end

_start:
    cld
    mov edi, __bss_start
    mov ecx, __bss_end
    sub ecx, edi
    xor eax, eax
    rep stosb
    call kmain
.hang:
    cli
    hlt
    jmp .hang
