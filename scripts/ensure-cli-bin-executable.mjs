#!/usr/bin/env node
import { chmodSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
chmodSync(resolve(root, "packages/cli/dist/index.js"), 0o755)
