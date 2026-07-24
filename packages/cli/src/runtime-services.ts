import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createConnection } from "node:net"
import { promisify } from "node:util"
import type { WorkspaceRecipeRuntimeService } from "@automattic/wp-codebox-core"

const execFileAsync = promisify(execFile)
const MYSQL_IMAGES = { mysql: "mysql:8.4", mariadb: "mariadb:11.4" } as const
const SERVICE_IMAGES = { redis: "redis:7.4-alpine", smtp: "axllent/mailpit:v1.27", http: "hashicorp/http-echo:1.0" } as const

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
  evidence: RuntimeServiceEvidence
  release(): Promise<void>
  control(action: RuntimeServiceControlAction, options?: Record<string, unknown>): Promise<RuntimeServiceControlResult>
}

export interface RuntimeServiceDependencies {
  execute(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number }): Promise<{ stdout: string }>
  waitForReady(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
  randomBytes(size: number): Buffer
}

export interface RuntimeServiceProvider {
  readonly name: string
  readonly kind: string
  version(service: WorkspaceRecipeRuntimeService): string
  provision(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidence: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService>
}

const defaultDependencies: RuntimeServiceDependencies = {
  execute: async (command, args, options) => await execFileAsync(command, args, options),
  waitForReady: waitForTcpProtocol,
  randomBytes,
}

export function runtimeServicePlan(services: WorkspaceRecipeRuntimeService[]): Array<{ id: string; kind: string; provider: string; version: string; bind: "loopback"; port: "ephemeral"; persistentVolume: false; configuration?: WorkspaceRecipeRuntimeService["configuration"]; outputs: Record<string, string> }> {
  return services.map((service) => {
    const provider = runtimeServiceProvider(service.kind)
    return { id: service.id, kind: service.kind, provider: provider.name, version: provider.version(service), bind: "loopback", port: "ephemeral", persistentVolume: false, ...(service.configuration ? { configuration: service.configuration } : {}), outputs: service.outputs }
  })
}

export async function provisionRuntimeServices(services: WorkspaceRecipeRuntimeService[], options: { signal?: AbortSignal; dependencies?: RuntimeServiceDependencies } = {}): Promise<{ env: Record<string, string>; evidence: RuntimeServiceEvidence[]; control(serviceId: string, action: RuntimeServiceControlAction, controlOptions?: Record<string, unknown>): Promise<RuntimeServiceControlResult>; release(): Promise<void> }> {
  const dependencies = options.dependencies ?? defaultDependencies
  const provisioned: ManagedRuntimeService[] = []
  const evidence: RuntimeServiceEvidence[] = []
  try {
    for (const service of services) {
      const managed = await runtimeServiceProvider(service.kind).provision(service, dependencies, options.signal, evidence)
      provisioned.push(managed)
    }
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
    env: Object.assign({}, ...provisioned.map((service) => service.env)),
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
  options: { signal?: AbortSignal; dependencies?: RuntimeServiceDependencies; onEvidence?: (evidence: RuntimeServiceEvidence[]) => void } = {},
): Promise<Awaited<ReturnType<typeof provisionRuntimeServices>>> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const provisioning = provisionRuntimeServices(services, { signal: controller.signal, dependencies: options.dependencies })
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
  provision: provisionMysqlDockerService,
}

const redisDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "redis", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.redis, provision: provisionRedisDockerService }
const smtpDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "smtp", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.smtp, provision: provisionSmtpDockerService }
const httpDockerProvider: RuntimeServiceProvider = { name: "docker", kind: "http", version: (service) => service.configuration?.image ?? SERVICE_IMAGES.http, provision: provisionHttpDockerService }

function mysqlDockerImage(service: WorkspaceRecipeRuntimeService): string {
  return MYSQL_IMAGES[service.configuration?.engine ?? "mysql"]
}

function runtimeServiceProvider(kind: string): RuntimeServiceProvider {
  if (kind === mysqlDockerProvider.kind) return mysqlDockerProvider
  if (kind === redisDockerProvider.kind) return redisDockerProvider
  if (kind === smtpDockerProvider.kind) return smtpDockerProvider
  if (kind === httpDockerProvider.kind) return httpDockerProvider
  throw new Error(`Unsupported managed runtime service kind: ${kind}`)
}

async function provisionMysqlDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
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
      env: Object.fromEntries(Object.entries(service.outputs).map(([output, name]) => [name, values[output] ?? ""])),
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

async function provisionRedisDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  return await provisionSimpleDockerService(service, dependencies, signal, evidenceList, {
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

async function provisionSmtpDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  return await provisionSimpleDockerService(service, dependencies, signal, evidenceList, {
    image: service.configuration?.image ?? SERVICE_IMAGES.smtp,
    ports: [1025, 8025],
    runArgs: [],
    values: (ports) => ({ host: "127.0.0.1", port: String(ports[0]), httpPort: String(ports[1]), url: `smtp://127.0.0.1:${ports[0]}` }),
  })
}

async function provisionHttpDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  return await provisionSimpleDockerService(service, dependencies, signal, evidenceList, {
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
