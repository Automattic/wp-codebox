export const HOST_TOOL_RESULT_SCHEMA = "wp-codebox/host-tool-result/v1" as const

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface HostToolJsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
  required?: string[]
  properties?: Record<string, HostToolJsonSchema>
  additionalProperties?: boolean
  items?: HostToolJsonSchema
}

export interface HostToolPolicyMetadata {
  capability?: string
  permissions?: string[]
  risk?: "read" | "write" | "external" | (string & {})
  description?: string
}

export interface HostToolCallContext {
  tool: string
  policyCommand: string
  metadata?: Record<string, unknown>
}

export type HostToolHandler = (input: JsonValue, context: HostToolCallContext) => Promise<JsonValue> | JsonValue

export interface HostToolDefinition {
  name: string
  description: string
  inputSchema: HostToolJsonSchema
  outputSchema: HostToolJsonSchema
  policy: HostToolPolicyMetadata
  handler: HostToolHandler
}

export interface HostToolResultOk {
  schema: typeof HOST_TOOL_RESULT_SCHEMA
  tool: string
  status: "ok"
  output: JsonValue
  startedAt: string
  finishedAt: string
}

export interface HostToolResultError {
  schema: typeof HOST_TOOL_RESULT_SCHEMA
  tool: string
  status: "error"
  error: {
    code: string
    message: string
    details?: JsonValue
  }
  startedAt: string
  finishedAt: string
}

export type HostToolResult = HostToolResultOk | HostToolResultError

export interface HostToolCatalogEntry {
  name: string
  description: string
  inputSchema: HostToolJsonSchema
  outputSchema: HostToolJsonSchema
  policy: HostToolPolicyMetadata
}

export class HostToolRegistry {
  private readonly tools = new Map<string, HostToolDefinition>()

  constructor(definitions: HostToolDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition)
    }
  }

  register(definition: HostToolDefinition): void {
    assertValidHostToolDefinition(definition)
    if (this.tools.has(definition.name)) {
      throw new Error(`Host tool is already registered: ${definition.name}`)
    }
    this.tools.set(definition.name, definition)
  }

  get(name: string): HostToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): HostToolCatalogEntry[] {
    return [...this.tools.values()].map(({ name, description, inputSchema, outputSchema, policy }) => ({
      name,
      description,
      inputSchema,
      outputSchema,
      policy,
    }))
  }
}

export function createHostToolRegistry(definitions: HostToolDefinition[] = []): HostToolRegistry {
  return new HostToolRegistry(definitions)
}

export async function executeHostTool(definition: HostToolDefinition, input: JsonValue, context: HostToolCallContext): Promise<HostToolResult> {
  const startedAt = new Date().toISOString()
  const inputIssue = validateJsonValueAgainstSchema(input, definition.inputSchema, "input")
  if (inputIssue) {
    return hostToolError(definition.name, startedAt, "host-tool-invalid-input", inputIssue)
  }

  try {
    const output = await definition.handler(input, context)
    const outputIssue = validateJsonValueAgainstSchema(output, definition.outputSchema, "output")
    if (outputIssue) {
      return hostToolError(definition.name, startedAt, "host-tool-invalid-output", outputIssue)
    }

    return {
      schema: HOST_TOOL_RESULT_SCHEMA,
      tool: definition.name,
      status: "ok",
      output,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
  } catch (error) {
    return hostToolError(definition.name, startedAt, "host-tool-handler-error", error instanceof Error ? error.message : String(error))
  }
}

function hostToolError(tool: string, startedAt: string, code: string, message: string, details?: JsonValue): HostToolResultError {
  return {
    schema: HOST_TOOL_RESULT_SCHEMA,
    tool,
    status: "error",
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

function assertValidHostToolDefinition(definition: HostToolDefinition): void {
  if (!definition.name || !/^[a-z0-9][a-z0-9._-]*$/i.test(definition.name)) {
    throw new Error("Host tool name must be a stable non-empty tool id")
  }
  if (!definition.description) {
    throw new Error(`Host tool ${definition.name} is missing a description`)
  }
  if (typeof definition.handler !== "function") {
    throw new Error(`Host tool ${definition.name} is missing a handler`)
  }
}

function validateJsonValueAgainstSchema(value: JsonValue, schema: HostToolJsonSchema, path: string): string | undefined {
  if (schema.type && !jsonValueMatchesType(value, schema.type)) {
    return `${path} must be ${schema.type}`
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    if (!isJsonObject(value)) {
      return `${path} must be object`
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        return `${path}.${key} is required`
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        const issue = validateJsonValueAgainstSchema(value[key], childSchema, `${path}.${key}`)
        if (issue) {
          return issue
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      const extra = Object.keys(value).find((key) => !allowed.has(key))
      if (extra) {
        return `${path}.${extra} is not allowed`
      }
    }
  }

  if ((schema.type === "array" || schema.items) && Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const issue = validateJsonValueAgainstSchema(value[index], schema.items, `${path}[${index}]`)
      if (issue) {
        return issue
      }
    }
  }

  return undefined
}

function jsonValueMatchesType(value: JsonValue, type: NonNullable<HostToolJsonSchema["type"]>): boolean {
  if (type === "null") {
    return value === null
  }
  if (type === "array") {
    return Array.isArray(value)
  }
  if (type === "object") {
    return isJsonObject(value)
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value)
  }
  return typeof value === type
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
