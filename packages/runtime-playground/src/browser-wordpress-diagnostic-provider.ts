import { browserWordPressDiagnosticsArtifact, installBrowserWordPressDiagnostics } from "./browser-probe-support.js"
import type { BrowserProbeDiagnosticProvider } from "./browser-probe-runner.js"

export function browserWordPressDiagnosticProvider(): BrowserProbeDiagnosticProvider {
  return {
    id: "wordpress",
    setup: ({ runPlaygroundCommand, server }) => installBrowserWordPressDiagnostics(runPlaygroundCommand, server),
    async collect({ artifactPath, network, server, setupResult }) {
      const artifact = await browserWordPressDiagnosticsArtifact({
        artifactPath,
        network,
        ready: setupResult === true,
        server,
      })
      if (!artifact) {
        return undefined
      }

      return {
        key: "wordpressDiagnostics",
        fileName: "wordpress-diagnostics.json",
        artifact,
        summary: artifact.summary,
      }
    },
  }
}
