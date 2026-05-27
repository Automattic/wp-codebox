import assert from "node:assert/strict"
import { normalizeThemeCheckOutput } from "../packages/runtime-playground/src/commands.js"

const raw = JSON.stringify([
  { type: "REQUIRED", value: "Missing license." },
  { type: "WARNING", value: "Found deprecated function." },
  { type: "INFO", value: "This is informational." },
])

const normalized = normalizeThemeCheckOutput(raw, 1, "sample-theme")
assert.equal(normalized.schema, "wp-codebox/theme-check/v1")
assert.equal(normalized.command, "wordpress.theme-check")
assert.equal(normalized.targetTheme, "sample-theme")
assert.equal(normalized.status, "failed")
assert.equal(normalized.exitCode, 1)
assert.equal(normalized.summary.total, 3)
assert.equal(normalized.summary.required, 1)
assert.equal(normalized.summary.warnings, 1)
assert.equal(normalized.summary.info, 1)
assert.deepEqual(normalized.findings.map((finding) => finding.severity), ["required", "warning", "info"])

const malformed = normalizeThemeCheckOutput("not json", 1, "broken-theme")
assert.equal(malformed.status, "error")
assert.equal(malformed.raw.format, "text")
assert.equal(malformed.summary.unknown, 1)

console.log("theme check normalization smoke passed")
