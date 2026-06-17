import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  phpEnvAssignmentFunction,
  phpEnvAssignments,
  phpBrowserWordPressDiagnosticsPlugin,
  phpLiteral,
  phpRuntimeComponentLifecycleReplayFunction,
  phpWpConfigDefineAppenderFunction,
  phpWpConfigDefineAssignment,
  phpWpConfigDefineAssignments,
} from "../packages/runtime-playground/src/php-snippets.js"

assert.equal(phpLiteral("quote' double\" newline\n"), '"quote\' double\\" newline\\n"')
assert.equal(phpLiteral(true), "true")
assert.equal(phpLiteral(false), "false")
assert.equal(phpLiteral(12.5), "12.5")
assert.equal(phpLiteral(null), "null")

assert.equal(phpEnvAssignments({ VALID_ENV: "secret\nvalue", "INVALID-NAME": "nope" }), 'putenv("VALID_ENV=secret\\nvalue");\n')
assert.equal(
  phpWpConfigDefineAssignments({ VALID_DEFINE: "value", FLAG: true, COUNT: 3, NULL_VALUE: null, "INVALID-NAME": "nope", ARRAY_VALUE: [] }),
  'if (!defined("VALID_DEFINE")) { define("VALID_DEFINE", "value"); }\n'
    + 'if (!defined("FLAG")) { define("FLAG", true); }\n'
    + 'if (!defined("COUNT")) { define("COUNT", 3); }\n'
    + 'if (!defined("NULL_VALUE")) { define("NULL_VALUE", null); }\n',
)
assert.throws(() => phpWpConfigDefineAssignment("INVALID-NAME", "value"), /Invalid PHP constant name/)

const dir = mkdtempSync(join(tmpdir(), "wp-codebox-php-snippets-"))

const staticPhp = join(dir, "static.php")
writeFileSync(staticPhp, `<?php
${phpEnvAssignments({ VALID_ENV: "value" })}
${phpWpConfigDefineAssignments({ VALID_DEFINE: "value", FLAG: true, COUNT: 3, NULL_VALUE: null })}`)
execFileSync("php", ["-l", staticPhp], { stdio: "pipe" })

const runtimePhp = join(dir, "runtime.php")
writeFileSync(runtimePhp, `<?php
${phpEnvAssignmentFunction("apply_env", "json_encode", "$GLOBALS['invalid_env'][] = $name;")}
${phpWpConfigDefineAppenderFunction("append_defines", "$GLOBALS['invalid_define'][] = $name;")}

$invalid_env = array();
apply_env(array('SCALAR_INT' => 12, 'SCALAR_BOOL' => true, 'ARRAY_VALUE' => array('a' => 1), 'INVALID-NAME' => 'nope'));
assert(getenv('SCALAR_INT') === '12');
assert($_ENV['SCALAR_BOOL'] === '1');
assert(getenv('ARRAY_VALUE') === '{"a":1}');
assert($invalid_env === array('INVALID-NAME'));

$invalid_define = array();
$config = "<?php\n";
append_defines($config, array('VALID_DEFINE' => "quote' value", 'INVALID-NAME' => 'nope'));
assert(strpos($config, "define('VALID_DEFINE', 'quote\\' value')") !== false);
assert($invalid_define === array('INVALID-NAME'));
`)
execFileSync("php", ["-l", runtimePhp], { stdio: "pipe" })
execFileSync("php", [runtimePhp], { stdio: "pipe" })

const lifecyclePhp = join(dir, "lifecycle.php")
writeFileSync(lifecyclePhp, `<?php
${phpRuntimeComponentLifecycleReplayFunction("wp_codebox_smoke")}
`)
execFileSync("php", ["-l", lifecyclePhp], { stdio: "pipe" })

const browserDiagnosticsPhp = join(dir, "browser-diagnostics.php")
writeFileSync(browserDiagnosticsPhp, phpBrowserWordPressDiagnosticsPlugin())
execFileSync("php", ["-l", browserDiagnosticsPhp], { stdio: "pipe" })
