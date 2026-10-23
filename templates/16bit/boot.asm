; KernelCraft 16-bit real-mode boot sector (template)
; Loads KERNEL_SECTORS sectors starting at LBA 1 to 0000:8000 and jumps there.
; The build engine passes -DKERNEL_SECTORS=<n> computed from the kernel size.
[bits 16]
[org 0x7C00]

%ifndef KERNEL_SECTORS
%define KERNEL_SECTORS 32
%endif

KERNEL_SEG equ 0x0800          ; 0x0800:0000 = phys 0x8000

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    sti
    mov [boot_drive], dl

    mov si, msg_loading
    call print

    ; Read one sector at a time (avoids track-boundary limits on some BIOSes)
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
    jnc .no_wrap                ; crossed a 64K boundary: bump ES
    mov ax, es
    add ax, 0x1000
    mov es, ax
.no_wrap:
    inc word [lba]
    loop .next

    mov dl, [boot_drive]
    jmp 0x0000:0x8000

; read sector [lba] into ES:BX (1.44MB geometry: 18 spt, 2 heads)
read_lba:
    mov di, 3                   ; retries
.retry:
    mov ax, [lba]
    xor dx, dx
    mov cx, 18
    div cx                      ; ax = lba / 18, dx = lba % 18
    inc dx
    mov cl, dl                  ; sector (1-based)
    xor dx, dx
    mov si, 2
    div si                      ; ax = cylinder, dx = head
    mov ch, al
    mov dh, dl
    mov dl, [boot_drive]
    mov ax, 0x0201
    int 0x13
    jnc .ok
    xor ax, ax
    int 0x13                    ; reset drive
    dec di
    jnz .retry
    mov si, msg_err
    call print
    cli
    hlt
.ok:
    ret

print:
    lodsb
    or al, al
    jz .done
    mov ah, 0x0E
    int 0x10
    jmp print
.done:
    ret

boot_drive  db 0
lba         dw 0
msg_loading db "KernelCraft boot: loading kernel...", 13, 10, 0
msg_err     db "Disk read error", 0

times 510-($-$$) db 0
dw 0xAA55
