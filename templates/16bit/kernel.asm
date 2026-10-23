; KernelCraft 16-bit real-mode kernel (template)
; Loaded at 0000:8000 by boot.asm. VGA text mode 80x25 with a title bar,
; status bar and a tiny command shell (help, clear, about, time, reboot).
[bits 16]
[org 0x8000]

TITLE_ATTR  equ 0x1F            ; white on blue
BODY_ATTR   equ 0x0A            ; light green on black
STATUS_ATTR equ 0x70            ; black on grey

kernel_main:
    xor ax, ax
    mov ds, ax
    mov es, ax

    mov ax, 0x0003              ; 80x25 colour text, clears screen
    int 0x10
    mov ah, 0x01                ; block cursor
    mov cx, 0x0007
    int 0x10

    call draw_chrome
    mov dh, 2
    mov dl, 0
    call set_cursor
    mov si, msg_welcome
    call puts

shell_loop:
    mov si, msg_prompt
    call puts
    call read_line
    call run_command
    jmp shell_loop

; ---------------------------------------------------------------- chrome ---
draw_chrome:
    push es
    mov ax, 0xB800
    mov es, ax
    xor di, di                  ; row 0: title bar
    mov ax, (TITLE_ATTR << 8) | ' '
    mov cx, 80
    rep stosw
    mov di, 24*160              ; row 24: status bar
    mov ax, (STATUS_ATTR << 8) | ' '
    mov cx, 80
    rep stosw
    mov di, 2*2                 ; title text
    mov si, msg_title
    mov ah, TITLE_ATTR
    call put_attr_str
    mov di, 24*160 + 2*2
    mov si, msg_status
    mov ah, STATUS_ATTR
    call put_attr_str
    pop es
    ret

; write DS:SI string at ES:DI with attribute AH
put_attr_str:
    lodsb
    or al, al
    jz .done
    stosw
    jmp put_attr_str
.done:
    ret

; ---------------------------------------------------------------- output ---
set_cursor:                     ; DH=row DL=col
    mov ah, 0x02
    xor bh, bh
    int 0x10
    ret

get_cursor:                     ; -> DH=row DL=col
    mov ah, 0x03
    xor bh, bh
    int 0x10
    ret

putc:                           ; AL=char, keeps body inside rows 1..23
    pusha
    cmp al, 13
    je .cr
    cmp al, 10
    je .lf
    mov ah, 0x09
    mov bx, BODY_ATTR
    mov cx, 1
    int 0x10
    call get_cursor
    inc dl
    cmp dl, 80
    jb .set
    xor dl, dl
    jmp .newline
.cr:
    call get_cursor
    xor dl, dl
    jmp .set
.lf:
    call get_cursor
.newline:
    inc dh
    cmp dh, 24
    jb .set
    call scroll_body
    mov dh, 23
.set:
    call set_cursor
    popa
    ret

scroll_body:                    ; scroll rows 1..23 up by one
    pusha
    mov ax, 0x0601
    mov bh, BODY_ATTR
    mov cx, 0x0100
    mov dx, 0x174F
    int 0x10
    popa
    ret

puts:                           ; DS:SI zero-terminated
    lodsb
    or al, al
    jz .done
    call putc
    jmp puts
.done:
    ret

; ----------------------------------------------------------------- input ---
read_line:                      ; into line_buf, zero-terminated
    mov di, line_buf
    xor cx, cx
.key:
    xor ah, ah
    int 0x16
    cmp al, 13
    je .enter
    cmp al, 8
    je .backspace
    cmp al, 32
    jb .key
    cmp cx, 60
    jae .key
    stosb
    inc cx
    call putc
    jmp .key
.backspace:
    jcxz .key
    dec di
    dec cx
    call get_cursor
    dec dl
    call set_cursor
    mov al, ' '
    call putc
    call get_cursor
    dec dl
    call set_cursor
    jmp .key
.enter:
    mov byte [di], 0
    mov si, crlf
    call puts
    ret

; -------------------------------------------------------------- commands ---
run_command:
    cmp byte [line_buf], 0
    je .done
    mov si, line_buf
    mov di, cmd_help
    call strcmp
    je .help
    mov si, line_buf
    mov di, cmd_clear
    call strcmp
    je .clear
    mov si, line_buf
    mov di, cmd_about
    call strcmp
    je .about
    mov si, line_buf
    mov di, cmd_time
    call strcmp
    je .time
    mov si, line_buf
    mov di, cmd_reboot
    call strcmp
    je .reboot
    mov si, msg_unknown
    call puts
.done:
    ret
.help:
    mov si, msg_help
    jmp puts
.about:
    mov si, msg_about
    jmp puts
.clear:
    mov ax, 0x0600
    mov bh, BODY_ATTR
    mov cx, 0x0100
    mov dx, 0x174F
    int 0x10
    mov dx, 0x0100
    jmp set_cursor
.reboot:
    int 0x19
.time:
    mov ah, 0x02                ; RTC time in BCD: CH=h CL=m DH=s
    int 0x1A
    mov al, ch
    call print_bcd
    mov al, ':'
    call putc
    mov al, cl
    call print_bcd
    mov al, ':'
    call putc
    mov al, dh
    call print_bcd
    mov si, crlf
    jmp puts

print_bcd:                      ; AL = BCD byte
    push ax
    shr al, 4
    add al, '0'
    call putc
    pop ax
    and al, 0x0F
    add al, '0'
    jmp putc

strcmp:                         ; ZF=1 if [SI]==[DI]
    lodsb
    mov ah, [di]
    inc di
    cmp al, ah
    jne .ne
    or al, al
    jnz strcmp
.ne:
    ret

; ------------------------------------------------------------------ data ---
msg_title   db "KernelCraft OS  |  16-bit Real Mode", 0
msg_status  db "Type 'help' for commands  |  booted from floppy", 0
msg_welcome db "Welcome to KernelCraft OS.", 13, 10
            db "Kernel loaded at 0x8000. Type 'help' to begin.", 13, 10, 13, 10, 0
msg_prompt  db "kc> ", 0
msg_help    db "Commands: help, clear, about, time, reboot", 13, 10, 0
msg_about   db "KernelCraft 16-bit demo kernel. Generated by AI, verified in QEMU.", 13, 10, 0
msg_unknown db "Unknown command. Try 'help'.", 13, 10, 0
crlf        db 13, 10, 0
cmd_help    db "help", 0
cmd_clear   db "clear", 0
cmd_about   db "about", 0
cmd_time    db "time", 0
cmd_reboot  db "reboot", 0
line_buf    times 64 db 0
