import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, statfs, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { RuntimePolicy, WorkspaceRecipeExternalServiceBoundary, WorkspaceRecipeRuntimeService } from "@automattic/wp-codebox-core"

const MYSQL_IMAGES = { mysql: "mysql:8.4", mariadb: "mariadb:11.4" } as const
const SERVICE_IMAGES = { redis: "redis:7.4-alpine", smtp: "axllent/mailpit:v1.27", http: "hashicorp/http-echo:1.0" } as const
const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024
const MAX_NATIVE_RUNTIME_SERVICES = 2

export type RuntimeServiceControlAction = "stop" | "start" | "pause" | "resume" | "restart" | "disconnect" | "reconnect" | "flush" | "read-only" | "read-write" | "latency"

export interface RuntimeServiceControlResult {
  serviceId: string
  action: RuntimeServiceControlAction
  status: "applied" | "unsupported" | "failed"
  fidelity: "exact" | "emulated" | "unsupported"
  reason?: string
}

export interface RuntimeServiceEvidence {
  id: string
  kind: string
  provider: string
  version: string
  readiness: "pending" | "ready" | "failed"
  lifecycle: "provisioning" | "provisioned" | "released" | "failed"
  teardown?: "completed" | "failed"
  diagnostic?: {
    code: "readiness-failed" | "provision-failed" | "provider-unavailable" | "teardown-failed" | "interrupted"
    command?: string
    cause?: { code: string; message: string }
  }
  controls?: RuntimeServiceControlResult[]
  memory?: { budgetMiB: number; observedRssMiB?: number }
  storage?: "tmpfs" | "disk"
}

export class RuntimeServiceProvisionError extends Error {
  constructor(message: string, readonly evidence: RuntimeServiceEvidence[], options?: ErrorOptions) {
    super(message, options)
    this.name = "RuntimeServiceProvisionError"
  }
}

export function runtimeServiceEvidenceFromError(error: unknown): RuntimeServiceEvidence[] | undefined {
  let current = error
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof RuntimeServiceProvisionError) return current.evidence
    seen.add(current)
    current = current.cause
  }
  return undefined
}

interface ManagedRuntimeService {
  env: Record<string, string>
  secretEnv: Record<string, string>
  secretEnvTargets: Record<string, string>
  evidence: RuntimeServiceEvidence
  release(): Promise<void>
  control(action: RuntimeServiceControlAction, options?: Record<string, unknown>): Promise<RuntimeServiceControlResult>
}

export interface RuntimeServiceDependencies {
  execute(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number; stdin?: string; maxOutputBytes?: number }): Promise<{ stdout: string }>
  waitForReady(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
  randomBytes(size: number): Buffer
  environment?: Record<string, string | undefined>
  nativeBinaryDirectories?: readonly string[]
  allocateNativePort?: () => Promise<number>
  removeNativeRoot?: (root: string) => Promise<void>
  signalNativeProcess?: (child: ChildProcess, signal: NodeJS.Signals) => boolean
  verifyNativeFilesystem?: (root: string, datadir: string) => Promise<void>
}

export interface RuntimeServiceProvider {
  readonly name: string
  readonly kind: string
  version(service: WorkspaceRecipeRuntimeService): string
  secretEnvTargets(service: WorkspaceRecipeRuntimeService): Record<string, string>
  provision(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidence: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService>
}

interface RuntimeServiceProvisionContext {
  signal?: AbortSignal
  policy?: RuntimePolicy
  externalServices: WorkspaceRecipeExternalServiceBoundary[]
  externalServiceWritesApproved: boolean
}

export interface ProvisionRuntimeServicesOptions {
  signal?: AbortSignal
  dependencies?: RuntimeServiceDependencies
  policy?: RuntimePolicy
  externalServices?: WorkspaceRecipeExternalServiceBoundary[]
  externalServiceWritesApproved?: boolean
  reservedEnvNames?: readonly string[]
}

const defaultDependencies: RuntimeServiceDependencies = {
  execute: executeRuntimeServiceProcess,
  waitForReady: waitForTcpProtocol,
  randomBytes,
  environment: process.env,
}

export function runtimeServicePlan(services: WorkspaceRecipeRuntimeService[]): Array<{ id: string; kind: string; provider: string; version: string; bind: "loopback" | "configured"; port: "ephemeral" | "configured"; persistentVolume: false; storage?: "tmpfs" | "disk"; configuration?: WorkspaceRecipeRuntimeService["configuration"]; outputs: Record<string, string | string[]> }> {
  return services.map((service) => {
    const provider = runtimeServiceProvider(service)
    const external = provider.name === "external"
    const storage = provider === mysqlDockerProvider ? service.configuration?.storage ?? "tmpfs" : undefined
    return { id: service.id, kind: service.kind, provider: provider.name, version: provider.version(service), bind: external ? "configured" : "loopback", port: external ? "configured" : "ephemeral", persistentVolume: false, ...(storage ? { storage } : {}), ...(service.configuration ? { configuration: service.configuration } : {}), outputs: service.outputs }
  })
}

export async function provisionRuntimeServices(services: WorkspaceRecipeRuntimeService[], options: ProvisionRuntimeServicesOptions = {}): Promise<{ env: Record<string, string>; secretEnv: Record<string, string>; secretEnvTargets: Record<string, string>; evidence: RuntimeServiceEvidence[]; control(serviceId: string, action: RuntimeServiceControlAction, controlOptions?: Record<string, unknown>): Promise<RuntimeServiceControlResult>; release(): Promise<void> }> {
  const dependencies = options.dependencies ?? defaultDependencies
  const provisioned: ManagedRuntimeService[] = []
  const evidence: RuntimeServiceEvidence[] = []
  let environment: ReturnType<typeof aggregateRuntimeServiceEnvironment>
  const context: RuntimeServiceProvisionContext = {
    signal: options.signal,
    policy: options.policy,
    externalServices: options.externalServices ?? [],
    externalServiceWritesApproved: options.externalServiceWritesApproved ?? false,
  }
  try {
    if (services.filter((service) => service.configuration?.provider === "native").length > MAX_NATIVE_RUNTIME_SERVICES) throw new Error(`Managed runtime services exceed the native service budget of ${MAX_NATIVE_RUNTIME_SERVICES}`)
    validateDeclaredRuntimeServiceSecretTargets(services, options.reservedEnvNames ?? [])
    for (const service of services) {
      const managed = await runtimeServiceProvider(service).provision(service, dependencies, context, evidence)
      provisioned.push(managed)
    }
    environment = aggregateRuntimeServiceEnvironment(provisioned, options.reservedEnvNames ?? [])
  } catch (error) {
    await releaseServices(provisioned).catch(() => undefined)
    if (error instanceof RuntimeServiceProvisionError) throw error
    throw new RuntimeServiceProvisionError("Managed runtime service provisioning failed", evidence)
  }

  // A provisioned host service is an active runtime resource. Keep Node alive
  // until release so temporarily handle-free PHP-WASM startup can still reach
  // its timeout/cancellation finalizer instead of exiting with unsettled await.
  const lease = provisioned.length > 0 ? setInterval(() => undefined, 1_000) : undefined

  return {
    ...environment,
    evidence,
    async control(serviceId, action, controlOptions) {
      const service = provisioned.find((candidate) => candidate.evidence.id === serviceId)
      if (!service) throw new Error(`Managed runtime service does not exist: ${serviceId}`)
      return await service.control(action, controlOptions)
    },
    async release() {
      try {
        await releaseServices(provisioned)
      } finally {
        if (lease) clearInterval(lease)
      }
    },
  }
}

export async function provisionRuntimeServicesForRecipe(
  services: WorkspaceRecipeRuntimeService[],
  guard: <T>(promise: Promise<T>) => Promise<T>,
  options: ProvisionRuntimeServicesOptions & { onEvidence?: (evidence: RuntimeServiceEvidence[]) => void } = {},
): Promise<Awaited<ReturnType<typeof provisionRuntimeServices>>> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const provisioning = provisionRuntimeServices(services, {
    signal: controller.signal,
    dependencies: options.dependencies,
    policy: options.policy,
    externalServices: options.externalServices,
    externalServiceWritesApproved: options.externalServiceWritesApproved,
    reservedEnvNames: options.reservedEnvNames,
  })
  try {
    return await guard(provisioning)
  } catch (error) {
    controller.abort()
    try {
      const provisioned = await provisioning
      try {
        await provisioned.release()
      } finally {
        options.onEvidence?.(provisioned.evidence)
      }
    } catch (provisionError) {
      const evidence = runtimeServiceEvidenceFromError(provisionError)
      if (evidence) options.onEvidence?.(evidence)
    }
    throw error
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }
}

const mysqlDockerProvider: RuntimeServiceProvider = {
  name: "docker",
  kind: "mysql",
  version: mysqlDockerImage,
  secretEnvTargets: mysqlRuntimeServiceSecretTargets,
  provision: provisionMysqlDockerService,
}

const mysqlExternalProvider: RuntimeServiceProvider = {
  name: "external",
  kind: "mysql",
  version: (service) => `mysql-compatible:${service.configuration?.engine ?? "mysql"}`,
  secretEnvTargets: mysqlRuntimeServiceSecretTargets,
  provision: provisionMysqlExternalService,
}

const mysqlNativeProvider: RuntimeServiceProvider = {
  name: "native",
  kind: "mysql",
  version: () => "mariadb:native",
  secretEnvTargets: mysqlRuntimeServiceSecretTargets,
  provision: provisionMysqlNativeService,
}

const redisDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "redis", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.redis, secretEnvTargets: () => ({}), provision: provisionRedisDockerService }
const smtpDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "smtp", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.smtp, secretEnvTargets: () => ({}), provision: provisionSmtpDockerService }
const httpDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "http", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.http, secretEnvTargets: () => ({}), provision: provisionHttpDockerService }

function mysqlDockerImage(service: WorkspaceRecipeRuntimeService): string {
  return MYSQL_IMAGES[service.configuration?.engine ?? "mysql"]
}

function mysqlRuntimeServiceSecretTargets(service: WorkspaceRecipeRuntimeService): Record<string, string> {
  const names = runtimeServiceOutputNames(service.outputs.password)
  return names.length > 0 ? { DB_PASSWORD: names.includes("DB_PASSWORD") ? "DB_PASSWORD" : names[0] as string } : {}
}

function runtimeServiceProvider(service: WorkspaceRecipeRuntimeService): RuntimeServiceProvider {
  if (service.kind === mysqlDockerProvider.kind) {
    if (service.configuration?.provider === "external") return mysqlExternalProvider
    if (service.configuration?.provider === "native") return mysqlNativeProvider
    return mysqlDockerProvider
  }
  if (service.configuration?.provider === "external" || service.configuration?.provider === "native") throw new Error(`Managed runtime service kind does not support the ${service.configuration.provider} provider: ${service.kind}`)
  if (service.kind === redisDockerProvider.kind) return redisDockerProvider
  if (service.kind === smtpDockerProvider.kind) return smtpDockerProvider
  if (service.kind === httpDockerProvider.kind) return httpDockerProvider
  throw new Error(`Unsupported managed runtime service kind: ${service.kind}`)
}

async function provisionMysqlDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  const { signal } = context
  const engine = service.configuration?.engine ?? "mysql"
  const storage = service.configuration?.storage ?? "tmpfs"
  const image = mysqlDockerImage(service)
  const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "docker", version: image, readiness: "pending", lifecycle: "provisioning", storage }
  evidenceList.push(evidence)
  const container = `wp-codebox-${service.id}-${dependencies.randomBytes(6).toString("hex")}`
  const password = dependencies.randomBytes(24).toString("base64url")
  const emptyRootPassword = service.configuration?.rootAuthentication === "empty-password"
  const environmentPrefix = engine === "mariadb" ? "MARIADB" : "MYSQL"
  const rootEnvironmentName = emptyRootPassword ? engine === "mariadb" ? "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD" : "MYSQL_ALLOW_EMPTY_PASSWORD" : `${environmentPrefix}_ROOT_PASSWORD`
  const rootEnvironment = { [rootEnvironmentName]: emptyRootPassword ? "yes" : password }
  const childEnvironment = { ...process.env, [`${environmentPrefix}_DATABASE`]: "runtime", [`${environmentPrefix}_USER`]: "runtime", [`${environmentPrefix}_PASSWORD`]: password, ...rootEnvironment }
  const foreignKeyTargetPolicy = service.configuration?.foreignKeyTargetPolicy
  const mysqlArguments = engine === "mysql" && foreignKeyTargetPolicy ? [`--restrict-fk-on-non-standard-key=${foreignKeyTargetPolicy === "indexed" ? "OFF" : "ON"}`] : []
  const storageArgs = storage === "disk" ? ["--mount", "type=volume,destination=/var/lib/mysql"] : ["--tmpfs", "/var/lib/mysql"]
  const runArgs = ["run", "--detach", "--name", container, "--label", "wp-codebox.managed=true", "--publish", "127.0.0.1::3306", ...storageArgs, "--env", `${environmentPrefix}_DATABASE`, "--env", `${environmentPrefix}_USER`, "--env", `${environmentPrefix}_PASSWORD`, "--env", rootEnvironmentName, image, ...mysqlArguments]
  let started = false
  try {
    throwIfAborted(signal)
    await ensureDockerImage(image, dependencies, signal)
    await dependencies.execute("docker", runArgs, { env: childEnvironment, signal, timeout: 30_000 })
    started = true
    const { stdout } = await dependencies.execute("docker", ["port", container, "3306/tcp"], { signal, timeout: 10_000 })
    const port = parseLoopbackPort(stdout)
    await dependencies.waitForReady("127.0.0.1", port, 30_000, signal)
    await waitForMysqlDatabase(container, engine, password, dependencies, 30_000, signal)
    throwIfAborted(signal)
    evidence.readiness = "ready"
    evidence.lifecycle = "provisioned"
    const values: Record<string, string> = { host: "127.0.0.1", port: String(port), username: "runtime", password, database: "runtime" }
    return {
      env: runtimeServiceOutputEnvironment(service, values, new Set(["password"])),
      secretEnv: runtimeServiceOutputAliases(service.outputs.password, password),
      secretEnvTargets: mysqlRuntimeServiceSecretTargets(service),
      evidence,
      async control(action, options) { return await controlDockerService(container, evidence, dependencies, action, options, async (customAction) => {
        if (customAction === "flush") {
          await dependencies.execute("docker", ["exec", "--env", "MYSQL_PWD", container, engine === "mariadb" ? "mariadb" : "mysql", "--user=root", "--execute=RESET MASTER"], { env: { ...process.env, MYSQL_PWD: emptyRootPassword ? "" : password }, timeout: 10_000 })
          return true
        }
        if (customAction === "read-only" || customAction === "read-write") {
          const enabled = customAction === "read-only" ? "ON" : "OFF"
          await dependencies.execute("docker", ["exec", "--env", "MYSQL_PWD", container, engine === "mariadb" ? "mariadb" : "mysql", "--user=root", `--execute=SET GLOBAL read_only=${enabled}`], { env: { ...process.env, MYSQL_PWD: emptyRootPassword ? "" : password }, timeout: 10_000 })
          return true
        }
        return false
      }, async () => { await dependencies.waitForReady("127.0.0.1", port, 30_000); await waitForMysqlDatabase(container, engine, password, dependencies, 30_000) }) },
      async release() { await releaseService(container, evidence, dependencies) },
    }
  } catch (error) {
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    evidence.diagnostic = signal?.aborted
      ? { code: "interrupted" }
      : providerUnavailableDiagnostic(error, "docker") ?? { code: started ? "readiness-failed" : "provision-failed" }
    if (started) await releaseService(container, evidence, dependencies, undefined).catch(() => undefined)
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList)
  }
}

function providerUnavailableDiagnostic(error: unknown, command: string): RuntimeServiceEvidence["diagnostic"] | undefined {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return undefined
  return { code: "provider-unavailable", command, cause: { code: "ENOENT", message: "Provider command executable was not found" } }
}

const NATIVE_MARIADB_ROOT_PREFIX = "wp-codebox-mariadb-"
const NATIVE_MARIADB_START_ATTEMPTS = 5
const NATIVE_MARIADB_START_TIMEOUT_MS = 30_000
const NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES = 256 * 1024
const NATIVE_MARIADB_ADDRESS_SPACE_BYTES = 2 * 1024 * 1024 * 1024
const NATIVE_MARIADB_FILE_SIZE_BYTES = 128 * 1024 * 1024
const NATIVE_MARIADB_DATADIR_BYTES = 256 * 1024 * 1024
const NATIVE_MARIADB_DATADIR_INODES = 4_096
const NATIVE_MARIADB_CPU_SECONDS = 300
const NATIVE_MARIADB_OPEN_FILES = 512
const NATIVE_MARIADB_PROCESSES = 512
const nativeOwnedProcesses = new Set<OwnedNativeProcess>()

interface NativeMariaDbBinaries {
  server: string
  initialize: string
  client: string
  limiter: string
  truncate: string
  mkfs: string
  fuse: string
  unmount: string
  version: string
}

interface NativeMariaDbStorage {
  process: OwnedNativeProcess
  datadir: string
}

interface OwnedNativeProcess {
  child: ChildProcess
  groupId?: number
  exited: boolean
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  exit: Promise<void>
  identity?: string
  identityReady: Promise<void>
}

interface OwnedNativeRoot {
  path: string
  device: number
  inode: number
}

