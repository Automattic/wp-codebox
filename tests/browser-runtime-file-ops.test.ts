import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Proves the in-sandbox file/code op dispatcher (browser-runtime.js embedded PHP)
// gained working read/ls/grep/edit/apply-patch operations alongside writeFile,
// by extracting the embedded PHP template and executing each op against a real
// temporary working root through the `php` CLI.

const here = fileURLToPath(new URL(".", import.meta.url))
const runtimeSource = readFileSync(join(here, "../packages/wordpress-plugin/assets/browser-runtime.js"), "utf8")

const openMarker = "const operationPhp = ( operation ) => `"
const start = runtimeSource.indexOf(openMarker)
assert.ok(start >= 0, "operationPhp template found")
const bodyStart = start + openMarker.length
const end = runtimeSource.indexOf("`;", bodyStart)
assert.ok(end > bodyStart, "operationPhp template closes")
const template = runtimeSource.slice(bodyStart, end)
assert.ok(!template.includes("`"), "embedded PHP avoids backticks")

const stubs = [
  "<?php",
  "function wp_json_encode( $value ) { return json_encode( $value ); }",
  "function wp_mkdir_p( $path ) { return is_dir( $path ) || mkdir( $path, 0777, true ); }",
  "function trailingslashit( $value ) { return rtrim( (string) $value, '/' ) . '/'; }",
  "",
].join("\n")

const runnerDir = mkdtempSync(join(tmpdir(), "wp-codebox-browser-ops-runner-"))

function runOperation(root: string, operation: Record<string, unknown>): { success: boolean; data: any; error: any } {
  const base64 = Buffer.from(JSON.stringify(operation), "utf8").toString("base64")
  const body = template.replace("${ base64Json( operation ) }", base64).replace(/^<\?php\n/, "")
  const php = stubs + "define( 'ABSPATH', '" + root.replace(/'/g, "\\'") + "/' );\n" + body
  const runnerPath = join(runnerDir, "runner.php")
  writeFileSync(runnerPath, php)
  const out = execFileSync("php", [runnerPath], { encoding: "utf8" })
  return JSON.parse(out)
}

const root = mkdtempSync(join(tmpdir(), "wp-codebox-browser-ops-"))
try {
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src/app.php"), "<?php\n// alpha\necho 'hello';\n// beta\n")
  writeFileSync(join(root, "README.md"), "# Title\n\nNeedle line here.\n")

  // write
  const write = runOperation(root, { type: "writeFile", args: { path: "notes/todo.txt", content: "line1\nline2\n" } })
  assert.equal(write.success, true, "writeFile succeeds")
  assert.equal(readFileSync(join(root, "notes/todo.txt"), "utf8"), "line1\nline2\n", "writeFile persisted content")

  // read
  const read = runOperation(root, { type: "readFile", args: { path: "notes/todo.txt" } })
  assert.equal(read.success, true, "readFile succeeds")
  assert.equal(read.data.content, "line1\nline2\n", "readFile returns content")
  assert.equal(read.data.linesRead, 3, "readFile counts lines")

  const readSlice = runOperation(root, { type: "readFile", args: { path: "src/app.php", offset: 2, limit: 2 } })
  assert.equal(readSlice.data.content, "// alpha\necho 'hello';", "readFile offset/limit slices lines")

  // listDirectory
  const ls = runOperation(root, { type: "listDirectory", args: {} })
  const names = ls.data.entries.map((e: any) => e.name)
  assert.ok(names.includes("src") && names.includes("README.md") && names.includes("notes"), "listDirectory lists entries")
  assert.equal(ls.data.entries[0].type, "directory", "listDirectory sorts directories first")

  // grep
  const grep = runOperation(root, { type: "grep", args: { pattern: "Needle" } })
  assert.equal(grep.data.count, 1, "grep finds one match")
  assert.equal(grep.data.matches[0].path, "README.md", "grep reports relative path")
  assert.equal(grep.data.matches[0].line, 3, "grep reports line number")

  const grepInclude = runOperation(root, { type: "grep", args: { pattern: "echo", include: "*.php" } })
  assert.equal(grepInclude.data.count, 1, "grep include glob filters")

  // editFile
  const edit = runOperation(root, { type: "editFile", args: { path: "src/app.php", oldString: "echo 'hello';", newString: "echo 'world';" } })
  assert.equal(edit.success, true, "editFile succeeds")
  assert.equal(edit.data.replacements, 1, "editFile reports replacement count")
  assert.ok(readFileSync(join(root, "src/app.php"), "utf8").includes("echo 'world';"), "editFile changed file")

  const editAmbiguous = runOperation(root, { type: "editFile", args: { path: "src/app.php", oldString: "//" } })
  assert.equal(editAmbiguous.success, false, "editFile fails closed on ambiguous match")

  // applyPatch (modify)
  writeFileSync(join(root, "patch-target.txt"), "one\ntwo\nthree\n")
  const patch = "--- a/patch-target.txt\n+++ b/patch-target.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"
  const applied = runOperation(root, { type: "applyPatch", args: { patch } })
  assert.equal(applied.success, true, "applyPatch succeeds")
  assert.deepEqual(applied.data.changedFiles, ["patch-target.txt"], "applyPatch reports changed file")
  assert.equal(readFileSync(join(root, "patch-target.txt"), "utf8"), "one\nTWO\nthree\n", "applyPatch applied hunk")

  // applyPatch (create)
  const createPatch = "--- /dev/null\n+++ b/created/new.txt\n@@ -0,0 +1,2 @@\n+fresh\n+content\n"
  const created = runOperation(root, { type: "applyPatch", args: { patch: createPatch } })
  assert.equal(created.success, true, "applyPatch creates new file")
  assert.equal(readFileSync(join(root, "created/new.txt"), "utf8"), "fresh\ncontent\n", "applyPatch wrote new file")

  // applyPatch context mismatch fails closed
  const badPatch = "--- a/patch-target.txt\n+++ b/patch-target.txt\n@@ -1,3 +1,3 @@\n one\n-WRONG\n+x\n three\n"
  const bad = runOperation(root, { type: "applyPatch", args: { patch: badPatch } })
  assert.equal(bad.success, false, "applyPatch fails closed on context mismatch")
  assert.equal(readFileSync(join(root, "patch-target.txt"), "utf8"), "one\nTWO\nthree\n", "applyPatch left file unchanged after failure")

  // path-escape rejection across the new strict file/code ops
  for (const op of [
    { type: "readFile", args: { path: "../escape.txt" } },
    { type: "editFile", args: { path: "../escape.txt", oldString: "a", newString: "b" } },
    { type: "listDirectory", args: { path: "../.." } },
    { type: "applyPatch", args: { patch: "--- /dev/null\n+++ b/../escape-via-patch.txt\n@@ -0,0 +1,1 @@\n+nope\n" } },
  ]) {
    const result = runOperation(root, op)
    assert.equal(result.success, false, `${op.type} rejects path escape`)
  }

  console.log("OK browser-runtime-file-ops")
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(runnerDir, { recursive: true, force: true })
}
