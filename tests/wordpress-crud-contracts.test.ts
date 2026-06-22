import assert from "node:assert/strict"
import {
  WORDPRESS_CRUD_OPERATION_SCHEMA,
  WORDPRESS_CRUD_RESULT_SCHEMA,
  createUnsupportedWordPressCrudResult,
  normalizeWordPressCrudOperation,
} from "../packages/runtime-core/src/index.js"
import { getCommandDefinition } from "../packages/runtime-core/src/contracts.js"

const operation = normalizeWordPressCrudOperation({
  schema: WORDPRESS_CRUD_OPERATION_SCHEMA,
  operation: "update",
  resource: {
    kind: "post",
    type: "page",
    id: "42",
    identifiers: { stable: true, source: "fuzz", index: 3, optional: null },
  },
  data: { title: "Fuzz target" },
  query: { context: "edit" },
  options: { dryRun: true },
})

assert.deepEqual(operation, {
  schema: WORDPRESS_CRUD_OPERATION_SCHEMA,
  operation: "update",
  resource: {
    kind: "post",
    type: "page",
    id: "42",
    identifiers: { stable: true, source: "fuzz", index: 3, optional: null },
  },
  data: { title: "Fuzz target" },
  query: { context: "edit" },
  options: { dryRun: true },
})

assert.deepEqual(createUnsupportedWordPressCrudResult(operation), {
  schema: WORDPRESS_CRUD_RESULT_SCHEMA,
  command: "wordpress.crud-operation",
  status: "unsupported",
  operation,
  diagnostics: [{ code: "crud-operation-unsupported", message: "wordpress.crud-operation is not implemented by this runtime backend.", severity: "warning" }],
  effects: [],
  artifactRefs: [],
})

const definition = getCommandDefinition("wordpress.crud-operation")
assert.equal(definition?.outputSchema?.id, WORDPRESS_CRUD_RESULT_SCHEMA)
assert.equal(definition?.handler.kind, "playground")

assert.throws(() => normalizeWordPressCrudOperation({ operation: "publish", resource: { kind: "post" } }), /operation must be create, read, update, delete, or list/)
assert.throws(() => normalizeWordPressCrudOperation({ operation: "read", resource: { kind: "post", identifiers: { nested: {} } } }), /identifiers\.nested must be a scalar value/)

console.log("wordpress CRUD contract normalization passed")
