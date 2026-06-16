import assert from "node:assert/strict"
import { ArtifactRedactor } from "../packages/runtime-playground/src/artifacts.js"

const redactor = new ArtifactRedactor({
  AI_PROVIDER_OPENAI_CODEX_ACCESS_TOKEN: "codex-access-token-1234567890",
  AI_PROVIDER_OPENAI_CODEX_REFRESH_TOKEN: "codex-refresh-token-1234567890",
  AI_PROVIDER_OPENAI_CODEX_EXPIRES_AT: "1780000000",
  AI_PROVIDER_OPENAI_CODEX_FEDRAMP: "false",
})

const redacted = redactor.redact("commands.jsonl", JSON.stringify({
  ok: true,
  activate: false,
  expires: 1780000000,
  token: "codex-access-token-1234567890",
}) + "\n")

assert.doesNotThrow(() => JSON.parse(redacted))
const parsed = JSON.parse(redacted) as Record<string, unknown>
assert.equal(parsed.ok, true)
assert.equal(parsed.activate, false)
assert.equal(parsed.expires, 1780000000)
assert.equal(parsed.token, "[REDACTED:configured-secret-value]")

const summary = redactor.summary()
assert.equal(summary.status, "redacted")
assert.equal(summary.byKind["configured-secret-value"], 1)

const largeRedactor = new ArtifactRedactor({
  HUGE_SECRET: "x".repeat(120000),
})

const largeArtifact = [
  "a".repeat(250000),
  `sk-${"A".repeat(5000)}`,
  "x".repeat(120000),
  `eyJ${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`,
].join(" ")
const largeRedacted = largeRedactor.redact("large-artifact.json", largeArtifact)

assert.match(largeRedacted, /\[REDACTED:openai-api-key\]/)
assert.match(largeRedacted, /\[REDACTED:configured-secret-value\]/)
assert.match(largeRedacted, /\[REDACTED:jwt\]/)
assert.equal(largeRedactor.summary().total, 3)
