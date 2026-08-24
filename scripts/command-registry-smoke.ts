import { commandRegistry, runtimeCommandDefinitions } from "@automattic/wp-codebox-core/contracts"
import { playgroundRuntimeCommandIds } from "@automattic/wp-codebox-playground"
import { executePlaygroundCommand } from "../packages/runtime-playground/src/command-router.js"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

async function main(): Promise<void> {
  const registryIds = commandRegistry.map((command) => command.id)
  assert(new Set(registryIds).size === registryIds.length, "Command registry ids must be unique")

  for (const command of commandRegistry) {
    assert(command.id.length > 0, "Command id must be non-empty")
    assert(command.description.length > 0, `${command.id} is missing description`)
    assert(command.outputShape.length > 0, `${command.id} is missing outputShape`)
    if (command.outputSchema) {
      assert(command.outputSchema.id.length > 0, `${command.id} outputSchema is missing id`)
      assert(command.outputShape.includes(command.outputSchema.id), `${command.id} outputShape should mention outputSchema id`)
      if (command.outputSchema.jsonSchema) {
        assert(command.outputSchema.jsonSchema.$id === command.outputSchema.id, `${command.id} outputSchema JSON Schema $id must match id`)
      }
    }
    assert(command.policyRequirement.length > 0, `${command.id} is missing policyRequirement`)
    assert(Array.isArray(command.acceptedArgs), `${command.id} acceptedArgs must be an array`)
  }

  const collectWorkloadResult = commandRegistry.find((command) => command.id === "wordpress.collect-workload-result")
  assert(collectWorkloadResult, "wordpress.collect-workload-result must be registered")
  assert(collectWorkloadResult.outputShape === "wp-codebox/typed-workload-artifact/v1 JSON object containing one requested typed artifact payload and preserving its concrete schema id, for example wp-codebox/wordpress-rest-db-query-profile/v1; collection fails when the artifact is missing or ambiguous.", "wordpress.collect-workload-result outputShape must describe the bounded typed artifact contract")
  assert(collectWorkloadResult.outputSchema?.id === "wp-codebox/typed-workload-artifact/v1", "wordpress.collect-workload-result must declare the typed workload artifact output schema")
  assert(collectWorkloadResult.outputSchema.jsonSchema?.type === "object", "wordpress.collect-workload-result output must be a JSON object")
  const collectWorkloadResultSchemaProperty = (collectWorkloadResult.outputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>).schema
  assert(collectWorkloadResultSchemaProperty?.type === "string", "wordpress.collect-workload-result output must preserve the concrete artifact schema id")

  const metadataRuntimeIds = new Set(runtimeCommandDefinitions().map((command) => command.id))
  const handlerRuntimeIds = new Set(playgroundRuntimeCommandIds())
  const metadataWithoutHandler = sorted([...metadataRuntimeIds].filter((id) => !handlerRuntimeIds.has(id)))
  const handlerWithoutMetadata = sorted([...handlerRuntimeIds].filter((id) => !metadataRuntimeIds.has(id)))

  assert(metadataWithoutHandler.length === 0, `Command metadata has no Playground handler: ${metadataWithoutHandler.join(", ")}`)
  assert(handlerWithoutMetadata.length === 0, `Playground handler has no command metadata: ${handlerWithoutMetadata.join(", ")}`)

  for (const command of runtimeCommandDefinitions()) {
    assert(command.handler.kind === "playground", `${command.id} must bind to a Playground handler`)
    assert(command.handler.method.length > 0, `${command.id} must name its Playground handler method`)
  }

  for (const command of runtimeCommandDefinitions()) {
    const calls: string[] = []
    const runtime = new Proxy({}, {
      get(_target, property) {
        if (typeof property !== "string") {
          return undefined
        }
        return async () => {
          calls.push(property)
          return ""
        }
      },
      has(_target, property) {
        return typeof property === "string"
      },
    })

    await executePlaygroundCommand(runtime as Parameters<typeof executePlaygroundCommand>[0], { command: command.id, args: [] })
    assert(calls[0] === command.handler.method, `${command.id} must dispatch through registry handler method ${command.handler.method}`)
  }

  assert(commandRegistry.some((command) => command.outputSchema?.jsonSchema), "Command registry should expose structured output schemas where available")
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
