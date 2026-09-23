import assert from "node:assert/strict"
import test from "node:test"

import type { Page } from "playwright"

import { browserStepRecord, executeBrowserInteractionStep, runBrowserEvaluateSource } from "../packages/runtime-playground/src/browser-interactions.js"

test("a bare expression evaluates to its value", async () => {
  assert.equal(await runBrowserEvaluateSource("1 + 1"), 2)
})

test("an async IIFE with nested return statements and an await resolves to its value", async () => {
  const source = [
    "(async () => {",
    "  const value = await new Promise((resolve) => setTimeout(() => resolve('nested-return'), 10));",
    "  const pick = (flag) => { if (flag) { return value } return 'unused' };",
    "  return pick(true);",
    "})()",
  ].join("\n")
  assert.equal(await runBrowserEvaluateSource(source), "nested-return")
})

test("a multi-statement body with a top-level return returns its value", async () => {
  const source = "const total = 20 + 3;\nreturn total * 2;"
  assert.equal(await runBrowserEvaluateSource(source), 46)
})

test("a body with no return evaluates to undefined", async () => {
  const source = "const quiet = 'side-effect';\nquiet + 1;"
  assert.equal(await runBrowserEvaluateSource(source), undefined)
})

test("an expression that throws propagates the error", async () => {
  await assert.rejects(runBrowserEvaluateSource("Promise.reject(new Error('evaluate boom'))"), /evaluate boom/)
})

test("the runner stays self-contained when serialized for page.evaluate", async () => {
  const deserialized = new Function(`return (${runBrowserEvaluateSource.toString()})`)() as typeof runBrowserEvaluateSource
  assert.equal(await deserialized("1 + 1"), 2)
  assert.equal(await deserialized("const x = 'body'; return x;"), "body")
})

test("a failed evaluate assertion records the actual value next to expected", async () => {
  const page = { evaluate: (fn: (source: string) => unknown, source: string) => fn(source) } as unknown as Page
  const outcome = await executeBrowserInteractionStep(page, { kind: "evaluate", expression: "1 + 1", assert: 3 }, "https://example.com", 1_000, async () => ({ path: "unused", isDefault: false }))
  assert.equal(outcome.assertion?.passed, false)
  assert.deepEqual(outcome.assertion?.expected, 3)
  assert.deepEqual(outcome.assertion?.actual, 2)
  const record = browserStepRecord(0, { kind: "evaluate", expression: "1 + 1", assert: 3 }, "failed", new Date().toISOString(), Date.now(), "https://example.com/", outcome)
  assert.deepEqual(record.assertion?.actual, 2)
})
