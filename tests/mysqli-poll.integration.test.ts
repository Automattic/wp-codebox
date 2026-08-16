import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRecipe } from "../packages/cli/src/commands/recipe-run.ts"

const directory = await mkdtemp(join(tmpdir(), "wp-codebox-mysqli-poll-"))
try {
  const recipePath = join(directory, "recipe.json")
  const code = `
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$connect = static function (): mysqli {
    $db = mysqli_init();
    mysqli_real_connect($db, getenv('DB_HOST'), getenv('DB_USER'), getenv('DB_PASSWORD'), getenv('DB_NAME'), (int) getenv('DB_PORT'));
    return $db;
};
$first = $connect();
$second = $connect();
$first->query('CREATE TABLE poll_lock (id INT PRIMARY KEY) ENGINE=InnoDB');
$first->query('INSERT INTO poll_lock VALUES (1)');
$first->query('START TRANSACTION');
$first->query('SELECT id FROM poll_lock WHERE id = 1 FOR UPDATE');
$second->query('SELECT id FROM poll_lock WHERE id = 1 FOR UPDATE', MYSQLI_ASYNC);
$read = array($second);
$error = array();
$reject = array();
$started = microtime(true);
$ready = mysqli_poll($read, $error, $reject, 0, 100000);
$elapsed_ms = (microtime(true) - $started) * 1000;
$timeout_set_counts = array(count($read), count($error), count($reject));
$first->query('ROLLBACK');
$cleanup_ready = false;
for ($attempt = 0; $attempt < 20; $attempt++) {
    $read = array($second);
    $error = array();
    $reject = array();
    if (mysqli_poll($read, $error, $reject, 0, 100000) > 0) {
        $cleanup_ready = true;
        break;
    }
}
if ($cleanup_ready) {
    $second->reap_async_query();
}
$first->query('DROP TABLE poll_lock');
echo json_encode(array(
    'ready' => $ready,
    'elapsed_ms' => $elapsed_ms,
    'timeout_set_counts' => $timeout_set_counts,
    'cleanup_ready' => $cleanup_ready,
));
`
  await writeFile(recipePath, JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { phpVersion: "8.3" },
    inputs: {
      services: [{
        id: "mariadb",
        kind: "mysql",
        configuration: { engine: "mariadb" },
        outputs: { host: "DB_HOST", port: "DB_PORT", username: "DB_USER", password: "DB_PASSWORD", database: "DB_NAME" },
      }],
    },
    workflow: { steps: [{ command: "wordpress.run-php", args: [`code=${code}`] }] },
  }))

  const result = await runRecipe({
    recipePath,
    previewHoldBlocking: false,
    previewLeaseRequested: false,
    previewLeaseChild: false,
    timeoutMs: 180_000,
    json: true,
    summary: false,
    dryRun: false,
    externalServiceWritesApproved: false,
  })
  assert.equal(result.success, true, JSON.stringify(result))
  const output = JSON.parse(result.executions.at(-1)?.stdout.trim() ?? "{}")
  assert.equal(output.ready, 0)
  assert.ok(output.elapsed_ms >= 50, `mysqli_poll returned too early after ${output.elapsed_ms}ms`)
  assert.ok(output.elapsed_ms < 2_000, `mysqli_poll exceeded its timeout: ${output.elapsed_ms}ms`)
  assert.deepEqual(output.timeout_set_counts, [0, 0, 0])
  assert.equal(output.cleanup_ready, true)
  console.log("mysqli_poll MariaDB integration passed")
} finally {
  await rm(directory, { recursive: true, force: true })
}
