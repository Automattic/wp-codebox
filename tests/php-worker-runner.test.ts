import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { PHP_WORKER_RUN_SCHEMA, phpWorkerResultJson, runPhpWorker } from "../packages/runtime-core/src/index.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-php-worker-"))
const workerFile = join(root, "worker.php")
await writeFile(workerFile, `<?php
$input = json_decode(file_get_contents(getenv('WP_CODEBOX_PHP_WORKER_INPUT_PATH')), true);
$env = getenv('EXAMPLE_FLAG');
file_put_contents(getenv('WP_CODEBOX_PHP_WORKER_RESULT_PATH'), json_encode(array(
    'ok' => true,
    'message' => $input['message'],
    'env' => $env,
), JSON_UNESCAPED_SLASHES));
`, "utf8")

const result = await runPhpWorker({
  cwd: root,
  allowedCwdRoots: [root],
  artifactsDirectory: join(root, "artifacts"),
}, {
  workerFile,
  input: { message: "hello" },
  env: { EXAMPLE_FLAG: "set" },
})

assert.equal(result.schema, PHP_WORKER_RUN_SCHEMA)
assert.equal(result.command, "wordpress.php-worker")
assert.equal(result.status, "completed")
assert.equal(result.exitCode, 0)
assert.deepEqual(result.json, { ok: true, message: "hello", env: "set" })
assert.equal(result.worker.basename, "worker.php")
assert.equal(result.diagnostics.output.parsedJson, true)
assert.deepEqual(result.diagnostics.environment.envNames, ["EXAMPLE_FLAG"])
assert.equal(JSON.parse(phpWorkerResultJson(result)).schema, PHP_WORKER_RUN_SCHEMA)

const stdoutWorker = join(root, "stdout-worker.php")
await writeFile(stdoutWorker, `<?php print json_encode(array('stdout' => true));`, "utf8")
const stdoutResult = await runPhpWorker({ cwd: root, allowedCwdRoots: [root], artifactsDirectory: join(root, "stdout-artifacts") }, { workerFile: stdoutWorker })
assert.equal(stdoutResult.status, "completed")
assert.deepEqual(stdoutResult.json, { stdout: true })

const invalidWorker = join(root, "invalid-worker.php")
await writeFile(invalidWorker, `<?php print 'not-json';`, "utf8")
const invalidResult = await runPhpWorker({ cwd: root, allowedCwdRoots: [root], artifactsDirectory: join(root, "invalid-artifacts") }, { workerFile: invalidWorker })
assert.equal(invalidResult.status, "failed")
assert.equal(invalidResult.diagnostics.error?.code, "php-worker-invalid-json")

await assert.rejects(
  () => runPhpWorker({ cwd: root, allowedCwdRoots: [root], artifactsDirectory: join(root, "escaped-artifacts") }, { workerFile, inputArtifact: "../input.json" }),
  /artifact path escapes artifact directory/
)

console.log("php worker runner ok")
