import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { phpRuntimeComponentLifecycleReplayFunction } from "../packages/runtime-core/src/index.js"
import { bootstrapPhpCode } from "../packages/runtime-playground/src/php-bootstrap.js"

const runtimeSpec = {
  backend: "wordpress-playground",
  environment: { kind: "wordpress", phpVersion: "8.3" },
  policy: { filesystem: "readwrite", network: "deny", commands: [] },
  metadata: {
    recipe: {
      inputs: {
        extra_plugins: [
          {
            slug: "late-ability-component",
            pluginFile: "late-ability-component/late-ability-component.php",
            target: "/wordpress/wp-content/plugins/late-ability-component",
            loadAs: "plugin",
            activate: true,
          },
        ],
      },
    },
  },
} as const

const bootstrap = bootstrapPhpCode(runtimeSpec, "echo 'ok';", [])

assert.match(bootstrap, /wp-codebox\/runtime-component-lifecycle-replay\/v1/, "late include bootstrap should expose lifecycle replay diagnostics")
assert.match(bootstrap, /wp_codebox_runtime_abilities_ready/, "late include bootstrap should replay the post-abilities contract hook")
assert.ok(
  bootstrap.indexOf("$lifecycle = wp_codebox_run_php_component_lifecycle_replay_prepare();") < bootstrap.indexOf("require_once $absolute_plugin_file;"),
  "late include bootstrap should reopen lifecycle before including plugin code",
)
assert.ok(
  bootstrap.indexOf("wp_codebox_run_php_component_lifecycle_replay_complete($lifecycle);") > bootstrap.indexOf("require_once $absolute_plugin_file;"),
  "late include bootstrap should replay newly registered callbacks after including plugin code",
)

const recipeRuntimeSetupSource = readFileSync(join(process.cwd(), "packages/cli/src/commands/recipe-runtime-setup.ts"), "utf8")
const activateFunction = recipeRuntimeSetupSource.slice(recipeRuntimeSetupSource.indexOf("function activateExtraPluginCode"), recipeRuntimeSetupSource.length)
const activationReplaySnippet = phpRuntimeComponentLifecycleReplayFunction("wp_codebox_activate_plugin")

assert.match(activateFunction, /phpRuntimeComponentLifecycleReplayFunction\("wp_codebox_activate_plugin"\)/, "activation setup should use the shared lifecycle replay snippet")
assert.match(activationReplaySnippet, /wp-codebox\/runtime-component-lifecycle-replay\/v1/, "activation setup should expose lifecycle replay diagnostics")
assert.match(activationReplaySnippet, /wp_codebox_runtime_abilities_ready/, "activation setup should replay the post-abilities contract hook")
assert.ok(
  activateFunction.indexOf("$lifecycle = wp_codebox_activate_plugin_component_lifecycle_replay_prepare();") < activateFunction.indexOf("activate_plugin($plugin_file"),
  "activation setup should reopen lifecycle before activate_plugin loads plugin code",
)
assert.ok(
  activateFunction.indexOf("wp_codebox_activate_plugin_component_lifecycle_replay_complete($lifecycle);") > activateFunction.indexOf("activate_plugin($plugin_file"),
  "activation setup should replay newly registered callbacks after activate_plugin loads plugin code",
)

console.log("runtime-component-lifecycle-replay-smoke: ok")
