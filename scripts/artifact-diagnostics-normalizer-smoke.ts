import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { ARTIFACT_DIAGNOSTICS_SCHEMA, artifactDiagnosticsResultEnvelope, buildArtifactDiagnostics, isArtifactDiagnostics, normalizeArtifactDiagnostics } from "@automattic/wp-codebox-core/artifacts"

const execFileAsync = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-diagnostics-"))

try {
  const importReport = {
    diagnostics: [
      {
        id: "fallback-1",
        type: "fallback_block",
        severity: "notice",
        reason_code: "unsupported-layout",
        source_path: "pages/home.html",
        selector: ".hero",
        message: "Used fallback block for unsupported layout.",
        blockName: "core/html",
      },
      {
        type: "missing_asset",
        error_message: "Image file is missing.",
        source_path: "assets/hero.jpg",
      },
    ],
  }
  const importReportPath = join(directory, "import-report.json")
  await writeFile(importReportPath, `${JSON.stringify(importReport, null, 2)}\n`)

  const direct = buildArtifactDiagnostics(importReport, {
    source: "static-site-importer",
    stage: "import",
    observationType: "static-site-importer/import-report",
    refs: [{ path: "import-report.json", kind: "static-site-importer/import-report" }],
  })

  assert.equal(direct.schema, ARTIFACT_DIAGNOSTICS_SCHEMA)
  assert.equal(isArtifactDiagnostics(direct), true)
  assert.equal(direct.status, "reported")
  assert.deepEqual(direct.summary, { total: 2, error: 0, warning: 1, notice: 1, info: 0 })
  assert.equal(direct.diagnostics[0]?.id, "fallback-1")
  assert.equal(direct.diagnostics[0]?.code, "unsupported-layout")
  assert.equal(direct.diagnostics[0]?.source, "static-site-importer")
  assert.equal(direct.diagnostics[0]?.stage, "import")
  assert.equal(direct.diagnostics[0]?.path, "pages/home.html")
  assert.equal(direct.diagnostics[0]?.provenance?.observationType, "static-site-importer/import-report")
  assert.deepEqual(direct.diagnostics[0]?.refs, [{ path: "import-report.json", kind: "static-site-importer/import-report" }])
  assert.equal(direct.diagnostics[0]?.details?.blockName, "core/html")
  assert.equal(direct.diagnostics[1]?.message, "Image file is missing.")
  assert.equal(direct.diagnostics[1]?.severity, "warning")

  const renormalized = normalizeArtifactDiagnostics(direct)
  assert.deepEqual(renormalized.summary, direct.summary)
  assert.deepEqual(renormalized.diagnostics, direct.diagnostics)

  const resultEnvelope = artifactDiagnosticsResultEnvelope({
    operation: "static-site-import",
    diagnosticsInput: importReport,
    diagnosticOptions: {
      source: "static-site-importer",
      stage: "import",
      refs: [{ path: "import-report.json", kind: "static-site-importer/import-report" }],
    },
    artifactRefs: [{ kind: "static-site-importer/import-report", path: "import-report.json" }],
  })
  assert.equal(resultEnvelope.success, true)
  assert.equal(resultEnvelope.result?.artifactDiagnostics?.schema, ARTIFACT_DIAGNOSTICS_SCHEMA)
  assert.equal(resultEnvelope.diagnostics[0]?.code, "wp-codebox.artifact-diagnostics.reported")

  const observation = buildArtifactDiagnostics([
    {
      id: "plugin-check",
      type: "wordpress.plugin-check",
      observedAt: "2026-06-07T00:00:00.000Z",
      data: { findings: [{ code: "late-escaping", message: "Output is not escaped.", severity: "error" }] },
    },
  ])
  assert.equal(observation.summary.error, 1)
  assert.equal(observation.diagnostics[0]?.id, "plugin-check-diagnostic-1")
  assert.equal(observation.diagnostics[0]?.provenance?.observationId, "plugin-check")
  assert.equal(observation.diagnostics[0]?.provenance?.observationType, "wordpress.plugin-check")

  const emptyContainer = buildArtifactDiagnostics({ diagnostics: [] })
  assert.equal(emptyContainer.status, "clean")
  assert.deepEqual(emptyContainer.summary, { total: 0, error: 0, warning: 0, notice: 0, info: 0 })
  assert.deepEqual(emptyContainer.diagnostics, [])

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "packages/cli/dist/index.js",
      "artifacts",
      "diagnostics",
      "--input",
      importReportPath,
      "--source",
      "static-site-importer",
      "--stage",
      "import",
      "--observation-type",
      "static-site-importer/import-report",
      "--ref",
      "import-report.json:static-site-importer/import-report",
      "--json",
    ],
    { cwd: resolve(import.meta.dirname, "..") },
  )
  assert.deepEqual(JSON.parse(stdout), direct)

  console.log("artifact diagnostics normalizer smoke passed")
} finally {
  await rm(directory, { recursive: true, force: true })
}
