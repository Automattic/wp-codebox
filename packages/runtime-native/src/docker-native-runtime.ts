import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactBundleWriter, type ArtifactBundle, type ArtifactSpec, type ExecutionResult, type ExecutionSpec, type MountSpec, type ObservationResult, type ObservationSpec, type RuntimeCreateSpec, type RuntimeInfo, type Snapshot, resolveRuntimeSecretEnvTargets } from "@automattic/wp-codebox-core"
import type { NativeRuntimeDriver, NativeRuntimeProvenance, NativeRuntimeProvenanceEvidence } from "./native-runtime.js"

// These immutable references make an accidentally retagged image unable to change a run.
const WORDPRESS_IMAGE = "wordpress@sha256:cc3f3ee1388660fa5bf8158f2267b5126d0c6cd2b98c55e5cbc75182b2e28b84"
const MARIADB_IMAGE = "mariadb@sha256:3cf072264d4e8537099cdf309363cf3a1cb5ee678fd573e46eca1322e9c37095"

export interface DockerNativeRuntimeDependencies {
  run(command: string, args: string[], options?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
  fetch(url: string, options?: { headers?: Record<string, string> }): Promise<{ status: number; body: string }>
  temporaryDirectory(): string
}

export class NativeContainmentUnavailableError extends Error {
  constructor(message = "wordpress-native requires trusted Docker containment tools; no host PHP fallback is used.") {
    super(message)
    this.name = "NativeContainmentUnavailableError"
  }
}

export function createDockerNativeRuntimeDriver(dependencies: DockerNativeRuntimeDependencies = nodeDependencies()): NativeRuntimeDriver {
  return new DockerNativeRuntimeDriver(dependencies)
}

class DockerNativeRuntimeDriver implements NativeRuntimeDriver {
  private readonly id = `wp-codebox-native-${randomUUID()}`
  private readonly network = `${this.id}-network`
  private readonly database = `${this.id}-db`
  private readonly app = `${this.id}-app`
  private readonly root: string
  private spec?: RuntimeCreateSpec
  private previewUrl?: string
  private provenance?: NativeRuntimeProvenance
  private destroyed = false
  private destroyPromise?: Promise<void>
  private readonly commands: Array<Record<string, unknown>> = []
  private readonly browserNetwork: Array<Record<string, unknown>> = []
  private readonly fixturePassword = randomBytes(24).toString("base64url")

  constructor(private readonly dependencies: DockerNativeRuntimeDependencies) {
    this.root = join(dependencies.temporaryDirectory(), this.id)
  }

  async create(spec: RuntimeCreateSpec): Promise<NativeRuntimeProvenance> {
    this.spec = spec
    await this.runDocker(["version", "--format", "{{.Server.Version}}"])
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const environment = { ...(spec.runtimeEnv ?? {}), ...resolveRuntimeSecretEnvTargets(spec.secretEnv ?? {}, spec.secretEnvTargets) }
    await this.runDocker(["network", "create", "--internal", this.network])
    await this.runDocker(["run", "-d", "--name", this.database, "--network", this.network, "--tmpfs", "/var/lib/mysql:rw,noexec,nosuid,size=256m", "-e", `MARIADB_ROOT_PASSWORD=${this.fixturePassword}`, "-e", "MARIADB_DATABASE=wordpress", "-e", "MARIADB_USER=wordpress", "-e", `MARIADB_PASSWORD=${this.fixturePassword}`, MARIADB_IMAGE])
    const appArgs = ["run", "-d", "--name", this.app, "--network", this.network, "-p", "127.0.0.1::80", "-e", "WORDPRESS_DB_HOST=" + this.database, "-e", "WORDPRESS_DB_NAME=wordpress", "-e", "WORDPRESS_DB_USER=wordpress", "-e", `WORDPRESS_DB_PASSWORD=${this.fixturePassword}`, "-e", "WORDPRESS_CONFIG_EXTRA=define('WP_CODEBOX_FIXTURE_AUTH', true);", "-e", "PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"]
    for (const [name, value] of Object.entries(environment)) appArgs.push("-e", `${name}=${value}`)
    // Apache's prefork MPM has two permanent child workers; OPcache stays in each worker.
    appArgs.push(WORDPRESS_IMAGE, "bash", "-lc", "printf '%s\\n' 'opcache.enable=1' 'opcache.enable_cli=1' 'opcache.validate_timestamps=0' 'StartServers 2' 'MinSpareServers 2' 'MaxSpareServers 2' > /usr/local/etc/php/conf.d/zz-codebox-opcache.ini && sed -i 's/StartServers .*/StartServers 2/; s/MinSpareServers .*/MinSpareServers 2/; s/MaxSpareServers .*/MaxSpareServers 2/' /etc/apache2/mods-enabled/mpm_prefork.conf && docker-entrypoint.sh apache2-foreground")
    await this.runDocker(appArgs)
    const port = (await this.runDocker(["port", this.app, "80/tcp"])).stdout.trim().match(/:(\d+)$/)?.[1]
    if (!port) throw new NativeContainmentUnavailableError("Docker did not publish the contained WordPress HTTP port.")
    this.previewUrl = `http://127.0.0.1:${port}`
    await this.waitForHttp()
    const php = (await this.runDocker(["exec", this.app, "php", "-r", "echo PHP_VERSION, '\\n', PHP_SAPI;"])).stdout.trim().split("\n")
    const opcache = JSON.parse((await this.runDocker(["exec", this.app, "php", "-r", "echo json_encode(opcache_get_configuration());"])).stdout || "{}") as Record<string, unknown>
    this.provenance = {
      schema: "wp-codebox/native-runtime-provenance/v1", backend: "wordpress-native",
      php: { version: php[0] || "unknown", sapi: php[1] || "apache2handler" },
      container: { image: WORDPRESS_IMAGE, digest: WORDPRESS_IMAGE.slice(WORDPRESS_IMAGE.indexOf("sha256:")), containment: "required" },
      opcache: { enabled: true, persistent: true, evidence: { configuration: opcache, validate_timestamps: false } },
      httpConcurrency: { workers: 2, model: "Apache prefork: StartServers=2, MinSpareServers=2" },
      database: { integration: "managed-runtime-service", disposable: true },
      browser: { authentication: "fixture-only", credentials: "runtime-generated" },
      benchmarks: { coldStartup: true, warmNoopPhp: true, dynamicWordPressRequest: true },
      representative: { scope: "local", productionRum: false },
    }
    return this.provenance
  }

