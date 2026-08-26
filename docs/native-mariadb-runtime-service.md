# Native MariaDB Runtime Service

`provider: "native"` provisions a short-lived MariaDB process for MySQL-compatible workloads on Docker-free hosts. The generic runtime-service layer owns its complete lifecycle. Recipes may select only `provider: "native"` and `engine: "mariadb"`; host, port, credentials, sockets, configuration files, and filesystem paths are not configurable.

## Isolation Contract

- Before resolving or executing any host tool, the provider requires available real/effective UID and GID APIs, rejects every root-valued identity, and requires real/effective IDs to match. It then resolves and validates `mariadbd`, `mariadb-install-db`, `mariadb`, util-linux `prlimit`, `truncate`, `mkfs.ext4`, `fuse2fs`, and `fusermount3` identities before allocation. The MariaDB username must resolve back to the same proven UID and GID.
- Default executable discovery ignores the caller's `PATH`, searches fixed system directories, resolves symlinks, and requires every executable and ancestor to be UID-0-owned and not group/other writable. Child processes receive a fixed minimal `PATH`.
- Every run gets a mode-`0700` `mkdtemp` root. MariaDB's data directory, temporary directory, socket, PID file, error log, plugin directory, secure-file directory, home, and working directory are all inside the bounded image.
- Initialization and the daemon run as the verified unprivileged FUSE mount owner through fixed hard rlimits; administrative clients retain the provider identity and each database command itself begins with `--no-defaults`. No shell or default socket is used.
- Administration uses only the private Unix socket. Workloads receive a generated least-privilege `runtime` account over loopback TCP through the existing ephemeral connector-secret channel.
- Initialization, FUSE, and daemon commands each run in a new owned process group. Cleanup addresses the retained group, not a PID file; it waits for the complete group to disappear after graceful shutdown, then applies group-wide `SIGTERM` and `SIGKILL` as needed. Linux captures the leader start-time token and revalidates it while the leader is alive. Root device/inode identity and a symlink-free tree are revalidated before recursive removal.
- Failures, aborts, timeouts, startup crashes, and partial initialization all enter the same graceful-shutdown, forced-shutdown, wait, and verified-removal state machine. Cleanup failure is terminal and retained in bounded lifecycle evidence.
- Address space is capped at 2 GiB, CPU at 300 seconds, individual daemon files at 128 MiB, open files at 512, and processes/threads at 512. Core files and locked memory are disabled. The datadir is a provider-owned 256 MiB ext4 image formatted with 4,096 inodes and mounted through unprivileged FUSE; device, byte, inode, UID/GID, FUSE identity, and `rw,nosuid,nodev,noexec` mount options must be proven before initialization. Hosts without this containment fail closed.
- Recipes may declare at most two native services, bounding the aggregate native ceiling to two 2-GiB address spaces, two 256-MiB images, and the corresponding process/file limits.
- The daemon uses an empty bounded plugin directory and a bounded `secure-file-priv` directory. Startup fails unless every enabled storage engine is on the fixed local-only allowlist; FEDERATED, CONNECT, SPIDER, S3, and unknown enabled engines are rejected. The runtime account has privileges only on its generated database and cannot install plugins.
- Runtime descriptor discovery distinguishes package support from host availability. It advertises the active native capability only after trusted tools and a full disposable native-service provision, initialization, readiness, query, teardown, process-group exit, unmount, and removal lifecycle succeeds; unavailable reasons are stable codes without private paths. Concurrent discovery shares only the active bounded probe; settled results are immediately invalidated so host capability changes are observed. A failed teardown retains its exact cleanup handle and must be retried to completion before another allocation can begin.
- Descriptor execution applies a bounded timeout and scoped `SIGINT`, `SIGTERM`, and `SIGHUP` abort handlers. Handlers are removed after execution, and interruption follows the same retained cleanup path before descriptor discovery settles.
- Cleanup is single-flight for concurrent callers. A failed attempt may be retried, and evidence transitions from `teardown: failed` to a consistent released/completed state only after the retry proves cleanup.
- Evidence contains service ID, engine/provider version, lifecycle state, and memory measurements only. It never contains credentials or private absolute paths.

## Daemon Arguments

The provider starts `mariadbd` through `prlimit` with these fixed controls plus provider-owned absolute paths and a freshly allocated loopback port:

```text
--no-defaults
--datadir=<bounded-image>/database
--socket=<bounded-image>/runtime/server.sock
--pid-file=<bounded-image>/runtime/server.pid
--log-error=<bounded-image>/runtime/server.log
--tmpdir=<bounded-image>/tmp
--plugin-dir=<bounded-image>/plugins
--secure-file-priv=<bounded-image>/files
--bind-address=127.0.0.1
--port=<ephemeral>
--skip-name-resolve
--skip-log-bin
--skip-host-cache
--skip-slave-start
--skip-symbolic-links
--local-infile=OFF
--performance-schema=OFF
--skip-feedback
--innodb-buffer-pool-size=32M
--innodb-buffer-pool-size-max=32M
--innodb-log-buffer-size=4M
--key-buffer-size=8M
--aria-pagecache-buffer-size=8M
--thread-handling=pool-of-threads
--thread-pool-size=1
--aria-log-file-size=16M
--innodb-file-per-table=OFF
--innodb-data-file-path=ibdata1:32M:autoextend:max:96M
--innodb-temp-data-file-path=ibtmp1:16M:autoextend:max:32M
--innodb-log-file-size=32M
--max-connections=10
--max-prepared-stmt-count=256
--max-session-mem-used=32M
--open-files-limit=512
--thread-cache-size=0
--table-open-cache=128
--table-definition-cache=128
--tmp-table-size=8M
--max-heap-table-size=8M
```

The hard address-space ceiling is 2 GiB. Linux runs record the owned daemon's post-readiness RSS in evidence; the MariaDB 10.11 integration gate additionally requires observed RSS to remain at or below 128 MiB.

## Integration Contract

Homeboy Extensions issue #2412 may select this provider by emitting the generic runtime-service recipe declaration below. WP Codebox performs all provisioning and cleanup; callers do not supply or manage native process details.

```json
{
  "id": "wordpress-database",
  "kind": "mysql",
  "configuration": { "provider": "native", "engine": "mariadb" },
  "outputs": {
    "host": "DB_HOST",
    "port": "DB_PORT",
    "username": "DB_USER",
    "password": "DB_PASSWORD",
    "database": "DB_NAME"
  }
}
```
