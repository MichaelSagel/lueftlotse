ENTRY(_start)
SECTIONS {
 . = 0x80000000;
 .text : { *(.text.start) *(.text*) }
 .rodata : { *(.rodata*) }
 .data : { *(.data*) *(.sdata*) }
 .bss : { *(.bss*) *(.sbss*) *(COMMON) }
 . = ALIGN(16);
 . += 65536;
 _stack_top = .;
}