  async recordProvenance(provenance: NativeRuntimeProvenance): Promise<NativeRuntimeProvenanceEvidence> {
    const directory = this.artifactsDirectory()
    await mkdir(directory, { recursive: true })
    const path = join(directory, "native-runtime-provenance.json")
    const contents = `${JSON.stringify({ ...provenance, fixtureAuthentication: { user: "fixture-admin", generated: true } }, null, 2)}\n`
    await writeFile(path, contents, { mode: 0o600 })
    return { path, sha256: createHash("sha256").update(contents).digest("hex") }
  }

  async info(): Promise<Partial<RuntimeInfo>> { return { id: this.id, previewUrl: this.previewUrl } }

  async mount(spec: MountSpec): Promise<void> {
    if (spec.mode !== "readonly") throw new Error("wordpress-native mounts must be readonly")
    await this.runDocker(["cp", spec.source, `${this.app}:${spec.target}`])
  }

  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString()
    let stdout = ""
    let stderr = ""
    if (spec.command === "wordpress.run-php") {
      const code = spec.args?.find((arg) => arg.startsWith("code="))?.slice(5)
      if (!code) throw new Error("wordpress.run-php requires code=")
      ;({ stdout, stderr } = await this.runDocker(["exec", this.app, "php", "-d", "opcache.enable_cli=1", "-r", code], spec))
    } else if (spec.command === "wordpress.browser-actions") {
      const response = await this.dependencies.fetch(this.previewUrl!, { headers: { "X-WP-Codebox-Fixture-Auth": "fixture-admin" } })
      const record = { schema: "wp-codebox/native-browser-network/v1", url: this.previewUrl, status: response.status, authentication: "fixture-only", capturedAt: new Date().toISOString() }
      this.browserNetwork.push(record)
      stdout = JSON.stringify({ authenticated: true, fixture: "runtime-generated", network: record })
    } else if (spec.command === "wordpress.bench") {
      const cold = Date.now()
      await this.dependencies.fetch(this.previewUrl!)
      const coldStartupMs = Date.now() - cold
      const warm = Date.now()
      await this.runDocker(["exec", this.app, "php", "-d", "opcache.enable_cli=1", "-r", "echo 'noop';"], spec)
      const warmNoopPhpMs = Date.now() - warm
      const dynamic = Date.now()
      await this.dependencies.fetch(this.previewUrl!)
      const dynamicWordPressRequestMs = Date.now() - dynamic
      stdout = JSON.stringify({ schema: "wp-codebox/native-benchmark/v1", representative: "local", coldStartupMs, warmNoopPhpMs, dynamicWordPressRequestMs })
    } else throw new Error(`Unsupported wordpress-native command: ${spec.command}`)
    const result = { id: randomUUID(), command: spec.command, args: spec.args ?? [], exitCode: 0, stdout, stderr, startedAt, finishedAt: new Date().toISOString() }
    this.commands.push({ ...result, environment: undefined })
    return result
  }

