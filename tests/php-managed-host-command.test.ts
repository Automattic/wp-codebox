import assert from "node:assert/strict"
import { resolve } from "node:path"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const root = phpStringLiteral(repoRoot)
const classPath = phpStringLiteral(resolve(repoRoot, "packages/wordpress-plugin/src/class-wp-codebox-managed-host-command.php"))
const result = await runPhpJson<{ success: boolean, stdout: string, args: string[] }>(
  `define('ABSPATH', ${root}); require ${classPath}; $result = WP_Codebox_Managed_Host_Command::run(array('command' => array(PHP_BINARY, '-r', 'print($argv[1]);', 'literal;not-shell'), 'cwd' => ${root}, 'allowed_cwd_roots' => array(${root}))); if (!is_array($result)) { var_export($result); exit(1); } echo json_encode($result, JSON_UNESCAPED_SLASHES);`
)
assert.equal(result.success, true)
assert.equal(result.stdout, "literal;not-shell")
assert.deepEqual(result.args.slice(-2), ["print($argv[1]);", "literal;not-shell"])

console.log("php managed host command ok")
