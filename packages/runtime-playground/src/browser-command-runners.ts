import { type ExecutionSpec, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import type { BrowserArtifact } from "./browser-artifacts.js"
import { browserWordPressDiagnosticProvider } from "./browser-wordpress-diagnostic-provider.js"
import { BrowserCommandArtifactError, isBrowserCommandArtifactError } from "./browser-command-artifact-error.js"
import { runBrowserProbeCommand, runSingleBrowserProbeCommand, type BrowserProbeRunPlan } from "./browser-probe-runner.js"
import type { PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"

export { BrowserCommandArtifactError, isBrowserCommandArtifactError }
export { runBrowserActionsCommand, runBrowserScenarioCommand, type BrowserActionsRunPlan } from "./browser-actions-runner.js"
export { runEditorActionsCommand, runEditorCanvasProbeCommand, runEditorOpenCommand } from "./editor-command-runners.js"
export { runBrowserProbeCommand, runSingleBrowserProbeCommand, type BrowserProbeRunPlan } from "./browser-probe-runner.js"
export { browserWordPressDiagnosticProvider } from "./browser-wordpress-diagnostic-provider.js"
export { wordpressAdminAuthCookiePhpCode } from "./browser-probe-support.js"
export { runVisualCompareCommand } from "./browser-visual-compare.js"

export async function runHtmlCaptureCommand(input: {
  artifactRoot: string
  runtimeSpec: RuntimeCreateSpec
  runPlaygroundCommand?: (command: string, server: PlaygroundCliServer, options: { code: string } | { scriptPath: string }) => Promise<PlaygroundRunResponse>
  server: PlaygroundCliServer
  spec: ExecutionSpec
}): Promise<{ artifact: BrowserArtifact; output: string }> {
  const args = [...(input.spec.args ?? [])]
  if (!args.some((arg) => arg.startsWith("capture="))) {
    args.push("capture=html,console,errors,network")
  }

  return runBrowserProbeCommand({
    ...input,
    command: "wordpress.capture-html",
    diagnosticProviders: [browserWordPressDiagnosticProvider()],
    spec: { ...input.spec, args },
  })
}