async function provisionMysqlNativeService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  const { signal } = context
  const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "native", version: "mariadb:native", readiness: "pending", lifecycle: "provisioning", controls: [] }
  evidenceList.push(evidence)
  let root: OwnedNativeRoot | undefined
  let processState: OwnedNativeProcess | undefined
  let binariesForCleanup: NativeMariaDbBinaries | undefined
  let storage: NativeMariaDbStorage | undefined
  let adminSocket: string | undefined
  let cleaned = false
  let cleanupPromise: Promise<void> | undefined

  const performCleanup = async (): Promise<void> => {
    if (cleaned || evidence.teardown === "completed") return
    try {
      if (processState) await stopOwnedNativeMariaDb(processState, root, dependencies, binariesForCleanup, adminSocket)
      if (storage && binariesForCleanup) await stopNativeMariaDbStorage(storage, binariesForCleanup, dependencies, root)
      if (root) await removeOwnedNativeRoot(root, dependencies)
      cleaned = true
      evidence.lifecycle = "released"
      evidence.teardown = "completed"
      delete evidence.diagnostic
    } catch (error) {
      evidence.lifecycle = "failed"
      evidence.teardown = "failed"
      evidence.diagnostic = { code: "teardown-failed" }
      throw new Error(`Managed runtime service teardown failed: ${service.id}`, { cause: error })
    }
  }
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = performCleanup().catch((error) => {
      cleanupPromise = undefined
      throw error
    })
    return cleanupPromise
  }

  try {
    assertNativeMariaDbConfiguration(service)
    assertNativeMariaDbUnprivilegedHost()
    throwIfAborted(signal)
    const binaries = await resolveNativeMariaDbBinaries(dependencies, signal)
    binariesForCleanup = binaries
    evidence.version = binaries.version
    root = await createOwnedNativeRoot()
    const storageRoot = ownedNativePath(root, "storage")
    await mkdir(storageRoot, { mode: 0o700 })
    const storageEnvironment = nativeMariaDbEnvironment(root.path)
    const userArgument: string[] = []
    storage = await provisionNativeMariaDbStorage(binaries, root, storageRoot, dependencies, storageEnvironment, signal)
    const datadir = join(storageRoot, "database")
    const runtimeDirectory = join(storageRoot, "runtime")
    const temporaryDirectory = join(storageRoot, "tmp")
    const pluginDirectory = join(storageRoot, "plugins")
    const secureFileDirectory = join(storageRoot, "files")
    for (const directory of [datadir, runtimeDirectory, temporaryDirectory, pluginDirectory, secureFileDirectory]) await mkdir(directory, { mode: 0o700 })
    const socket = join(runtimeDirectory, "server.sock")
    adminSocket = socket
    const pidFile = join(runtimeDirectory, "server.pid")
    const logFile = join(runtimeDirectory, "server.log")
    const childEnvironment = nativeMariaDbEnvironment(temporaryDirectory)

    await executeOwnedNativeLimited(dependencies, binaries, binaries.initialize, [
      "--no-defaults",
      `--datadir=${datadir}`,
      "--auth-root-authentication-method=normal",
      "--skip-test-db",
      "--skip-name-resolve",
      "--innodb-buffer-pool-size=32M",
      "--innodb-buffer-pool-size-max=32M",
      "--key-buffer-size=8M",
      "--aria-pagecache-buffer-size=8M",
      "--thread-handling=pool-of-threads",
      "--thread-pool-size=1",
      "--innodb-file-per-table=OFF",
      "--innodb-data-file-path=ibdata1:32M:autoextend:max:96M",
      "--innodb-temp-data-file-path=ibtmp1:16M:autoextend:max:32M",
      "--innodb-log-file-size=32M",
      `--open-files-limit=${NATIVE_MARIADB_OPEN_FILES}`,
      ...userArgument,
    ], { env: childEnvironment, signal, timeout: 60_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
    await assertOwnedNativeRoot(root)
    throwIfAborted(signal)

    let port = 0
    for (let attempt = 0; attempt < NATIVE_MARIADB_START_ATTEMPTS; attempt += 1) {
      port = await (dependencies.allocateNativePort ?? allocateLoopbackPort)()
      await writeFile(logFile, "", { mode: 0o600 })
      processState = spawnOwnedNativeMariaDb(binaries.limiter, [...nativeMariaDbLimitArguments(), "--", binaries.server, ...nativeMariaDbDaemonArguments({ datadir, socket, pidFile, logFile, temporaryDirectory, pluginDirectory, secureFileDirectory, port, userArgument })], childEnvironment, false, temporaryDirectory)
      try {
        await waitForNativeMariaDbReady(binaries, socket, processState, root, dependencies, signal)
        break
      } catch (error) {
        await stopOwnedNativeMariaDb(processState, root, dependencies, binaries, socket)
        const bindCollision = await nativeMariaDbBindCollision(logFile, processState)
        if (!processState.exited) throw new Error("Native MariaDB process exit was not proven")
        processState = undefined
        if (!bindCollision || attempt === NATIVE_MARIADB_START_ATTEMPTS - 1) throw error
      }
    }
    if (!processState || port === 0) throw new Error("Native MariaDB startup did not establish an owned process")

    const password = dependencies.randomBytes(24).toString("base64url")
    const adminArgs = nativeMariaDbSocketArguments(socket)
    const executeAdminSql = async (sql: string): Promise<{ stdout: string }> => {
      if (!root) throw new Error("Native MariaDB root is unavailable")
      await assertOwnedNativeRoot(root)
      return await executeNativeLimited(dependencies, binaries, binaries.client, adminArgs, { env: childEnvironment, signal, timeout: 10_000, stdin: sql, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
    }
    await executeAdminSql([
      "CREATE DATABASE `runtime` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
      `CREATE USER 'runtime'@'127.0.0.1' IDENTIFIED BY ${quoteMysqlValue(password)};`,
      "GRANT ALL PRIVILEGES ON `runtime`.* TO 'runtime'@'127.0.0.1';",
      "FLUSH PRIVILEGES;",
      "",
    ].join("\n"))
    const engines = await executeAdminSql("SHOW ENGINES;\n")
    assertNativeMariaDbEngines(engines.stdout)
    if ((await readdir(pluginDirectory)).length !== 0) throw new Error("Native MariaDB plugin isolation cannot be proven")
    await waitForNativeMariaDbRuntimeAccount(binaries, port, password, dependencies, childEnvironment, signal)
    throwIfAborted(signal)

    evidence.readiness = "ready"
    evidence.lifecycle = "provisioned"
    const observedRssMiB = await ownedProcessRssMiB(processState)
    evidence.memory = { budgetMiB: NATIVE_MARIADB_ADDRESS_SPACE_BYTES / 1024 / 1024, ...(observedRssMiB !== undefined ? { observedRssMiB } : {}) }
    const values: Record<string, string> = { host: "127.0.0.1", port: String(port), username: "runtime", password, database: "runtime" }
    return {
      env: runtimeServiceOutputEnvironment(service, values, new Set(["password"])),
      secretEnv: runtimeServiceOutputAliases(service.outputs.password, password),
      secretEnvTargets: mysqlRuntimeServiceSecretTargets(service),
      evidence,
      async control(action) {
        const result: RuntimeServiceControlResult = { serviceId: service.id, action, status: "unsupported", fidelity: "unsupported", reason: `The native ${service.kind} provider does not support ${action}.` }
        evidence.controls?.push(result)
        return result
      },
      release: cleanup,
    }
  } catch (error) {
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    const diagnostic = { code: signal?.aborted ? "interrupted" as const : processState ? "readiness-failed" as const : "provision-failed" as const }
    let cleanupError: unknown
    try { await cleanup() } catch (caught) { cleanupError = caught }
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    evidence.diagnostic = evidence.teardown === "failed" ? { code: "teardown-failed" } : diagnostic
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList, { cause: cleanupError ?? error })
  }
}

export function assertNativeMariaDbEngines(output: string): void {
  const safe = new Set(["aria", "csv", "innodb", "memory", "mrg_myisam", "myisam", "performance_schema", "sequence"])
  const enabled = new Set<string>()
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [engine, support] = line.split(/\t|\s{2,}/).map((value) => value.trim().toLowerCase())
    if (engine && (support === "yes" || support === "default")) {
      enabled.add(engine)
      if (!safe.has(engine)) throw new Error("Native MariaDB exposes an outbound-capable or unknown storage engine")
    }
  }
  if (!enabled.has("innodb")) throw new Error("Native MariaDB engine isolation cannot be proven")
}

export function assertNativeMariaDbUnprivilegedHost(uid = typeof process.getuid === "function" ? process.getuid() : undefined): void {
  if (uid === undefined || uid === 0) throw new Error("Native MariaDB requires a provably unprivileged host identity")
}

export async function nativeMariaDbHostReadiness(dependencies: RuntimeServiceDependencies = defaultDependencies): Promise<{ status: "ready" | "unavailable"; reason?: string }> {
  try {
    assertNativeMariaDbUnprivilegedHost()
  } catch {
    return { status: "unavailable", reason: "unprivileged-host-required" }
  }
  let binaries: NativeMariaDbBinaries
  try {
    binaries = await resolveNativeMariaDbBinaries(dependencies)
  } catch {
    return { status: "unavailable", reason: "trusted-containment-tools-unavailable" }
  }
  let root: OwnedNativeRoot | undefined
  let storage: NativeMariaDbStorage | undefined
  try {
    root = await createOwnedNativeRoot()
    const mountpoint = ownedNativePath(root, "storage")
    await mkdir(mountpoint, { mode: 0o700 })
    storage = await provisionNativeMariaDbStorage(binaries, root, mountpoint, dependencies, nativeMariaDbEnvironment(root.path))
    await writeFile(join(mountpoint, ".readiness"), "ready", { mode: 0o600 })
    await stopNativeMariaDbStorage(storage, binaries, dependencies, root)
    storage = undefined
    await removeOwnedNativeRoot(root, dependencies)
    root = undefined
    return { status: "ready" }
  } catch {
    try {
      if (storage && root) await stopNativeMariaDbStorage(storage, binaries, dependencies, root)
      if (root) await removeOwnedNativeRoot(root, dependencies)
    } catch {
      return { status: "unavailable", reason: "containment-probe-cleanup-failed" }
    }
    return { status: "unavailable", reason: "bounded-filesystem-unavailable" }
  }
}

function assertNativeMariaDbConfiguration(service: WorkspaceRecipeRuntimeService): void {
  const configuration = service.configuration
  if (configuration?.provider !== "native" || configuration.engine !== "mariadb") throw new Error("Native MySQL-compatible services require engine=mariadb")
  for (const field of ["externalService", "hostEnv", "portEnv", "usernameEnv", "passwordEnv", "image", "rootAuthentication", "foreignKeyTargetPolicy", "responseStatus", "responseBody"] as const) {
    if (configuration[field] !== undefined) throw new Error(`Native MariaDB does not accept ${field}`)
  }
}

async function resolveNativeMariaDbBinaries(dependencies: RuntimeServiceDependencies, signal?: AbortSignal): Promise<NativeMariaDbBinaries> {
  const directories = dependencies.nativeBinaryDirectories ?? nativeExecutableDirectories()
  const requireTrusted = dependencies.nativeBinaryDirectories === undefined
  const server = await findNativeExecutable("mariadbd", directories, requireTrusted)
  const initialize = await findNativeExecutable("mariadb-install-db", directories, requireTrusted)
  const client = await findNativeExecutable("mariadb", directories, requireTrusted)
  const limiter = await findNativeExecutable("prlimit", directories, requireTrusted)
  const truncate = await findNativeExecutable("truncate", directories, requireTrusted)
  const mkfs = await findNativeExecutable("mkfs.ext4", directories, requireTrusted)
  const fuse = await findNativeExecutable("fuse2fs", directories, requireTrusted)
  const unmount = await findNativeExecutable("fusermount3", directories, requireTrusted)
  if (!server || !initialize || !client || !limiter || !truncate || !mkfs || !fuse || !unmount) throw new Error("Compatible native MariaDB containment tools are unavailable")
  const environment = nativeMariaDbEnvironment(tmpdir())
  const [serverVersion, initializerHelp, clientVersion, limiterVersionResult] = await Promise.all([
    dependencies.execute(server, ["--no-defaults", "--version"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
    nativeMariaDbInitializerHelp(initialize, dependencies, environment, signal),
    dependencies.execute(client, ["--no-defaults", "--version"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
    dependencies.execute(limiter, ["--version"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
  ])
  const combinedVersions = `${serverVersion.stdout}\n${clientVersion.stdout}`
  if (!/MariaDB/i.test(combinedVersions) || !/--auth-root-authentication-method/.test(initializerHelp) || !/--skip-test-db/.test(initializerHelp)) {
    throw new Error("Native MariaDB tools do not satisfy the required isolation capabilities")
  }
  const version = combinedVersions.match(/\b(\d+\.\d+(?:\.\d+)?)-MariaDB\b/i)?.[1]
  if (!version) throw new Error("Native MariaDB version identity cannot be proven")
  const limiterVersion = limiterVersionResult.stdout
  if (!/prlimit from util-linux/i.test(limiterVersion)) throw new Error("Native MariaDB hard resource limiter identity cannot be proven")
  await dependencies.execute(limiter, [...nativeMariaDbLimitArguments(), "--", client, "--no-defaults", "--version"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
  await Promise.all([
    dependencies.execute(truncate, ["--version"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
    dependencies.execute(mkfs, ["-V"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
    dependencies.execute(fuse, ["-V"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
    dependencies.execute(unmount, ["--version"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES }),
  ])
  return { server, initialize, client, limiter, truncate, mkfs, fuse, unmount, version: `mariadb:${version}` }
}

function nativeMariaDbLimitArguments(fileSizeBytes = NATIVE_MARIADB_FILE_SIZE_BYTES): string[] {
  return [
    `--as=${NATIVE_MARIADB_ADDRESS_SPACE_BYTES}`,
    `--cpu=${NATIVE_MARIADB_CPU_SECONDS}`,
    `--fsize=${fileSizeBytes}`,
    `--nofile=${NATIVE_MARIADB_OPEN_FILES}`,
    `--nproc=${NATIVE_MARIADB_PROCESSES}`,
    "--core=0",
    "--memlock=0",
  ]
}

async function executeNativeLimited(dependencies: RuntimeServiceDependencies, binaries: NativeMariaDbBinaries, command: string, args: string[], options: Parameters<RuntimeServiceDependencies["execute"]>[2]): Promise<{ stdout: string }> {
  return await dependencies.execute(binaries.limiter, [...nativeMariaDbLimitArguments(), "--", command, ...args], options)
}

async function executeOwnedNativeLimited(dependencies: RuntimeServiceDependencies, binaries: NativeMariaDbBinaries, command: string, args: string[], options: Parameters<RuntimeServiceDependencies["execute"]>[2]): Promise<{ stdout: string }> {
  const state = spawnOwnedNativeMariaDb(binaries.limiter, [...nativeMariaDbLimitArguments(), "--", command, ...args], options.env ?? nativeMariaDbEnvironment("/nonexistent"), true, options.env?.TMPDIR)
  const limit = options.maxOutputBytes ?? NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  let overflow = false
  const collect = (target: Buffer[], chunk: Buffer): void => {
    const remaining = Math.max(0, limit - outputBytes)
    if (remaining > 0) target.push(chunk.subarray(0, remaining))
    if (chunk.length > remaining) overflow = true
    outputBytes += Math.min(chunk.length, remaining)
  }
  state.child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk))
  state.child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk))
  state.child.stdin?.end(options.stdin)
  let rejectStop: (error: unknown) => void = () => undefined
  const stopFailure = new Promise<never>((_resolve, reject) => { rejectStop = reject })
  let stopPromise: Promise<void> | undefined
  const requestStop = (): void => {
    if (!stopPromise) {
      stopPromise = stopOwnedNativeProcess(state, dependencies)
      void stopPromise.catch(rejectStop)
    }
  }
  const abort = () => requestStop()
  options.signal?.addEventListener("abort", abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; requestStop() }, options.timeout)
  try {
    await Promise.race([state.exit, stopFailure])
    if (stopPromise) await stopPromise
    if (!await waitForOwnedProcessGroupExit(state, 100)) await stopOwnedNativeProcess(state, dependencies)
    else nativeOwnedProcesses.delete(state)
    const boundedStdout = Buffer.concat(stdout).toString("utf8")
    const boundedStderr = Buffer.concat(stderr).toString("utf8")
    if (options.signal?.aborted) throw new Error("Managed runtime service provisioning interrupted")
    if (timedOut) throw new Error("Native MariaDB initialization timed out")
    if (overflow) throw new Error(`Runtime service process output exceeded ${limit} bytes`)
    if (state.exitCode !== 0) {
      const error = new Error(`Command failed with exit code ${state.exitCode ?? "unknown"}`) as Error & { stdout: string; stderr: string }
      error.stdout = boundedStdout
      error.stderr = boundedStderr
      throw error
    }
    return { stdout: boundedStdout }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

async function provisionNativeMariaDbStorage(binaries: NativeMariaDbBinaries, root: OwnedNativeRoot, datadir: string, dependencies: RuntimeServiceDependencies, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<NativeMariaDbStorage> {
  const image = ownedNativePath(root, "datadir.ext4")
  const storageLimits = nativeMariaDbLimitArguments(NATIVE_MARIADB_DATADIR_BYTES)
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined || uid === 0) throw new Error("Native MariaDB bounded filesystem requires an unprivileged POSIX identity")
  await dependencies.execute(binaries.limiter, [...storageLimits, "--", binaries.truncate, "--size", String(NATIVE_MARIADB_DATADIR_BYTES), image], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
  await dependencies.execute(binaries.limiter, [...storageLimits, "--", binaries.mkfs, "-q", "-F", "-N", String(NATIVE_MARIADB_DATADIR_INODES), "-E", `root_owner=${uid}:${gid}`, image], { env: environment, signal, timeout: 30_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
  const processState = spawnOwnedNativeMariaDb(binaries.limiter, [...storageLimits, "--", binaries.fuse, "-f", "-o", "rw,nosuid,nodev,noexec", image, datadir], environment)
  try {
    if (dependencies.verifyNativeFilesystem) await dependencies.verifyNativeFilesystem(root.path, datadir)
    else await waitForNativeFilesystemContainment(root, datadir, processState, signal)
    return { process: processState, datadir }
  } catch (error) {
    try {
      await unmountNativeMariaDbStorage(datadir, binaries, dependencies, root).catch((unmountError) => {
        const stderr = unmountError instanceof Error && "stderr" in unmountError && typeof unmountError.stderr === "string" ? unmountError.stderr : ""
        if (!/not mounted|not found|no such file/i.test(stderr)) throw unmountError
      })
      await stopOwnedNativeProcess(processState, dependencies)
    } catch (stopError) {
      throw new Error("Native MariaDB bounded filesystem stop failed", { cause: stopError })
    }
    throw error
  }
}

async function waitForNativeFilesystemContainment(root: OwnedNativeRoot, datadir: string, state: OwnedNativeProcess, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    if (state.exited) throw new Error("Native MariaDB bounded filesystem exited before readiness")
    try {
      const [directory, filesystem] = await Promise.all([stat(datadir), statfs(datadir)])
      const bytes = filesystem.blocks * filesystem.bsize
      assertNativeMariaDbFilesystemGeometry(directory.dev, root.device, bytes, filesystem.files)
      return
    } catch (error) {
      if (signal?.aborted) throw error
    }
    await abortableDelay(25, signal)
  }
  throw new Error("Native MariaDB bounded filesystem could not be proven")
}

export function assertNativeMariaDbFilesystemGeometry(device: number, rootDevice: number, bytes: number, inodes: number): void {
  if (device === rootDevice || bytes > NATIVE_MARIADB_DATADIR_BYTES || inodes > NATIVE_MARIADB_DATADIR_INODES || bytes < NATIVE_MARIADB_FILE_SIZE_BYTES || inodes < 1_024) {
    throw new Error("Native MariaDB bounded filesystem geometry is unavailable")
  }
}

async function stopNativeMariaDbStorage(storage: NativeMariaDbStorage, binaries: NativeMariaDbBinaries, dependencies: RuntimeServiceDependencies, root: OwnedNativeRoot | undefined): Promise<void> {
  if (!storage.process.exited) {
    if (!root) throw new Error("Native MariaDB storage root is unavailable")
    await assertOwnedNativeRoot(root)
    await unmountNativeMariaDbStorage(storage.datadir, binaries, dependencies, root)
  }
  await stopOwnedNativeProcess(storage.process, dependencies)
}

async function unmountNativeMariaDbStorage(datadir: string, binaries: NativeMariaDbBinaries, dependencies: RuntimeServiceDependencies, root: OwnedNativeRoot): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await executeNativeLimited(dependencies, binaries, binaries.unmount, ["--unmount", datadir], { env: nativeMariaDbEnvironment(root.path), timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
      return
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : ""
      if (!/device or resource busy/i.test(stderr) || attempt === 19) throw error
      await abortableDelay(50)
    }
  }
}

async function stopOwnedNativeProcess(state: OwnedNativeProcess, dependencies: RuntimeServiceDependencies): Promise<void> {
  if (!await ownedProcessGroupExists(state)) { nativeOwnedProcesses.delete(state); return }
  if (!state.exited) await waitForOwnedProcessExit(state, 5_000)
  if (await waitForOwnedProcessGroupExit(state, 100)) { nativeOwnedProcesses.delete(state); return }
  await signalOwnedNativeProcess(state, "SIGTERM", dependencies)
  if (await waitForOwnedProcessGroupExit(state, 5_000)) { nativeOwnedProcesses.delete(state); return }
  await signalOwnedNativeProcess(state, "SIGKILL", dependencies)
  if (!await waitForOwnedProcessGroupExit(state, 5_000)) throw new Error("Owned native containment process group did not exit")
  nativeOwnedProcesses.delete(state)
}

async function nativeMariaDbInitializerHelp(initialize: string, dependencies: RuntimeServiceDependencies, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  try {
    return (await dependencies.execute(initialize, ["--no-defaults", "--help"], { env: environment, signal, timeout: 10_000, maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })).stdout
  } catch (error) {
    const stdout = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : ""
    if (stdout.startsWith("Usage:") && stdout.includes("mariadb-install-db")) return stdout
    throw error
  }
}

function nativeExecutableDirectories(): string[] {
  return ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]
}

async function findNativeExecutable(name: string, directories: readonly string[], requireTrusted = false): Promise<string | undefined> {
  for (const directory of directories) {
    const candidate = resolve(directory, name)
    try {
      await access(candidate, fsConstants.X_OK)
      const canonical = await realpath(candidate)
      const metadata = await stat(canonical)
      if (metadata.isFile() && (!requireTrusted || await nativeExecutableIsTrusted(canonical))) return canonical
    } catch {
      // Missing and incompatible candidates are ignored; all required tools must resolve.
    }
  }
  return undefined
}

async function nativeExecutableIsTrusted(path: string): Promise<boolean> {
  let current = path
  while (true) {
    const metadata = await stat(current)
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) return false
    if (current === "/") return true
    current = dirname(current)
  }
}

async function createOwnedNativeRoot(): Promise<OwnedNativeRoot> {
  const temporaryRoot = await realpath(tmpdir())
  const path = await mkdtemp(join(temporaryRoot, NATIVE_MARIADB_ROOT_PREFIX))
  await chmod(path, 0o700)
  const canonical = await realpath(path)
  if (canonical !== resolve(path)) throw new Error("Native MariaDB root ownership cannot be proven")
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Native MariaDB root is not a private directory")
  return { path, device: metadata.dev, inode: metadata.ino }
}

function ownedNativePath(root: OwnedNativeRoot, name: string): string {
  const path = resolve(root.path, name)
  if (!path.startsWith(`${resolve(root.path)}/`)) throw new Error("Native MariaDB path escaped its private root")
  return path
}

async function assertOwnedNativeRoot(root: OwnedNativeRoot): Promise<void> {
  const metadata = await lstat(root.path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== root.device || metadata.ino !== root.inode) {
    throw new Error("Native MariaDB root ownership changed")
  }
}

function nativeMariaDbEnvironment(privateTemporaryDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C",
    LC_ALL: "C",
    HOME: privateTemporaryDirectory,
    TMPDIR: privateTemporaryDirectory,
  }
}

function nativeMariaDbDaemonArguments(options: { datadir: string; socket: string; pidFile: string; logFile: string; temporaryDirectory: string; pluginDirectory: string; secureFileDirectory: string; port: number; userArgument: string[] }): string[] {
  return [
    "--no-defaults",
    `--datadir=${options.datadir}`,
    `--socket=${options.socket}`,
    `--pid-file=${options.pidFile}`,
    `--log-error=${options.logFile}`,
    `--tmpdir=${options.temporaryDirectory}`,
    `--plugin-dir=${options.pluginDirectory}`,
    `--secure-file-priv=${options.secureFileDirectory}`,
    "--bind-address=127.0.0.1",
    `--port=${options.port}`,
    "--skip-name-resolve",
    "--skip-log-bin",
    "--skip-host-cache",
    "--skip-slave-start",
    "--skip-symbolic-links",
    "--local-infile=OFF",
    "--performance-schema=OFF",
    "--skip-feedback",
    "--innodb-buffer-pool-size=32M",
    "--innodb-buffer-pool-size-max=32M",
    "--innodb-log-buffer-size=4M",
    "--key-buffer-size=8M",
    "--aria-pagecache-buffer-size=8M",
    "--thread-handling=pool-of-threads",
    "--thread-pool-size=1",
    "--aria-log-file-size=16M",
    "--innodb-file-per-table=OFF",
    "--innodb-data-file-path=ibdata1:32M:autoextend:max:96M",
    "--innodb-temp-data-file-path=ibtmp1:16M:autoextend:max:32M",
    "--innodb-log-file-size=32M",
    "--max-connections=10",
    "--max-prepared-stmt-count=256",
    "--max-session-mem-used=32M",
    `--open-files-limit=${NATIVE_MARIADB_OPEN_FILES}`,
    "--thread-cache-size=0",
    "--table-open-cache=128",
    "--table-definition-cache=128",
    "--tmp-table-size=8M",
    "--max-heap-table-size=8M",
    ...options.userArgument,
  ]
}

function nativeMariaDbSocketArguments(socket: string): string[] {
  return ["--no-defaults", "--batch", "--skip-column-names", "--protocol=SOCKET", `--socket=${socket}`, "--user=root"]
}

function spawnOwnedNativeMariaDb(command: string, args: string[], environment: NodeJS.ProcessEnv, captureOutput = false, cwd?: string): OwnedNativeProcess {
  const child = spawn(command, args, { cwd, detached: process.platform !== "win32", env: environment, stdio: captureOutput ? ["pipe", "pipe", "pipe"] : "ignore", windowsHide: true })
  const state: OwnedNativeProcess = { child, groupId: child.pid, exited: false, exitCode: null, signalCode: null, exit: Promise.resolve(), identityReady: Promise.resolve() }
  nativeOwnedProcesses.add(state)
  state.identityReady = captureOwnedProcessIdentity(state)
  state.exit = new Promise<void>((resolveExit) => {
    child.once("error", () => { state.exited = true; resolveExit() })
    child.once("exit", (code, signal) => {
      state.exited = true
      state.exitCode = code
      state.signalCode = signal
      resolveExit()
    })
  })
  return state
}

async function waitForNativeMariaDbReady(binaries: NativeMariaDbBinaries, socket: string, state: OwnedNativeProcess, root: OwnedNativeRoot, dependencies: RuntimeServiceDependencies, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + NATIVE_MARIADB_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    await assertOwnedNativeRoot(root)
    if (state.exited) throw new Error("Native MariaDB exited before readiness")
    try {
      await executeNativeLimited(dependencies, binaries, binaries.client, nativeMariaDbSocketArguments(socket), { env: nativeMariaDbEnvironment(root.path), signal, timeout: 2_000, stdin: "SELECT 1;\n", maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
      if (state.exited) throw new Error("Native MariaDB exited during readiness")
      return
    } catch (error) {
      if (signal?.aborted) throw error
      await abortableDelay(100, signal)
    }
  }
  throw new Error("Native MariaDB readiness timed out")
}

async function waitForNativeMariaDbRuntimeAccount(binaries: NativeMariaDbBinaries, port: number, password: string, dependencies: RuntimeServiceDependencies, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10_000
  const args = ["--no-defaults", ...mysqlConnectionArgs("127.0.0.1", port, "runtime"), "--database", "runtime"]
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      await executeNativeLimited(dependencies, binaries, binaries.client, args, { env: { ...environment, MYSQL_PWD: password }, signal, timeout: 2_000, stdin: "SELECT 1;\n", maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
      return
    } catch (error) {
      if (signal?.aborted) throw error
      await abortableDelay(100, signal)
    }
  }
  throw new Error("Native MariaDB runtime account readiness timed out")
}

async function nativeMariaDbBindCollision(logFile: string, state: OwnedNativeProcess): Promise<boolean> {
  if (!state.exited) return false
  try {
    const log = await readFile(logFile, "utf8")
    return /address already in use|can't start server.*bind|bind\(\).*error/i.test(log.slice(-64 * 1024))
  } catch {
    return false
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Unable to allocate a loopback port")
  }
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return address.port
}

async function stopOwnedNativeMariaDb(state: OwnedNativeProcess, root: OwnedNativeRoot | undefined, dependencies: RuntimeServiceDependencies, binaries?: NativeMariaDbBinaries, socket?: string): Promise<void> {
  if (!state.exited && root) {
    try {
      await assertOwnedNativeRoot(root)
      if (binaries && socket) await dependencies.execute(binaries.limiter, [...nativeMariaDbLimitArguments(), "--", binaries.client, ...nativeMariaDbSocketArguments(socket)], { env: nativeMariaDbEnvironment(dirname(socket)), timeout: 5_000, stdin: "SHUTDOWN;\n", maxOutputBytes: NATIVE_MARIADB_PROCESS_OUTPUT_LIMIT_BYTES })
    } catch {
      // The owned child handle remains the authority when socket shutdown fails.
    }
  }
  await stopOwnedNativeProcess(state, dependencies)
}

async function captureOwnedProcessIdentity(state: OwnedNativeProcess): Promise<void> {
  if (process.platform !== "linux" || !state.child.pid) return
  for (let attempt = 0; attempt < 20 && !state.exited; attempt += 1) {
    try {
      state.identity = await linuxProcessStartIdentity(state.child.pid)
      return
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
    }
  }
}

async function signalOwnedNativeProcess(state: OwnedNativeProcess, signal: NodeJS.Signals, dependencies: RuntimeServiceDependencies): Promise<void> {
  await state.identityReady
  if (!state.exited && process.platform === "linux") {
    if (!state.child.pid || !state.identity || await linuxProcessStartIdentity(state.child.pid) !== state.identity) {
      throw new Error("Owned native MariaDB process identity changed")
    }
  }
  let signaled: boolean
  if (dependencies.signalNativeProcess) signaled = dependencies.signalNativeProcess(state.child, signal)
  else if (process.platform !== "win32" && state.groupId) {
    try { process.kill(-state.groupId, signal); signaled = true } catch (error) { signaled = (error as NodeJS.ErrnoException).code === "ESRCH" }
  } else signaled = state.child.kill(signal)
  if (!signaled && await ownedProcessGroupExists(state)) throw new Error("Owned native MariaDB process group could not be signaled")
}

async function linuxProcessStartIdentity(pid: number): Promise<string> {
  const processStat = await readFile(`/proc/${pid}/stat`, "utf8")
  const commandEnd = processStat.lastIndexOf(")")
  const fieldsAfterCommand = commandEnd >= 0 ? processStat.slice(commandEnd + 2).trim().split(/\s+/) : []
  const startTime = fieldsAfterCommand[19]
  if (!startTime || !/^\d+$/.test(startTime)) throw new Error("Owned process start identity is unavailable")
  return `${pid}:${startTime}`
}

async function waitForOwnedProcessExit(state: OwnedNativeProcess, timeoutMs: number): Promise<boolean> {
  if (state.exited) return true
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    state.exit,
    new Promise<void>((resolveTimeout) => { timer = setTimeout(resolveTimeout, timeoutMs) }),
  ])
  if (timer) clearTimeout(timer)
  return state.exited
}

async function ownedProcessGroupExists(state: OwnedNativeProcess): Promise<boolean> {
  if (process.platform === "win32" || !state.groupId) return !state.exited
  try { process.kill(-state.groupId, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}

async function waitForOwnedProcessGroupExit(state: OwnedNativeProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await ownedProcessGroupExists(state)) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  return !await ownedProcessGroupExists(state)
}

async function ownedProcessRssMiB(state: OwnedNativeProcess): Promise<number | undefined> {
  if (state.exited || !state.child.pid || process.platform !== "linux") return undefined
  try {
    const status = await readFile(`/proc/${state.child.pid}/status`, "utf8")
    const kibibytes = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1])
    return Number.isFinite(kibibytes) ? Math.ceil(kibibytes / 1024) : undefined
  } catch {
    return undefined
  }
}

async function removeOwnedNativeRoot(root: OwnedNativeRoot, dependencies: RuntimeServiceDependencies): Promise<void> {
  await assertOwnedNativeRoot(root)
  await assertNoSymlinks(root.path)
  await (dependencies.removeNativeRoot ?? (async (path) => await rm(path, { recursive: true, force: false })))(root.path)
  try {
    await lstat(root.path)
    throw new Error("Native MariaDB private root still exists")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function assertNoSymlinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error("Native MariaDB private root contains a symlink")
    if (metadata.isDirectory()) await assertNoSymlinks(path)
  }
}

async function provisionMysqlExternalService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  const { signal } = context
  const engine = service.configuration?.engine ?? "mysql"
  const version = `mysql-compatible:${engine}`
  const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "external", version, readiness: "pending", lifecycle: "provisioning", controls: [] }
  evidenceList.push(evidence)

  let connection: ReturnType<typeof externalMysqlConnection>
  try {
    connection = externalMysqlConnection(service, dependencies.environment ?? process.env)
    assertExternalMysqlAuthorization(service, connection.host, connection.port, context)
  } catch {
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    evidence.diagnostic = { code: "provision-failed" }
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList)
  }
  const client = engine === "mariadb" ? "mariadb" : "mysql"
  const suffix = dependencies.randomBytes(12).toString("hex")
  const database = validateGeneratedMysqlIdentifier(`wp_codebox_${suffix}`)
  const username = validateGeneratedMysqlIdentifier(`wpcb_${suffix}`)
  const password = dependencies.randomBytes(24).toString("base64url")
  const adminArgs = mysqlConnectionArgs(connection.host, connection.port, connection.username)
  const adminEnvironment = { ...process.env, MYSQL_PWD: connection.password }
  let namespaceProven = false
  let databaseAttempted = false
  let userAttempted = false
  let readinessAttempted = false

  const executeAdminSql = async (sql: string, cleanup = false): Promise<{ stdout: string }> => await dependencies.execute(client, adminArgs, {
    env: adminEnvironment,
    signal: cleanup ? undefined : signal,
    timeout: 30_000,
    stdin: sql,
  })

  const cleanup = async (): Promise<void> => {
    if (evidence.teardown === "completed") return
    const results: PromiseSettledResult<unknown>[] = []
    if (databaseAttempted) results.push(await settle(executeAdminSql(`DROP DATABASE IF EXISTS ${quoteMysqlIdentifier(database)};\n`, true)))
    if (userAttempted) results.push(await settle(executeAdminSql(`DROP USER IF EXISTS ${quoteMysqlValue(username)}@'%';\n`, true)))
    const failure = results.find((result) => result.status === "rejected")
    if (failure) {
      evidence.lifecycle = "failed"
      evidence.teardown = "failed"
      evidence.diagnostic = { code: "teardown-failed" }
      throw new Error(`Managed runtime service teardown failed: ${service.id}`)
    }
    evidence.lifecycle = "released"
    evidence.teardown = "completed"
  }

  try {
    throwIfAborted(signal)
    const preflight = await executeAdminSql([
      `SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${quoteMysqlValue(database)});`,
      `SELECT EXISTS(SELECT 1 FROM mysql.user WHERE User=${quoteMysqlValue(username)} AND Host='%');`,
      "",
    ].join("\n"))
    if (preflight.stdout.trim().split(/\s+/).join(" ") !== "0 0") throw new Error("External MySQL isolation namespace is unavailable or cannot be proven unused")
    namespaceProven = true

    databaseAttempted = true
    await executeAdminSql(`CREATE DATABASE ${quoteMysqlIdentifier(database)};\n`)
    throwIfAborted(signal)
    userAttempted = true
    await executeAdminSql(`CREATE USER ${quoteMysqlValue(username)}@'%' IDENTIFIED BY ${quoteMysqlValue(password)};\n`)
    throwIfAborted(signal)
    await executeAdminSql(`GRANT ALL PRIVILEGES ON ${quoteMysqlIdentifier(database)}.* TO ${quoteMysqlValue(username)}@'%';\n`)
    throwIfAborted(signal)

    readinessAttempted = true
    await dependencies.execute(client, [...mysqlConnectionArgs(connection.host, connection.port, username), "--database", database], {
      env: { ...process.env, MYSQL_PWD: password },
      signal,
      timeout: 30_000,
      stdin: "SELECT 1;\n",
    })
    throwIfAborted(signal)
    evidence.readiness = "ready"
    evidence.lifecycle = "provisioned"
    const values: Record<string, string> = { host: connection.host, port: String(connection.port), username, password, database }
    return {
      env: runtimeServiceOutputEnvironment(service, values, new Set(["password"])),
      secretEnv: runtimeServiceOutputAliases(service.outputs.password, password),
      secretEnvTargets: mysqlRuntimeServiceSecretTargets(service),
      evidence,
      async control(action) {
        const result: RuntimeServiceControlResult = { serviceId: service.id, action, status: "unsupported", fidelity: "unsupported", reason: `The ${service.kind} provider does not support ${action}.` }
        evidence.controls?.push(result)
        return result
      },
      release: cleanup,
    }
  } catch {
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    evidence.diagnostic = { code: signal?.aborted ? "interrupted" : readinessAttempted ? "readiness-failed" : "provision-failed" }
    if (namespaceProven && (databaseAttempted || userAttempted)) await cleanup().catch(() => undefined)
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList)
  }
}

function externalMysqlConnection(service: WorkspaceRecipeRuntimeService, environment: Record<string, string | undefined>): { host: string; port: number; username: string; password: string } {
  const configuration = service.configuration
  const host = configuredEnvironmentValue(configuration?.hostEnv, environment, "hostEnv")
  const username = configuredEnvironmentValue(configuration?.usernameEnv, environment, "usernameEnv")
  const password = configuredEnvironmentValue(configuration?.passwordEnv, environment, "passwordEnv", true)
  const portValue = configuration?.portEnv ? configuredEnvironmentValue(configuration.portEnv, environment, "portEnv") : "3306"
  const port = Number(portValue)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("External MySQL port environment value must be an integer between 1 and 65535")
  return { host, port, username, password }
}

function assertExternalMysqlAuthorization(service: WorkspaceRecipeRuntimeService, host: string, port: number, context: RuntimeServiceProvisionContext): void {
  const policy = context.policy
  if (!policy || policy.network === "deny") throw new Error("External MySQL access is denied by runtime network policy")
  if (typeof policy.network === "object" && !hostListAllows(policy.network.allowHosts, host, port)) {
    throw new Error("External MySQL host is not allowed by runtime network policy")
  }

  const boundaryId = service.configuration?.externalService
  const boundary = context.externalServices.find((candidate) => candidate.id === boundaryId)
  if (!boundary || boundary.allowedHosts?.length === 0 || !hostListAllows(boundary.allowedHosts ?? [], host, port)) {
    throw new Error("External MySQL host is not explicitly allowlisted by its external-service boundary")
  }
  if (hostListAllows(boundary.blockedHosts ?? [], host, port)) throw new Error("External MySQL host is blocked by its external-service boundary")
  if (boundary.writes !== "allowed-with-approval") throw new Error("External MySQL boundary does not permit managed writes")
  if (policy.approvals !== "on-write" || !context.externalServiceWritesApproved) throw new Error("External MySQL managed writes were not explicitly approved")
}

function hostListAllows(allowedHosts: readonly string[], host: string, port: number): boolean {
  const targetHost = host.trim().toLowerCase()
  const targetWithPort = `${targetHost}:${port}`
  return allowedHosts.some((candidate) => {
    const normalized = candidate.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    return normalized === targetHost || normalized === targetWithPort
  })
}

function configuredEnvironmentValue(name: string | undefined, environment: Record<string, string | undefined>, field: string, allowEmpty = false): string {
  if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`External MySQL ${field} must reference a runtime environment variable`)
  const value = environment[name]
  if (value === undefined || (!allowEmpty && value.trim() === "")) throw new Error(`External MySQL ${field} environment variable is unavailable`)
  return value
}

function mysqlConnectionArgs(host: string, port: number, username: string): string[] {
  return ["--batch", "--skip-column-names", "--protocol=TCP", "--host", host, "--port", String(port), "--user", username]
}

function runtimeServiceOutputEnvironment(service: WorkspaceRecipeRuntimeService, values: Record<string, string>, secretOutputs: ReadonlySet<string> = new Set()): Record<string, string> {
  return Object.fromEntries(Object.entries(service.outputs)
    .filter(([output]) => !secretOutputs.has(output))
    .flatMap(([output, names]) => runtimeServiceOutputNames(names).map((name) => [name, values[output] ?? ""])))
}

function runtimeServiceOutputAliases(names: string | string[] | undefined, value: string): Record<string, string> {
  return Object.fromEntries(runtimeServiceOutputNames(names).map((name) => [name, value]))
}

function runtimeServiceOutputNames(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function validateDeclaredRuntimeServiceSecretTargets(services: readonly WorkspaceRecipeRuntimeService[], reservedEnvNames: readonly string[]): void {
  const reserved = new Set(reservedEnvNames)
  const outputOwners = new Map<string, Array<{ serviceIndex: number; output: string }>>()
  for (const [serviceIndex, service] of services.entries()) {
    for (const [output, names] of Object.entries(service.outputs)) {
      for (const name of runtimeServiceOutputNames(names)) {
        const owners = outputOwners.get(name) ?? []
        owners.push({ serviceIndex, output })
        outputOwners.set(name, owners)
      }
    }
  }
  const targets = new Map<string, string>()
  for (const [serviceIndex, service] of services.entries()) {
    for (const [target, source] of Object.entries(runtimeServiceProvider(service).secretEnvTargets(service))) {
      if (reserved.has(target)) throw new Error(`Managed runtime service secret target is reserved by injected environment: ${target}`)
      const conflictingOutput = (outputOwners.get(target) ?? []).some((owner) => !(owner.serviceIndex === serviceIndex && owner.output === "password" && source === target))
      if (conflictingOutput) throw new Error(`Managed runtime service secret target collides with managed output: ${target}`)
      if (targets.has(target)) throw new Error(`Managed runtime service secret target is ambiguous: ${target}`)
      targets.set(target, source)
    }
  }
}

function aggregateRuntimeServiceEnvironment(services: readonly ManagedRuntimeService[], reservedEnvNames: readonly string[]): { env: Record<string, string>; secretEnv: Record<string, string>; secretEnvTargets: Record<string, string> } {
  const env: Record<string, string> = {}
  const secretEnv: Record<string, string> = {}
  const secretEnvTargets: Record<string, string> = {}
  for (const service of services) {
    mergeUniqueEnvironment(env, service.env, "runtime service environment")
    mergeUniqueEnvironment(secretEnv, service.secretEnv, "runtime service secret environment")
    for (const [target, source] of Object.entries(service.secretEnvTargets)) {
      const existing = secretEnvTargets[target]
      if (existing !== undefined && existing !== source) throw new Error(`Managed runtime service secret target is ambiguous: ${target}`)
      secretEnvTargets[target] = source
    }
  }
  for (const [target, source] of Object.entries(secretEnvTargets)) {
    if (!(source in secretEnv)) throw new Error(`Managed runtime service secret target references an unavailable secret: ${target}`)
    if (target in env) throw new Error(`Managed runtime service secret target collides with non-secret environment: ${target}`)
    if (reservedEnvNames.includes(target)) throw new Error(`Managed runtime service secret target is reserved by injected environment: ${target}`)
  }
  return { env, secretEnv, secretEnvTargets }
}

function mergeUniqueEnvironment(target: Record<string, string>, source: Record<string, string>, label: string): void {
  for (const [name, value] of Object.entries(source)) {
    if (name in target) throw new Error(`Duplicate ${label} name: ${name}`)
    target[name] = value
  }
}

function validateGeneratedMysqlIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(identifier)) throw new Error("Generated MySQL isolation identifier is unsafe")
  return identifier
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${validateGeneratedMysqlIdentifier(identifier).replaceAll("`", "``")}\``
}

function quoteMysqlValue(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise }
  } catch (reason) {
    return { status: "rejected", reason }
  }
}

