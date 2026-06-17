import assert from "node:assert/strict"
import { containsSecretLikeValue, isRedactedValue, isSensitiveKey, redactJsonValue, redactString, redactUrl } from "../packages/runtime-core/src/redaction.js"

const sensitiveKeyCases: Array<[string, boolean]> = [
  ["token", true],
  ["api_key", true],
  ["private-key", true],
  ["authorization", true],
  ["displayName", false],
]

for (const [key, expected] of sensitiveKeyCases) {
  assert.equal(isSensitiveKey(key), expected, `isSensitiveKey(${key})`)
}

const redactedValueCases: Array<[string, boolean]> = [
  ["[redacted]", true],
  ["redacted", true],
  ["***", true],
  ["visible", false],
]

for (const [value, expected] of redactedValueCases) {
  assert.equal(isRedactedValue(value), expected, `isRedactedValue(${value})`)
}

assert.equal(containsSecretLikeValue("token sk-abcdefghijklmnopqrstuvwxyz"), true)
assert.equal(containsSecretLikeValue("token [redacted]"), false)
assert.equal(redactString("token sk-abcdefghijklmnopqrstuvwxyz"), "token [redacted]")

assert.deepEqual(
  redactJsonValue({ token: "abc", nested: { api_key: "def", visible: "ok" }, list: [{ password: "secret" }] }, { redactStrings: false }),
  { token: "[redacted]", nested: { api_key: "[redacted]", visible: "ok" }, list: [{ password: "[redacted]" }] },
)

assert.equal(
  redactString("visit https://example.com/path?b=2&a=1#frag token: abc", { redactAllUrlQueryValues: true, redactUrlHash: true }),
  "visit https://example.com/path?a=[redacted]&b=[redacted]#[redacted] token: [redacted]",
)

assert.equal(
  redactString("/wp-admin/?nonce=abc&plain=ok", { redactQueryAssignments: true }),
  "/wp-admin/?nonce=[redacted]&plain=[redacted]",
)

assert.equal(
  redactUrl("https://example.com/path?plain=ok&token=abc#frag"),
  "https://example.com/path?plain=ok&token=[redacted]#frag",
)
