import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { ArtifactBundleWriter, type ArtifactBundle, type ArtifactSpec, type BrowserInteractionStep, type ExecutionResult, type ExecutionSpec, type MountSpec, type ObservationResult, type ObservationSpec, type RuntimeCreateSpec, type RuntimeInfo, type Snapshot, resolveRuntimeSecretEnvTargets, validateBrowserInteractionScript } from "@automattic/wp-codebox-core"
import type { NativeRuntimeDriver, NativeRuntimeProvenance, NativeRuntimeProvenanceEvidence } from "./native-runtime.js"

// These immutable references make an accidentally retagged image unable to change a run.
// Resolved on the linux/amd64 Docker runner on 2026-09-03. The platform is
// explicit so the digest cannot accidentally select a different manifest.
const DOCKER_PLATFORM = "linux/amd64"
const WORDPRESS_IMAGE = "wordpress:php8.4-apache@sha256:b5ad1a1b6fe6f1232d27a6effb0abc45cf71dcac6d6aba0db7d6fcaec047ffb3"
const MARIADB_IMAGE = "mariadb:11.4@sha256:8fade42367c1d0505a2c06cfacd411e1bd81c28995183d00935e09b702fd0042"

export interface DockerNativeRuntimeDependencies {
  run(command: string, args: string[], options?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>
  fetch(url: string, options?: { headers?: Record<string, string>; method?: string; body?: string }): Promise<{ status: number; body: string }>
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
  private readonly browserConsole: Array<Record<string, unknown>> = []
  private readonly browserErrors: Array<Record<string, unknown>> = []
  private readonly browserSteps: Array<Record<string, unknown>> = []
  private readonly browserFiles: Array<{ path: string; kind: string; contentType: string }> = []
  private readonly fixturePassword = randomBytes(24).toString("base64url")
  private startupMs = 0

  constructor(private readonly dependencies: DockerNativeRuntimeDependencies) {
    this.root = join(dependencies.temporaryDirectory(), this.id)
  }

  async create(spec: RuntimeCreateSpec): Promise<NativeRuntimeProvenance> {
    this.spec = spec
    await this.runDocker(["version", "--format", "{{.Server.Version}}"])
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const environment = { ...(spec.runtimeEnv ?? {}), ...resolveRuntimeSecretEnvTargets(spec.secretEnv ?? {}, spec.secretEnvTargets) }
    await this.runDocker(["network", "create", "--internal", this.network])
    await this.runDocker(["run", "-d", "--platform", DOCKER_PLATFORM, "--name", this.database, "--network", this.network, "--tmpfs", "/var/lib/mysql:rw,noexec,nosuid,size=256m", "-e", `MARIADB_ROOT_PASSWORD=${this.fixturePassword}`, "-e", "MARIADB_DATABASE=wordpress", "-e", "MARIADB_USER=wordpress", "-e", `MARIADB_PASSWORD=${this.fixturePassword}`, MARIADB_IMAGE])
    const appArgs = ["run", "-d", "--platform", DOCKER_PLATFORM, "--name", this.app, "--network", this.network, "-p", "127.0.0.1::80", "-e", "WORDPRESS_DB_HOST=" + this.database, "-e", "WORDPRESS_DB_NAME=wordpress", "-e", "WORDPRESS_DB_USER=wordpress", "-e", `WORDPRESS_DB_PASSWORD=${this.fixturePassword}`, "-e", "WORDPRESS_CONFIG_EXTRA=define('WP_CODEBOX_FIXTURE_AUTH', true);", "-e", "PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"]
    for (const [name, value] of Object.entries(environment)) appArgs.push("-e", `${name}=${value}`)
    // Apache's prefork MPM has two permanent child workers; OPcache stays in each worker.
    appArgs.push(WORDPRESS_IMAGE, "bash", "-lc", "printf '%s\\n' 'opcache.enable=1' 'opcache.enable_cli=1' 'opcache.validate_timestamps=0' 'StartServers 2' 'MinSpareServers 2' 'MaxSpareServers 2' > /usr/local/etc/php/conf.d/zz-codebox-opcache.ini && sed -i 's/StartServers .*/StartServers 2/; s/MinSpareServers .*/MinSpareServers 2/; s/MaxSpareServers .*/MaxSpareServers 2/' /etc/apache2/mods-enabled/mpm_prefork.conf && docker-entrypoint.sh apache2-foreground")
    const startupStarted = Date.now()
    await this.runDocker(appArgs)
    const port = (await this.runDocker(["port", this.app, "80/tcp"])).stdout.trim().match(/:(\d+)$/)?.[1]
    if (!port) throw new NativeContainmentUnavailableError("Docker did not publish the contained WordPress HTTP port.")
    this.previewUrl = `http://127.0.0.1:${port}`
    await this.waitForHttp()
    await this.installFixtureWordPress()
    this.startupMs = Math.max(1, Date.now() - startupStarted)
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
    if (spec.type !== "directory") throw new Error("wordpress-native supports readonly directory snapshot mounts only; live and file mounts are not available for running containers")
    // Recipes target Playground's /wordpress root; map it to the official
    // image root so those downstream distributions do not need a native fork.
    const target = spec.target === "/wordpress" ? "/var/www/html" : spec.target.startsWith("/wordpress/") ? `/var/www/html/${spec.target.slice("/wordpress/".length)}` : spec.target
    if (target !== "/var/www/html" && !target.startsWith("/var/www/html/")) throw new Error("wordpress-native readonly copies may only target the WordPress root")
    // Docker cannot add a bind mount to a running container. This is a one-time,
    // readonly-source copy, not a live readonly bind; do not claim otherwise.
    await this.runDocker(["cp", `${spec.source}/.`, `${this.app}:${target}`])
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
      stdout = JSON.stringify(await this.runBrowserActions(spec))
    } else if (spec.command === "wordpress.bench") {
      const coldStartupMs = await this.measureColdStartup()
      const warm = Date.now()
      await this.runDocker(["exec", this.app, "php", "-d", "opcache.enable_cli=1", "-r", "echo 'noop';"], spec)
      const warmNoopPhpMs = Date.now() - warm
      const dynamic = Date.now()
      await this.dependencies.fetch(`${this.previewUrl}/?wp-codebox-dynamic=${randomUUID()}`)
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
    await writer.writeJson("files/browser/network.json", this.browserNetwork, { kind: "browser-network" })
    await writer.writeJson("files/browser/console.json", this.browserConsole, { kind: "browser-console" })
    await writer.writeJson("files/browser/errors.json", this.browserErrors, { kind: "browser-errors" })
    await writer.writeJson("files/browser/steps.json", this.browserSteps, { kind: "browser-steps" })
    for (const file of this.browserFiles) await writer.writeGenerated(file.path, { kind: file.kind, contentType: file.contentType }, async () => undefined)
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
  private async installFixtureWordPress(): Promise<void> {
    const body = new URLSearchParams({ weblog_title: "WP Codebox Fixture", user_name: "fixture-admin", admin_password: this.fixturePassword, admin_password2: this.fixturePassword, admin_email: "fixture-admin@example.test", Submit: "Install WordPress", language: "en_US" }).toString()
    const installed = await this.dependencies.fetch(`${this.previewUrl}/wp-admin/install.php?step=2`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
    if (installed.status >= 400 || !/Success|Log In/i.test(installed.body)) throw new NativeContainmentUnavailableError("Contained WordPress installation did not complete.")
    const user = await this.runDocker(["exec", this.app, "php", "-r", "require '/var/www/html/wp-load.php'; echo get_user_by('login', 'fixture-admin') ? 'ready' : 'missing';"])
    if (user.stdout.trim() !== "ready") throw new NativeContainmentUnavailableError("Contained WordPress fixture administrator was not created.")
  }
  private async measureColdStartup(): Promise<number> {
    if (this.startupMs <= 0) throw new NativeContainmentUnavailableError("Contained WordPress startup was not measured.")
    return this.startupMs
  }
  private async runBrowserActions(spec: ExecutionSpec): Promise<Record<string, unknown>> {
    const raw = spec.args?.find((arg) => arg.startsWith("steps-json="))?.slice("steps-json=".length)
    if (!raw) throw new Error("wordpress.browser-actions requires steps-json=<array>")
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error("wordpress.browser-actions steps-json must be valid JSON") }
    const validation = validateBrowserInteractionScript(parsed)
    if (!validation.valid) throw new Error(`wordpress.browser-actions steps-json is invalid: ${validation.issues.map((issue) => `[${issue.index}] ${issue.message}`).join("; ")}`)
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.on("console", (message) => this.browserConsole.push({ type: message.type(), text: message.text(), capturedAt: new Date().toISOString() }))
    page.on("pageerror", (error) => this.browserErrors.push({ message: error.message, capturedAt: new Date().toISOString() }))
    page.on("response", (response) => this.browserNetwork.push({ schema: "wp-codebox/native-browser-network/v1", url: response.url(), status: response.status(), method: response.request().method(), capturedAt: new Date().toISOString() }))
    try {
      await page.goto(`${this.previewUrl}/wp-login.php`, { waitUntil: "load" })
      await page.locator("#user_login").fill("fixture-admin")
      await page.locator("#user_pass").fill(this.fixturePassword)
      await page.locator("#wp-submit").click()
      await page.waitForURL(/wp-admin/, { timeout: 15_000 })
      for (const [index, step] of validation.steps.entries()) await this.runBrowserStep(page, step, index)
      return { schema: "wp-codebox/native-browser-actions/v1", authenticated: true, fixture: "runtime-generated", steps: validation.steps.length, network: this.browserNetwork.slice(-100) }
    } finally { await browser.close() }
  }
  private async runBrowserStep(page: import("playwright").Page, step: BrowserInteractionStep, index: number): Promise<void> {
    const started = Date.now()
    const selector = step.selector ?? (step.text ? `text=${step.text}` : undefined)
    try {
      if (step.kind === "navigate") await page.goto(new URL(step.url ?? "/", this.previewUrl).toString(), { waitUntil: step.waitFor === "load" || step.waitFor === "networkidle" ? step.waitFor : "domcontentloaded" })
      else if (step.kind === "click") await page.locator(selector!).click()
      else if (step.kind === "fill") await page.locator(selector!).fill(step.value ?? "")
      else if (step.kind === "type") await page.locator(selector!).pressSequentially(step.value ?? "")
      else if (step.kind === "press") await page.locator(selector!).press(step.key!)
      else if (step.kind === "drag") {
        if (!step.from || !step.to || !("selector" in step.to)) throw new Error("native browser drag requires selector source and target")
        await page.locator(step.from).dragTo(page.locator(step.to.selector))
      }
      else if (step.kind === "hover") await page.locator(selector!).hover()
      else if (step.kind === "select") await page.locator(selector!).selectOption(step.values ?? step.value ?? "")
      else if (step.kind === "waitFor") {
        if (step.duration) await page.waitForTimeout(Number.parseFloat(step.duration) * (step.duration.endsWith("s") && !step.duration.endsWith("ms") ? 1000 : 1))
        else if (step.waitFor === "load" || step.waitFor === "networkidle" || step.waitFor === "domcontentloaded") await page.waitForLoadState(step.waitFor)
        else await page.locator((step.waitFor ?? "").replace(/^selector:/, "")).waitFor()
      }
      else if (step.kind === "evaluate") { const value = await page.evaluate(step.expression!); if (step.assert !== undefined && JSON.stringify(value) !== JSON.stringify(step.assert)) throw new Error("evaluate assertion failed") }
      else if (step.kind === "expect") await this.assertBrowserState(page, selector!, step.state ?? "visible")
      else if (step.kind === "screenshot") { const path = `files/browser/${step.name ?? `step-${index}`}.png`; await mkdir(join(this.artifactsDirectory(), "files", "browser"), { recursive: true }); await page.screenshot({ path: join(this.artifactsDirectory(), path) }); this.browserFiles.push({ path, kind: "browser-screenshot", contentType: "image/png" }) }
      else if (step.kind === "capture") { const path = `files/browser/capture-${index}.html`; await mkdir(join(this.artifactsDirectory(), "files", "browser"), { recursive: true }); await writeFile(join(this.artifactsDirectory(), path), await page.content(), { mode: 0o600 }); this.browserFiles.push({ path, kind: "browser-html-snapshot", contentType: "text/html; charset=utf-8" }) }
      else if (step.kind === "assertObservation") {
        if (step.assertion === "no-console-errors" && this.browserConsole.some(({ type }) => type === "error")) throw new Error("console errors were captured")
        if (step.assertion === "no-page-errors" && this.browserErrors.length > 0) throw new Error("page errors were captured")
        if (step.assertion !== "no-console-errors" && step.assertion !== "no-page-errors") throw new Error(`native browser assertion is unsupported: ${step.assertion}`)
      }
      else throw new Error(`wordpress.browser-actions native executor does not support ${step.kind}`)
      this.browserSteps.push({ index, kind: step.kind, status: "passed", durationMs: Date.now() - started })
    } catch (error) { this.browserSteps.push({ index, kind: step.kind, status: "failed", durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }); throw error }
  }
  private async assertBrowserState(page: import("playwright").Page, selector: string, state: NonNullable<BrowserInteractionStep["state"]>): Promise<void> {
    const locator = page.locator(selector)
    if (state === "visible" || state === "hidden" || state === "attached" || state === "detached") { await locator.waitFor({ state }); return }
    const actual = state === "enabled" ? await locator.isEnabled() : state === "disabled" ? !(await locator.isEnabled()) : state === "checked" ? await locator.isChecked() : state === "unchecked" ? !(await locator.isChecked()) : await locator.isEditable()
    if (!actual) throw new Error(`expected ${selector} to be ${state}`)
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