async function provisionRedisDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  return await provisionSimpleDockerService(service, dependencies, context.signal, evidenceList, {
    image: service.configuration?.image ?? SERVICE_IMAGES.redis,
    ports: [6379],
    runArgs: ["--save", "", "--appendonly", "no"],
    values: (ports) => ({ host: "127.0.0.1", port: String(ports[0]), url: `redis://127.0.0.1:${ports[0]}` }),
    customControl: async (container, action) => {
      if (action !== "flush") return false
      await dependencies.execute("docker", ["exec", container, "redis-cli", "FLUSHALL"], { timeout: 10_000 })
      return true
    },
  })
}

async function provisionSmtpDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  return await provisionSimpleDockerService(service, dependencies, context.signal, evidenceList, {
    image: service.configuration?.image ?? SERVICE_IMAGES.smtp,
    ports: [1025, 8025],
    runArgs: [],
    values: (ports) => ({ host: "127.0.0.1", port: String(ports[0]), httpPort: String(ports[1]), url: `smtp://127.0.0.1:${ports[0]}` }),
  })
}

async function provisionHttpDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  return await provisionSimpleDockerService(service, dependencies, context.signal, evidenceList, {
    image: service.configuration?.image ?? SERVICE_IMAGES.http,
    ports: [5678],
    runArgs: ["-listen=:5678", `-status-code=${service.configuration?.responseStatus ?? 200}`, `-text=${service.configuration?.responseBody ?? "ok"}`],
    values: (ports) => ({ host: "127.0.0.1", port: String(ports[0]), url: `http://127.0.0.1:${ports[0]}` }),
  })
}

