import { resolve } from "node:path"

import { inspectCliFreshness, writeCliBuildProvenance } from "../packages/cli/src/cli-build-provenance.ts"

const repositoryRoot = resolve(import.meta.dirname, "..")
const packageRoot = resolve(repositoryRoot, "packages", "cli")
const provenance = await writeCliBuildProvenance(repositoryRoot, packageRoot)
const check = await inspectCliFreshness(packageRoot, resolve(packageRoot, "dist", "index.js"))
if (check.status === "error") throw new Error(check.message)
process.stdout.write(`WP Codebox CLI build provenance: ${provenance.package.version} ${provenance.git.commit ?? "no-git-commit"} ${provenance.source.sha256}\n`)
