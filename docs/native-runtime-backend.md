# Native WordPress runtime (initial slice)

Select `runtime.backend: "wordpress-native"` in a workspace recipe. Playground remains the default; `wordpress` still means `wordpress-playground`.

```json
{
  "schema": "wp-codebox/workspace-recipe/v1",
  "runtime": { "backend": "wordpress-native", "wp": "6.8", "phpVersion": "8.4" },
  "workflow": { "steps": [
    { "command": "wordpress.run-php", "args": ["code=echo PHP_VERSION, opcache_get_status() ? 'opcache' : 'no-opcache';"] },
    { "command": "wordpress.wp-cli", "args": ["command=option get siteurl"] }
  ] }
}
```

Docker must be running. Creation probes `docker info` and throws code `wordpress-native-docker-unavailable` when unavailable. Containers boot lazily on the first supported command so mounts can be declared first. Mounts use their original absolute targets and honor readonly mode; adding mounts after startup is rejected.

## Images and execution

The backend resolves the official `php:<version>-apache` image to its repository digest before building. PHP defaults to 8.4, matching Playground. The cached Docker layers add mysqli, gd, intl, zip, exif, in-memory OPcache, and WP-CLI. Each run uses its own immutable built image ID. MariaDB 11.4 runs on a per-runtime Docker network with tmpfs database storage and generated credentials; no database port is published.

WordPress archives use the same release resolver, validation, and cache as Playground. PHP commands use the existing PHP argument parser and bootstrap; requests go through Apache workers so OPcache persists across requests. WP-CLI uses the existing command-string parser and a real phar. Other commands return `wordpress-native-command-unsupported` in the standard error envelope.

`info().environment.metadata.native` records PHP version, built image ID, base digest, MariaDB version, and OPcache status. Artifact runtime-info observations include these values as well.

Destroy removes containers (including anonymous volumes), the WordPress volume, network, and temporary build directory. Startup failures and command cancellation/timeouts also trigger cleanup. Built images and the shared WordPress archive cache remain reusable.

## Current limits / follow-up

This is a tested **partial slice** of #2578, not the complete backend:

- Single-site installation only, with site URL `http://localhost`. Arbitrary Blueprints (including multisite setup) are rejected. Subdomain multisite and host mapping remain pending.
- No published web port, preview lease, browser commands, snapshots, or checkpoints.
- Declare mounts before execution. Mount phase sequencing and directory-based core assets are not implemented.
- Execution environment/cwd overrides, result-path capture, and structured diagnostics are not implemented.
- No runtime backend JS package override; this backend owns its Docker image.
- This initial backend is for trusted local/CI recipes: Docker network egress policy enforcement is not implemented. It is not a replacement for Playground's untrusted-code isolation.
- WP-CLI and OS packages follow upstream sources; only the PHP base is resolved to a digest per build. MariaDB's tag is not digest-pinned.
- Process crashes/forced host termination require manual Docker cleanup. Cleanup errors are best-effort, and startup uses bounded individual operations rather than a single episode-wide deadline.

Validation: `npm run build` and `npx tsx --test tests/native-runtime.test.ts`. The Docker test skips when `docker info` fails and otherwise checks PHP/OPcache, WP-CLI, and resource teardown. On hosts with long temporary directory paths, use `TMPDIR=/tmp` for tsx's Unix socket.