async function provisionSimpleDockerService(
  service: WorkspaceRecipeRuntimeService,
  dependencies: RuntimeServiceDependencies,
  signal: AbortSignal | undefined,
  evidenceList: RuntimeServiceEvidence[],
  spec: { image: string; ports: number[]; runArgs: string[]; values(ports: number[]): Record<string, string>; customControl?(container: string, action: RuntimeServiceControlAction, options?: Record<string, unknown>): Promise<boolean> },
): Promise<ManagedRuntimeService> {
  const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "docker", version: spec.image, readiness: "pending", lifecycle: "provisioning", controls: [] }
  evidenceList.push(evidence)
  const container = `wp-codebox-${service.id}-${dependencies.randomBytes(6).toString("hex")}`
  let started = false
  try {
    throwIfAborted(signal)
    await ensureDockerImage(spec.image, dependencies, signal)
    const publishArgs = spec.ports.flatMap((port) => ["--publish", `127.0.0.1::${port}`])
    await dependencies.execute("docker", ["run", "--detach", "--name", container, "--label", "wp-codebox.managed=true", ...publishArgs, "--tmpfs", "/tmp", spec.image, ...spec.runArgs], { signal, timeout: 30_000 })
    started = true
    const ports: number[] = []
    for (const containerPort of spec.ports) {
      const { stdout } = await dependencies.execute("docker", ["port", container, `${containerPort}/tcp`], { signal, timeout: 10_000 })
      ports.push(parseLoopbackPort(stdout))
    }
    await dependencies.waitForReady("127.0.0.1", ports[0] as number, 30_000, signal)
    evidence.readiness = "ready"
    evidence.lifecycle = "provisioned"
    const values = spec.values(ports)
    return {
      env: runtimeServiceOutputEnvironment(service, values),
      secretEnv: {},
      secretEnvTargets: {},
      evidence,
      async control(action, options) { return await controlDockerService(container, evidence, dependencies, action, options, spec.customControl ? async (candidate, candidateOptions) => await spec.customControl?.(container, candidate, candidateOptions) ?? false : undefined, async () => await dependencies.waitForReady("127.0.0.1", ports[0] as number, 30_000)) },
      async release() { await releaseService(container, evidence, dependencies) },
    }
  } catch (error) {
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    evidence.diagnostic = { code: signal?.aborted ? "interrupted" : started ? "readiness-failed" : "provision-failed" }
    if (started) await releaseService(container, evidence, dependencies).catch(() => undefined)
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList)
  }
}

