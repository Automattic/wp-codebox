import assert from "node:assert/strict"

import {
  WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  type WordPressRuntimeDiscoveryResult,
} from "../packages/runtime-core/src/index.js"
import { getCommandDefinition, runtimeCommandDefinitions } from "../packages/runtime-core/src/command-registry.js"
import { runtimeDiscoverySurfacesFromArgs } from "../packages/runtime-playground/src/runtime-discovery-command-handlers.js"

const result: WordPressRuntimeDiscoveryResult = {
  schema: WORDPRESS_RUNTIME_DISCOVERY_SCHEMA,
  command: "wordpress.runtime-discovery",
  status: "ok",
  surfaces: ["rest", "admin", "database", "frontend", "blocks"],
  diagnostics: [],
}

assert.equal(result.schema, "wp-codebox/wordpress-runtime-discovery/v1")
assert.deepEqual(runtimeDiscoverySurfacesFromArgs([]), ["rest", "admin", "database", "frontend", "blocks"])
assert.deepEqual(runtimeDiscoverySurfacesFromArgs(["surface=rest,blocks,rest"]), ["rest", "blocks"])
assert.throws(() => runtimeDiscoverySurfacesFromArgs(["surface=woocommerce"]), /unsupported: woocommerce/)

const definition = getCommandDefinition("wordpress.runtime-discovery")
assert.equal(definition?.handler.kind, "playground")
assert.equal(definition?.handler.kind === "playground" ? definition.handler.method : undefined, "runRuntimeDiscovery")
assert.equal(definition?.outputSchema?.id, WORDPRESS_RUNTIME_DISCOVERY_SCHEMA)
assert.equal(runtimeCommandDefinitions().some((command) => command.id === "wordpress.runtime-discovery"), true)

console.log("wordpress runtime discovery contracts ok")
