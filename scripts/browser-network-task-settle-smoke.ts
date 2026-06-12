import assert from "node:assert/strict"
import { settleBrowserNetworkTasks } from "../packages/runtime-playground/src/browser-capture-session.js"

const startedAt = Date.now()
await settleBrowserNetworkTasks([new Promise<void>(() => undefined)], 25)
const elapsedMs = Date.now() - startedAt

assert.ok(elapsedMs < 1_000, `network task settlement should be bounded, got ${elapsedMs}ms`)

console.log("browser network task settlement smoke passed")
