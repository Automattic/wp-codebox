#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <stdio.h>

#if defined(__linux__)
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#elif defined(__APPLE__)
#include <sys/attr.h>
#else
#error "Atomic directory exchange is supported only on Linux and macOS"
#endif

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: atomic-directory-exchange <left> <right>\n");
        return 2;
    }

#if defined(__linux__)
    if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_EXCHANGE) != 0) {
#elif defined(__APPLE__)
    if (renamex_np(argv[1], argv[2], RENAME_SWAP) != 0) {
#endif
        perror("atomic directory exchange");
        return 1;
    }
    return 0;
}
