import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { normalizePreviewOptions, previewInputSchema, PreviewOptionError } from "../packages/cli/src/preview-options.js"

interface FixtureCase {
  name: string
  input: Record<string, unknown>
  valid: boolean
  normalized?: unknown
  code?: string
}

const fixturePath = resolve(import.meta.dirname, "..", "contracts", "preview-options.fixture.json")
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { options: unknown; cases: FixtureCase[] }

assert.deepEqual(previewInputSchema, fixture.options)

for (const testCase of fixture.cases) {
  try {
    const normalized = normalizePreviewOptions(testCase.input)
    assert.equal(testCase.valid, true, `${testCase.name}: expected invalid fixture`)
    assert.deepEqual(normalized, testCase.normalized, `${testCase.name}: normalized preview options`)
  } catch (error) {
    assert.equal(testCase.valid, false, `${testCase.name}: expected valid fixture, got ${String(error)}`)
    assert(error instanceof PreviewOptionError, `${testCase.name}: expected PreviewOptionError`)
    assert.equal(error.code, testCase.code, `${testCase.name}: error code`)
  }
}

console.log(`preview options contract smoke passed (${fixture.cases.length} cases)`)
