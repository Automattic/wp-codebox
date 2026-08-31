#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#elif defined(__APPLE__)
#include <sys/attr.h>
#else
#error "Atomic directory exchange is supported only on Linux and macOS"
#endif

int main(int argc, char **argv) {
    if (argc != 8) {
        fprintf(stderr, "usage: atomic-directory-exchange <left> <right> <lock> <left-dev> <left-ino> <right-dev> <right-ino>\n");
        return 2;
    }

    int lock = open(argv[3], O_CREAT | O_RDWR, 0600);
    if (lock < 0 || flock(lock, LOCK_EX) != 0) {
        perror("atomic directory exchange lock");
        return 1;
    }

    struct stat left;
    struct stat right;
    if (lstat(argv[1], &left) != 0 || lstat(argv[2], &right) != 0 ||
        !S_ISDIR(left.st_mode) || S_ISLNK(left.st_mode) ||
        !S_ISDIR(right.st_mode) || S_ISLNK(right.st_mode)) {
        fprintf(stderr, "atomic directory exchange operands must be non-symlink directories\n");
        return 4;
    }
    if ((unsigned long long)left.st_dev != strtoull(argv[4], NULL, 10) ||
        (unsigned long long)left.st_ino != strtoull(argv[5], NULL, 10) ||
        (unsigned long long)right.st_dev != strtoull(argv[6], NULL, 10) ||
        (unsigned long long)right.st_ino != strtoull(argv[7], NULL, 10)) {
        return 3;
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
