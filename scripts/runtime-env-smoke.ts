import assert from "node:assert/strict"
import {
  assertRuntimeEnvName,
  isValidRuntimeEnvName,
  normalizeRuntimeEnvRecord,
  registerRuntimeSecretRedactions,
  resolveSecretEnvNames,
  shouldRedactRuntimeSecretValue,
} from "../packages/runtime-core/src/runtime-env.js"

assert.equal(isValidRuntimeEnvName("WP_CODEBOX_SECRET"), true)
assert.equal(isValidRuntimeEnvName("wp_codebox_secret"), false)
assert.equal(isValidRuntimeEnvName("1_SECRET"), false)
assert.throws(() => assertRuntimeEnvName("bad-name", "test.env"), /test\.env must match/)

assert.deepEqual(normalizeRuntimeEnvRecord({ " EMPTY ": "", FALSE_VALUE: "false", ZERO_VALUE: "0" }), {
  EMPTY: "",
  FALSE_VALUE: "false",
  ZERO_VALUE: "0",
})
assert.throws(() => normalizeRuntimeEnvRecord({ valid: "no" }), /env\.valid/)
assert.deepEqual(normalizeRuntimeEnvRecord({ valid: "no", VALID: "yes", NON_STRING: false }, { invalid: "omit" }), { VALID: "yes" })

assert.deepEqual(resolveSecretEnvNames([" EMPTY_SECRET ", "FALSE_SECRET", "ZERO_SECRET", "MISSING_SECRET"], {
  source: {
    EMPTY_SECRET: "",
    FALSE_SECRET: "false",
    ZERO_SECRET: "0",
  },
}), {
  EMPTY_SECRET: "",
  FALSE_SECRET: "false",
  ZERO_SECRET: "0",
})
assert.throws(() => resolveSecretEnvNames(["bad-secret"], { source: {} }), /secretEnv must match/)

assert.equal(shouldRedactRuntimeSecretValue("codex-access-token-1234567890"), true)
assert.equal(shouldRedactRuntimeSecretValue("false"), false)
assert.equal(shouldRedactRuntimeSecretValue("12345678"), false)
assert.equal(shouldRedactRuntimeSecretValue("short"), false)

const registeredNames: string[] = []
const registeredValues: string[] = []
registerRuntimeSecretRedactions({ SECRET_NAME: "codex-access-token-1234567890", FALSE_FLAG: "false", EMPTY_VALUE: "" }, {
  registerSecretName: (name) => registeredNames.push(name),
  registerSecretValue: (value) => registeredValues.push(value),
})
assert.deepEqual(registeredNames, ["SECRET_NAME", "FALSE_FLAG", "EMPTY_VALUE"])
assert.deepEqual(registeredValues, ["codex-access-token-1234567890"])
