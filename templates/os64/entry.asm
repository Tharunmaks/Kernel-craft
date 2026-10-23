; KernelCraft SDK entry, 64-bit long mode.
; Entered in 32-bit protected mode at 0x10000. Identity-maps the first 4GB
; with 2MB pages (tables at 0x70000, so the framebuffer BAR is reachable),
; enables PAE + EFER.LME + paging, jumps to 64-bit code, zeroes .bss and
; calls kmain(). Also provides the 48 interrupt stubs for kc_interrupt().
[bits 32]
section .text.entry
global _start
global kc_isr_table
extern kmain
extern kc_interrupt
extern __bss_start
extern __bss_end

PML4 equ 0x70000
PDPT equ 0x71000
PD0  equ 0x72000                ; 4 page directories: 0x72000-0x75FFF

_start:
    cld
    mov edi, PML4
    xor eax, eax
    mov ecx, 6 * 4096 / 4
    rep stosd
    mov dword [PML4], PDPT | 3
    mov edi, PDPT
    mov eax, PD0 | 3
    mov ecx, 4
.pdpt:
    mov [edi], eax
    add eax, 0x1000
    add edi, 8
    loop .pdpt
    mov edi, PD0                ; 2048 x 2MB pages = 4GB
    xor eax, eax
    xor edx, edx
    mov ecx, 2048
.map:
    mov ebx, eax
    or ebx, 0x83                ; present | writable | 2MB page
    mov [edi], ebx
    mov [edi + 4], edx
    add eax, 0x200000
    adc edx, 0
    add edi, 8
    loop .map

    mov eax, cr4
    or eax, 1 << 5              ; PAE
    mov cr4, eax
    mov eax, PML4
    mov cr3, eax
    mov ecx, 0xC0000080         ; EFER.LME
    rdmsr
    or eax, 1 << 8
    wrmsr
    mov eax, cr0
    or eax, 1 << 31             ; paging
    mov cr0, eax
    lgdt [gdt64_desc]
    jmp 0x08:long_entry

[bits 64]
long_entry:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    xor ax, ax
    mov fs, ax
    mov gs, ax
    mov rsp, 0x90000
    mov rdi, __bss_start
    mov rcx, __bss_end
    sub rcx, rdi
    xor eax, eax
    rep stosb
    call kmain
.hang:
    cli
    hlt
    jmp .hang

%macro ISR_NOERR 1
isr%1:
    push qword 0
    push qword %1
    jmp isr_common
%endmacro
%macro ISR_ERR 1
isr%1:
    push qword %1
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
    push rax
    push rbx
    push rcx
    push rdx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15
    mov rdi, rsp                ; kc_frame *
    mov rbx, rsp
    and rsp, ~0xF               ; SysV stack alignment
    call kc_interrupt
    mov rsp, rbx
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rcx
    pop rbx
    pop rax
    add rsp, 16                 ; int_no, err_code
    iretq

align 8
gdt64:
    dq 0
    dq 0x00AF9A000000FFFF       ; 0x08 64-bit code
    dq 0x00CF92000000FFFF       ; 0x10 data
gdt64_desc:
    dw gdt64_desc - gdt64 - 1
    dq gdt64

section .rodata
kc_isr_table:
%assign i 0
%rep 48
    dq isr %+ i
%assign i i+1
%endrep
