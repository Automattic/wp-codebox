import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { repoRoot } from "../scripts/test-kit.js"

const execution = readFileSync(join(repoRoot, "packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php"), "utf8")
const descriptors = readFileSync(join(repoRoot, "packages/wordpress-plugin/src/class-wp-codebox-browser-ability-descriptors.php"), "utf8")

assert.match(execution, /'authorization'\s*=>\s*is_array\(\s*\$session_envelope\['authorization'\]/)
assert.match(execution, /'task_input'\s*=>\s*is_array\(\s*\$primary\['task_input'\]/)
assert.match(execution, /'authorization'\s*=>\s*is_array\(\s*\$contract\['authorization'\]/)
assert.match(execution, /'task_input'\s*=>\s*is_array\(\s*\$contract\['task_input'\]/)
assert.doesNotMatch(descriptors, /'source_digest'\s*=>\s*array\(\s*'description'/)
assert.match(descriptors, /'source_digest'\s*=>\s*array\(\s*'type'\s*=>\s*array\(\s*'string',\s*'object'\s*\)/)

console.log("browser task contract product dto ok")
