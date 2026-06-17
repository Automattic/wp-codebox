import { executeHostCommand, normalizeRuntimeEnvRecord, type HostCommandExecutorInput, type HostToolDefinition, type JsonObject, type JsonValue } from "@automattic/wp-codebox-core"

export interface HostCommandToolConfig {
  name: string
  description: string
  command: string
  args?: string[]
  cwd: string
  allowedCwdRoots?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
  inheritedEnv?: string[]
  allowedInputEnv?: string[]
  env?: Record<string, string>
}

interface HostCommandInput extends HostCommandExecutorInput {
  args?: string[]
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export function createHostCommandTool(config: HostCommandToolConfig): HostToolDefinition {
  return {
    name: config.name,
    description: config.description,
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "integer" },
        env: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["command", "args", "cwd", "exitCode", "signal", "stdout", "stderr", "durationMs", "timedOut", "outputTruncated"],
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        exitCode: { type: "integer" },
        signal: { type: "string" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        durationMs: { type: "integer" },
        timedOut: { type: "boolean" },
        outputTruncated: { type: "boolean" },
      },
      additionalProperties: false,
    },
    policy: {
      capability: config.name,
      permissions: ["host-command"],
      risk: "external",
      description: "Runs one explicitly registered host command without shell expansion.",
    },
    handler: (input) => executeHostCommand(config, normalizeHostCommandInput(input)),
  }
}

function normalizeHostCommandInput(input: JsonValue): HostCommandInput {
  if (!isJsonObject(input)) {
    throw new Error("host command input must be an object")
  }
  return {
    args: input.args === undefined ? undefined : stringArray(input.args, "args"),
    cwd: input.cwd === undefined ? undefined : stringValue(input.cwd, "cwd"),
    timeoutMs: input.timeoutMs === undefined ? undefined : boundedPositiveInteger(input.timeoutMs, "timeoutMs"),
    env: input.env === undefined ? undefined : normalizeRuntimeEnvRecord(stringRecord(input.env, "env"), { field: "env" }),
  }
}

function boundedPositiveInteger(value: JsonValue | number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

function stringValue(value: JsonValue, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`)
  }
  return value
}

function stringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value
}

function stringRecord(value: JsonValue, field: string): Record<string, string> {
  if (!isJsonObject(value)) {
    throw new Error(`${field} must be an object`)
  }
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`${field}.${key} must be a string`)
    }
    record[key] = item
  }
  return record
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
