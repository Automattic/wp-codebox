import { createHostToolTransportError, executeHostTool, getCommandDefinition, type HostToolRegistry, type JsonValue, type PlaygroundRuntimeCommandId } from "@automattic/wp-codebox-core"
import type { ExecutionSpec } from "@automattic/wp-codebox-core"

interface PlaygroundCommandRuntime {
  inspectMountedInputs(): Promise<string>
  runPhp(spec: ExecutionSpec): Promise<string>
  runWpCli(spec: ExecutionSpec): Promise<string>
  runRestRequest(spec: ExecutionSpec): Promise<string>
  runAbility(spec: ExecutionSpec): Promise<string>
  runBench(spec: ExecutionSpec): Promise<string>
  runPhpunit(spec: ExecutionSpec): Promise<string>
  runPluginCheck(spec: ExecutionSpec): Promise<string>
  runCorePhpunit(spec: ExecutionSpec): Promise<string>
  runThemeCheck(spec: ExecutionSpec): Promise<string>
  runBrowserProbe(spec: ExecutionSpec): Promise<string>
  runHtmlCapture(spec: ExecutionSpec): Promise<string>
  runEditorCanvasProbe(spec: ExecutionSpec): Promise<string>
  runBrowserActions(spec: ExecutionSpec): Promise<string>
  runBrowserScenario(spec: ExecutionSpec): Promise<string>
  runEditorOpen(spec: ExecutionSpec): Promise<string>
  runEditorActions(spec: ExecutionSpec): Promise<string>
}

const playgroundCommandHandlers = {
  "inspect-mounted-inputs": (runtime) => runtime.inspectMountedInputs(),
  "wordpress.run-php": (runtime, spec) => runtime.runPhp(spec),
  "wordpress.wp-cli": (runtime, spec) => runtime.runWpCli(spec),
  "wordpress.rest-request": (runtime, spec) => runtime.runRestRequest(spec),
  "wordpress.ability": (runtime, spec) => runtime.runAbility(spec),
  "wordpress.bench": (runtime, spec) => runtime.runBench(spec),
  "wordpress.phpunit": (runtime, spec) => runtime.runPhpunit(spec),
  "wordpress.plugin-check": (runtime, spec) => runtime.runPluginCheck(spec),
  "wordpress.core-phpunit": (runtime, spec) => runtime.runCorePhpunit(spec),
  "wordpress.theme-check": (runtime, spec) => runtime.runThemeCheck(spec),
  "wordpress.browser-probe": (runtime, spec) => runtime.runBrowserProbe(spec),
  "wordpress.capture-html": (runtime, spec) => runtime.runHtmlCapture(spec),
  "wordpress.editor-canvas-probe": (runtime, spec) => runtime.runEditorCanvasProbe(spec),
  "wordpress.browser-actions": (runtime, spec) => runtime.runBrowserActions(spec),
  "wordpress.browser-scenario": (runtime, spec) => runtime.runBrowserScenario(spec),
  "wordpress.editor-open": (runtime, spec) => runtime.runEditorOpen(spec),
  "wordpress.editor-actions": (runtime, spec) => runtime.runEditorActions(spec),
} satisfies Record<PlaygroundRuntimeCommandId, (runtime: PlaygroundCommandRuntime, spec: ExecutionSpec) => Promise<string>>

export function playgroundRuntimeCommandIds(): string[] {
  return Object.keys(playgroundCommandHandlers)
}

export async function executePlaygroundCommand(runtime: PlaygroundCommandRuntime, spec: ExecutionSpec, hostTools?: HostToolRegistry): Promise<string> {
  const hostTool = hostTools?.get(spec.command)
  if (hostTool) {
    const startedAt = new Date().toISOString()
    let input: JsonValue
    try {
      input = hostToolInput(spec.args ?? [])
    } catch (error) {
      return JSON.stringify(createHostToolTransportError(hostTool, spec.command, startedAt, "host-tool-invalid-input-json", error instanceof Error ? error.message : String(error)))
    }

    const result = await executeHostTool(hostTool, input, {
      tool: hostTool.name,
      policyCommand: spec.command,
      metadata: { cwd: spec.cwd ?? null, timeoutMs: spec.timeoutMs ?? null },
    })
    return JSON.stringify(result)
  }

  const definition = getCommandDefinition(spec.command)
  if (definition?.handler.kind === "playground") {
    const handler = playgroundCommandHandlers[definition.id as PlaygroundRuntimeCommandId]
    if (handler) {
      return handler(runtime, spec)
    }
  }

  throw new Error(`No Playground command handler is registered for: ${spec.command}`)
}

function hostToolInput(args: string[]): JsonValue {
  const explicit = argValue(args, "input-json")
  if (explicit !== undefined) {
    const parsed = JSON.parse(explicit) as JsonValue
    return parsed
  }

  const input: Record<string, string> = {}
  for (const arg of args) {
    const separator = arg.indexOf("=")
    if (separator > 0) {
      input[arg.slice(0, separator)] = arg.slice(separator + 1)
    }
  }
  return input
}

function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}
