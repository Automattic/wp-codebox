import { createHostToolTransportError, createRuntimeCommandResultEnvelope, executeHostTool, parseCommandInput, type HostToolRegistry, type JsonValue, type RuntimeCommandResultEnvelope } from "@automattic/wp-codebox-core"
import { getCommandDefinition, runtimeCommandDefinitions } from "@automattic/wp-codebox-core/contracts"
import type { ExecutionSpec } from "@automattic/wp-codebox-core"

export type PlaygroundCommandOutput = string | RuntimeCommandResultEnvelope

interface PlaygroundCommandRuntime {
  inspectMountedInputs(): Promise<string>
  runCommandAgent(spec: ExecutionSpec): Promise<PlaygroundCommandOutput>
  runPhp(spec: ExecutionSpec): Promise<PlaygroundCommandOutput>
  runWpCli(spec: ExecutionSpec): Promise<string>
  runWordPressSession(spec: ExecutionSpec): Promise<string>
  runWordPressNonce(spec: ExecutionSpec): Promise<string>
  runWordPressActionAuth(spec: ExecutionSpec): Promise<string>
  runExportBrowserStorageState(spec: ExecutionSpec): Promise<string>
  runCaptureStateBundle(spec: ExecutionSpec): Promise<string>
  runExportReplayPackage(spec: ExecutionSpec): Promise<string>
  runHttpRequest(spec: ExecutionSpec): Promise<string>
  runServerPageLoad(spec: ExecutionSpec): Promise<string>
  runRestRequest(spec: ExecutionSpec): Promise<string>
  runRestPerformanceObservation(spec: ExecutionSpec): Promise<string>
  runCacheChurnObservation(spec: ExecutionSpec): Promise<string>
  runRuntimeDiscovery(spec: ExecutionSpec): Promise<string>
  runRestRouteInventory(spec: ExecutionSpec): Promise<string>
  runAdminPageInventory(spec: ExecutionSpec): Promise<string>
  runFuzzAdminPages(spec: ExecutionSpec): Promise<string>
  runAdminAction(spec: ExecutionSpec): Promise<string>
  runFuzzPluginModuleState(spec: ExecutionSpec): Promise<string>
  runInventoryPluginModuleOptionsTables(spec: ExecutionSpec): Promise<string>
  runDatabaseInventory(spec: ExecutionSpec): Promise<string>
  runFrontendUrlInventory(spec: ExecutionSpec): Promise<string>
  runAdminPageLoad(spec: ExecutionSpec): Promise<string>
  runFrontendPageLoad(spec: ExecutionSpec): Promise<string>
  runCrudOperation(spec: ExecutionSpec): Promise<string>
  runBlockRender(spec: ExecutionSpec): Promise<string>
  runBlockExercise(spec: ExecutionSpec): Promise<string>
  runDbOperation(spec: ExecutionSpec): Promise<string>
  runAbility(spec: ExecutionSpec): Promise<PlaygroundCommandOutput>
  runBench(spec: ExecutionSpec): Promise<string>
  runPhpunit(spec: ExecutionSpec): Promise<string>
  runPluginCheck(spec: ExecutionSpec): Promise<string>
  runPluginSetup(spec: ExecutionSpec): Promise<string>
  runPluginState(spec: ExecutionSpec): Promise<string>
  runCollectWorkloadResult(spec: ExecutionSpec): Promise<string>
  runCorePhpunit(spec: ExecutionSpec): Promise<string>
  runThemeSetup(spec: ExecutionSpec): Promise<string>
  runThemeCheck(spec: ExecutionSpec): Promise<string>
  runBrowserProbe(spec: ExecutionSpec): Promise<string>
  runBrowserPageLoad(spec: ExecutionSpec): Promise<string>
  runHtmlCapture(spec: ExecutionSpec): Promise<string>
  runEditorCanvasProbe(spec: ExecutionSpec): Promise<string>
  runBrowserActions(spec: ExecutionSpec): Promise<string>
  runBrowserScenario(spec: ExecutionSpec): Promise<string>
  runVisualCompare(spec: ExecutionSpec): Promise<string>
  runEditorOpen(spec: ExecutionSpec): Promise<string>
  runEditorActions(spec: ExecutionSpec): Promise<string>
  runEditorValidateBlocks(spec: ExecutionSpec): Promise<string>
}

export function playgroundRuntimeCommandIds(): string[] {
  return runtimeCommandDefinitions().map((definition) => definition.id)
}

export async function executePlaygroundCommand(runtime: PlaygroundCommandRuntime, spec: ExecutionSpec, hostTools?: HostToolRegistry): Promise<PlaygroundCommandOutput> {
  const hostTool = hostTools?.get(spec.command)
  if (hostTool) {
    const startedAt = new Date().toISOString()
    let input: JsonValue
    try {
      input = parseCommandInput(spec.args ?? [])
    } catch (error) {
      const result = createHostToolTransportError(hostTool, spec.command, startedAt, "host-tool-invalid-input-json", error instanceof Error ? error.message : String(error))
      return createRuntimeCommandResultEnvelope({ status: "error", stdout: `${JSON.stringify(result)}\n`, json: result, error: { code: result.error.code, message: result.error.message }, diagnostics: result.diagnostics })
    }

    const result = await executeHostTool(hostTool, input, {
      tool: hostTool.name,
      policyCommand: spec.command,
      metadata: { cwd: spec.cwd ?? null, timeoutMs: spec.timeoutMs ?? null },
    })
    return createRuntimeCommandResultEnvelope({ status: result.status, stdout: `${JSON.stringify(result)}\n`, json: result, ...(result.status === "error" ? { error: { code: result.error.code, message: result.error.message } } : {}), diagnostics: result.diagnostics })
  }

  const definition = getCommandDefinition(spec.command)
  if (definition?.handler.kind === "playground") {
    const method = definition.handler.method
    if (isPlaygroundCommandRuntimeMethod(runtime, method)) {
      return runtime[method](spec)
    }
    throw new Error(`Playground command handler method is unavailable for ${spec.command}: ${method}`)
  }

  throw new Error(`No Playground command handler is registered for: ${spec.command}`)
}

function isPlaygroundCommandRuntimeMethod(runtime: PlaygroundCommandRuntime, method: string): method is keyof PlaygroundCommandRuntime {
  return method in runtime && typeof runtime[method as keyof PlaygroundCommandRuntime] === "function"
}
