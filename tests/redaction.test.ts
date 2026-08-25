import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { containsSecretLikeValue, isRedactedValue, isSensitiveKey, redactError, redactJsonValue, redactString, redactUrl, type RedactionPolicyProfileName } from "../packages/runtime-core/src/redaction.js"

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

const proseCases: Array<[string, string]> = [
  ["Local wp-admin auth fixture user could not be loaded.", "Local wp-admin auth fixture user could not be loaded."],
  ["The token validation fixture passed.", "The token validation fixture passed."],
  ["Apply the cookie policy to this session state.", "Apply the cookie policy to this session state."],
  ["    at <anonymous> (/workspace/auth-fixture.ts:7:21)", "    at <anonymous> (/workspace/auth-fixture.ts:7:21)"],
]

for (const [input, expected] of proseCases) {
  assert.equal(redactString(input), expected, `ordinary prose should survive: ${input}`)
}

const secretContextCases: Array<[string, string]> = [
  ["Local wp-admin auth: fixture-password user could not be loaded.", "Local wp-admin auth: [redacted] user could not be loaded."],
  ["The token=fixture-token validation failed.", "The token=[redacted] validation failed."],
  ["Authorization: Bearer fixture-auth-token", "Authorization: [redacted]"],
  ["Bearer fixture-auth-token", "Bearer [redacted]"],
  ["Cookie: wordpress_logged_in=fixture-cookie", "Cookie: [redacted]"],
  ['{"username":"fixture","password":"fixture-password"}', '{"username":"fixture","password":"[redacted]"}'],
]

for (const [input, expected] of secretContextCases) {
  assert.equal(redactString(input), expected, `secret context should redact: ${input}`)
}

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

const headerSentinels = ["SENTINEL_COOKIE_2094", "SENTINEL_AUTH_2094", "SENTINEL_NONCE_2094", "SENTINEL_TOKEN_2094"]
const headerLog = `route.fetch: read ECONNRESET\n  cookie: wordpress_logged_in=${headerSentinels[0]}; preference=visible\nAuthorization: Bearer ${headerSentinels[1]}\nx-wp-nonce: ${headerSentinels[2]}\nx-session-token: ${headerSentinels[3]}\naccept: text/html`
const redactedHeaderLog = redactString(headerLog)
assert.match(redactedHeaderLog, /cookie: \[redacted\]/i)
assert.match(redactedHeaderLog, /authorization: \[redacted\]/i)
assert.match(redactedHeaderLog, /x-wp-nonce: \[redacted\]/i)
assert.match(redactedHeaderLog, /x-session-token: \[redacted\]/i)
assert.match(redactedHeaderLog, /accept: text\/html/i)
for (const sentinel of headerSentinels) assert.doesNotMatch(redactedHeaderLog, new RegExp(sentinel))

const redactedError = redactError(Object.assign(new Error(headerLog), { stack: `Error: ${headerLog}` }))
for (const sentinel of headerSentinels) assert.doesNotMatch(`${redactedError.message}\n${redactedError.stack}`, new RegExp(sentinel))

const fixture = JSON.parse(await readFile(new URL("./fixtures/redaction-policy-profiles.json", import.meta.url), "utf8")) as {
  profiles: Record<RedactionPolicyProfileName, { redact: string[]; preserve: string[] }>
}

for (const [profile, cases] of Object.entries(fixture.profiles) as Array<[RedactionPolicyProfileName, { redact: string[]; preserve: string[] }]>) {
  for (const key of cases.redact) {
    assert.equal(isSensitiveKey(key, { profile }), true, `${profile} should redact ${key}`)
  }

  for (const key of cases.preserve) {
    assert.equal(isSensitiveKey(key, { profile }), false, `${profile} should preserve ${key}`)
  }
}
