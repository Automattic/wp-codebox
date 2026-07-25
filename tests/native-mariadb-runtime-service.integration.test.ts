import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRecipe } from "../packages/cli/src/commands/recipe-run.ts"
import { executeRuntimeServiceProcess, provisionRuntimeServices } from "../packages/cli/src/runtime-services.ts"
import type { WorkspaceRecipeRuntimeService } from "../packages/runtime-core/src/index.ts"

const service = (id: string, prefix = "DB"): WorkspaceRecipeRuntimeService => ({
  id,
  kind: "mysql",
  configuration: { provider: "native", engine: "mariadb" },
  outputs: { host: `${prefix}_HOST`, port: `${prefix}_PORT`, username: `${prefix}_USER`, password: `${prefix}_SECRET`, database: `${prefix}_NAME` },
})
const rootsBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("wp-codebox-mariadb-")))
const [first, second] = await Promise.all([provisionRuntimeServices([service("native-one")]), provisionRuntimeServices([service("native-two", "SECOND_DB")])])
try {
  assert.notEqual(first.env.DB_PORT, second.env.SECOND_DB_PORT)
  const password = first.secretEnv.DB_SECRET ?? ""
  assert.ok(password)
  const args = ["--no-defaults", "--batch", "--skip-column-names", "--protocol=TCP", "--host=127.0.0.1", `--port=${first.env.DB_PORT}`, "--user=runtime", "--database=runtime"]
  const environment = { ...process.env, MYSQL_PWD: password }
  const sql = [
    "CREATE TABLE wp_options (option_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, option_name VARCHAR(191) NOT NULL UNIQUE, option_value LONGTEXT NOT NULL) ENGINE=InnoDB;",
    "CREATE TABLE wp_2_options LIKE wp_options;",
    "START TRANSACTION; INSERT INTO wp_options(option_name, option_value) VALUES ('rolled_back', 'yes'); ROLLBACK;",
    "SELECT COUNT(*) FROM wp_options WHERE option_name='rolled_back';",
    "INSERT INTO wp_2_options(option_name, option_value) VALUES ('siteurl', 'https://example.test/network/site-2');",
    "SELECT option_value FROM wp_2_options WHERE option_name='siteurl';",
    "",
  ].join("\n")
  const result = await executeRuntimeServiceProcess("mariadb", args, { env: environment, timeout: 20_000, stdin: sql })
  assert.deepEqual(result.stdout.trim().split("\n"), ["0", "https://example.test/network/site-2"])

  const lockHolder = executeRuntimeServiceProcess("mariadb", args, { env: environment, timeout: 20_000, stdin: "SELECT GET_LOCK('wp_codebox_native_lock', 0); SELECT SLEEP(2);\n" })
  await new Promise((resolve) => setTimeout(resolve, 250))
  const contender = await executeRuntimeServiceProcess("mariadb", args, { env: environment, timeout: 10_000, stdin: "SELECT GET_LOCK('wp_codebox_native_lock', 0);\n" })
  assert.equal(contender.stdout.trim(), "0", "independent sessions preserve MariaDB advisory-lock behavior")
  assert.equal((await lockHolder).stdout.trim().split("\n")[0], "1")
  assert.ok((first.evidence[0]?.memory?.observedRssMiB ?? 0) > 0)
  assert.ok((first.evidence[0]?.memory?.observedRssMiB ?? 129) <= 128, JSON.stringify(first.evidence[0]?.memory))

  const recipeRoot = await mkdtemp(join(tmpdir(), "wp-codebox-native-mariadb-recipe-"))
  try {
    const recipePath = join(recipeRoot, "recipe.json")
    const code = "mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); $db = mysqli_init(); mysqli_real_connect($db, getenv('DB_HOST'), getenv('DB_USER'), getenv('DB_PASSWORD'), getenv('DB_NAME'), (int) getenv('DB_PORT')); $row = mysqli_fetch_assoc(mysqli_query($db, 'SELECT VERSION() AS version')); echo str_contains($row['version'], 'MariaDB') ? 'native-mariadb' : 'wrong-engine';"
    await writeFile(recipePath, JSON.stringify({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [service("recipe-native")] }, workflow: { steps: [{ command: "wordpress.run-php", args: [`code=${code}`] }] } }))
    const artifactsDirectory = join(recipeRoot, "artifacts")
    const recipeResult = await runRecipe({ recipePath, artifactsDirectory, previewHoldBlocking: false, previewLeaseRequested: false, previewLeaseChild: false, timeoutMs: 180_000, json: true, summary: false, dryRun: false })
    assert.equal(recipeResult.success, true, JSON.stringify(recipeResult))
    assert.equal(recipeResult.executions.at(-1)?.stdout.trim(), "native-mariadb")
    assert.equal(recipeResult.managedRuntimeServices?.[0]?.lifecycle, "released")
    assert.equal(recipeResult.managedRuntimeServices?.[0]?.teardown, "completed")
    const resultServices = recipeResult.result?.metadata.managed_runtime_services as Array<{ lifecycle: string; teardown: string }>
    assert.equal(resultServices[0]?.lifecycle, "released")
    assert.equal(resultServices[0]?.teardown, "completed")
    assert.equal((recipeResult.run?.metadata?.managedRuntimeServices as Array<{ lifecycle: string }>)[0]?.lifecycle, "released")
    const pointer = JSON.parse(await import("node:fs/promises").then(async ({ readFile }) => await readFile(join(artifactsDirectory, "latest-runtime.json"), "utf8")))
    assert.equal(pointer.managedRuntimeServices[0]?.lifecycle, "released")
    assert.equal(pointer.managedRuntimeServices[0]?.teardown, "completed")
    assert.equal(JSON.stringify(pointer).includes(password), false)
  } finally {
    await rm(recipeRoot, { recursive: true, force: true })
  }
} finally {
  await Promise.allSettled([first.release(), second.release()])
}
const leakedRoots = (await readdir(tmpdir())).filter((name) => name.startsWith("wp-codebox-mariadb-") && !rootsBefore.has(name))
assert.deepEqual(leakedRoots, [], "real native MariaDB integration recursively removes every private root")
console.log("native MariaDB runtime service integration passed")
