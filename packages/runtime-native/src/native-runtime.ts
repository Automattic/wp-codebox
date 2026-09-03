import { randomUUID } from "node:crypto"
import { assertRuntimeCommandAllowed, assertRuntimeSecretEnvTargetsAvailable, type ArtifactBundle, type ArtifactSpec, type ExecutionResult, type ExecutionSpec, type MountSpec, type ObservationResult, type ObservationSpec, type Runtime, type RuntimeBackend, type RuntimeBackendFactoryContext, type RuntimeBackendProvider, type RuntimeCreateSpec, type RuntimeInfo, type Snapshot } from "@automattic/wp-codebox-core"

export interface NativeRuntimeProvenance {
  schema: "wp-codebox/native-runtime-provenance/v1"
  backend: "wordpress-native"
  php: { version: string; sapi: string }
  container: { image: string; digest: string; containment: "required" }
  opcache: { enabled: true; persistent: true; evidence: Record<string, unknown> }
  httpConcurrency: { workers: number; model: string }
  database: { integration: "managed-runtime-service"; disposable: true }
  browser: { authentication: "fixture-only"; credentials: "runtime-generated" }
  benchmarks: { coldStartup: true; warmNoopPhp: true; dynamicWordPressRequest: true }
  representative: { scope: "local"; productionRum: false }
}

export interface NativeRuntimeProvenanceEvidence {
  path: string
  sha256: string
}

/** Process/container details stay in this adapter; host PHP is never a fallback. */
export interface NativeRuntimeDriver {
  create(spec: RuntimeCreateSpec): Promise<NativeRuntimeProvenance>
  /** Persist reviewer-safe provenance before the runtime can accept commands. */
  recordProvenance(provenance: NativeRuntimeProvenance): Promise<NativeRuntimeProvenanceEvidence>
  info?(): Promise<Partial<RuntimeInfo>>
  mount?(spec: MountSpec): Promise<void>
  execute(spec: ExecutionSpec): Promise<ExecutionResult>
  observe(spec: ObservationSpec): Promise<ObservationResult>
  snapshot(options?: unknown): Promise<Snapshot>
  collectArtifacts(spec?: ArtifactSpec): Promise<ArtifactBundle>
  destroy(): Promise<void>
}

export interface NativeRuntimeDriverFactory {
  createNativeRuntimeDriver(): NativeRuntimeDriver
}

export interface NativeRuntimeBackendOptions { driver?: NativeRuntimeDriver }

export class NativeRuntimeUnavailableError extends Error {
  constructor() {
    super("wordpress-native requires a contained native runtime driver; host PHP, ambient credentials, and production state are never used as fallbacks.")
    this.name = "NativeRuntimeUnavailableError"
  }
}

export class NativeRuntimeBackend implements RuntimeBackend {
  readonly kind = "wordpress-native" as const
  constructor(private readonly options: NativeRuntimeBackendOptions = {}) {}
  async create(spec: RuntimeCreateSpec): Promise<Runtime> {
    if (!this.options.driver) throw new NativeRuntimeUnavailableError()
    try {
      const provenance = await this.options.driver.create(spec)
      assertNativeProvenance(provenance)
      assertNativeProvenanceEvidence(await this.options.driver.recordProvenance(provenance))
      return new NativeRuntime(spec, this.options.driver)
    } catch (error) {
      await this.options.driver.destroy().catch(() => undefined)
      throw error
    }
  }
}

