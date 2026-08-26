import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { startPlaygroundCliServer } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-custom-drop-in-"))
const content = join(root, "wp-content")
const artifacts = join(root, "artifacts")
await mkdir(content)
await writeFile(join(content, "db.php"), "<?php echo 'WP_CODEBOX_CUSTOM_DROP_IN_SENTINEL'; exit;\n")

const spec: RuntimeCreateSpec = {
  backend: "wordpress-playground",
  environment: {
    version: "7.1",
    phpVersion: "8.3",
    databaseSetup: "custom-drop-in",
    blueprint: {},
  },
  policy: {
    network: "deny",
    filesystem: "readwrite-mounts",
    commands: ["wordpress.run-php"],
    secrets: "none",
    approvals: "never",
  },
  artifactsDirectory: artifacts,
}

try {
  const server = await startPlaygroundCliServer(spec, [
    { type: "directory", source: content, target: "/wordpress/wp-content", mode: "readwrite", phase: "pre-install" },
  ])
  try {
    const mounted = await server.playground.run({ code: "<?php echo json_encode( array( 'dropin' => is_file( '/wordpress/wp-content/db.php' ), 'config' => is_file( '/wordpress/wp-config.php' ) ) );" })
    assert.deepEqual(JSON.parse(mounted.text), { dropin: true, config: true }, "the custom drop-in and WordPress configuration remain available to workload PHP instances")
    const bootstrap = await server.playground.run({ code: "<?php require '/wordpress/wp-load.php';" })
    assert.equal(bootstrap.text, "WP_CODEBOX_CUSTOM_DROP_IN_SENTINEL", "the custom db.php executes when the workload boots WordPress")
  } finally {
    await server[Symbol.asyncDispose]()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("custom database drop-in integration ok")
