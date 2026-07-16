import { randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { createConnection } from "node:net"
import { promisify } from "node:util"
import type { WorkspaceRecipeRuntimeService } from "@automattic/wp-codebox-core"

const execFileAsync = promisify(execFile)
const MYSQL_IMAGE = "mysql:8.4"

export interface RuntimeServiceEvidence { id: string; kind: string; provider: string; version: string; readiness: "ready" | "failed"; lifecycle: "provisioned" | "released"; teardown?: "completed" | "failed" }
interface ManagedRuntimeService { env: Record<string, string>; evidence: RuntimeServiceEvidence; release(): Promise<void> }

export function runtimeServicePlan(services: WorkspaceRecipeRuntimeService[]): Array<{ id: string; kind: string; provider: string; version: string; bind: "loopback"; port: "ephemeral"; persistentVolume: false; outputs: Record<string, string> }> {
  return services.map((service) => ({ id: service.id, kind: service.kind, provider: "docker", version: MYSQL_IMAGE, bind: "loopback", port: "ephemeral", persistentVolume: false, outputs: service.outputs }))
}

export async function provisionRuntimeServices(services: WorkspaceRecipeRuntimeService[]): Promise<{ env: Record<string, string>; evidence: RuntimeServiceEvidence[]; release(): Promise<void> }> {
  const provisioned: ManagedRuntimeService[] = []
  try { for (const service of services) provisioned.push(await provisionRuntimeService(service)) } catch (error) { await Promise.allSettled(provisioned.map((service) => service.release())); throw error }
  return { env: Object.assign({}, ...provisioned.map((service) => service.env)), evidence: provisioned.map((service) => service.evidence), async release() { await Promise.all(provisioned.reverse().map((service) => service.release())) } }
}

async function provisionRuntimeService(service: WorkspaceRecipeRuntimeService): Promise<ManagedRuntimeService> {
  if (service.kind !== "mysql") throw new Error(`Unsupported managed runtime service kind: ${service.kind}`)
  const container = `wp-codebox-${service.id}-${randomBytes(6).toString("hex")}`
  const password = randomBytes(24).toString("base64url")
  const args = ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::3306", "--tmpfs", "/var/lib/mysql", "--env", "MYSQL_DATABASE=runtime", "--env", "MYSQL_USER=runtime", "--env", `MYSQL_PASSWORD=${password}`, "--env", `MYSQL_ROOT_PASSWORD=${password}`, MYSQL_IMAGE]
  try {
    await execFileAsync("docker", args, { timeout: 30_000 })
    const { stdout } = await execFileAsync("docker", ["port", container, "3306/tcp"], { timeout: 10_000 })
    const port = parseLoopbackPort(stdout)
    await waitForMysqlProtocol("127.0.0.1", port, 30_000)
    const values: Record<string, string> = { host: "127.0.0.1", port: String(port), username: "runtime", password, database: "runtime" }
    const env = Object.fromEntries(Object.entries(service.outputs).map(([output, name]) => [name, values[output] ?? ""]))
    let released = false
    const evidence: RuntimeServiceEvidence = { id: service.id, kind: service.kind, provider: "docker", version: MYSQL_IMAGE, readiness: "ready", lifecycle: "provisioned" }
    return { env, evidence, async release() { if (released) return; released = true; try { await execFileAsync("docker", ["rm", "--force", container], { timeout: 30_000 }); evidence.lifecycle = "released"; evidence.teardown = "completed" } catch { evidence.teardown = "failed"; throw new Error(`Managed runtime service teardown failed: ${service.id}`) } } }
  } catch {
    await execFileAsync("docker", ["rm", "--force", container], { timeout: 30_000 }).catch(() => undefined)
    throw new Error(`Managed runtime service failed readiness: ${service.id} (${MYSQL_IMAGE})`)
  }
}

export function parseLoopbackPort(output: string): number {
  const match = output.trim().match(/^127\.0\.0\.1:(\d+)$/m); const port = match ? Number(match[1]) : NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Managed runtime service did not publish a loopback port")
  return port
}

export async function waitForMysqlProtocol(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { try { await mysqlHandshake(host, port); return } catch { await new Promise((resolve) => setTimeout(resolve, 100)) } }
  throw new Error(`MySQL protocol readiness timed out after ${timeoutMs}ms`)
}

function mysqlHandshake(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }); const timer = setTimeout(() => socket.destroy(new Error("connection timeout")), 1_000)
    socket.once("error", reject)
    socket.once("data", (chunk: Buffer) => { clearTimeout(timer); socket.destroy(); if (chunk.length < 5 || chunk[4] !== 10) reject(new Error("invalid MySQL protocol handshake")); else resolve() })
    socket.once("close", () => clearTimeout(timer))
  })
}
