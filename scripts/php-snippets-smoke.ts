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

const escapedEnvValue = "quote' double\" newline\nbackslash\\value"
const environmentSnippet = phpEnvAssignments({ VALID_ENV: escapedEnvValue, "INVALID-NAME": "nope" })
assert.equal(
  environmentSnippet,
  'putenv("VALID_ENV=quote\' double\\" newline\\nbackslash\\\\value");\n'
    + '$_ENV["VALID_ENV"] = "quote\' double\\" newline\\nbackslash\\\\value";\n'
    + '$_SERVER["VALID_ENV"] = "quote\' double\\" newline\\nbackslash\\\\value";\n',
)
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
${environmentSnippet}
${phpWpConfigDefineAssignments({ VALID_DEFINE: "value", FLAG: true, COUNT: 3, NULL_VALUE: null })}
echo json_encode(array(
    'accepted' => array(getenv('VALID_ENV'), $_ENV['VALID_ENV'], $_SERVER['VALID_ENV']),
    'invalid' => array(getenv('INVALID-NAME'), array_key_exists('INVALID-NAME', $_ENV), array_key_exists('INVALID-NAME', $_SERVER)),
));`)
execFileSync("php", ["-l", staticPhp], { stdio: "pipe" })
const staticEnvironmentOutput = JSON.parse(execFileSync("php", [staticPhp], { encoding: "utf8" }))
assert.deepEqual(staticEnvironmentOutput, {
  accepted: [escapedEnvValue, escapedEnvValue, escapedEnvValue],
  invalid: [false, false, false],
})

const runtimePhp = join(dir, "runtime.php")
writeFileSync(runtimePhp, `<?php
${phpEnvAssignmentFunction("apply_env", "json_encode", "$GLOBALS['invalid_env'][] = $name;")}
${phpWpConfigDefineAppenderFunction("append_defines", "$GLOBALS['invalid_define'][] = $name;")}

$invalid_env = array();
apply_env(array('VALID_ENV' => ${JSON.stringify(escapedEnvValue)}, 'SCALAR_INT' => 12, 'SCALAR_BOOL' => true, 'ARRAY_VALUE' => array('a' => 1), 'INVALID-NAME' => 'nope'));
assert(getenv('SCALAR_INT') === '12');
assert($_ENV['SCALAR_BOOL'] === '1');
assert(getenv('ARRAY_VALUE') === '{"a":1}');
assert($invalid_env === array('INVALID-NAME'));

$invalid_define = array();
$config = "<?php\n";
append_defines($config, array('VALID_DEFINE' => "quote' value", 'INVALID-NAME' => 'nope'));
assert(strpos($config, "define('VALID_DEFINE', 'quote\\' value')") !== false);
assert($invalid_define === array('INVALID-NAME'));

echo json_encode(array(
    'environment' => array(
        'accepted' => array(getenv('VALID_ENV'), $_ENV['VALID_ENV'], $_SERVER['VALID_ENV']),
        'invalid' => array(getenv('INVALID-NAME'), array_key_exists('INVALID-NAME', $_ENV), array_key_exists('INVALID-NAME', $_SERVER)),
    ),
    'invalid_names' => $invalid_env,
));
`)
execFileSync("php", ["-l", runtimePhp], { stdio: "pipe" })
const runtimeEnvironmentOutput = JSON.parse(execFileSync("php", [runtimePhp], { encoding: "utf8" }))
assert.deepEqual(runtimeEnvironmentOutput.environment, staticEnvironmentOutput)
assert.deepEqual(runtimeEnvironmentOutput.invalid_names, ["INVALID-NAME"])

const lifecyclePhp = join(dir, "lifecycle.php")
writeFileSync(lifecyclePhp, `<?php
${phpRuntimeComponentLifecycleReplayFunction("wp_codebox_smoke")}
`)
execFileSync("php", ["-l", lifecyclePhp], { stdio: "pipe" })

const browserDiagnosticsPhp = join(dir, "browser-diagnostics.php")
writeFileSync(browserDiagnosticsPhp, phpBrowserWordPressDiagnosticsPlugin())
execFileSync("php", ["-l", browserDiagnosticsPhp], { stdio: "pipe" })
