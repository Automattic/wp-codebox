import assert from "node:assert/strict"
import { normalizeWordPressDbOperation } from "../packages/runtime-core/src/wordpress-db-contracts.js"
import { wordpressDbOperationPhpCode } from "../packages/runtime-playground/src/wordpress-crud-command-handlers.js"

const inspectOperation = normalizeWordPressDbOperation({
  schema: "wp-codebox/wordpress-db-operation/v1",
  operation: "inspect",
  resource: { table: "posts" },
})

assert.equal(inspectOperation.operation, "inspect")
assert.equal(inspectOperation.resource?.table, "posts")

assert.throws(() => normalizeWordPressDbOperation({
  schema: "wp-codebox/wordpress-db-operation/v1",
  operation: "drop",
}), /must be schema, read, inspect, query-summary, or write/)

const php = wordpressDbOperationPhpCode(inspectOperation)

assert.match(php, /\$verb === 'inspect'/)
assert.match(php, /wp_codebox_db_discovered_tables/)
assert.match(php, /wp_codebox_db_resolve_table/)
assert.match(php, /SELECT COUNT\(\*\) FROM/)
assert.match(php, /SHOW INDEX FROM/)
assert.match(php, /unsafe-table/)
assert.match(php, /db-destructive-permission-required/)

console.log("wordpress db contracts ok")
