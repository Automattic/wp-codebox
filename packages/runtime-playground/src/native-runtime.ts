import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { Runtime, RuntimeBackendProvider, RuntimeCreateSpec, RuntimeInfo, MountSpec, ExecutionSpec, ExecutionResult, ObservationSpec, ObservationResult, Snapshot, ArtifactSpec } from "@automattic/wp-codebox-core"
import { bootstrapPhpCode, phpCodeFromArgs } from "./php-bootstrap.js"
import { shellArgv, wpCliCommandFromArgs } from "./commands.js"
import { resolvePlaygroundWordPressStartupAsset } from "./playground-cli-runner.js"
import { collectPlaygroundArtifacts } from "./runtime-artifact-helpers.js"

const exec = promisify(execFile)
export const NATIVE_BACKEND = "wordpress-native"
export const nativeRuntimeBackendProvider: RuntimeBackendProvider = {
  kind: NATIVE_BACKEND,
  createBackend: () => ({ kind: NATIVE_BACKEND, create: async (spec) => {
    try { await docker(["info"], 10_000) } catch {
      throw Object.assign(new Error("wordpress-native requires a running Docker daemon"), { code: "wordpress-native-docker-unavailable" })
    }
    return new NativeRuntime(spec)
  } }),
}

async function docker(args: string[], timeout = 120_000, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(timeout)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const result = await exec("docker", args, { signal: combined, maxBuffer: 16 * 1024 * 1024 })
  return result.stdout
}