async function controlDockerService(container: string, evidence: RuntimeServiceEvidence, dependencies: RuntimeServiceDependencies, action: RuntimeServiceControlAction, options?: Record<string, unknown>, custom?: (action: RuntimeServiceControlAction, options?: Record<string, unknown>) => Promise<boolean>, recover?: () => Promise<void>): Promise<RuntimeServiceControlResult> {
  const common: Partial<Record<RuntimeServiceControlAction, string[]>> = {
    stop: ["stop", container],
    start: ["start", container],
    pause: ["pause", container],
    resume: ["unpause", container],
    restart: ["restart", container],
    disconnect: ["network", "disconnect", "bridge", container],
    reconnect: ["network", "connect", "bridge", container],
  }
  let result: RuntimeServiceControlResult
  try {
    const args = common[action]
    if (args) {
      await dependencies.execute("docker", args, { timeout: 30_000 })
      if (["start", "resume", "restart", "reconnect"].includes(action)) await recover?.()
      result = { serviceId: evidence.id, action, status: "applied", fidelity: "exact" }
    } else if (await custom?.(action, options)) {
      result = { serviceId: evidence.id, action, status: "applied", fidelity: "exact" }
    } else if (action === "latency") {
      result = { serviceId: evidence.id, action, status: "unsupported", fidelity: "unsupported", reason: "The Docker provider does not inject host network shaping; use a declared transport fault adapter." }
    } else {
      result = { serviceId: evidence.id, action, status: "unsupported", fidelity: "unsupported", reason: `The ${evidence.kind} provider does not support ${action}.` }
    }
  } catch (error) {
    result = { serviceId: evidence.id, action, status: "failed", fidelity: "exact", reason: error instanceof Error ? error.message : String(error) }
  }
  ;(evidence.controls ??= []).push(result)
  return result
}

