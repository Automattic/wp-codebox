#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
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

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif

/* A small self-contained SHA-256 keeps the helper dependency-free. */
typedef struct {
    uint32_t h[8];
    uint64_t bits;
    unsigned char block[64];
    size_t used;
} sha256;
static const uint32_t k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
static uint32_t rr(uint32_t x, int n) {
    return (x >> n) | (x << (32 - n));
}
static void sha_block(sha256 *s, const unsigned char *p) {
    uint32_t w[64], a, b, c, d, e, f, g, h;
    int i;
    for (i = 0; i < 16; i++) {
        w[i] =
            ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) | ((uint32_t)p[i * 4 + 2] << 8) | p[i * 4 + 3];
    }
    for (; i < 64; i++) {
        uint32_t x = w[i - 15], y = w[i - 2];
        w[i] = (rr(x, 7) ^ rr(x, 18) ^ (x >> 3)) + w[i - 16] + (rr(y, 17) ^ rr(y, 19) ^ (y >> 10)) + w[i - 7];
    }
    a = s->h[0];
    b = s->h[1];
    c = s->h[2];
    d = s->h[3];
    e = s->h[4];
    f = s->h[5];
    g = s->h[6];
    h = s->h[7];
    for (i = 0; i < 64; i++) {
        uint32_t s1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ ((~e) & g), t1 = h + s1 + ch + k[i] + w[i],
                 s0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = s0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    s->h[0] += a;
    s->h[1] += b;
    s->h[2] += c;
    s->h[3] += d;
    s->h[4] += e;
    s->h[5] += f;
    s->h[6] += g;
    s->h[7] += h;
}
static void sha_init(sha256 *s) {
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(s->h, h, sizeof(h));
    s->bits = 0;
    s->used = 0;
}
static void sha_add(sha256 *s, const void *data, size_t n) {
    const unsigned char *p = data;
    s->bits += (uint64_t)n * 8;
    while (n) {
        size_t take = 64 - s->used;
        if (take > n) {
            take = n;
        }
        memcpy(s->block + s->used, p, take);
        s->used += take;
        p += take;
        n -= take;
        if (s->used == 64) {
            sha_block(s, s->block);
            s->used = 0;
        }
    }
}
static void sha_final(sha256 *s, char out[65]) {
    unsigned char pad[128] = {0x80}, digest[32];
    uint64_t bits = s->bits;
    size_t n = s->used < 56 ? 56 - s->used : 120 - s->used;
    sha_add(s, pad, n);
    for (int i = 0; i < 8; i++) {
        pad[i] = (unsigned char)(bits >> (56 - i * 8));
    }
    sha_add(s, pad, 8);
    for (int i = 0; i < 8; i++) {
        digest[i * 4] = s->h[i] >> 24;
        digest[i * 4 + 1] = s->h[i] >> 16;
        digest[i * 4 + 2] = s->h[i] >> 8;
        digest[i * 4 + 3] = s->h[i];
    }
    for (int i = 0; i < 32; i++) {
        sprintf(out + i * 2, "%02x", digest[i]);
    }
    out[64] = 0;
}

