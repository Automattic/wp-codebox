# Native MariaDB Runtime Service

`provider: "native"` provisions a short-lived MariaDB process for MySQL-compatible workloads on Docker-free hosts. The generic runtime-service layer owns its complete lifecycle. Recipes may select only `provider: "native"` and `engine: "mariadb"`; host, port, credentials, sockets, configuration files, and filesystem paths are not configurable.

## Isolation Contract

- The provider rejects UID 0 and resolves and validates `mariadbd`, `mariadb-install-db`, `mariadb`, util-linux `prlimit`, `truncate`, `mkfs.ext4`, `fuse2fs`, and `fusermount3` identities before allocation.
- Every run gets a mode-`0700` `mkdtemp` root. The data directory, temporary directory, socket, PID file, and error log are children of that root.
- Initialization, daemon, and administrative clients run through fixed hard rlimits; each database command itself begins with `--no-defaults`. No shell or default socket is used.
- Administration uses only the private Unix socket. Workloads receive a generated least-privilege `runtime` account over loopback TCP through the existing ephemeral connector-secret channel.
- Cleanup signals only the retained direct `ChildProcess`; the PID file is never trusted or read. Linux captures the owned process start-time token and revalidates it before every signal to reject PID reuse. Root device/inode identity and a symlink-free tree are revalidated before recursive removal.
- Failures, aborts, timeouts, startup crashes, and partial initialization all enter the same graceful-shutdown, forced-shutdown, wait, and verified-removal state machine. Cleanup failure is terminal and retained in bounded lifecycle evidence.
- Address space is capped at 2 GiB, CPU at 300 seconds, individual daemon files at 128 MiB, open files at 512, and processes/threads at 512. Core files and locked memory are disabled. The datadir is a provider-owned 256 MiB ext4 image formatted with 4,096 inodes and mounted through unprivileged FUSE; device, byte, and inode geometry must be proven before initialization. Hosts without this containment fail closed.
- Evidence contains service ID, engine/provider version, lifecycle state, and memory measurements only. It never contains credentials or private absolute paths.

## Daemon Arguments

The provider starts `mariadbd` through `prlimit` with these fixed controls plus provider-owned absolute paths and a freshly allocated loopback port:

```text
--no-defaults
--datadir=<private-root>/data
--socket=<private-root>/server.sock
--pid-file=<private-root>/server.pid
--log-error=<private-root>/server.log
--tmpdir=<private-root>/tmp
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
