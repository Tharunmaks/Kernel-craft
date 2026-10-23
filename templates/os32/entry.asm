; KernelCraft SDK entry, 32-bit protected mode.
; Linked first at 0x10000: zeroes .bss, calls kmain(). Also provides the
; 48 interrupt stubs (CPU exceptions 0-31, IRQs 32-47) that funnel into
; kc_interrupt(kc_frame *) in arch.c.
[bits 32]
section .text.entry
global _start
global kc_isr_table
extern kmain
extern kc_interrupt
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

%macro ISR_NOERR 1
isr%1:
    push dword 0
    push dword %1
    jmp isr_common
%endmacro
%macro ISR_ERR 1
isr%1:
    push dword %1
    jmp isr_common
%endmacro

%assign i 0
%rep 48
%if i == 8 || (i >= 10 && i <= 14) || i == 17 || i == 21 || i == 29 || i == 30
ISR_ERR i
%else
ISR_NOERR i
%endif
%assign i i+1
%endrep

isr_common:
    pusha
    push ds
    push es
    push fs
    push gs
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    push esp                    ; kc_frame *
    call kc_interrupt
    add esp, 4
    pop gs
    pop fs
    pop es
    pop ds
    popa
    add esp, 8                  ; int_no, err_code
    iret

section .rodata
kc_isr_table:
%assign i 0
%rep 48
    dd isr %+ i
%assign i i+1
%endrep
