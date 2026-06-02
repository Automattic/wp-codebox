#!/usr/bin/env node
import { runCli } from "./cli-entry.js"
import { serializeError } from "./output.js"

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(serializeError(error)?.message ?? String(error))
    process.exitCode = 1
  },
)
