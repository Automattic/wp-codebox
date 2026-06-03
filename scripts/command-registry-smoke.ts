import { commandRegistry, runtimeCommandDefinitions } from "@automattic/wp-codebox-core"
import { playgroundRuntimeCommandIds } from "@automattic/wp-codebox-playground"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function main(): void {
  const registryIds = commandRegistry.map((command) => command.id)
  assert(new Set(registryIds).size === registryIds.length, "Command registry ids must be unique")

  for (const command of commandRegistry) {
    assert(command.id.length > 0, "Command id must be non-empty")
    assert(command.description.length > 0, `${command.id} is missing description`)
    assert(command.outputShape.length > 0, `${command.id} is missing outputShape`)
    assert(command.policyRequirement.length > 0, `${command.id} is missing policyRequirement`)
    assert(Array.isArray(command.acceptedArgs), `${command.id} acceptedArgs must be an array`)
  }

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
}

main()
