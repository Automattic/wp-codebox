import { RUNTIME_COMMAND_RESULT_SCHEMA, type RuntimeCommandResultEnvelope } from "./runtime-contracts.js"

export function createRuntimeCommandResultEnvelope(result: Omit<RuntimeCommandResultEnvelope, "schema">): RuntimeCommandResultEnvelope {
  return {
    schema: RUNTIME_COMMAND_RESULT_SCHEMA,
    ...result,
  }
}
