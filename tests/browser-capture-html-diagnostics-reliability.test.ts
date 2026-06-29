import assert from "node:assert/strict"

import { runBoundedBrowserDiagnostic } from "../packages/runtime-playground/src/browser-probe-runner.js"

// Regression coverage for the wordpress.capture-html navigation/diagnostics hang.
//
// capture-html attaches the WordPress diagnostic provider, whose setup shells out to a
// playground command (wordpress.browser-diagnostics-setup) BEFORE navigation, and whose
// collect runs in the finally block. Both were previously awaited with no liveness bound,
// so a provider wedged under runtime contention rode the recipe-level timeout (observed as
// capture-html hanging for the full 25-minute recipe budget while the sibling browser-probe
// navigation path failed fast at its 120s wall bound). runBoundedBrowserDiagnostic bounds
// these calls so a stuck provider fails fast with a clear, non-empty error surfaced as a
// non-fatal probe error.

async function main(): Promise<void> {
  // 1. A provider operation that never settles must fail fast within the wall budget,
  //    surface a clear non-empty liveness error through onError, and never ride a longer timeout.
  {
    const onErrors: Error[] = []
    // A long-running operation that outlives the wall budget models a wedged playground command.
    // The backing timer is ref'd so the event loop stays alive long enough for the bounded wall
    // timeout to fire, then it is cleared after the assertions so the test process exits cleanly.
    let hungTimer: NodeJS.Timeout | undefined
    const hungOperation = new Promise<boolean>((resolve) => {
      hungTimer = setTimeout(() => resolve(true), 30_000)
    })
    const startedAt = Date.now()
    const result = await runBoundedBrowserDiagnostic({
      command: "wordpress.capture-html",
      phase: "diagnostics-setup:wordpress",
      operation: hungOperation,
      timeoutMs: 50,
      onError: (error) => onErrors.push(error),
    })
    const elapsedMs = Date.now() - startedAt
    if (hungTimer) {
      clearTimeout(hungTimer)
    }

    assert.equal(result.ok, false, "a hung diagnostic operation must report failure, not success")
    assert.equal(onErrors.length, 1, "the bounded failure must be surfaced exactly once via onError")
    assert.ok(onErrors[0] instanceof Error, "onError must receive an Error instance")
    assert.ok(onErrors[0].message.length > 0, "the surfaced error must be non-empty")
    assert.match(onErrors[0].message, /exceeded 50ms/, "the surfaced error must describe the wall timeout")
    assert.match(onErrors[0].message, /diagnostics-setup:wordpress/, "the surfaced error must name the failing phase")
    assert.ok(elapsedMs < 5_000, `a hung diagnostic must fail fast, not ride a long timeout (took ${elapsedMs}ms)`)
  }

  // 2. A legitimately resolved value — including a falsy result like setup returning false —
  //    must be preserved as ok:true without invoking onError.
  {
    const onErrors: Error[] = []
    const falseResult = await runBoundedBrowserDiagnostic({
      command: "wordpress.capture-html",
      phase: "diagnostics-setup:wordpress",
      operation: Promise.resolve(false),
      timeoutMs: 5_000,
      onError: (error) => onErrors.push(error),
    })
    assert.equal(falseResult.ok, true, "a resolved diagnostic must report success even when the value is falsy")
    assert.equal(falseResult.ok === true && falseResult.value, false, "the resolved falsy value must be preserved")
    assert.equal(onErrors.length, 0, "a successful diagnostic must not surface an error")

    const valueResult = await runBoundedBrowserDiagnostic({
      command: "wordpress.capture-html",
      phase: "diagnostics-collect:wordpress",
      operation: Promise.resolve({ key: "wordpressDiagnostics" }),
      timeoutMs: 5_000,
      onError: (error) => onErrors.push(error),
    })
    assert.equal(valueResult.ok, true)
    assert.deepEqual(valueResult.ok === true ? valueResult.value : undefined, { key: "wordpressDiagnostics" })
    assert.equal(onErrors.length, 0)
  }

  // 3. A provider that rejects must surface the real underlying error (not an empty or generic
  //    message) and report failure, keeping diagnostics best-effort.
  {
    const onErrors: Error[] = []
    const result = await runBoundedBrowserDiagnostic({
      command: "wordpress.capture-html",
      phase: "diagnostics-collect:wordpress",
      operation: Promise.reject(new Error("playground command failed: boom")),
      timeoutMs: 5_000,
      onError: (error) => onErrors.push(error),
    })
    assert.equal(result.ok, false)
    assert.equal(onErrors.length, 1)
    assert.match(onErrors[0].message, /playground command failed: boom/, "the real rejection reason must be surfaced")
  }

  console.log("browser-capture-html-diagnostics-reliability: ok")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