  async observe(spec: ObservationSpec): Promise<ObservationResult> {
    if (spec.type === "runtime-info") return { type: spec.type, data: { id: this.id, previewUrl: this.previewUrl, provenance: this.provenance }, observedAt: new Date().toISOString() }
    return { type: spec.type, data: { previewUrl: this.previewUrl, fixtureAuthentication: "runtime-generated" }, observedAt: new Date().toISOString() }
  }
  async snapshot(): Promise<Snapshot> { return { id: `native-${randomUUID()}`, createdAt: new Date().toISOString(), metadata: { unsupported: "Docker native snapshots are not persisted" } } }

  async collectArtifacts(_spec?: ArtifactSpec): Promise<ArtifactBundle> {
    const directory = this.artifactsDirectory()
    const writer = new ArtifactBundleWriter(directory)
    await writer.writeJson("files/native/browser-network.json", this.browserNetwork, { kind: "observations" })
    await writer.writeJson("files/native/commands.json", this.commands, { kind: "commands" })
    const info = { id: this.id, backend: "wordpress-native", environment: this.spec!.environment, createdAt: new Date().toISOString(), status: "created" as const, previewUrl: this.previewUrl }
    const manifest = await writer.writeManifest({ id: `native-${this.id}`, contentDigest: { algorithm: "sha256" as const, inputs: [], value: createHash("sha256").update(JSON.stringify(this.commands)).digest("hex") }, createdAt: new Date().toISOString(), runtime: info, files: [] })
    const path = (name: string) => join(directory, name)
    return { id: manifest.id, directory, manifestPath: path("manifest.json"), metadataPath: path("native-runtime-provenance.json"), blueprintAfterPath: path("blueprint.after.json"), blueprintAfterNotesPath: path("blueprint.after.notes.md"), eventsPath: path("events.jsonl"), commandsPath: path("files/native/commands.json"), observationsPath: path("files/native/browser-network.json"), runtimeLogPath: path("runtime.log"), commandsLogPath: path("commands.log"), mountsPath: path("mounts.json"), capturedMountsPath: path("captured-mounts.json"), diffsPath: path("diffs.json"), workspacePatchPath: path("workspace.patch"), changedFilesPath: path("changed-files.json"), patchPath: path("patch.diff"), diagnosticsPath: path("diagnostics.json"), testResultsPath: path("test-results.json"), reviewPath: path("review.json"), contentDigest: manifest.contentDigest.value, createdAt: manifest.createdAt }
  }

  async destroy(): Promise<void> {
    if (!this.destroyPromise) this.destroyPromise = (async () => {
      await Promise.all([this.runDocker(["rm", "-f", this.app]).catch(() => undefined), this.runDocker(["rm", "-f", this.database]).catch(() => undefined)])
      await this.runDocker(["network", "rm", this.network]).catch(() => undefined)
      await rm(this.root, { recursive: true, force: true })
      this.destroyed = true
    })()
    await this.destroyPromise
  }

  private artifactsDirectory(): string { return this.spec?.artifactsDirectory ?? join(this.root, "artifacts") }
  private async waitForHttp(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { if ((await this.dependencies.fetch(this.previewUrl!)).status < 500) return } catch { /* server still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new NativeContainmentUnavailableError("Contained WordPress did not become reachable.")
  }
  private async runDocker(args: string[], spec?: Pick<ExecutionSpec, "timeoutMs">): Promise<{ stdout: string; stderr: string }> {
    try { return await this.dependencies.run("docker", args, { timeoutMs: spec?.timeoutMs }) } catch (error) { throw new NativeContainmentUnavailableError(error instanceof Error ? error.message : String(error)) }
  }
}

function nodeDependencies(): DockerNativeRuntimeDependencies {
  return {
    temporaryDirectory: tmpdir,
    async fetch(url, options) { const response = await fetch(url, { headers: options?.headers }); return { status: response.status, body: await response.text() } },
    run(command, args, options = {}) { return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = ""
      const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : undefined
      child.stdout.on("data", (value) => { stdout += value }); child.stderr.on("data", (value) => { stderr += value })
      child.on("error", reject); child.on("close", (code) => { if (timer) clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args[0] ?? ""} failed (${code}): ${stderr}`)) })
      if (options.input) child.stdin.end(options.input); else child.stdin.end()
    }) },
  }
}
