import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createConnection } from "node:net"
import type { RuntimePolicy, WorkspaceRecipeExternalServiceBoundary, WorkspaceRecipeRuntimeService } from "@automattic/wp-codebox-core"

const MYSQL_IMAGES = { mysql: "mysql:8.4", mariadb: "mariadb:11.4" } as const
const SERVICE_IMAGES = { redis: "redis:7.4-alpine", smtp: "axllent/mailpit:v1.27", http: "hashicorp/http-echo:1.0" } as const
const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024

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
  diagnostic?: { code: "readiness-failed" | "provision-failed" | "teardown-failed" | "interrupted" }
  controls?: RuntimeServiceControlResult[]
}

export class RuntimeServiceProvisionError extends Error {
  constructor(message: string, readonly evidence: RuntimeServiceEvidence[]) {
    super(message)
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

export function runtimeServicePlan(services: WorkspaceRecipeRuntimeService[]): Array<{ id: string; kind: string; provider: string; version: string; bind: "loopback" | "configured"; port: "ephemeral" | "configured"; persistentVolume: false; configuration?: WorkspaceRecipeRuntimeService["configuration"]; outputs: Record<string, string> }> {
  return services.map((service) => {
    const provider = runtimeServiceProvider(service)
    const external = provider.name === "external"
    return { id: service.id, kind: service.kind, provider: provider.name, version: provider.version(service), bind: external ? "configured" : "loopback", port: external ? "configured" : "ephemeral", persistentVolume: false, ...(service.configuration ? { configuration: service.configuration } : {}), outputs: service.outputs }
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

const redisDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "redis", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.redis, secretEnvTargets: () => ({}), provision: provisionRedisDockerService }
const smtpDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "smtp", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.smtp, secretEnvTargets: () => ({}), provision: provisionSmtpDockerService }
const httpDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "http", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.http, secretEnvTargets: () => ({}), provision: provisionHttpDockerService }

function mysqlDockerImage(service: WorkspaceRecipeRuntimeService): string {
  return MYSQL_IMAGES[service.configuration?.engine ?? "mysql"]
}

function mysqlRuntimeServiceSecretTargets(service: WorkspaceRecipeRuntimeService): Record<string, string> {
  return service.outputs.password ? { DB_PASSWORD: service.outputs.password } : {}
}

function runtimeServiceProvider(service: WorkspaceRecipeRuntimeService): RuntimeServiceProvider {
  if (service.kind === mysqlDockerProvider.kind) return service.configuration?.provider === "external" ? mysqlExternalProvider : mysqlDockerProvider
  if (service.configuration?.provider === "external") throw new Error(`Managed runtime service kind does not support the external provider: ${service.kind}`)
  if (service.kind === redisDockerProvider.kind) return redisDockerProvider
  if (service.kind === smtpDockerProvider.kind) return smtpDockerProvider
  if (service.kind === httpDockerProvider.kind) return httpDockerProvider
  throw new Error(`Unsupported managed runtime service kind: ${service.kind}`)
}

async function provisionMysqlDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, context: RuntimeServiceProvisionContext, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  const { signal } = context
  const engine = service.configuration?.engine ?? "mysql"
  const image = mysqlDockerImage(service)
  const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "docker", version: image, readiness: "pending", lifecycle: "provisioning" }
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
  const runArgs = ["run", "--detach", "--name", container, "--label", "wp-codebox.managed=true", "--publish", "127.0.0.1::3306", "--tmpfs", "/var/lib/mysql", "--env", `${environmentPrefix}_DATABASE`, "--env", `${environmentPrefix}_USER`, "--env", `${environmentPrefix}_PASSWORD`, "--env", rootEnvironmentName, image, ...mysqlArguments]
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
      secretEnv: service.outputs.password ? { [service.outputs.password]: password } : {},
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
    evidence.diagnostic = { code: signal?.aborted ? "interrupted" : started ? "readiness-failed" : "provision-failed" }
    if (started) await releaseService(container, evidence, dependencies, undefined).catch(() => undefined)
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList)
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
      secretEnv: service.outputs.password ? { [service.outputs.password]: password } : {},
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
    .map(([output, name]) => [name, values[output] ?? ""]))
}

function validateDeclaredRuntimeServiceSecretTargets(services: readonly WorkspaceRecipeRuntimeService[], reservedEnvNames: readonly string[]): void {
  const reserved = new Set(reservedEnvNames)
  const outputOwners = new Map<string, Array<{ serviceIndex: number; output: string }>>()
  for (const [serviceIndex, service] of services.entries()) {
    for (const [output, name] of Object.entries(service.outputs)) {
      const owners = outputOwners.get(name) ?? []
      owners.push({ serviceIndex, output })
      outputOwners.set(name, owners)
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
      env: Object.fromEntries(Object.entries(service.outputs).map(([output, name]) => [name, values[output] ?? ""])),
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
    await dependencies.execute("docker", ["rm", "--force", container], { signal, timeout: 30_000 })
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
    evidence.diagnostic = { code: "teardown-failed" }
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
      timeout: options.timeout,
      stdio: ["pipe", "pipe", "pipe"],
    })
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
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
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
