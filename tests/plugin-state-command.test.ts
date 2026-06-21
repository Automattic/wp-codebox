import assert from "node:assert/strict"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { pluginStateInputFromArgs, pluginStatePhpCode } from "../packages/runtime-playground/src/plugin-state-command-handlers.js"

const command = commandRegistry.find((definition) => definition.id === "wordpress.plugin-state")
assert.ok(command, "wordpress.plugin-state is registered")
assert.equal(command?.handler.kind, "playground")
assert.equal(command?.handler.kind === "playground" ? command.handler.method : "", "runPluginState")
assert.equal(command?.outputSchema?.id, "wp-codebox/wordpress-plugin-state/v1")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "action"), "plugin-state accepts action")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "plugin"), "plugin-state accepts plugin")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "slug"), "plugin-state accepts slug")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "file"), "plugin-state accepts file")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "path"), "plugin-state accepts path")

assert.deepEqual(pluginStateInputFromArgs(["plugin=akismet"]), { action: "report", target: "akismet", network: false })
assert.deepEqual(pluginStateInputFromArgs(["action=status", "file=demo/demo.php", "network=true"]), { action: "report", target: "demo/demo.php", network: true })
assert.deepEqual(pluginStateInputFromArgs(["action=activate", "path=/wordpress/wp-content/plugins/demo/demo.php"]), { action: "activate", target: "/wordpress/wp-content/plugins/demo/demo.php", network: false })
assert.throws(() => pluginStateInputFromArgs(["action=delete", "plugin=akismet"]), /action must be/)
assert.throws(() => pluginStateInputFromArgs(["action=report"]), /requires plugin/)

const php = pluginStatePhpCode({ action: "activate", target: "demo/demo.php", network: false })
assert.match(php, /wp-codebox\/wordpress-plugin-state\/v1/)
assert.match(php, /activate_plugin\(\$plugin_file/)
assert.match(php, /deactivate_plugins\(array\(\$plugin_file\)/)
assert.match(php, /activePluginsBefore/)
assert.match(php, /activePluginsAfter/)
assert.match(php, /networkActivePluginsBefore/)
assert.match(php, /networkActivePluginsAfter/)
assert.match(php, /artifactRefs/)
assert.doesNotMatch(JSON.stringify(command), /homeboy|woocommerce|hbx/i)

console.log("plugin-state command ok")