/** Lazy startup lets the orchestrator declare bind mounts before containers start. */
export class NativeRuntime implements Runtime {
  readonly id = `wp-codebox-native-${randomUUID()}`
  readonly createdAt = new Date().toISOString()
  private status: RuntimeInfo["status"] = "created"
  private mounts: MountSpec[] = []
  private commands: ExecutionResult[] = []
  private bootPromise?: Promise<void>
  private directory?: string
  private provenance: Record<string, unknown> = {}
  private readonly artifactRoot: string
  constructor(private readonly spec: RuntimeCreateSpec) {
    this.artifactRoot = resolve(spec.artifactsDirectory ?? join(tmpdir(), `${this.id}-artifacts`))
  }
  async info(): Promise<RuntimeInfo> {
    return { id: this.id, backend: NATIVE_BACKEND, environment: { ...this.spec.environment, metadata: { ...this.spec.environment.metadata, native: this.provenance } }, createdAt: this.createdAt, status: this.status }
  }
  async mount(spec: MountSpec): Promise<void> {
    if (this.bootPromise) throw new Error("wordpress-native mounts must be declared before the first command")
    if (!spec.target.startsWith("/") || spec.target.includes(",") || spec.source.includes(",")) throw new Error("Invalid native mount path")
    this.mounts.push({ ...spec, source: resolve(spec.source) })
  }
  private async boot(): Promise<void> {
    if (this.status === "destroyed") throw new Error("wordpress-native runtime is destroyed")
    this.bootPromise ??= this.start().catch(async (error) => { await this.destroy(); throw error })
    return this.bootPromise
  }
  private async start(): Promise<void> {
    const php = this.spec.environment.phpVersion ?? "8.4"
    if (!/^8\.[1-5]$/.test(php)) throw new Error(`Unsupported native PHP version: ${php}`)
    // Arbitrary Blueprint steps are not silently ignored by this initial backend.
    if (this.spec.environment.blueprint) throw new Error("Blueprints are not yet supported on wordpress-native")
    this.directory = await mkdtemp(join(tmpdir(), "wp-codebox-native-"))
    const base = `php:${php}-apache`
    await docker(["pull", base], 300_000)
    const digest = (await docker(["image", "inspect", base, "--format", "{{index .RepoDigests 0}}"])).trim()
    const tag = `wp-codebox-native:${php}`
    await writeFile(join(this.directory, "Dockerfile"), `FROM ${digest}\nRUN apt-get update && apt-get install -y --no-install-recommends libpng-dev libjpeg62-turbo-dev libfreetype6-dev libicu-dev libzip-dev unzip curl mariadb-client && docker-php-ext-configure gd --with-freetype --with-jpeg && docker-php-ext-install mysqli gd intl zip exif opcache && rm -rf /var/lib/apt/lists/*\nRUN curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /usr/local/bin/wp && chmod +x /usr/local/bin/wp\nRUN printf 'opcache.enable=1\\nopcache.enable_cli=1\\nopcache.file_cache_only=0\\nopcache.memory_consumption=256\\n' > /usr/local/etc/php/conf.d/native-opcache.ini && ln -s /wordpress /var/www/html/native\nWORKDIR /wordpress\n`)
    await docker(["build", "-t", tag, "--iidfile", join(this.directory, "image-id"), this.directory], 600_000)
    // The per-build ID avoids a race with another run updating the cache tag.
    const image = (await readFile(join(this.directory, "image-id"), "utf8")).trim()
    await docker(["network", "create", this.id])
    await docker(["volume", "create", `${this.id}-wp`])
    const password = randomUUID()
    await docker(["run", "-d", "--name", `${this.id}-db`, "--network", this.id, "--network-alias", "db", "--tmpfs", "/var/lib/mysql", "-e", `MARIADB_ROOT_PASSWORD=${password}`, "-e", "MARIADB_DATABASE=wordpress", "-e", "MARIADB_USER=wordpress", "-e", `MARIADB_PASSWORD=${password}`, "mariadb:11.4"])
    let ready = false
    for (let i = 0; i < 90; i++) {
      try { await docker(["exec", `${this.id}-db`, "healthcheck.sh", "--connect", "--innodb_initialized"], 5_000); ready = true; break } catch { await new Promise((r) => setTimeout(r, 1_000)) }
    }
    if (!ready) throw new Error("wordpress-native MariaDB startup timed out")
    const bindArgs = this.mounts.flatMap((m) => ["--mount", `type=bind,src=${m.source},dst=${m.target}${m.mode === "readonly" ? ",readonly" : ""}`])
    const envArgs = Object.entries({ ...this.spec.runtimeEnv, ...this.spec.secretEnv }).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    await docker(["run", "-d", "--name", `${this.id}-php`, "--network", this.id, "--mount", `type=volume,src=${this.id}-wp,dst=/wordpress`, ...bindArgs, ...envArgs, image])
    const asset = await resolvePlaygroundWordPressStartupAsset(this.spec.environment.version, this.spec.environment.assets?.wordpressZip)
    try {
      if (!asset.localPath) throw new Error("Native WordPress source must resolve to a local archive")
      await docker(["cp", asset.localPath, `${this.id}-php:/tmp/wordpress.zip`])
      await docker(["exec", `${this.id}-php`, "unzip", "-oq", "/tmp/wordpress.zip", "-d", "/tmp/core"])
      await docker(["exec", `${this.id}-php`, "sh", "-c", "cp -an /tmp/core/wordpress/. /wordpress/ && rm -rf /tmp/core /tmp/wordpress.zip"])
    } finally { await asset.archiveReference?.release() }
    await this.wp(["config", "create", "--dbname=wordpress", "--dbuser=wordpress", `--dbpass=${password}`, "--dbhost=db"])
    await this.wp(["core", "install", "--url=http://localhost", "--title=WP Codebox", "--admin_user=admin", `--admin_password=${randomUUID()}`, "--admin_email=admin@example.org", "--skip-email"])
    const phpVersion = (await docker(["exec", `${this.id}-php`, "php", "-r", "echo PHP_VERSION;"])).trim()
    const mariadbVersion = (await docker(["exec", `${this.id}-db`, "mariadbd", "--version"])).trim()
    const opcache = (await docker(["exec", `${this.id}-php`, "php", "-r", "echo opcache_get_status() !== false ? 'enabled' : 'disabled';"])).trim() === "enabled"
    this.provenance = { phpVersion, imageId: image, baseImageDigest: digest, mariadbVersion, opcache }
  }
  private wp(argv: string[], timeout?: number, signal?: AbortSignal): Promise<string> {
    return docker(["exec", `${this.id}-php`, "wp", "--allow-root", "--path=/wordpress", ...argv], timeout, signal)
  }
  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString()
    const result: ExecutionResult = { id: randomUUID(), command: spec.command, args: spec.args ?? [], exitCode: 0, stdout: "", stderr: "", startedAt, finishedAt: startedAt }
    try {
      if (!["wordpress.run-php", "wordpress.wp-cli"].includes(spec.command)) {
        throw Object.assign(new Error(`Command ${spec.command} is not supported on wordpress-native`), { code: "wordpress-native-command-unsupported" })
      }
      await this.boot()
      if (spec.command === "wordpress.wp-cli") {
        const argv = shellArgv(wpCliCommandFromArgs(spec.args ?? []))
        if (!argv.length) throw new Error("wordpress.wp-cli requires a non-empty command")
        result.stdout = await this.wp(argv, spec.timeoutMs, spec.signal)
      } else {
        const code = bootstrapPhpCode(this.spec, await phpCodeFromArgs(spec.args ?? []), spec.args ?? [])
        const name = `.wp-codebox-${randomUUID()}.php`
        const local = join(this.directory!, name)
        await writeFile(local, code)
        try {
          await docker(["cp", local, `${this.id}-php:/wordpress/${name}`])
          // Apache workers share in-memory OPcache; a fresh CLI process would not.
          result.stdout = await docker(["exec", `${this.id}-php`, "curl", "--silent", "--show-error", "--fail-with-body", `http://127.0.0.1/native/${name}`], spec.timeoutMs, spec.signal)
        } finally {
          await rm(local, { force: true })
          await docker(["exec", `${this.id}-php`, "rm", "-f", `/wordpress/${name}`]).catch(() => {})
        }
      }
    } catch (error) {
      const e = error as Error & { code?: string; killed?: boolean; stdout?: string; stderr?: string }
      result.exitCode = 1
      result.stdout = e.stdout ?? ""
      result.stderr = e.stderr || e.message
      result.result = { schema: "wp-codebox/runtime-command-result/v1", status: "error", stdout: result.stdout, stderr: result.stderr, error: { code: typeof e.code === "string" ? e.code : "wordpress-native-execution-failed", message: e.message } }
      if (e.killed || e.code === "ABORT_ERR" || spec.signal?.aborted) await this.destroy()
    }
    result.finishedAt = new Date().toISOString()
    this.commands.push(result)
    return result
  }
  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    const data = spec.type === "runtime-info" ? await this.info() : spec.type === "mounts" ? this.mounts : spec.type === "command-result" ? this.commands.find((c) => c.id === spec.commandId) : { error: "Observation not supported on wordpress-native" }
    return { type: spec.type, data, observedAt: new Date().toISOString() }
  }
  async snapshot(): Promise<Snapshot> { throw new Error("Snapshots are not supported on wordpress-native") }
  async collectArtifacts(spec: ArtifactSpec = {}) {
    await mkdir(this.artifactRoot, { recursive: true })
    return collectPlaygroundArtifacts({ artifactRoot: this.artifactRoot, runtimeId: this.id, createdAt: this.createdAt, spec: this.spec, mounts: this.mounts, commands: this.commands, observations: [{ type: "runtime-info", data: await this.info(), observedAt: new Date().toISOString() }], snapshots: [], events: [], info: () => this.info(), previewInfo: async () => undefined, recordArtifactsCollected: () => {}, browserProbes: [], pluginChecks: [], themeChecks: [] }, spec)
  }
  async destroy(): Promise<void> {
    this.status = "destroyed"
    await docker(["rm", "-f", "-v", `${this.id}-php`, `${this.id}-db`]).catch(() => {})
    await docker(["volume", "rm", "-f", `${this.id}-wp`]).catch(() => {})
    await docker(["network", "rm", this.id]).catch(() => {})
    if (this.directory) await rm(this.directory, { recursive: true, force: true })
  }
}
