import assert from "node:assert/strict"

import {
  crudFixtureSeedOperation,
  fuzzFixturePlanContract,
  mutationFixtureSeedOperation,
  readFixtureSeedOperation,
  restMutationGeneratedFixturesContract,
  restMutationFixtureOptInContract,
  restRouteInventoryToFuzzSuite,
} from "../packages/runtime-core/src/public.js"

const plan = fuzzFixturePlanContract({
  id: "generic-fixture-plan",
  operations: [
    readFixtureSeedOperation({ id: "read-existing", resource: { kind: "entity", id: "stable-id" }, target: "/entities/stable-id" }),
    crudFixtureSeedOperation({ id: "crud-seed", resource: { kind: "entity" }, method: "create", input: { fields: ["title"] } }),
    mutationFixtureSeedOperation({ id: "mutation-update", resource: { kind: "entity" }, method: "PATCH", target: "/entities/stable-id", input: { fields: ["status"] } }),
  ],
})

assert.equal(plan.schema, "wp-codebox/fuzz-fixture-plan/v1")
assert.deepEqual(plan.operationKinds, ["read", "crud", "mutation"])
assert.equal(plan.operations[0]?.resource?.kind, "entity")
assert.equal(JSON.stringify(plan).includes("product"), false)
assert.equal(JSON.stringify(plan).includes("post_type"), false)

const optIn = restMutationFixtureOptInContract({
  id: "generic-rest-mutation-opt-in",
  route: "/example/v1/entities/(?P<id>[\\d]+)",
  methods: ["post", "PATCH", "DELETE", "PATCH"],
  fixturePlan: plan,
})

assert.equal(optIn.schema, "wp-codebox/rest-mutation-fixture-opt-in/v1")
assert.deepEqual(optIn.methods, ["POST", "PATCH", "DELETE"])
assert.equal(optIn.fixturePlan?.id, "generic-fixture-plan")

const routeInventory = {
  schema: "wp-codebox/wordpress-rest-route-discovery/v1",
  namespaces: ["example/v1"],
  routes: [{
    route: "/example/v1/entities/1",
    namespace: "example/v1",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    argNames: [],
    endpoints: [{ methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], permission: { mode: "callback" }, args: [] }],
  }],
  status: "ok",
} as const
const mutationOptIns = (["POST", "PUT", "PATCH", "DELETE"] as const).map((method) => restMutationFixtureOptInContract({
  id: `${method.toLowerCase()}-entity-opt-in`,
  route: "/example/v1/entities/1",
  methods: [method],
  auth: { user: "fixture-user" },
  rollbackPolicy: { mode: "checkpoint-per-case", checkpointName: `${method.toLowerCase()}-entity` },
  fixturePlan: fuzzFixturePlanContract({
    id: `${method.toLowerCase()}-entity-plan`,
    operations: [mutationFixtureSeedOperation({ id: `${method.toLowerCase()}-entity`, method, target: "/example/v1/entities/1", input: { body: { name: "fixture" } } })],
  }),
}))
const suite = restRouteInventoryToFuzzSuite(routeInventory, { restMutationOptIns: mutationOptIns })
for (const method of ["POST", "PUT", "PATCH"] as const) {
  const fuzzCase = suite.cases.find((candidate) => candidate.id === `rest-${method.toLowerCase()}-example-v1-entities-1-0`)
  assert.equal(fuzzCase?.target?.kind, "runtime-action")
  assert.equal((fuzzCase?.input as Record<string, unknown> | undefined)?.type, "rest_request")
  assert.equal((fuzzCase?.input as Record<string, unknown> | undefined)?.method, method)
  assert.equal((fuzzCase?.metadata?.restMutationFixtureOptIn as Record<string, unknown> | undefined)?.schema, "wp-codebox/rest-mutation-fixture-opt-in/v1")
  assert.equal((fuzzCase?.metadata?.requiredRunnerCapabilities as { capabilities?: string[] } | undefined)?.capabilities?.includes(`rest-mutation:${method.toLowerCase()}:mutation-isolation-artifact`), true)
}
const deleteCase = suite.cases.find((candidate) => candidate.id === "rest-delete-example-v1-entities-1-0")
assert.equal(deleteCase?.target?.kind, "runtime-action")
assert.equal((deleteCase?.metadata?.requiredRunnerCapabilities as { capabilities?: string[] } | undefined)?.capabilities?.includes("delete-boundary-artifact"), true)
assert.equal((deleteCase?.metadata?.requiredRunnerCapabilities as { capabilities?: string[] } | undefined)?.capabilities?.includes("rest-mutation:delete:delete-boundary-artifact"), true)