class NativeRuntime implements Runtime {
  private readonly id = `native-${randomUUID()}`
  private readonly createdAt = new Date().toISOString()
  private destroyed = false
  private destroying = false
  private destroyPromise?: Promise<void>
  constructor(private readonly spec: RuntimeCreateSpec, private readonly driver: NativeRuntimeDriver) {}
  async info(): Promise<RuntimeInfo> {
    const driverInfo = await this.driver.info?.()
    return { id: driverInfo?.id ?? this.id, backend: "wordpress-native", environment: this.spec.environment, createdAt: driverInfo?.createdAt ?? this.createdAt, status: this.destroyed ? "destroyed" : "created", ...(driverInfo?.previewUrl ? { previewUrl: driverInfo.previewUrl } : {}) }
  }
  async mount(spec: MountSpec): Promise<void> {
    this.assertLive()
    if (!this.driver.mount) throw new Error("wordpress-native driver does not support mounts")
    await this.driver.mount(spec)
  }
  async execute(spec: ExecutionSpec): Promise<ExecutionResult> {
    this.assertLive()
    assertRuntimeCommandAllowed(spec.command, this.spec.policy)
    assertRuntimeSecretEnvTargetsAvailable(this.spec.secretEnvTargets, spec.environment ?? {})
    assertAuthenticatedBrowserAction(spec)
    return await this.driver.execute(spec)
  }
  async observe(spec: ObservationSpec): Promise<ObservationResult> { this.assertLive(); return await this.driver.observe(spec) }
  async snapshot(options?: unknown): Promise<Snapshot> { this.assertLive(); return await this.driver.snapshot(options) }
  async collectArtifacts(spec?: ArtifactSpec): Promise<ArtifactBundle> { return await this.driver.collectArtifacts(spec) }
  async destroy(): Promise<void> {
    if (!this.destroyPromise) {
      this.destroying = true
      this.destroyPromise = this.driver.destroy().finally(() => {
        this.destroyed = true
        this.destroying = false
      })
    }
    await this.destroyPromise
  }
  private assertLive(): void {
    if (this.destroyed || this.destroying) throw new Error("Cannot use a destroyed native runtime")
  }
}

export function createNativeRuntimeBackend(options: NativeRuntimeBackendOptions = {}): RuntimeBackend { return new NativeRuntimeBackend(options) }

export const nativeRuntimeBackendProvider: RuntimeBackendProvider = {
  kind: "wordpress-native",
  createBackend(context: RuntimeBackendFactoryContext = {}) {
    return createNativeRuntimeBackend({ driver: context.nativeRuntimeDriver as NativeRuntimeDriver | undefined })
  },
}

function assertNativeProvenance(provenance: NativeRuntimeProvenance): void {
  if (provenance.schema !== "wp-codebox/native-runtime-provenance/v1" || provenance.backend !== "wordpress-native" || provenance.container.containment !== "required") throw new Error("wordpress-native driver did not prove contained execution")
  if (!provenance.php.version || !provenance.php.sapi || !provenance.container.image || !/^sha256:[a-f0-9]{64}$/i.test(provenance.container.digest) || !provenance.opcache.enabled || !provenance.opcache.persistent || Object.keys(provenance.opcache.evidence).length === 0) throw new Error("wordpress-native driver did not provide pinned native PHP and persistent OPcache evidence")
  if (!Number.isInteger(provenance.httpConcurrency.workers) || provenance.httpConcurrency.workers < 2 || !provenance.httpConcurrency.model) throw new Error("wordpress-native driver did not provide a concurrent HTTP worker model")
  if (provenance.database.integration !== "managed-runtime-service" || !provenance.database.disposable) throw new Error("wordpress-native driver did not prove disposable managed database integration")
  if (provenance.browser.authentication !== "fixture-only" || provenance.browser.credentials !== "runtime-generated") throw new Error("wordpress-native driver did not prove fixture-only browser authentication")
  if (!provenance.benchmarks.coldStartup || !provenance.benchmarks.warmNoopPhp || !provenance.benchmarks.dynamicWordPressRequest) throw new Error("wordpress-native driver did not provide cold startup, warm PHP, and dynamic WordPress benchmark coverage")
  if (provenance.representative.scope !== "local" || provenance.representative.productionRum !== false) throw new Error("wordpress-native driver must identify results as local representative evidence")
}

function assertNativeProvenanceEvidence(evidence: NativeRuntimeProvenanceEvidence): void {
  if (!evidence.path || !/^[a-f0-9]{64}$/i.test(evidence.sha256)) {
    throw new Error("wordpress-native driver did not persist native runtime provenance evidence")
  }
}

function assertAuthenticatedBrowserAction(spec: ExecutionSpec): void {
  if (spec.command !== "wordpress.browser-actions") return
  const auth = (spec.args ?? []).find((arg) => arg.startsWith("auth="))?.slice("auth=".length)
  if (auth !== "wordpress-admin" && auth !== "storage-state") {
    throw new Error("wordpress-native browser actions require runtime fixture authentication")
  }
}
