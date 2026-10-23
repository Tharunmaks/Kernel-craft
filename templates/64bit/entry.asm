; KernelCraft 64-bit kernel entry (template)
; Entered in 32-bit protected mode at 0x10000 (see boot.asm). Identity-maps
; the first 1GB with 2MB pages, enables PAE + long mode + paging, then jumps
; to 64-bit code, zeroes .bss and calls kmain().
[bits 32]
section .text.entry
global _start
extern kmain
extern __bss_start
extern __bss_end

PML4 equ 0x1000
PDPT equ 0x2000
PD   equ 0x3000

_start:
    cld
    ; clear 3 pages of tables
    mov edi, PML4
    xor eax, eax
    mov ecx, 3 * 4096 / 4
    rep stosd
    mov dword [PML4], PDPT | 3
    mov dword [PDPT], PD | 3
    ; 512 x 2MB pages = 1GB identity map
    mov edi, PD
    mov eax, 0x83               ; present | writable | page size
    mov ecx, 512
.map:
    mov [edi], eax
    mov dword [edi + 4], 0
    add eax, 0x200000
    add edi, 8
    loop .map

    mov eax, cr4
    or eax, 1 << 5              ; PAE
    mov cr4, eax
    mov eax, PML4
    mov cr3, eax
    mov ecx, 0xC0000080         ; EFER
    rdmsr
    or eax, 1 << 8              ; LME
    wrmsr
    mov eax, cr0
    or eax, 1 << 31             ; PG
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

align 8
gdt64:
    dq 0
    dq 0x00AF9A000000FFFF       ; 0x08 64-bit code
    dq 0x00CF92000000FFFF       ; 0x10 data
gdt64_desc:
    dw gdt64_desc - gdt64 - 1
    dq gdt64
