#!/usr/bin/env node
import { runCliEntrypoint } from "./cli-main.js"

runCliEntrypoint(process.argv.slice(2))
