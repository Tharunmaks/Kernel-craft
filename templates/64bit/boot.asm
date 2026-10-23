; KernelCraft 64-bit boot sector (template): enters 32-bit protected mode;
; entry.asm then builds page tables and switches to 64-bit long mode.
; 1. switches to VGA mode 13h (320x200, 256 colours, framebuffer at 0xA0000)
; 2. copies the BIOS 8x8 font to phys 0x6000 (chars 0-255, 8 bytes each)
; 3. loads KERNEL_SECTORS sectors from LBA 1 to phys 0x10000
; 4. enables A20, loads a flat GDT, enters protected mode, jumps to 0x10000
[bits 16]
[org 0x7C00]

%ifndef KERNEL_SECTORS
%define KERNEL_SECTORS 64
%endif

FONT_ADDR   equ 0x6000
KERNEL_SEG  equ 0x1000           ; 0x1000:0000 = phys 0x10000

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    sti
    mov [boot_drive], dl

    ; ---- load kernel (one sector at a time, crossing 64K by bumping ES)
    mov ax, KERNEL_SEG
    mov es, ax
    xor bx, bx
    mov word [lba], 1
    mov cx, KERNEL_SECTORS
.next:
    push cx
    call read_lba
    pop cx
    add bx, 512
    jnc .no_wrap
    mov ax, es
    add ax, 0x1000
    mov es, ax
.no_wrap:
    inc word [lba]
    loop .next

    ; ---- graphics mode 13h
    mov ax, 0x0013
    int 0x10

    ; ---- copy 8x8 font: BH=3 gives chars 0-127, BH=4 gives 128-255
    mov bh, 3
    mov di, FONT_ADDR
    call copy_font
    mov bh, 4
    mov di, FONT_ADDR + 1024
    call copy_font

    ; ---- A20 (fast gate) + protected mode
    in al, 0x92
    or al, 2
    and al, 0xFE
    out 0x92, al

    cli
    lgdt [gdt_desc]
    mov eax, cr0
    or eax, 1
    mov cr0, eax
    jmp 0x08:pm_entry

; BH = font selector, DI = destination offset in segment 0
copy_font:
    push ds
    mov ax, 0x1130
    int 0x10                    ; -> ES:BP font table
    push es
    pop ds
    mov si, bp
    xor ax, ax
    mov es, ax
    mov cx, 1024
    rep movsb
    pop ds
    ret

read_lba:                       ; read sector [lba] into ES:BX
    mov di, 3
.retry:
    mov ax, [lba]
    xor dx, dx
    mov cx, 18
    div cx
    inc dx
    mov cl, dl
    xor dx, dx
    mov si, 2
    div si
    mov ch, al
    mov dh, dl
    mov dl, [boot_drive]
    mov ax, 0x0201
    int 0x13
    jnc .ok
    xor ax, ax
    int 0x13
    dec di
    jnz .retry
    mov si, msg_err
.print:
    lodsb
    or al, al
    jz .halt
    mov ah, 0x0E
    int 0x10
    jmp .print
.halt:
    cli
    hlt
.ok:
    ret

[bits 32]
pm_entry:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov fs, ax
    mov gs, ax
    mov ss, ax
    mov esp, 0x90000
    jmp 0x08:0x10000

align 8
gdt:
    dq 0
    dq 0x00CF9A000000FFFF       ; 0x08 code, base 0, 4GB, 32-bit
    dq 0x00CF92000000FFFF       ; 0x10 data, base 0, 4GB
gdt_desc:
    dw gdt_desc - gdt - 1
    dd gdt

boot_drive db 0
lba        dw 0
msg_err    db "Disk read error", 0

times 510-($-$$) db 0
dw 0xAA55
