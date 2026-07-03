import assert from "node:assert/strict"

import { runtimeSnapshotExportPhp } from "../packages/runtime-playground/src/runtime-snapshot.js"

const php = runtimeSnapshotExportPhp()

assert.match(php, /@ini_set\( 'memory_limit', '512M' \);/)

console.log("runtime snapshot export memory limit ok")
