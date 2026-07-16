import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createConnection } from "node:net"
import { promisify } from "node:util"
import type { WorkspaceRecipeRuntimeService } from "@automattic/wp-codebox-core"

const execFileAsync = promisify(execFile)
const MYSQL_IMAGE = "mysql:8.4"

export interface RuntimeServiceEvidence {
  id: string
  kind: string
  provider: string
  version: string
  readiness: "pending" | "ready" | "failed"
  lifecycle: "provisioning" | "provisioned" | "released" | "failed"
  teardown?: "completed" | "failed"
  diagnostic?: { code: "readiness-failed" | "provision-failed" | "teardown-failed" | "interrupted" }
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
}

export interface RuntimeServiceDependencies {
  execute(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number }): Promise<{ stdout: string }>
  waitForReady(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
  randomBytes(size: number): Buffer
}

export interface RuntimeServiceProvider {
  readonly name: string
  readonly kind: string
  readonly version: string
  provision(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidence: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService>
}

const defaultDependencies: RuntimeServiceDependencies = {
  execute: async (command, args, options) => await execFileAsync(command, args, options),
  waitForReady: waitForMysqlProtocol,
  randomBytes,
}

export function runtimeServicePlan(services: WorkspaceRecipeRuntimeService[]): Array<{ id: string; kind: string; provider: string; version: string; bind: "loopback"; port: "ephemeral"; persistentVolume: false; configuration?: WorkspaceRecipeRuntimeService["configuration"]; outputs: Record<string, string> }> {
  return services.map((service) => {
    const provider = runtimeServiceProvider(service.kind)
    return { id: service.id, kind: service.kind, provider: provider.name, version: provider.version, bind: "loopback", port: "ephemeral", persistentVolume: false, ...(service.configuration ? { configuration: service.configuration } : {}), outputs: service.outputs }
  })
}

export async function provisionRuntimeServices(services: WorkspaceRecipeRuntimeService[], options: { signal?: AbortSignal; dependencies?: RuntimeServiceDependencies } = {}): Promise<{ env: Record<string, string>; evidence: RuntimeServiceEvidence[]; release(): Promise<void> }> {
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
  version: MYSQL_IMAGE,
  provision: provisionMysqlDockerService,
}

function runtimeServiceProvider(kind: string): RuntimeServiceProvider {
  if (kind === mysqlDockerProvider.kind) return mysqlDockerProvider
  throw new Error(`Unsupported managed runtime service kind: ${kind}`)
}

async function provisionMysqlDockerService(service: WorkspaceRecipeRuntimeService, dependencies: RuntimeServiceDependencies, signal: AbortSignal | undefined, evidenceList: RuntimeServiceEvidence[]): Promise<ManagedRuntimeService> {
  const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "docker", version: MYSQL_IMAGE, readiness: "pending", lifecycle: "provisioning" }
  evidenceList.push(evidence)
  const container = `wp-codebox-${service.id}-${dependencies.randomBytes(6).toString("hex")}`
  const password = dependencies.randomBytes(24).toString("base64url")
  const emptyRootPassword = service.configuration?.rootAuthentication === "empty-password"
  const rootEnvironment = emptyRootPassword ? { MYSQL_ALLOW_EMPTY_PASSWORD: "yes" } : { MYSQL_ROOT_PASSWORD: password }
  const childEnvironment = { ...process.env, MYSQL_DATABASE: "runtime", MYSQL_USER: "runtime", MYSQL_PASSWORD: password, ...rootEnvironment }
  const rootEnvironmentName = emptyRootPassword ? "MYSQL_ALLOW_EMPTY_PASSWORD" : "MYSQL_ROOT_PASSWORD"
  const runArgs = ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::3306", "--tmpfs", "/var/lib/mysql", "--env", "MYSQL_DATABASE", "--env", "MYSQL_USER", "--env", "MYSQL_PASSWORD", "--env", rootEnvironmentName, MYSQL_IMAGE]
  let started = false
  try {
    throwIfAborted(signal)
    await ensureDockerImage(dependencies, signal)
    await dependencies.execute("docker", runArgs, { env: childEnvironment, signal, timeout: 30_000 })
    started = true
    const { stdout } = await dependencies.execute("docker", ["port", container, "3306/tcp"], { signal, timeout: 10_000 })
    const port = parseLoopbackPort(stdout)
    await dependencies.waitForReady("127.0.0.1", port, 30_000, signal)
    throwIfAborted(signal)
    evidence.readiness = "ready"
    evidence.lifecycle = "provisioned"
    const values: Record<string, string> = { host: "127.0.0.1", port: String(port), username: "runtime", password, database: "runtime" }
    return { env: Object.fromEntries(Object.entries(service.outputs).map(([output, name]) => [name, values[output] ?? ""])), evidence, async release() { await releaseService(container, evidence, dependencies) } }
  } catch (error) {
    evidence.readiness = "failed"
    evidence.lifecycle = "failed"
    evidence.diagnostic = { code: signal?.aborted ? "interrupted" : started ? "readiness-failed" : "provision-failed" }
    if (started) await releaseService(container, evidence, dependencies, undefined).catch(() => undefined)
    throw new RuntimeServiceProvisionError(`Managed runtime service failed: ${service.id}`, evidenceList)
  }
}

async function ensureDockerImage(dependencies: RuntimeServiceDependencies, signal?: AbortSignal): Promise<void> {
  try {
    await dependencies.execute("docker", ["image", "inspect", MYSQL_IMAGE], { signal, timeout: 10_000 })
  } catch {
    throwIfAborted(signal)
    await dependencies.execute("docker", ["pull", MYSQL_IMAGE], { signal, timeout: 5 * 60_000 })
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
