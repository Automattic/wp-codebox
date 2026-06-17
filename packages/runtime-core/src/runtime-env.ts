export const RUNTIME_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export interface RuntimeEnvRedactionRegistrar {
  registerSecretName(name: string): void
  registerSecretValue(value: string): void
}

export interface NormalizeRuntimeEnvRecordOptions {
  field?: string
  invalid?: "throw" | "omit"
}

export interface ResolveSecretEnvNamesOptions {
  source?: Record<string, string | undefined>
  field?: string
}

export function isValidRuntimeEnvName(name: string): boolean {
  return RUNTIME_ENV_NAME_PATTERN.test(name)
}

export function assertRuntimeEnvName(name: string, field = "env name"): void {
  if (!isValidRuntimeEnvName(name)) {
    throw new Error(`${field} must match ${RUNTIME_ENV_NAME_PATTERN.source}: ${name}`)
  }
}

export function normalizeRuntimeEnvRecord(values: Record<string, unknown>, options: NormalizeRuntimeEnvRecordOptions = {}): Record<string, string> {
  const runtimeEnv: Record<string, string> = {}
  const invalid = options.invalid ?? "throw"
  const field = options.field ?? "env"

  for (const [name, value] of Object.entries(values)) {
    const normalized = name.trim()
    const valid = isValidRuntimeEnvName(normalized) && typeof value === "string"
    if (!valid) {
      if (invalid === "throw") {
        throw new Error(`${field}.${name} must be a string value with a valid environment variable name`)
      }
      continue
    }

    runtimeEnv[normalized] = value
  }

  return runtimeEnv
}

export function resolveSecretEnvNames(names: readonly string[], options: ResolveSecretEnvNamesOptions = {}): Record<string, string> {
  const source = options.source ?? process.env
  const field = options.field ?? "secretEnv"
  const secretEnv: Record<string, string> = {}

  for (const name of names) {
    const normalized = name.trim()
    assertRuntimeEnvName(normalized, field)
    const value = source[normalized]
    if (value !== undefined) {
      secretEnv[normalized] = value
    }
  }

  return secretEnv
}

export function registerRuntimeSecretRedactions(secretEnv: Record<string, string>, registrar: RuntimeEnvRedactionRegistrar): void {
  for (const [name, value] of Object.entries(secretEnv)) {
    registrar.registerSecretName(name)
    if (shouldRedactRuntimeSecretValue(value)) {
      registrar.registerSecretValue(value)
    }
  }
}

export function shouldRedactRuntimeSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 8) {
    return false
  }

  if (["true", "false", "null", "undefined"].includes(trimmed.toLowerCase())) {
    return false
  }

  if (/^[0-9]+$/.test(trimmed)) {
    return false
  }

  return true
}
