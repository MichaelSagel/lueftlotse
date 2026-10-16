.section .text.start
.global _start
_start:
    la sp, _stack_top
    call run_tests
1:  j 1b