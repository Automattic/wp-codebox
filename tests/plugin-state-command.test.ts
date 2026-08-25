import assert from "node:assert/strict"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { pluginStateInputFromArgs, pluginStatePhpCode } from "../packages/runtime-playground/src/plugin-state-command-handlers.js"
import { materializePlaygroundRunResponse } from "../packages/runtime-playground/src/playground-runtime.js"
import { runPluginStateCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

const command = commandRegistry.find((definition) => definition.id === "wordpress.plugin-state")
const ensureCommand = commandRegistry.find((definition) => definition.id === "wordpress.ensure-plugin-active")
assert.ok(command, "wordpress.plugin-state is registered")
assert.ok(ensureCommand, "wordpress.ensure-plugin-active is registered")
assert.equal(command?.handler.kind, "playground")
assert.equal(command?.handler.kind === "playground" ? command.handler.method : "", "runPluginState")
assert.equal(ensureCommand?.handler.kind, "playground")
assert.equal(ensureCommand?.handler.kind === "playground" ? ensureCommand.handler.method : "", "runPluginState")
assert.deepEqual(ensureCommand?.requiresPolicyCommands, ["wordpress.plugin-state"])
assert.equal(command?.outputSchema?.id, "wp-codebox/wordpress-plugin-state/v1")
assert.equal(ensureCommand?.outputSchema?.id, "wp-codebox/wordpress-plugin-state/v1")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "action"), "plugin-state accepts action")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "plugin"), "plugin-state accepts plugin")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "slug"), "plugin-state accepts slug")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "file"), "plugin-state accepts file")
assert.ok(command?.acceptedArgs.some((arg) => arg.name === "path"), "plugin-state accepts path")

assert.deepEqual(pluginStateInputFromArgs(["plugin=akismet"]), { action: "report", target: "akismet", network: false })
assert.deepEqual(pluginStateInputFromArgs(["plugin=akismet"], "activate", "wordpress.ensure-plugin-active"), { action: "activate", target: "akismet", network: false })
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

const pluginStateJson = JSON.stringify({ schema: "wp-codebox/wordpress-plugin-state/v1", active_plugins: ["example/example.php"] })
let responseAvailable = true
const lazyResponse = new Proxy({ exitCode: 0 }, {
  get(target, property, receiver) {
    return property === "text" ? responseAvailable ? pluginStateJson : "\0" : Reflect.get(target, property, receiver)
  },
})
const materializedResponse = materializePlaygroundRunResponse(lazyResponse as never)
responseAvailable = false
assert.equal(typeof materializedResponse.text, "string")
assert.deepEqual(JSON.parse(materializedResponse.text), JSON.parse(pluginStateJson))

const pluginStateOutput = await runPluginStateCommand({
  runPlaygroundCommand: async () => materializedResponse,
  runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.plugin-state"] }),
  server: {} as never,
  spec: { command: "wordpress.plugin-state", args: ["plugin=example"] } as never,
})
assert.equal(typeof pluginStateOutput, "string")
assert.deepEqual(JSON.parse(pluginStateOutput), JSON.parse(pluginStateJson))

console.log("plugin-state command ok")