typedef struct {
    dev_t dev;
    ino_t ino;
} identity;
static int same(identity a, identity b) {
    return a.dev == b.dev && a.ino == b.ino;
}
static identity identity_of(struct stat st) {
    identity x = {st.st_dev, st.st_ino};
    return x;
}
static int stable_metadata(struct stat a, struct stat b) {
#if defined(__APPLE__)
    return same(identity_of(a), identity_of(b)) && a.st_mode == b.st_mode && a.st_size == b.st_size &&
           a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
           a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
#else
    return same(identity_of(a), identity_of(b)) && a.st_mode == b.st_mode && a.st_size == b.st_size &&
           a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec &&
           a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec;
#endif
}
static int write_status(const char *s) {
    return dprintf(STDOUT_FILENO, "%s\n", s) < 0 ? -1 : 0;
}
static int read_command(char *line, size_t size) {
    if (!fgets(line, (int)size, stdin)) {
        return -1;
    }
    line[strcspn(line, "\r\n")] = 0;
    return 0;
}
static void file_barrier(const char *environment) {
    const char *barrier = getenv(environment);
    if (!barrier || !*barrier) {
        return;
    }
    int marker = open(barrier, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
    if (marker < 0) {
        return;
    }
    close(marker);
    while (access(barrier, F_OK) == 0) {
        usleep(1000);
    }
}

static int compare_names(const void *a, const void *b) {
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}
static int sync_directory(int fd);
static int manifest_dir(int fd, const char *prefix, sha256 *hash, int synchronize) {
    int scan = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW), result = -1;
    DIR *dir;
    struct dirent *entry;
    char **names = NULL;
    size_t count = 0;
    struct stat before, after;
    if (scan < 0 || fstat(fd, &before) != 0 || !S_ISDIR(before.st_mode) || !(dir = fdopendir(scan))) {
        if (scan >= 0) {
            close(scan);
        }
        return -1;
    }
    while ((entry = readdir(dir))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) {
            continue;
        }
        if (!strcmp(entry->d_name, ".wp-codebox-cleanup-token")) {
            continue;
        }
        char **grown = realloc(names, (count + 1) * sizeof(*names));
        if (!grown) {
            goto done;
        }
        names = grown;
        if (!(names[count] = strdup(entry->d_name))) {
            goto done;
        }
        count++;
    }
    qsort(names, count, sizeof(*names), compare_names);
    for (size_t i = 0; i < count; i++) {
        struct stat st;
        int child;
        char path[4096], header[8192];
        if (snprintf(path, sizeof(path), "%s%s%s", prefix, *prefix ? "/" : "", names[i]) >= (int)sizeof(path)) {
            goto done;
        }
        if (fstatat(fd, names[i], &st, AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(st.st_mode)) {
            goto done;
        }
        if (S_ISDIR(st.st_mode)) {
            int n = snprintf(header, sizeof(header), "d%c%s%c%u%c", 0, path, 0, (unsigned)st.st_mode, 0);
            sha_add(hash, header, (size_t)n);
            child = openat(fd, names[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
            if (child < 0) {
                goto done;
            }
            struct stat opened, current;
            if (fstat(child, &opened) != 0 || !stable_metadata(st, opened) ||
                manifest_dir(child, path, hash, synchronize) != 0 || (synchronize && sync_directory(child) != 0) ||
                fstat(child, &current) != 0 || !stable_metadata(opened, current) ||
                fstatat(fd, names[i], &current, AT_SYMLINK_NOFOLLOW) != 0 || !stable_metadata(opened, current)) {
                close(child);
                goto done;
            }
            close(child);
        } else if (S_ISREG(st.st_mode)) {
            child = openat(fd, names[i], O_RDONLY | O_NOFOLLOW);
            if (child < 0) {
                goto done;
            }
            struct stat opened;
            if (fstat(child, &opened) != 0 || !S_ISREG(opened.st_mode) || !stable_metadata(st, opened)) {
                close(child);
                goto done;
            }
            int n = snprintf(header, sizeof(header), "f%c%s%c%u%c%llu%c", 0, path, 0, (unsigned)opened.st_mode, 0,
                             (unsigned long long)opened.st_size, 0);
            sha_add(hash, header, (size_t)n);
            if (synchronize && fsync(child) != 0) {
                close(child);
                goto done;
            }
            unsigned char buffer[65536];
            ssize_t got;
            while ((got = read(child, buffer, sizeof(buffer))) > 0) {
                sha_add(hash, buffer, (size_t)got);
            }
            if (got < 0 || fstat(child, &after) != 0 || !stable_metadata(opened, after)) {
                close(child);
                goto done;
            }
            close(child);
            if (fstatat(fd, names[i], &after, AT_SYMLINK_NOFOLLOW) != 0 || !stable_metadata(opened, after)) {
                goto done;
            }
        } else {
            goto done;
        }
    }
    if (fstat(fd, &after) == 0 && stable_metadata(before, after)) {
        result = 0;
    }
done:
    for (size_t i = 0; i < count; i++) {
        free(names[i]);
    }
    free(names);
    closedir(dir);
    return result;
}
static int tree_manifest(int root, char out[65], int synchronize) {
    sha256 hash;
    sha_init(&hash);
    if (manifest_dir(root, "", &hash, synchronize) != 0 || (synchronize && sync_directory(root) != 0)) {
        return -1;
    }
    sha_final(&hash, out);
    return 0;
}
static int manifest(int root, char out[65]) {
    return tree_manifest(root, out, 0);
}
static int sync_manifest(int root, char out[65]) {
    return tree_manifest(root, out, 1);
}

static int sync_directory(int fd) {
    return fsync(fd);
}
static int sync_failure(const char *point) {
    static int injected;
    const char *wanted = getenv("WP_CODEBOX_SYNC_FAILURE");
    if (!injected && wanted && *wanted && !strcmp(wanted, point)) {
        injected = 1;
        errno = EIO;
        return -1;
    }
    return 0;
}
static int copy_snapshot_dir(int source, int destination) {
    int scan = openat(source, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW), result = -1;
    DIR *dir;
    struct dirent *entry;
    struct stat source_before, source_after;
    if (scan < 0 || fstat(source, &source_before) != 0 || !S_ISDIR(source_before.st_mode) || !(dir = fdopendir(scan))) {
        if (scan >= 0) {
            close(scan);
        }
        return -1;
    }
    while ((entry = readdir(dir))) {
        int input = -1, output = -1;
        struct stat path_stat, opened;
        unsigned char buffer[65536];
        ssize_t got;
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) {
            continue;
        }
        if (!strcmp(entry->d_name, ".wp-codebox-cleanup-token")) {
            continue;
        }
        if (fstatat(source, entry->d_name, &path_stat, AT_SYMLINK_NOFOLLOW) != 0 || S_ISLNK(path_stat.st_mode)) {
            goto done;
        }
        if (S_ISDIR(path_stat.st_mode)) {
            if (mkdirat(destination, entry->d_name, 0700) != 0 || sync_directory(destination) != 0) {
                goto done;
            }
            input = openat(source, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
            output = openat(destination, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
            if (input < 0 || output < 0 || fstat(input, &opened) != 0 || !S_ISDIR(opened.st_mode) ||
                !stable_metadata(path_stat, opened) || fchmod(output, path_stat.st_mode & 07777) != 0 ||
                copy_snapshot_dir(input, output) != 0 || fstat(input, &source_after) != 0 ||
                !stable_metadata(opened, source_after) ||
                fstatat(source, entry->d_name, &source_after, AT_SYMLINK_NOFOLLOW) != 0 ||
                !stable_metadata(opened, source_after)) {
                if (input >= 0) {
                    close(input);
                }
                if (output >= 0) {
                    close(output);
                }
                goto done;
            }
            close(input);
            close(output);
        } else if (S_ISREG(path_stat.st_mode)) {
            input = openat(source, entry->d_name, O_RDONLY | O_NOFOLLOW);
            output = openat(destination, entry->d_name, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
            if (input < 0 || output < 0 || fstat(input, &opened) != 0 || !S_ISREG(opened.st_mode) ||
                !stable_metadata(path_stat, opened) || fchmod(output, path_stat.st_mode & 07777) != 0) {
                if (input >= 0) {
                    close(input);
                }
                if (output >= 0) {
                    close(output);
                }
                goto done;
            }
            while ((got = read(input, buffer, sizeof(buffer))) > 0) {
                ssize_t sent = 0;
                while (sent < got) {
                    ssize_t n = write(output, buffer + sent, (size_t)(got - sent));
                    if (n <= 0) {
                        close(input);
                        close(output);
                        goto done;
                    }
                    sent += n;
                }
            }
            if (got < 0 || fsync(output) != 0 || fstat(input, &source_after) != 0 ||
                !stable_metadata(opened, source_after) ||
                fstatat(source, entry->d_name, &source_after, AT_SYMLINK_NOFOLLOW) != 0 ||
                !stable_metadata(opened, source_after)) {
                close(input);
                close(output);
                goto done;
            }
            close(input);
            close(output);
        } else {
            goto done;
        }
    }
    {
        const char *barrier = getenv("WP_CODEBOX_SNAPSHOT_BARRIER");
        if (barrier && *barrier) {
            int marker = open(barrier, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
            if (marker >= 0) {
                close(marker);
                while (access(barrier, F_OK) == 0) {
                    usleep(1000);
                }
            }
        }
    }
    if (fstat(source, &source_after) == 0 && stable_metadata(source_before, source_after) &&
        sync_directory(destination) == 0) {
        result = 0;
    }
done:
    closedir(dir);
    return result;
}

static int split_path(const char *path, char **parent, char **name) {
    char *copy = strdup(path), *slash;
    if (!copy) {
        return -1;
    }
    slash = strrchr(copy, '/');
    if (!slash || !slash[1]) {
        free(copy);
        return -1;
    }
    *name = strdup(slash + 1);
    if (slash == copy) {
        slash[1] = 0;
    } else {
        *slash = 0;
    }
    *parent = copy;
    return *name ? 0 : -1;
}
static int open_absolute_directory(const char *path) {
    if (!path || path[0] != '/') {
        return -1;
    }
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    char *copy = strdup(path), *save = NULL, *part;
    if (fd < 0 || !copy) {
        if (fd >= 0) {
            close(fd);
        }
        free(copy);
        return -1;
    }
    for (part = strtok_r(copy, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) {
            close(fd);
            free(copy);
            return -1;
        }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        close(fd);
        if (next < 0) {
            free(copy);
            return -1;
        }
        fd = next;
    }
    free(copy);
    return fd;
}
static int open_relative_file(int root, const char *path) {
    if (!path || !*path || path[0] == '/') {
        return -1;
    }
    int fd = dup(root);
    char *copy = strdup(path), *save = NULL, *part, *next;
    if (fd < 0 || !copy) {
        if (fd >= 0) {
            close(fd);
        }
        free(copy);
        return -1;
    }
    part = strtok_r(copy, "/", &save);
    while (part) {
        if (!strcmp(part, ".") || !strcmp(part, "..")) {
            close(fd);
            free(copy);
            return -1;
        }
        next = strtok_r(NULL, "/", &save);
        int opened = openat(fd, part, O_RDONLY | O_NOFOLLOW | (next ? O_DIRECTORY : 0));
        close(fd);
        if (opened < 0) {
            free(copy);
            return -1;
        }
        fd = opened;
        part = next;
    }
    free(copy);
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode)) {
        close(fd);
        return -1;
    }
    return fd;
}
static int relative_file_identity(int root, const char *path, identity expected) {
    int file = open_relative_file(root, path);
    struct stat st;
    if (file < 0) {
        return 0;
    }
    int result = fstat(file, &st) == 0 && same(identity_of(st), expected);
    close(file);
    return result;
}
static int entry_identity(int parent, const char *name, identity expected) {
    struct stat st;
    return fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(st.st_mode) && !S_ISLNK(st.st_mode) &&
           same(identity_of(st), expected);
}
static int any_entry_identity(int parent, const char *name, identity expected) {
    struct stat st;
    return fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && same(identity_of(st), expected);
}
static int exchange_at(int lp, const char *ln, int rp, const char *rn) {
#if defined(__linux__)
    return (int)syscall(SYS_renameat2, lp, ln, rp, rn, RENAME_EXCHANGE);
#else
    return renameatx_np(lp, ln, rp, rn, RENAME_SWAP);
#endif
}

typedef struct {
    int file;
    int parent;
    char *name;
    identity directory;
} secure_lock_handle;
static secure_lock_handle secure_lock(const char *path) {
    secure_lock_handle result = {-1, -1, NULL, {0, 0}};
    struct stat st, after, directory;
    int fd;
    char *parent_path = NULL;
    if (split_path(path, &parent_path, &result.name)) {
        return result;
    }
    result.parent = open_absolute_directory(parent_path);
    free(parent_path);
    if (result.parent < 0) {
        return result;
    }
    if (mkdirat(result.parent, result.name, 0700) == 0) {
        if (sync_directory(result.parent) != 0) {
            return result;
        }
    } else if (errno != EEXIST) {
        return result;
    }
    fd = openat(result.parent, result.name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) {
        return result;
    }
    if (fstat(fd, &directory) != 0 || directory.st_uid != geteuid()) {
        close(fd);
        return result;
    }
    if ((directory.st_mode & 0777) != 0500 && fchmod(fd, 0500) != 0) {
        close(fd);
        return result;
    }
    if (fstat(fd, &directory) != 0 || directory.st_uid != geteuid() || (directory.st_mode & 0777) != 0500) {
        close(fd);
        return result;
    }
    int lock = openat(fd, "lock", O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (lock < 0 && errno == EACCES) {
        if (fchmod(fd, 0700) != 0) {
            close(fd);
            return result;
        }
        lock = openat(fd, "lock", O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
        if (fchmod(fd, 0500) != 0) {
            if (lock >= 0) {
                close(lock);
            }
            close(fd);
            return result;
        }
    }
    if (lock < 0 || fstat(lock, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != geteuid() ||
        (st.st_mode & 0777) != 0600 || flock(lock, LOCK_EX) != 0) {
        if (lock >= 0) {
            close(lock);
        }
        close(fd);
        return result;
    }
    if (fstatat(fd, "lock", &after, AT_SYMLINK_NOFOLLOW) != 0 || !same(identity_of(st), identity_of(after))) {
        close(lock);
        close(fd);
        return result;
    }
    result.file = lock;
    result.directory = identity_of(directory);
    close(fd);
    return result;
}
static int lock_continuous(secure_lock_handle lock) {
    struct stat directory, file, path_file;
    int directory_fd = openat(lock.parent, lock.name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (directory_fd < 0 || fstat(directory_fd, &directory) || !same(identity_of(directory), lock.directory) ||
        (directory.st_mode & 0777) != 0500 || directory.st_uid != geteuid()) {
        if (directory_fd >= 0) {
            close(directory_fd);
        }
        return 0;
    }
    if (fstat(lock.file, &file) || fstatat(directory_fd, "lock", &path_file, AT_SYMLINK_NOFOLLOW) ||
        !same(identity_of(file), identity_of(path_file)) || !S_ISREG(file.st_mode) || file.st_uid != geteuid() ||
        (file.st_mode & 0777) != 0600) {
        close(directory_fd);
        return 0;
    }
    close(directory_fd);
    return 1;
}

enum cleanup_result { CLEAN_OK = 0, CLEAN_IDENTITY = 1, CLEAN_PENDING = 2 };

static enum cleanup_result remove_contents(int fd);
static enum cleanup_result remove_child(int parent, const char *name, struct stat before, unsigned long sequence) {
    char temporary[128];
    struct stat st;
    identity expected = identity_of(before), placeholder;
    int child = -1;
    snprintf(temporary, sizeof(temporary), ".wp-codebox-child-%ld-%lu", (long)getpid(), sequence);
    if (S_ISDIR(before.st_mode)) {
        if (mkdirat(parent, temporary, 0700) != 0 || sync_directory(parent) != 0) {
            return CLEAN_PENDING;
        }
    } else {
        int file = openat(parent, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
        if (file < 0) {
            return CLEAN_PENDING;
        }
        close(file);
        if (sync_directory(parent) != 0) {
            return CLEAN_PENDING;
        }
    }
    if (fstatat(parent, temporary, &st, AT_SYMLINK_NOFOLLOW) != 0) {
        goto pending;
    }
    placeholder = identity_of(st);
    if (exchange_at(parent, name, parent, temporary) != 0 || sync_directory(parent) != 0) {
        goto pending;
    }
    if (fstatat(parent, temporary, &st, AT_SYMLINK_NOFOLLOW) != 0) {
        goto pending;
    }
    if (!same(identity_of(st), expected)) {
        if (any_entry_identity(parent, name, placeholder)) {
            exchange_at(parent, name, parent, temporary);
        }
        goto pending;
    }
    if (S_ISDIR(before.st_mode)) {
        child = openat(parent, temporary, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (child < 0 || fstat(child, &st) != 0 || !same(identity_of(st), expected) ||
            remove_contents(child) != CLEAN_OK || fstat(child, &st) != 0 || !same(identity_of(st), expected)) {
            if (child >= 0) {
                close(child);
            }
            goto restore;
        }
        close(child);
        child = -1;
        if (!entry_identity(parent, temporary, expected) || unlinkat(parent, temporary, AT_REMOVEDIR) != 0 ||
            sync_directory(parent) != 0) {
            goto restore;
        }
    } else {
        child = openat(parent, temporary, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
        if (child < 0 || fstat(child, &st) != 0 || !same(identity_of(st), expected)) {
            if (child >= 0) {
                close(child);
            }
            goto restore;
        }
        close(child);
        child = -1;
        if (fstatat(parent, temporary, &st, AT_SYMLINK_NOFOLLOW) != 0 || !same(identity_of(st), expected) ||
            unlinkat(parent, temporary, 0) != 0 || sync_directory(parent) != 0) {
            goto restore;
        }
    }
    if (S_ISDIR(before.st_mode)) {
        if (!entry_identity(parent, name, placeholder) || unlinkat(parent, name, AT_REMOVEDIR) != 0 ||
            sync_directory(parent) != 0) {
            return CLEAN_PENDING;
        }
    } else {
        if (fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) != 0 || !same(identity_of(st), placeholder) ||
            unlinkat(parent, name, 0) != 0 || sync_directory(parent) != 0) {
            return CLEAN_PENDING;
        }
    }
    return CLEAN_OK;
restore:
    if (child >= 0) {
        close(child);
    }
    if (S_ISDIR(before.st_mode)) {
        if (entry_identity(parent, name, placeholder) && entry_identity(parent, temporary, expected) &&
            exchange_at(parent, name, parent, temporary) == 0) {
            sync_directory(parent);
        }
    } else if (any_entry_identity(parent, name, placeholder) && any_entry_identity(parent, temporary, expected) &&
               exchange_at(parent, name, parent, temporary) == 0) {
        sync_directory(parent);
    }
pending:
    if (S_ISDIR(before.st_mode)) {
        if (entry_identity(parent, temporary, placeholder) && unlinkat(parent, temporary, AT_REMOVEDIR) == 0) {
            sync_directory(parent);
        }
    } else if (fstatat(parent, temporary, &st, AT_SYMLINK_NOFOLLOW) == 0 && same(identity_of(st), placeholder) &&
               unlinkat(parent, temporary, 0) == 0) {
        sync_directory(parent);
    }
    return CLEAN_PENDING;
}

static enum cleanup_result remove_contents(int fd) {
    static unsigned long sequence;
    int scan = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    DIR *dir;
    struct dirent *e;
    char **names = NULL;
    size_t count = 0;
    enum cleanup_result result = CLEAN_OK;
    if (scan < 0 || !(dir = fdopendir(scan))) {
        if (scan >= 0) {
            close(scan);
        }
        return CLEAN_PENDING;
    }
    while ((e = readdir(dir))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) {
            continue;
        }
        char **grown = realloc(names, (count + 1) * sizeof(*names));
        if (!grown) {
            result = CLEAN_PENDING;
            break;
        }
        names = grown;
        names[count] = strdup(e->d_name);
        if (!names[count]) {
            result = CLEAN_PENDING;
            break;
        }
        count++;
    }
    closedir(dir);
    if (result == CLEAN_OK) {
        for (size_t i = 0; i < count; i++) {
            struct stat before;
            if (fstatat(fd, names[i], &before, AT_SYMLINK_NOFOLLOW) != 0 ||
                remove_child(fd, names[i], before, sequence++) != CLEAN_OK) {
                result = CLEAN_PENDING;
                break;
            }
        }
    }
    for (size_t i = 0; i < count; i++) {
        free(names[i]);
    }
    free(names);
    return result;
}

static void cleanup_barrier(const char *point) {
    const char *barrier = getenv("WP_CODEBOX_CLEANUP_BARRIER"), *wanted = getenv("WP_CODEBOX_CLEANUP_BARRIER_POINT");
    if (barrier && *barrier &&
        (((!wanted || !*wanted) && !strcmp(point, "quarantined")) || (wanted && *wanted && !strcmp(wanted, point)))) {
        int marker = open(barrier, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
        if (marker >= 0) {
            dprintf(marker, "%ld\n", (long)getpid());
            close(marker);
            while (1) {
                pause();
            }
        }
    }
}
static int valid_token(const char *token) {
    if (!token || !*token || strlen(token) > 80) {
        return 0;
    }
    for (const char *p = token; *p; p++) {
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '-')) {
            return 0;
        }
    }
    return 1;
}
static const char cleanup_token_file[] = ".wp-codebox-cleanup-token";
static int write_target_token(int target, const char *token) {
    int fd = openat(target, cleanup_token_file, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
    if (fd < 0) {
        return -1;
    }
    int ok = dprintf(fd, "%s\n", token) > 0 && fsync(fd) == 0;
    close(fd);
    if (ok && sync_directory(target) == 0) {
        return 0;
    }
    unlinkat(target, cleanup_token_file, 0);
    sync_directory(target);
    return -1;
}
static int target_token(int target, const char *token) {
    char data[82], saved[81], extra;
    struct stat st, path;
    ssize_t n;
    int fd = openat(target, cleanup_token_file, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) {
        return 0;
    }
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || (st.st_mode & 0777) != 0600 ||
        fstatat(target, cleanup_token_file, &path, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same(identity_of(st), identity_of(path)) || (n = read(fd, data, sizeof(data) - 1)) <= 0) {
        close(fd);
        return 0;
    }
    close(fd);
    data[n] = 0;
    return sscanf(data, "%80s %c", saved, &extra) == 1 && !strcmp(saved, token);
}
static int remove_target_token(int target, const char *token) {
    struct stat st;
    if (!target_token(target, token)) {
        if (fstatat(target, cleanup_token_file, &st, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT) {
            return 0;
        }
        errno = EPERM;
        return -1;
    }
    return unlinkat(target, cleanup_token_file, 0) == 0 && sync_directory(target) == 0 ? 0 : -1;
}
static int ensure_target_token(int target, const char *token) {
    return target_token(target, token) ? 0 : write_target_token(target, token);
}
static int write_cleanup_state(int qfd, const char *token, identity expected, identity placeholder) {
    int fd = openat(qfd, "owner", O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
    if (fd < 0) {
        return -1;
    }
    int ok = dprintf(fd, "%s %llu %llu %llu %llu\n", token, (unsigned long long)expected.dev,
                     (unsigned long long)expected.ino, (unsigned long long)placeholder.dev,
                     (unsigned long long)placeholder.ino) > 0 &&
             fsync(fd) == 0;
    close(fd);
    return ok && sync_directory(qfd) == 0 ? 0 : -1;
}
static int read_cleanup_state(int qfd, const char *token, identity expected, identity *placeholder) {
    char data[256], saved[81], extra;
    unsigned long long ed, ei, pd, pi;
    int fd = openat(qfd, "owner", O_RDONLY | O_NOFOLLOW), result = 0;
    struct stat st;
    ssize_t n;
    if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || (st.st_mode & 0777) != 0600 ||
        (n = read(fd, data, sizeof(data) - 1)) <= 0) {
        if (fd >= 0) {
            close(fd);
        }
        return 0;
    }
    close(fd);
    data[n] = 0;
    if (sscanf(data, "%80s %llu %llu %llu %llu %c", saved, &ed, &ei, &pd, &pi, &extra) == 5 && !strcmp(saved, token) &&
        (dev_t)ed == expected.dev && (ino_t)ei == expected.ino) {
        placeholder->dev = (dev_t)pd;
        placeholder->ino = (ino_t)pi;
        result = 1;
    }
    return result;
}
static int directory_empty(int fd) {
    int scan = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW), empty = 0;
    DIR *dir;
    struct dirent *entry;
    if (scan < 0 || !(dir = fdopendir(scan))) {
        if (scan >= 0) {
            close(scan);
        }
        return 0;
    }
    empty = 1;
    while ((entry = readdir(dir))) {
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
            empty = 0;
            break;
        }
    }
    closedir(dir);
    return empty;
}
static enum cleanup_result cleanup_entry(int parent, const char *name, identity expected, const char *token) {
    char quarantine[256];
    int qfd = -1, root = -1, created = 0;
    struct stat st;
    identity placeholder = {0, 0};
    enum cleanup_result result = CLEAN_PENDING;
    if (!valid_token(token)) {
        return CLEAN_PENDING;
    }
    snprintf(quarantine, sizeof(quarantine), ".wp-codebox-cleanup-%llu-%llu-%s", (unsigned long long)expected.dev,
             (unsigned long long)expected.ino, token);
    if (mkdirat(parent, quarantine, 0700) == 0) {
        created = 1;
        if (sync_directory(parent) != 0) {
            goto done;
        }
    } else if (errno != EEXIST) {
        return CLEAN_PENDING;
    }
    qfd = openat(parent, quarantine, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (qfd < 0) {
        return CLEAN_PENDING;
    }
    if (created) {
        int target = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (target < 0 || !target_token(target, token)) {
            if (target >= 0) {
                close(target);
            }
            result = CLEAN_IDENTITY;
            goto done;
        }
        close(target);
        if (mkdirat(qfd, "root", 0700) != 0 || sync_directory(qfd) != 0 ||
            fstatat(qfd, "root", &st, AT_SYMLINK_NOFOLLOW) != 0) {
            goto done;
        }
        placeholder = identity_of(st);
        if (write_cleanup_state(qfd, token, expected, placeholder) != 0) {
            goto done;
        }
    } else if (!read_cleanup_state(qfd, token, expected, &placeholder)) {
        if (directory_empty(qfd)) {
            goto done;
        }
        if (entry_identity(parent, name, expected) && fstatat(qfd, "root", &st, AT_SYMLINK_NOFOLLOW) == 0 &&
            S_ISDIR(st.st_mode)) {
            int orphan = openat(qfd, "root", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
            if (orphan >= 0 && directory_empty(orphan)) {
                close(orphan);
                if (unlinkat(qfd, "root", AT_REMOVEDIR) == 0 && sync_directory(qfd) == 0) {
                    close(qfd);
                    qfd = -1;
                    if (unlinkat(parent, quarantine, AT_REMOVEDIR) == 0 && sync_directory(parent) == 0) {
                        return cleanup_entry(parent, name, expected, token);
                    }
                }
            } else if (orphan >= 0) {
                close(orphan);
            }
        }
        goto done;
    }
    if (entry_identity(qfd, "root", placeholder)) {
        if (!entry_identity(parent, name, expected)) {
            if (unlinkat(qfd, "root", AT_REMOVEDIR) == 0 && sync_directory(qfd) == 0 &&
                unlinkat(qfd, "owner", 0) == 0 && sync_directory(qfd) == 0) {
                close(qfd);
                qfd = -1;
                if (unlinkat(parent, quarantine, AT_REMOVEDIR) == 0) {
                    sync_directory(parent);
                }
            }
            return CLEAN_IDENTITY;
        }
        cleanup_barrier("before-exchange");
        if (exchange_at(parent, name, qfd, "root") != 0 || sync_directory(parent) != 0 || sync_directory(qfd) != 0) {
            goto done;
        }
    }
    if (!entry_identity(qfd, "root", expected)) {
        if (fstatat(qfd, "root", &st, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT && unlinkat(qfd, "owner", 0) == 0 &&
            sync_directory(qfd) == 0) {
            close(qfd);
            qfd = -1;
            if (unlinkat(parent, quarantine, AT_REMOVEDIR) == 0 && sync_directory(parent) == 0) {
                return CLEAN_OK;
            }
        }
        goto done;
    }
    cleanup_barrier("after-exchange");
    root = openat(qfd, "root", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (root < 0 || !target_token(root, token)) {
        goto done;
    }
    close(root);
    root = -1;
    if (entry_identity(parent, name, placeholder) &&
        (unlinkat(parent, name, AT_REMOVEDIR) != 0 || sync_directory(parent) != 0)) {
        goto done;
    }
    cleanup_barrier("quarantined");
    root = openat(qfd, "root", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (root < 0 || fstat(root, &st) != 0 || !same(identity_of(st), expected)) {
        goto done;
    }
    result = remove_contents(root);
    close(root);
    root = -1;
    if (result != CLEAN_OK) {
        goto done;
    }
    if (!entry_identity(qfd, "root", expected) || unlinkat(qfd, "root", AT_REMOVEDIR) != 0 ||
        sync_directory(qfd) != 0) {
        goto done;
    }
    if (unlinkat(qfd, "owner", 0) != 0 || sync_directory(qfd) != 0) {
        goto done;
    }
    if (unlinkat(parent, quarantine, AT_REMOVEDIR) != 0 || sync_directory(parent) != 0) {
        goto done;
    }
    close(qfd);
    return CLEAN_OK;
done:
    if (root >= 0) {
        close(root);
    }
    if (qfd >= 0) {
        close(qfd);
    }
    return result;
}

static int rollback_failure(const char *status) {
    write_status(status);
    return 5;
}
static int rollback_with_status(int lp, const char *ln, int rp, const char *rn, int staged_fd, int displaced_fd,
                                identity old_left, identity old_right, const char *token, const char *status) {
    file_barrier("WP_CODEBOX_ROLLBACK_BARRIER");
    if (!entry_identity(rp, rn, old_left)) {
        write_status("RIGHT_OWNERSHIP_CHANGED");
        return 4;
    }
    if (!entry_identity(lp, ln, old_right)) {
        char quarantine[192];
        struct stat st;
        identity empty, removed;
        snprintf(quarantine, sizeof(quarantine), ".wp-codebox-failed-promotion-%llu-%llu",
                 (unsigned long long)old_left.dev, (unsigned long long)old_left.ino);
        if (remove_target_token(displaced_fd, token) != 0) {
            return rollback_failure("ROLLBACK_IO_FAILED");
        }
        if (mkdirat(rp, quarantine, 0700) != 0 || fstatat(rp, quarantine, &st, AT_SYMLINK_NOFOLLOW) != 0) {
            return rollback_failure("ROLLBACK_IO_FAILED");
        }
        if (sync_directory(rp) != 0) {
            return rollback_failure("ROLLBACK_SYNC_FAILED");
        }
        empty = identity_of(st);
        if (!entry_identity(rp, rn, old_left)) {
            write_status("RIGHT_OWNERSHIP_CHANGED");
            return 4;
        }
        if (exchange_at(rp, quarantine, rp, rn) != 0) {
            return rollback_failure("ROLLBACK_EXCHANGE_FAILED");
        }
        if (sync_directory(rp) != 0) {
            return rollback_failure("ROLLBACK_SYNC_FAILED");
        }
        if (fstatat(rp, quarantine, &st, AT_SYMLINK_NOFOLLOW) != 0) {
            return rollback_failure("ROLLBACK_IO_FAILED");
        }
        removed = identity_of(st);
        if (!same(removed, old_left) || !entry_identity(rp, rn, empty)) {
            if (entry_identity(rp, rn, empty) && entry_identity(rp, quarantine, removed)) {
                if (exchange_at(rp, rn, rp, quarantine) != 0) {
                    return rollback_failure("ROLLBACK_EXCHANGE_FAILED");
                }
                if (sync_directory(rp) != 0) {
                    return rollback_failure("ROLLBACK_SYNC_FAILED");
                }
                if (!entry_identity(rp, rn, removed) || !entry_identity(rp, quarantine, empty)) {
                    return rollback_failure("ROLLBACK_OWNERSHIP_CHANGED");
                }
            }
            return rollback_failure("ROLLBACK_OWNERSHIP_CHANGED");
        }
        return rollback_failure("ROLLBACK_FAILED_LEFT_OWNERSHIP_CHANGED");
    }
    if (remove_target_token(displaced_fd, token) != 0) {
        return rollback_failure("ROLLBACK_IO_FAILED");
    }
    if (!entry_identity(rp, rn, old_left)) {
        write_status("RIGHT_OWNERSHIP_CHANGED");
        return 4;
    }
    if (!entry_identity(lp, ln, old_right)) {
        return rollback_failure("ROLLBACK_FAILED_LEFT_OWNERSHIP_CHANGED");
    }
    if (exchange_at(lp, ln, rp, rn) != 0) {
        return rollback_failure("ROLLBACK_EXCHANGE_FAILED");
    }
    if (sync_directory(lp) != 0 || (rp != lp && sync_directory(rp) != 0)) {
        return rollback_failure("ROLLBACK_SYNC_FAILED");
    }
    if (!entry_identity(rp, rn, old_right) || !entry_identity(lp, ln, old_left)) {
        return rollback_failure("ROLLBACK_OWNERSHIP_CHANGED");
    }
    if (ensure_target_token(staged_fd, token) != 0) {
        return rollback_failure("ROLLBACK_IO_FAILED");
    }
    write_status(status);
    return 0;
}
static int rollback(int lp, const char *ln, int rp, const char *rn, int staged_fd, int displaced_fd, identity old_left,
                    identity old_right, const char *token) {
    return rollback_with_status(lp, ln, rp, rn, staged_fd, displaced_fd, old_left, old_right, token, "ROLLED_BACK");
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    if (argc == 5 && !strcmp(argv[1], "--manifest")) {
        int root = open_absolute_directory(argv[2]);
        char digest[65];
        struct stat st;
        identity expected = {(dev_t)strtoull(argv[3], NULL, 10), (ino_t)strtoull(argv[4], NULL, 10)};
        if (root < 0 || fstat(root, &st) || !same(identity_of(st), expected) || manifest(root, digest) != 0) {
            if (root >= 0) {
                close(root);
            }
            write_status("INVALID_STAGING");
            return 6;
        }
        dprintf(STDOUT_FILENO, "MANIFEST %s\n", digest);
        close(root);
        return 0;
    }
    if (argc == 6 && !strcmp(argv[1], "--snapshot")) {
        int source = open_absolute_directory(argv[2]), destination = open_absolute_directory(argv[3]);
        char digest[65];
        struct stat before, after;
        identity expected = {(dev_t)strtoull(argv[4], NULL, 10), (ino_t)strtoull(argv[5], NULL, 10)};
        if (source < 0 || destination < 0 || fstat(source, &before) || !same(identity_of(before), expected) ||
            copy_snapshot_dir(source, destination) != 0 || fstat(source, &after) || !stable_metadata(before, after) ||
            manifest(destination, digest) != 0) {
            if (source >= 0) {
                close(source);
            }
            if (destination >= 0) {
                close(destination);
            }
            write_status("INVALID_STAGING");
            return 6;
        }
        dprintf(STDOUT_FILENO, "SNAPSHOT %s\n", digest);
        close(source);
        close(destination);
        return 0;
    }
    if (argc == 6 && !strcmp(argv[1], "--read")) {
        int root = open_absolute_directory(argv[2]);
        int file = root < 0 ? -1 : open_relative_file(root, argv[3]);
        unsigned char buffer[65536];
        ssize_t got;
        struct stat root_before, root_after, file_before, file_after;
        identity expected = {(dev_t)strtoull(argv[4], NULL, 10), (ino_t)strtoull(argv[5], NULL, 10)};
        if (root < 0 || fstat(root, &root_before) || !same(identity_of(root_before), expected) || file < 0 ||
            fstat(file, &file_before) || !S_ISREG(file_before.st_mode)) {
            return 8;
        }
        while ((got = read(file, buffer, sizeof(buffer))) > 0) {
            ssize_t sent = 0;
            while (sent < got) {
                ssize_t n = write(STDOUT_FILENO, buffer + sent, (size_t)(got - sent));
                if (n <= 0) {
                    return 8;
                }
                sent += n;
            }
        }
        {
            const char *barrier = getenv("WP_CODEBOX_READ_BARRIER");
            if (barrier && *barrier) {
                int marker = open(barrier, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
                if (marker >= 0) {
                    close(marker);
                    while (access(barrier, F_OK) == 0) {
                        usleep(1000);
                    }
                }
            }
        }
        if (got < 0 || fstat(file, &file_after) || !stable_metadata(file_before, file_after) ||
            fstat(root, &root_after) || !stable_metadata(root_before, root_after) ||
            !relative_file_identity(root, argv[3], identity_of(file_before))) {
            return 8;
        }
        return 0;
    }
    if (argc == 6 && !strcmp(argv[1], "--cleanup")) {
        char *parent_path = NULL, *name = NULL;
        identity expected = {(dev_t)strtoull(argv[3], NULL, 10), (ino_t)strtoull(argv[4], NULL, 10)};
        if (split_path(argv[2], &parent_path, &name)) {
            return 2;
        }
        int parent = open_absolute_directory(parent_path);
        enum cleanup_result cleaned = parent < 0 ? CLEAN_PENDING : cleanup_entry(parent, name, expected, argv[5]);
        free(parent_path);
        free(name);
        if (parent >= 0) {
            close(parent);
        }
        if (cleaned == CLEAN_IDENTITY) {
            write_status("RIGHT_OWNERSHIP_CHANGED");
            return 4;
        }
        if (cleaned == CLEAN_PENDING) {
            write_status("CLEANUP_PENDING");
            return 7;
        }
        write_status("CLEANED");
        return 0;
    }
    if (argc != 5 || strcmp(argv[1], "--transaction")) {
        fprintf(stderr, "usage: atomic-directory-exchange --transaction <lock-dir> <left> <right>\n");
        return 2;
    }
    secure_lock_handle lock = secure_lock(argv[2]);
    if (lock.file < 0) {
        perror("secure promotion lock");
        return 1;
    }
    char *lparent_path = NULL, *rparent_path = NULL, *ln = NULL, *rn = NULL;
    if (split_path(argv[3], &lparent_path, &ln) || split_path(argv[4], &rparent_path, &rn)) {
        return 2;
    }
    int lp = open_absolute_directory(lparent_path), rp = open_absolute_directory(rparent_path);
    int left_fd = lp < 0 ? -1 : openat(lp, ln, O_RDONLY | O_DIRECTORY | O_NOFOLLOW),
        right_fd = rp < 0 ? -1 : openat(rp, rn, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    struct stat ls, rs;
    if (lp < 0 || rp < 0 || left_fd < 0 || right_fd < 0 || fstat(left_fd, &ls) || fstat(right_fd, &rs)) {
        write_status("INVALID_DIRECTORY_ENTRY");
        return 6;
    }
    identity old_left = identity_of(ls), old_right = identity_of(rs);
    char line[256], digest[65], current[65], token[81];
    dprintf(STDOUT_FILENO, "LOCKED %llu %llu %llu %llu\n", (unsigned long long)old_left.dev,
            (unsigned long long)old_left.ino, (unsigned long long)old_right.dev, (unsigned long long)old_right.ino);
    while (read_command(line, sizeof(line)) == 0) {
        if (!strcmp(line, "MANIFEST")) {
            if (manifest(left_fd, current)) {
                write_status("INVALID_STAGING");
            } else {
                dprintf(STDOUT_FILENO, "MANIFEST %s\n", current);
            }
            continue;
        }
        if (!strncmp(line, "SNAPSHOT ", 9)) {
            int snapshot = open_absolute_directory(line + 9);
            if (snapshot < 0 || copy_snapshot_dir(left_fd, snapshot) != 0 || manifest(snapshot, current) != 0) {
                write_status("STAGING_CONTENT_CHANGED");
            } else {
                dprintf(STDOUT_FILENO, "SNAPSHOT %s\n", current);
            }
            if (snapshot >= 0) {
                close(snapshot);
            }
            continue;
        }
        if (!strncmp(line, "PROMOTE ", 8)) {
            char extra;
            if (sscanf(line + 8, "%64s %80s %c", digest, token, &extra) != 2 || strlen(digest) != 64 ||
                !valid_token(token)) {
                write_status("INVALID_STAGING");
                continue;
            }
            if (!lock_continuous(lock)) {
                write_status("DIRECTORY_LOCK_LOST");
                continue;
            }
            if (!entry_identity(lp, ln, old_left)) {
                write_status("LEFT_OWNERSHIP_CHANGED");
                continue;
            }
            if (!entry_identity(rp, rn, old_right)) {
                write_status("RIGHT_OWNERSHIP_CHANGED");
                continue;
            }
            if (manifest(left_fd, current) || strcmp(current, digest)) {
                write_status("STAGING_CONTENT_CHANGED");
                continue;
            }
            if (ensure_target_token(left_fd, token) != 0) {
                write_status("IO_FAILED");
                continue;
            }
            write_status("CHECKED");
            if (read_command(line, sizeof(line)) || strcmp(line, "EXCHANGE")) {
                return 2;
            }
            if (!lock_continuous(lock)) {
                write_status("DIRECTORY_LOCK_LOST");
                continue;
            }
            if (!entry_identity(lp, ln, old_left)) {
                write_status("LEFT_OWNERSHIP_CHANGED");
                continue;
            }
            if (!entry_identity(rp, rn, old_right)) {
                write_status("RIGHT_OWNERSHIP_CHANGED");
                continue;
            }
            if (sync_failure("staged-tree") || sync_manifest(left_fd, current) != 0) {
                write_status("SYNC_FAILED");
                continue;
            }
            if (strcmp(current, digest) || !lock_continuous(lock) || !entry_identity(lp, ln, old_left) ||
                !entry_identity(rp, rn, old_right)) {
                write_status("STAGING_CONTENT_CHANGED");
                continue;
            }
            if (exchange_at(lp, ln, rp, rn) != 0) {
                write_status("EXCHANGE_FAILED");
                continue;
            }
            if (sync_failure("exchange-parent") || sync_directory(lp) != 0 || (rp != lp && sync_directory(rp) != 0)) {
                return rollback_with_status(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token,
                                            "ROLLED_BACK SYNC_FAILED");
            }
            if (!entry_identity(rp, rn, old_left) || !entry_identity(lp, ln, old_right) || manifest(left_fd, current) ||
                strcmp(current, digest)) {
                return rollback_with_status(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token,
                                            "ROLLED_BACK STAGING_CONTENT_CHANGED");
            }
            if (remove_target_token(left_fd, token) != 0 || write_target_token(right_fd, token) != 0) {
                return rollback_with_status(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token,
                                            "ROLLED_BACK IO_FAILED");
            }
            if (write_status("PROMOTED") != 0) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            if (read_command(line, sizeof(line))) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            if (!strcmp(line, "ROLLBACK")) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            if (strcmp(line, "COMMIT")) {
                return 2;
            }
            if (!lock_continuous(lock)) {
                return rollback_with_status(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token,
                                            "ROLLED_BACK DIRECTORY_LOCK_LOST");
            }
            if (!entry_identity(rp, rn, old_left)) {
                write_status("RIGHT_OWNERSHIP_CHANGED");
                return 4;
            }
            if (!entry_identity(lp, ln, old_right) || manifest(left_fd, current) || strcmp(current, digest)) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            write_status("FINAL_MANIFEST");
            if (read_command(line, sizeof(line)) || strcmp(line, "FINALIZE")) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            if (manifest(left_fd, current) || strcmp(current, digest)) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            file_barrier("WP_CODEBOX_FINALIZE_BARRIER");
            if (manifest(left_fd, current) || strcmp(current, digest)) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            if (!lock_continuous(lock)) {
                return rollback_with_status(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token,
                                            "ROLLED_BACK DIRECTORY_LOCK_LOST");
            }
            if (!entry_identity(rp, rn, old_left)) {
                write_status("RIGHT_OWNERSHIP_CHANGED");
                return 4;
            }
            if (!entry_identity(lp, ln, old_right)) {
                return rollback(lp, ln, rp, rn, left_fd, right_fd, old_left, old_right, token);
            }
            write_status("COMMITTED");
            if (read_command(line, sizeof(line)) || strncmp(line, "CLEANUP ", 8)) {
                write_status("CLEANUP_PENDING");
                return 7;
            }
            enum cleanup_result cleaned = cleanup_entry(lp, ln, old_right, line + 8);
            if (cleaned == CLEAN_IDENTITY) {
                write_status("RIGHT_OWNERSHIP_CHANGED");
                return 4;
            }
            if (cleaned == CLEAN_PENDING) {
                write_status("CLEANUP_PENDING");
                return 7;
            }
            write_status("CLEANED");
            return 0;
        }
        if (!strcmp(line, "ABORT")) {
            return 0;
        }
        return 2;
    }
    close(lock.file);
    close(lock.parent);
    free(lock.name);
    return 0;
}
