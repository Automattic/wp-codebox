import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import {
  namedFileTreeSkipPolicyNames,
  normalizeRelativePath,
  normalizeRootedPath,
  pathIsWithinRoot,
  phpStringArrayLiteral,
  relativePathExcluded,
  relativePathIsWithinRoot,
} from "../packages/runtime-core/src/index.js"

assert.equal(normalizeRelativePath("./src\\nested/../file.ts"), "src/file.ts")
assert.equal(normalizeRootedPath("wp-content/plugins", "/workspace"), "/workspace/wp-content/plugins")
assert.equal(normalizeRootedPath("/workspace/../workspace/plugin", "/workspace"), "/workspace/plugin")

const root = resolve("/tmp/wp-codebox-root")
assert.equal(pathIsWithinRoot(resolve(root, "child/file.txt"), root), true)
assert.equal(pathIsWithinRoot(root, root), true)
assert.equal(pathIsWithinRoot(resolve(root, "../wp-codebox-root-sibling/file.txt"), root), false)
assert.equal(relativePathIsWithinRoot("/workspace/plugin/file.php", "/workspace/plugin"), true)
assert.equal(relativePathIsWithinRoot("/workspace/plugin-extra/file.php", "/workspace/plugin"), false)
assert.equal(relativePathIsWithinRoot("../outside", "/workspace"), false)

assert.deepEqual(namedFileTreeSkipPolicyNames("prepared-source"), [".git", "node_modules", "vendor"])
assert.deepEqual(namedFileTreeSkipPolicyNames("captured-mount"), [".git", "node_modules", "target"])

assert.equal(relativePathExcluded("build/output.js", ["build"]), true)
assert.equal(relativePathExcluded("build/nested/output.js", ["build/**"]), true)
assert.equal(relativePathExcluded("build-tools/output.js", ["build"]), false)
assert.equal(relativePathExcluded("/logs/app.log", [" logs/** "]), true)
assert.equal(relativePathExcluded("src/app.ts", ["", "/dist/"]), false)

assert.equal(phpStringArrayLiteral([".git", "vendor's", "node\\modules"]), "array('.git', 'vendor\\'s', 'node\\\\modules')")

console.log("file-tree-policy-smoke: ok")
