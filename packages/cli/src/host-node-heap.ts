import { spawn } from "node:child_process"
import v8 from "node:v8"
import type { WorkspaceRecipeHostNodeHeap } from "@automattic/wp-codebox-core"

const MIB = 1024 * 1024

export interface HostNodeHeapPreflight {
  status: "ready" | "insufficient"
  effectiveMiB: number
  minimumMiB: number
  maximumMiB: number
  replayOption: string
}

export class HostNodeHeapPreflightError extends Error {
  readonly code = "wp-codebox-host-node-heap-insufficient"

  constructor(readonly preflight: HostNodeHeapPreflight) {
    super(`The effective Node V8 heap limit is ${preflight.effectiveMiB} MiB, but this runtime profile requires at least ${preflight.minimumMiB} MiB. Replay with ${preflight.replayOption}. The profile caps the host heap at ${preflight.maximumMiB} MiB.`)
    this.name = "HostNodeHeapPreflightError"
  }
}

export function preflightHostNodeHeap(requirement: WorkspaceRecipeHostNodeHeap | undefined, effectiveBytes = v8.getHeapStatistics().heap_size_limit): HostNodeHeapPreflight | undefined {
  if (!requirement) return undefined
  assertHostNodeHeapRequirement(requirement)
  const effectiveMiB = Math.floor(effectiveBytes / MIB)
  return {
    status: effectiveMiB >= requirement.minimumMiB ? "ready" : "insufficient",
    effectiveMiB,
    minimumMiB: requirement.minimumMiB,
    maximumMiB: requirement.maximumMiB,
    replayOption: `--host-node-heap-mb=${requirement.minimumMiB}`,
  }
}

export function assertHostNodeHeapRequirement(requirement: WorkspaceRecipeHostNodeHeap): void {
  for (const [name, value] of Object.entries(requirement)) {
    if (!Number.isInteger(value) || value < 256 || value > 16_384) {
      throw new Error(`runtime.hostNodeHeap.${name} must be an integer from 256 to 16384 MiB`)
    }
  }
  if (requirement.minimumMiB > requirement.maximumMiB) {
    throw new Error("runtime.hostNodeHeap.minimumMiB must not exceed runtime.hostNodeHeap.maximumMiB")
  }
}

export async function replayWithHostNodeHeap(args: string[], requestedMiB: number | undefined, requirement: WorkspaceRecipeHostNodeHeap | undefined, effectiveBytes = v8.getHeapStatistics().heap_size_limit, spawnProcess = spawn): Promise<number | undefined> {
  const preflight = preflightHostNodeHeap(requirement, effectiveBytes)
  if (!preflight || preflight.status === "ready") return undefined
  if (requestedMiB === undefined) throw new HostNodeHeapPreflightError(preflight)
  if (!Number.isInteger(requestedMiB) || requestedMiB < preflight.minimumMiB || requestedMiB > preflight.maximumMiB) {
    throw new Error(`--host-node-heap-mb must be an integer from ${preflight.minimumMiB} to ${preflight.maximumMiB} MiB for this runtime profile`)
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawnProcess(process.execPath, hostNodeHeapReplayArgs(args, requestedMiB), { stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
}

export function hostNodeHeapReplayArgs(args: string[], heapMiB: number): string[] {
  const forwarded: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host-node-heap-mb") {
      index += 1
      continue
    }
    if (!args[index].startsWith("--host-node-heap-mb=")) forwarded.push(args[index])
  }
  return [`--max-old-space-size=${heapMiB}`, process.argv[1], ...forwarded]
}

export type RuntimeMemoryFailureKind = "host-v8-oom" | "php-wasm-oom"

export function classifyRuntimeMemoryFailure(error: unknown): RuntimeMemoryFailureKind | undefined {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  if (/FATAL ERROR:.*(?:heap out of memory|Ineffective mark-compacts)|JavaScript heap out of memory/i.test(message)) return "host-v8-oom"
  if (/(?:php\.wasm|WebAssembly\.Memory).*?(?:out of memory|memory access out of bounds)|(?:out of memory|cannot enlarge memory).*?(?:php\.wasm|wasm)/is.test(message)) return "php-wasm-oom"
  return undefined
}
