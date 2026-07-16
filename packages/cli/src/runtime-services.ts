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

export function runtimeServicePlan(services: WorkspaceRecipeRuntimeService[]): Array<{ id: string; kind: string; provider: string; version: string; bind: "loopback"; port: "ephemeral"; persistentVolume: false; outputs: Record<string, string> }> {
  return services.map((service) => {
    const provider = runtimeServiceProvider(service.kind)
    return { id: service.id, kind: service.kind, provider: provider.name, version: provider.version, bind: "loopback", port: "ephemeral", persistentVolume: false, outputs: service.outputs }
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
    await releaseServices(provisioned)
    if (error instanceof RuntimeServiceProvisionError) throw error
    throw new RuntimeServiceProvisionError("Managed runtime service provisioning failed", evidence)
  }

  return {
    env: Object.assign({}, ...provisioned.map((service) => service.env)),
    evidence,
    async release() {
      await releaseServices(provisioned)
    },
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
  const childEnvironment = { PATH: process.env.PATH, MYSQL_DATABASE: "runtime", MYSQL_USER: "runtime", MYSQL_PASSWORD: password, MYSQL_ROOT_PASSWORD: password }
  const runArgs = ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::3306", "--tmpfs", "/var/lib/mysql", "--env", "MYSQL_DATABASE", "--env", "MYSQL_USER", "--env", "MYSQL_PASSWORD", "--env", "MYSQL_ROOT_PASSWORD", MYSQL_IMAGE]
  let started = false
  try {
    throwIfAborted(signal)
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

async function releaseServices(services: ManagedRuntimeService[]): Promise<void> {
  const results = await Promise.allSettled([...services].reverse().map(async (service) => await service.release()))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) throw failure.reason
}

async function releaseService(container: string, evidence: RuntimeServiceEvidence, dependencies: RuntimeServiceDependencies, signal?: AbortSignal): Promise<void> {
  if (evidence.teardown) return
  try {
    await dependencies.execute("docker", ["rm", "--force", container], { signal, timeout: 30_000 })
    evidence.lifecycle = "released"
    evidence.teardown = "completed"
  } catch {
    evidence.lifecycle = "failed"
    evidence.teardown = "failed"
    evidence.diagnostic = { code: "teardown-failed" }
    throw new Error(`Managed runtime service teardown failed: ${evidence.id}`)
  }
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
    const timer = setTimeout(() => socket.destroy(new Error("connection timeout")), 1_000)
    const abort = () => socket.destroy(new Error("aborted"))
    signal?.addEventListener("abort", abort, { once: true })
    socket.once("error", reject)
    socket.once("data", (chunk: Buffer) => {
      clearTimeout(timer)
      socket.destroy()
      if (chunk.length < 5 || chunk[4] !== 10) reject(new Error("invalid MySQL protocol handshake"))
      else resolve()
    })
    socket.once("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort) })
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
