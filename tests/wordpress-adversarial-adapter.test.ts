import assert from "node:assert/strict"

import { transportFaultModel, type AdversarialCasePlan } from "../packages/runtime-core/src/index.js"
import {
  WORDPRESS_ADVERSARIAL_CAPABILITIES,
  WORDPRESS_ADVERSARIAL_ORACLES,
  WORDPRESS_CLOCK_CONTROL_CAPABILITIES,
  createWordPressAdversarialAdapter,
  evaluateWordPressAdversarialOracles,
  negotiateWordPressHttpTransportFaults,
  wordpressAdversarialActionSpec,
  wordpressHttpFaultConfigurationAction,
  wordpressNoveltySignals,
  wordpressSchedulerClockAction,
} from "../packages/runtime-playground/src/wordpress-adversarial-adapter.js"

const adapter = createWordPressAdversarialAdapter()
assert.equal(adapter.schema, "wp-codebox/wordpress-adversarial-adapter/v1")
assert.equal(WORDPRESS_ADVERSARIAL_CAPABILITIES.find(({ surface }) => surface === "rest")?.fidelity, "exact")
assert.equal(WORDPRESS_ADVERSARIAL_CAPABILITIES.find(({ surface }) => surface === "ajax")?.fidelity, "unsupported")
assert.equal(WORDPRESS_CLOCK_CONTROL_CAPABILITIES.capabilities.find(({ surface }) => surface === "runtime")?.fidelity, "unsupported")
assert.equal(WORDPRESS_CLOCK_CONTROL_CAPABILITIES.capabilities.find(({ surface }) => surface === "scheduler")?.fidelity, "emulated")

const rest = wordpressAdversarialActionSpec({ surface: "rest", operation: "POST", target: "/fixture/v1/action", input: { value: "mutated" } })
assert.equal(rest.command, "wordpress.run-php")
assert.equal(rest.metadata?.fidelity, "exact")
assert.match(rest.args?.[0] ?? "", /WP_REST_Request/)
assert.throws(() => wordpressAdversarialActionSpec({ surface: "xmlrpc", operation: "POST" }), /unsupported/)

const cli = wordpressAdversarialActionSpec({ surface: "cli", operation: "run", input: "option get home" })
assert.deepEqual(cli.args, ["command=option get home"])
const scheduler = wordpressSchedulerClockAction(1900000000, "fixture_hook")
assert.equal(scheduler.operation, "adversarial:cron")
assert.equal(scheduler.metadata?.fidelity, "exact")

const emulated = negotiateWordPressHttpTransportFaults(transportFaultModel({
  seed: "faults",
  rules: [{ id: "timeout", match: { host: "fixture.invalid" }, sequence: [{ timeoutMs: 100 }] }],
}))
assert.equal(emulated.supported, true)
assert.equal(emulated.capabilities.capabilities.find(({ semantic }) => semantic === "timeout")?.fidelity, "emulated")
const configuredFaults = transportFaultModel({ seed: "configured", rules: [{ id: "response", match: { host: "fixture.invalid" }, sequence: [{ status: 503, body: "down" }] }] })
assert.match(wordpressHttpFaultConfigurationAction(configuredFaults).args?.[0] ?? "", /WPMU_PLUGIN_DIR/)

const unsupported = negotiateWordPressHttpTransportFaults(transportFaultModel({
  seed: "faults",
  rules: [{ id: "half-close", match: { host: "fixture.invalid" }, sequence: [{ connection: "half-close" }] }],
}))
assert.equal(unsupported.supported, false)
assert.deepEqual(unsupported.unsupported.map(({ semantic }) => semantic), ["half-close"])

const plan = { caseId: "case", corpusId: "seed", iteration: 0, workerId: 0, matrix: {}, mutation: { kind: "scalar", path: "$", description: "test" }, id: "case", actions: [] } as AdversarialCasePlan
const oracleResults = evaluateWordPressAdversarialOracles(plan, {
  status: "passed",
  metadata: { wordpressAdversarial: { violations: ["nonce-bypass", "partial-state-commit", "token-leak"] } },
}, WORDPRESS_ADVERSARIAL_ORACLES)
assert.deepEqual(oracleResults.filter(({ failed }) => failed).map(({ oracleId }) => oracleId), ["wordpress-authorization", "wordpress-transactional-consistency", "wordpress-secret-leakage"])

const novelty = wordpressNoveltySignals({
  hooks: ["init", "rest_api_init", "secret-value-is-hashed"],
  routes: ["/fixture/v1/action"],
  queries: ["SELECT * FROM wp_posts WHERE ID = 1"],
  filesystem: ["uploads/fixture.txt"],
  cache: ["fixture:key"],
  locks: ["fixture-lock"],
  metrics: { memoryBytes: 4097, cpuMs: 4.2, durationMs: 17 },
})
assert(novelty.some((signal) => signal === "memoryBytes:4096"))
assert(novelty.every((signal) => !signal.includes("secret-value")))
assert(novelty.length <= 128)

console.log("wordpress adversarial adapter ok")
