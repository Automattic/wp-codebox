import { basename, dirname, join } from "node:path"
import { captureArtifactFile, type MountSpec } from "@automattic/wp-codebox-core"
import type { PlaygroundCliServer } from "./preview-server.js"
import { extractPhpunitFailureMessage } from "./playground-command-errors.js"
import { PHPUNIT_COMPLETED_RESULT_PREFIX, parsePhpunitCompletedResult, type PhpunitCompletedResult } from "./phpunit-test-results.js"

export async function persistPluginPhpunitResult(server: PlaygroundCliServer, vfsPath: string, artifactRoot: string, namespace?: string): Promise<void> {
  await persistPhpunitResult(server, vfsPath, join(artifactRoot, "files", "phpunit", ...(namespace ? [namespace] : []), ".pg-test-result.txt"))
}

export async function persistPluginPhpunitCompletedResult(artifactRoot: string, result: PhpunitCompletedResult, namespace?: string): Promise<void> {
  const hostPath = join(artifactRoot, "files", "phpunit", ...(namespace ? [namespace] : []), ".wp-codebox-result.txt")
  const { passed: _passed, failed: _failed, ...aggregate } = result
  await captureArtifactFile({
    root: dirname(hostPath),
    path: basename(hostPath),
    kind: "test-results",
    contentType: "text/plain; charset=utf-8",
    contents: `${PHPUNIT_COMPLETED_RESULT_PREFIX}${JSON.stringify(aggregate)}\n`,
    redact: (_path, contents) => contents,
    redaction: { policy: "applied", sensitive: false },
    provenance: { source: "wordpress-playground", operation: "persist-phpunit-completed-result" },
  })
}

export async function persistCorePhpunitResult(server: PlaygroundCliServer, vfsPath: string, artifactRoot: string): Promise<void> {
  await persistPhpunitResult(server, vfsPath, join(artifactRoot, "files", "core-phpunit", ".pg-test-result.txt"))
}

export async function persistPhpunitResult(server: PlaygroundCliServer, vfsPath: string, hostPath: string): Promise<void> {
  if (!server.playground.readFileAsText) {
    return
  }

  try {
    const contents = await server.playground.readFileAsText(vfsPath)
    await captureArtifactFile({
      root: dirname(hostPath),
      path: basename(hostPath),
      kind: "test-results",
      contentType: "text/plain; charset=utf-8",
      contents,
      redaction: { policy: "applied", sensitive: true, reason: "PHPUnit failure diagnostics are redacted before artifact capture." },
      provenance: { source: "wordpress-playground", operation: "persist-phpunit-result", id: vfsPath },
    })
  } catch {
    // The structured result is best-effort; preserve the command outcome if copying fails.
  }
}

export async function readPluginPhpunitDiagnostic(server: PlaygroundCliServer, vfsPath: string): Promise<string | undefined> {
  return readPhpunitDiagnostic(server, vfsPath)
}

export async function readPluginPhpunitCompletedResult(server: PlaygroundCliServer, vfsPath: string): Promise<PhpunitCompletedResult | undefined> {
  const contents = await readPhpunitResult(server, vfsPath)
  return contents ? parsePhpunitCompletedResult(contents) : undefined
}

export async function readCorePhpunitDiagnostic(server: PlaygroundCliServer, vfsPath: string): Promise<string | undefined> {
  return readPhpunitDiagnostic(server, vfsPath)
}

async function readPhpunitDiagnostic(server: PlaygroundCliServer, vfsPath: string): Promise<string | undefined> {
  const contents = await readPhpunitResult(server, vfsPath)
  return contents ? extractPhpunitFailureMessage(contents) : undefined
}

async function readPhpunitResult(server: PlaygroundCliServer, vfsPath: string): Promise<string | undefined> {
  if (!server.playground.readFileAsText) {
    return undefined
  }

  let contents: string
  try {
    contents = await server.playground.readFileAsText(vfsPath)
  } catch {
    return undefined
  }

  return contents
}

export async function persistVfsDiagnosticFile(server: PlaygroundCliServer, vfsPath: string, mounts: MountSpec[]): Promise<void> {
  await persistVfsDiagnosticFileToHost(server, vfsPath, vfsPath, mounts)
}

export async function persistVfsDiagnosticFileToHost(server: PlaygroundCliServer, sourceVfsPath: string, hostVfsPath: string, mounts: MountSpec[]): Promise<void> {
  if (!server.playground.readFileAsText) {
    return
  }

  const hostPath = hostPathForVfsPath(hostVfsPath, mounts)
  if (!hostPath) {
    return
  }

  try {
    const contents = await server.playground.readFileAsText(sourceVfsPath)
    await captureArtifactFile({
      root: dirname(hostPath),
      path: basename(hostPath),
      kind: "diagnostics",
      contentType: "text/plain; charset=utf-8",
      contents,
      redaction: { policy: "applied", sensitive: true, reason: "Failure diagnostics are redacted before host capture." },
      provenance: { source: "wordpress-playground", operation: "persist-vfs-diagnostic", id: sourceVfsPath, metadata: { hostVfsPath } },
    })
  } catch {
    // The structured result is best-effort; preserve the command failure if copying fails.
  }
}

function hostPathForVfsPath(vfsPath: string, mounts: MountSpec[]): string | undefined {
  for (const mount of mounts) {
    if (mount.mode !== "readwrite") {
      continue
    }

    const target = mount.target.replace(/\/+$/, "")
    if (vfsPath !== target && !vfsPath.startsWith(`${target}/`)) {
      continue
    }

    const relativePath = vfsPath === target ? "" : vfsPath.slice(target.length + 1)
    if (relativePath.split("/").includes("..")) {
      continue
    }

    return join(mount.source, relativePath)
  }

  return undefined
}