async function waitForMysqlDatabase(container: string, engine: keyof typeof MYSQL_IMAGES, password: string, dependencies: RuntimeServiceDependencies, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const client = engine === "mariadb" ? "mariadb" : "mysql"
  const args = ["exec", "--env", "MYSQL_PWD", container, client, "--protocol=TCP", "--host=127.0.0.1", "--user=runtime", "--database=runtime", "--execute=SELECT 1"]
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      await dependencies.execute("docker", args, { env: { ...process.env, MYSQL_PWD: password }, signal, timeout: 5_000 })
      return
    } catch (error) {
      if (signal?.aborted) throw error
      if (providerUnavailableDiagnostic(error, "docker")) throw error
      await abortableDelay(100, signal)
    }
  }
  throw new Error(`MySQL database readiness timed out after ${timeoutMs}ms`)
}

async function ensureDockerImage(image: string, dependencies: RuntimeServiceDependencies, signal?: AbortSignal): Promise<void> {
  try {
    await dependencies.execute("docker", ["image", "inspect", image], { signal, timeout: 10_000 })
  } catch {
    throwIfAborted(signal)
    await dependencies.execute("docker", ["pull", image], { signal, timeout: 5 * 60_000 })
  }
}

async function releaseServices(services: ManagedRuntimeService[]): Promise<void> {
  const results = await Promise.allSettled([...services].reverse().map(async (service) => await service.release()))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) throw failure.reason
}

