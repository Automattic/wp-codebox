import { executeHostCommand, type HostCommandExecutorInput, type HostCommandExecutorResult } from "./host-command-executor.js"
import type { JsonObject } from "./host-tool-registry.js"
import { redactString } from "./redaction.js"

export interface ManagedHostCommandConfig {
  command: string
  args?: string[]
  cwd: string
  allowedCwdRoots?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
  inheritedEnv?: string[]
  allowedInputEnv?: string[]
  env?: Record<string, string>
  label?: string
  rejectOnNonZero?: boolean
  redact?: ManagedHostCommandRedactor[]
}

export interface ManagedHostCommandInput extends HostCommandExecutorInput {
  label?: string
}

export type ManagedHostCommandDiagnostic = JsonObject & {
  label: string
  command: string
  args: string[]
  cwd: string
  exitCode: number
  signal: string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  outputTruncated: boolean
}

export type ManagedHostCommandResult = HostCommandExecutorResult & {
  diagnostic: ManagedHostCommandDiagnostic
}

export type ManagedHostCommandRedactor = (value: string, field: keyof Pick<ManagedHostCommandDiagnostic, "command" | "args" | "cwd" | "stdout" | "stderr">) => string

export class ManagedHostCommandError extends Error {
  readonly diagnostic: ManagedHostCommandDiagnostic

  constructor(diagnostic: ManagedHostCommandDiagnostic) {
    super(managedHostCommandErrorMessage(diagnostic))
    this.name = "ManagedHostCommandError"
    this.diagnostic = diagnostic
  }
}

export async function executeManagedHostCommand(config: ManagedHostCommandConfig, input: ManagedHostCommandInput = {}): Promise<ManagedHostCommandResult> {
  const started = Date.now()
  const label = input.label ?? config.label ?? config.command
  const redactors = config.redact ?? []
  let result: HostCommandExecutorResult
  try {
    result = await executeHostCommand(config, input)
  } catch (error) {
    throw new ManagedHostCommandError(managedHostCommandFailureDiagnostic(config, input, label, error, Date.now() - started, redactors))
  }
  const diagnostic = managedHostCommandDiagnostic(result, label, redactors)
  const managedResult: ManagedHostCommandResult = {
    ...result,
    diagnostic,
  }

  if (config.rejectOnNonZero !== false && (result.exitCode !== 0 || result.timedOut)) {
    throw new ManagedHostCommandError(diagnostic)
  }

  return managedResult
}

function managedHostCommandFailureDiagnostic(config: ManagedHostCommandConfig, input: ManagedHostCommandInput, label: string, error: unknown, durationMs: number, redactors: ManagedHostCommandRedactor[]): ManagedHostCommandDiagnostic {
  const message = error instanceof Error ? error.message : String(error)
  return {
    label,
    command: redactManagedHostCommandValue(config.command, "command", redactors),
    args: [...(config.args ?? []), ...(input.args ?? [])].map((arg) => redactManagedHostCommandValue(arg, "args", redactors)),
    cwd: redactManagedHostCommandValue(input.cwd ?? config.cwd, "cwd", redactors),
    exitCode: -1,
    signal: "",
    stdout: "",
    stderr: redactManagedHostCommandValue(message, "stderr", redactors),
    durationMs,
    timedOut: false,
    outputTruncated: false,
  }
}

export function managedHostCommandDiagnostic(result: HostCommandExecutorResult, label: string, redactors: ManagedHostCommandRedactor[] = []): ManagedHostCommandDiagnostic {
  return {
    label,
    command: redactManagedHostCommandValue(result.command, "command", redactors),
    args: result.args.map((arg) => redactManagedHostCommandValue(arg, "args", redactors)),
    cwd: redactManagedHostCommandValue(result.cwd, "cwd", redactors),
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: redactManagedHostCommandValue(result.stdout, "stdout", redactors),
    stderr: redactManagedHostCommandValue(result.stderr, "stderr", redactors),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated,
  }
}

function managedHostCommandErrorMessage(diagnostic: ManagedHostCommandDiagnostic): string {
  const reason = diagnostic.timedOut ? `timed out after ${diagnostic.durationMs}ms` : `exited with code ${diagnostic.exitCode}${diagnostic.signal ? ` (${diagnostic.signal})` : ""}`
  const detail = diagnostic.stderr.trim() || diagnostic.stdout.trim()
  return `${diagnostic.label} ${reason}${detail ? `: ${detail}` : ""}`
}

function redactManagedHostCommandValue(value: string, field: keyof Pick<ManagedHostCommandDiagnostic, "command" | "args" | "cwd" | "stdout" | "stderr">, redactors: ManagedHostCommandRedactor[]): string {
  return redactors.reduce((current, redactor) => redactor(current, field), redactString(value, { redactAllUrlQueryValues: true, redactUrlHash: true, redactQueryAssignments: true }))
}
