import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const classPath = resolve(root, "packages/wordpress-plugin/src/class-wp-codebox-managed-host-command.php")
const escapedRoot = root.replace(/'/g, "'\\''")
const escapedClassPath = classPath.replace(/'/g, "'\\''")

const php = spawnSync(
  "php",
  [
    "-r",
    `define('ABSPATH', '${escapedRoot}'); require '${escapedClassPath}'; $result = WP_Codebox_Managed_Host_Command::run(array('command' => array(PHP_BINARY, '-r', 'print($argv[1]);', 'literal;not-shell'), 'cwd' => '${escapedRoot}', 'allowed_cwd_roots' => array('${escapedRoot}'))); if (!is_array($result)) { var_export($result); exit(1); } echo json_encode($result, JSON_UNESCAPED_SLASHES);`,
  ],
  { encoding: "utf8", cwd: root }
)

assert.equal(php.status, 0, php.stderr || php.stdout)
const result = JSON.parse(php.stdout)
assert.equal(result.success, true)
assert.equal(result.stdout, "literal;not-shell")
assert.deepEqual(result.args.slice(-2), ["print($argv[1]);", "literal;not-shell"])

console.log("php managed host command ok")
