import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactJsonLines, redactArtifactFiles, writeRedactedArtifactFile } from "../packages/runtime-playground/src/artifact-bundle-writer.js"
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

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-artifact-redaction-"))
try {
  const artifactRoot = directory
  const commandPath = join(artifactRoot, "commands.jsonl")
  const logPath = join(artifactRoot, "logs/runtime.log")
  const fileRedactor = new ArtifactRedactor({ WP_CODEBOX_SECRET: "super-secret-value" })

  await writeRedactedArtifactFile(artifactRoot, commandPath, artifactJsonLines([{ token: "super-secret-value" }]), fileRedactor)
  assert.deepEqual(JSON.parse(await readFile(commandPath, "utf8")), { token: "[REDACTED:configured-secret-value]" })

  await mkdir(join(artifactRoot, "logs"), { recursive: true })
  await writeFile(logPath, "secret=super-secret-value\n")
  await redactArtifactFiles(artifactRoot, ["logs/runtime.log", "missing.log"], fileRedactor)
  assert.equal(await readFile(logPath, "utf8"), "secret=[REDACTED:configured-secret-value]\n")
  assert.deepEqual(fileRedactor.summary().artifacts.map((artifact) => artifact.path).sort(), ["commands.jsonl", "logs/runtime.log"])
} finally {
  await rm(directory, { recursive: true, force: true })
}