const generatedFixtures = restMutationGeneratedFixturesContract({
  id: "generated-entity-fixtures",
  route: {
    route: "/example/v1/entities/(?P<id>[\\d]+)",
    namespace: "example/v1",
    methods: ["GET", "POST", "PATCH", "DELETE"],
    argNames: ["id", "name", "status", "featured"],
    endpoints: [{
      methods: ["POST", "PATCH", "DELETE"],
      permission: { mode: "callback" },
      args: [
        { name: "id", required: true, type: "integer" },
        { name: "name", required: true, type: "string" },
        { name: "status", required: true, type: "string", enum: ["draft", "published"] },
        { name: "featured", required: true, type: "boolean" },
      ],
    }],
  },
  collectionSamples: [{ id: 44, name: "Existing entity" }],
  auth: { user: "fixture-user" },
  resetPolicy: { mode: "checkpoint-per-case", checkpointName: "generated-rest-fixtures" },
})

assert.equal(generatedFixtures.schema, "wp-codebox/rest-mutation-generated-fixtures/v1")
assert.equal(generatedFixtures.fixturePlan.operations.length, 3)
assert.deepEqual(generatedFixtures.fixturePlan.operationKinds, ["mutation"])
assert.equal(generatedFixtures.artifacts[0]?.bounded, true)
assert.equal(generatedFixtures.metadata?.semanticValidity, "not-claimed")
assert.equal(generatedFixtures.unsupported.length, 0)
for (const operation of generatedFixtures.fixturePlan.operations) {
  assert.equal(operation.target, "/example/v1/entities/44")
  assert.equal(operation.metadata?.bounded, true)
  assert.equal(operation.metadata?.confidence, "high")
  assert.deepEqual(operation.metadata?.sources, ["collection-sample", "typed-generator", "route-schema"])
  assert.equal((operation.input as { bodyJson?: Record<string, unknown> }).bodyJson?.status, "draft")
  assert.equal((operation.input as { bodyJson?: Record<string, unknown> }).bodyJson?.featured, true)
}
assert.equal(generatedFixtures.optIns.length, 3)
assert.equal(generatedFixtures.optIns[0]?.fixturePlan?.id, "generated-entity-fixtures-fixture-plan")

const generatedFixtureSuite = restRouteInventoryToFuzzSuite({ ...routeInventory, routes: [{
  route: "/example/v1/entities/(?P<id>[\\d]+)",
  namespace: "example/v1",
  methods: ["GET", "POST", "PATCH", "DELETE"],
  argNames: ["id", "name", "status", "featured"],
  endpoints: [{
    methods: ["POST", "PATCH", "DELETE"],
    permission: { mode: "callback" },
    args: [
      { name: "id", required: true, type: "integer" },
      { name: "name", required: true, type: "string" },
      { name: "status", required: true, type: "string", enum: ["draft", "published"] },
      { name: "featured", required: true, type: "boolean" },
    ],
  }],
}] }, { restMutationOptIns: generatedFixtures.optIns })
const generatedPatchCase = generatedFixtureSuite.cases.find((candidate) => candidate.id === "rest-patch-example-v1-entities-p-id-d-0")
assert.equal(generatedPatchCase?.target.kind, "runtime-action")
assert.equal((generatedPatchCase?.input as Record<string, unknown> | undefined)?.path, "/example/v1/entities/44")
assert.equal((generatedPatchCase?.input as Record<string, unknown> | undefined)?.restMutationFixture, "generated-entity-fixtures-fixture-plan")
assert.equal((generatedPatchCase?.metadata?.restMutationFixtureOptIn as Record<string, unknown> | undefined)?.schema, "wp-codebox/rest-mutation-fixture-opt-in/v1")

const unsupportedGeneratedFixtures = restMutationGeneratedFixturesContract({
  id: "unsupported-generated-fixtures",
  route: {
    route: "/example/v1/entities/(?P<compound>.+)",
    namespace: "example/v1",
    methods: ["PATCH"],
    argNames: ["compound"],
    endpoints: [{ methods: ["PATCH"], permission: { mode: "callback" }, args: [{ name: "compound", required: true, type: "object" }] }],
  },
})
assert.equal(unsupportedGeneratedFixtures.metadata?.confidence, "unsupported")
assert.equal(unsupportedGeneratedFixtures.fixturePlan.operations.length, 0)
assert.deepEqual(unsupportedGeneratedFixtures.unsupported[0]?.reasons, ["path_token_compound_unbound"])

console.log("fuzz fixture plan contracts ok")
