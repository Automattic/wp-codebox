/**
 * A php.wasm trap only ever reports a bare interpreter message such as
 * "unreachable" (#2518) — the PHP call that triggered it is discarded by
 * default. Diagnosing the real fault required downloading a CI evidence
 * artifact and reading a WebAssembly stack by hand to find the `zif_*` frame
 * naming the trapping PHP internal function. That frame is already present
 * on `reason.stack`; this pins that `PhpWasmRuntimeRejectionError` extracts
 * it into both the human-readable message and structured `runtime` metadata.
 */
import assert from "node:assert/strict"
import { PhpWasmRuntimeRejectionError } from "../packages/runtime-playground/src/playground-command-errors.js"

function wasmFailure(message: string, stack?: string): WebAssembly.RuntimeError {
  const failure = new WebAssembly.RuntimeError(message)
  if (stack !== undefined) {
    failure.stack = stack
  }
  return failure
}

// Case 1: the real stack from #2518 — a `zend_parse_method_parameters` frame
// sits above the trapping call, then `zif_mysqli_rollback` names it.
{
  const cause = wasmFailure(
    "unreachable",
    [
      "Unhandled rejection: RuntimeError: unreachable",
      "    at php.wasm.zend_parse_method_parameters (wasm://wasm/php.wasm-05996276:wasm-function[314]:0x2905d)",
      "    at php.wasm.zif_mysqli_rollback (wasm://wasm/php.wasm-05996276:wasm-function[13621]:0x9d900a)",
      "    at php.wasm.ZEND_DO_FCALL_SPEC_RETVAL_UNUSED_HANDLER (wasm://wasm/php.wasm-05996276:wasm-function[22510]:0xddf366)",
      "    at php.wasm.execute_ex (wasm://wasm/php.wasm-05996276:wasm-function[18869]:0xc05944)",
    ].join("\n"),
  )
  const error = new PhpWasmRuntimeRejectionError(cause)

  assert.equal(
    error.message,
    "PHP WASM runtime rejected while a command was active: unreachable (trapped in mysqli_rollback())",
  )
  assert.equal(error.runtime.trappedFunction, "mysqli_rollback")
  // The raw diagnostic message stays unmodified; the trap annotation is additive.
  assert.equal(error.runtime.message, "unreachable")
}

// Case 2: multiple zif_* frames on the stack — the innermost (first, reading
// top-down) is the one that trapped, not an outer caller.
{
  const cause = wasmFailure(
    "unreachable",
    [
      "RuntimeError: unreachable",
      "    at php.wasm.zif_mysqli_rollback (wasm://wasm/php.wasm-05996276:wasm-function[13621]:0x9d900a)",
      "    at php.wasm.zif_call_user_func (wasm://wasm/php.wasm-05996276:wasm-function[9001]:0x1122334)",
      "    at php.wasm.zif_array_map (wasm://wasm/php.wasm-05996276:wasm-function[9002]:0x2233445)",
    ].join("\n"),
  )
  const error = new PhpWasmRuntimeRejectionError(cause)

  assert.equal(error.runtime.trappedFunction, "mysqli_rollback")
  assert.match(error.message, /\(trapped in mysqli_rollback\(\)\)$/)
}

// Case 3: php.wasm frames are present (so this is still recognized as a
// php.wasm rejection upstream) but none of them is a zif_* frame — fall back
// to today's plain message, unchanged.
{
  const cause = wasmFailure(
    "unreachable",
    [
      "RuntimeError: unreachable",
      "    at php.wasm.execute_ex (wasm://wasm/php.wasm-05996276:wasm-function[18869]:0xc05944)",
      "    at php.wasm.zend_execute (wasm://wasm/php.wasm-05996276:wasm-function[5524]:0x40eab2)",
    ].join("\n"),
  )
  const error = new PhpWasmRuntimeRejectionError(cause)

  assert.equal(error.message, "PHP WASM runtime rejected while a command was active: unreachable")
  assert.equal(error.runtime.trappedFunction, undefined)
  assert.ok(!("trappedFunction" in error.runtime))
}

// Case 4a: no stack at all.
{
  const cause = wasmFailure("unreachable")
  delete (cause as { stack?: string }).stack
  const error = new PhpWasmRuntimeRejectionError(cause)

  assert.equal(error.message, "PHP WASM runtime rejected while a command was active: unreachable")
  assert.equal(error.runtime.trappedFunction, undefined)
}

// Case 4b: stack explicitly undefined.
{
  const cause = wasmFailure("unreachable")
  Object.defineProperty(cause, "stack", { value: undefined, configurable: true })
  const error = new PhpWasmRuntimeRejectionError(cause)

  assert.equal(error.message, "PHP WASM runtime rejected while a command was active: unreachable")
  assert.equal(error.runtime.trappedFunction, undefined)
}

// Case 4c: stack is a non-string value (hostile/unexpected shape).
{
  const cause = wasmFailure("unreachable")
  Object.defineProperty(cause, "stack", { value: { not: "a string" }, configurable: true })
  const error = new PhpWasmRuntimeRejectionError(cause)

  assert.equal(error.message, "PHP WASM runtime rejected while a command was active: unreachable")
  assert.equal(error.runtime.trappedFunction, undefined)
}

// Case 4d: cause is not even an Error instance — construction must still be total.
{
  const error = new PhpWasmRuntimeRejectionError("unreachable")

  assert.equal(error.message, "PHP WASM runtime rejected while a command was active: unreachable")
  assert.equal(error.runtime.trappedFunction, undefined)
  assert.equal(error.runtime.errorName, "Error")
}

// Case 4e: a stack whose access throws must not propagate out of construction.
{
  const cause = wasmFailure("unreachable")
  Object.defineProperty(cause, "stack", {
    configurable: true,
    get: () => {
      throw new Error("hostile stack accessor must not run to completion")
    },
  })

  assert.doesNotThrow(() => new PhpWasmRuntimeRejectionError(cause))
  const error = new PhpWasmRuntimeRejectionError(cause)
  assert.equal(error.runtime.trappedFunction, undefined)
}

console.log("php.wasm trapped function extraction ok")