async function releaseService(container: string, evidence: RuntimeServiceEvidence, dependencies: RuntimeServiceDependencies, signal?: AbortSignal): Promise<void> {
  if (evidence.teardown === "completed") return
  try {
    await dependencies.execute("docker", ["rm", "--force", "--volumes", container], { signal, timeout: 30_000 })
    evidence.lifecycle = "released"
    evidence.teardown = "completed"
  } catch (error) {
    if (dockerContainerIsAbsent(error)) {
      evidence.lifecycle = "released"
      evidence.teardown = "completed"
      return
    }
    evidence.lifecycle = "failed"
    evidence.teardown = "failed"
    if (evidence.diagnostic?.code !== "provider-unavailable") evidence.diagnostic = { code: "teardown-failed" }
    throw new Error(`Managed runtime service teardown failed: ${evidence.id}`)
  }
}

function dockerContainerIsAbsent(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : ""
  return /No such container/i.test(`${error.message}\n${stderr}`)
}

export function parseLoopbackPort(output: string): number {
  const match = output.trim().match(/^127\.0\.0\.1:(\d+)$/m)
  const port = match ? Number(match[1]) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Managed runtime service did not publish a loopback port")
  return port
}

export async function waitForMysqlProtocol(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      await mysqlHandshake(host, port, signal)
      return
    } catch (error) {
      if (signal?.aborted) throw error
      await abortableDelay(100, signal)
    }
  }
  throw new Error(`MySQL protocol readiness timed out after ${timeoutMs}ms`)
}

export async function waitForTcpProtocol(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      await tcpConnect(host, port, signal)
      return
    } catch (error) {
      if (signal?.aborted) throw error
      await abortableDelay(100, signal)
    }
  }
  throw new Error(`TCP readiness timed out after ${timeoutMs}ms`)
}

function tcpConnect(host: string, port: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => socket.destroy(new Error("connection timeout")), 1_000)
    const abort = () => socket.destroy(new Error("aborted"))
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
    signal?.addEventListener("abort", abort, { once: true })
    socket.once("connect", () => { cleanup(); socket.destroy(); resolve() })
    socket.once("error", (error) => { cleanup(); reject(error) })
  })
}

function mysqlHandshake(host: string, port: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    let settled = false
    const timer = setTimeout(() => socket.destroy(new Error("connection timeout")), 1_000)
    const abort = () => socket.destroy(new Error("aborted"))
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    signal?.addEventListener("abort", abort, { once: true })
    socket.once("error", fail)
    socket.once("data", (chunk: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (chunk.length < 5 || chunk[4] !== 10) reject(new Error("invalid MySQL protocol handshake"))
      else resolve()
    })
    socket.once("close", () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      fail(new Error("connection closed before MySQL protocol handshake"))
    })
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Managed runtime service provisioning interrupted")
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Managed runtime service provisioning interrupted")) }, { once: true })
  })
}

export function executeRuntimeServiceProcess(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number; stdin?: string; maxOutputBytes?: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const limit = options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES
    if (!Number.isSafeInteger(limit) || limit < 1) {
      reject(new Error("Runtime service process output limit must be a positive integer"))
      return
    }
    const child = spawn(command, args, {
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const timeout = setTimeout(() => child.kill(), options.timeout)
    timeout.unref()
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow = false
    let settled = false
    const collect = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = Math.max(0, limit - currentBytes)
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      if (chunk.length > remaining && !overflow) {
        overflow = true
        child.kill("SIGKILL")
      }
      return currentBytes + Math.min(chunk.length, remaining)
    }
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdout, chunk, stdoutBytes) })
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes) })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const boundedStdout = Buffer.concat(stdout).toString("utf8")
      const boundedStderr = Buffer.concat(stderr).toString("utf8")
      if (overflow) {
        const error = new Error(`Runtime service process output exceeded ${limit} bytes`) as Error & { code: string; stdout: string; stderr: string }
        error.code = "runtime-service-output-overflow"
        error.stdout = boundedStdout
        error.stderr = boundedStderr
        reject(error)
        return
      }
      if (code === 0) {
        resolve({ stdout: boundedStdout })
        return
      }
      const error = new Error(`Command failed with exit code ${code ?? "unknown"}`) as Error & { stdout: string; stderr: string }
      error.stdout = boundedStdout
      error.stderr = boundedStderr
      reject(error)
    })
    child.stdin.on("error", () => undefined)
    child.stdin.end(options.stdin)
  })
}
