import assert from "node:assert/strict"
import { commandRegistry } from "../packages/runtime-core/src/command-registry.js"
import { pluginSetupInputFromArgs, themeSetupInputFromArgs } from "../packages/runtime-playground/src/setup-command-handlers.js"
import {
  setWordPressPluginState,
  setupWordPressPlugin,
  setupWordPressTheme,
  type WordPressRuntimeActionEpisode,
} from "../packages/runtime-playground/src/public.js"

const pluginSetup = commandRegistry.find((definition) => definition.id === "wordpress.plugin-setup")
const themeSetup = commandRegistry.find((definition) => definition.id === "wordpress.theme-setup")

assert.ok(pluginSetup, "wordpress.plugin-setup is registered")
assert.ok(themeSetup, "wordpress.theme-setup is registered")
assert.equal(pluginSetup?.handler.kind === "playground" ? pluginSetup.handler.method : "", "runPluginSetup")
assert.equal(themeSetup?.handler.kind === "playground" ? themeSetup.handler.method : "", "runThemeSetup")
assert.equal(pluginSetup?.outputSchema?.id, "wp-codebox/wordpress-plugin-setup/v1")
assert.equal(themeSetup?.outputSchema?.id, "wp-codebox/wordpress-theme-setup/v1")

assert.deepEqual(pluginSetupInputFromArgs([]), { action: "list", activate: false, network: false })
assert.deepEqual(pluginSetupInputFromArgs(["action=install", "plugin=query-monitor", "activate=true"]), { action: "install", slug: "query-monitor", activate: true, network: false })
assert.throws(() => pluginSetupInputFromArgs(["action=install", "plugin=/tmp/plugin.zip"]), /paths, URLs, and package files are not accepted/)
assert.throws(() => pluginSetupInputFromArgs(["action=install"]), /install requires/)

assert.deepEqual(themeSetupInputFromArgs([]), { action: "list", activate: false })
assert.deepEqual(themeSetupInputFromArgs(["action=switch", "theme=twentytwentysix"]), { action: "switch", slug: "twentytwentysix", activate: false })
assert.deepEqual(themeSetupInputFromArgs(["action=install", "slug=twentytwentysix", "activate=true"]), { action: "install", slug: "twentytwentysix", activate: true })
assert.throws(() => themeSetupInputFromArgs(["action=switch", "theme=https://example.test/theme.zip"]), /paths, URLs, and package files are not accepted/)
assert.throws(() => themeSetupInputFromArgs(["action=switch"]), /switch requires/)

const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = []
const fakeEpisode: WordPressRuntimeActionEpisode = {
  async step(action) {
    calls.push({ command: action.command, args: action.args ?? [], timeoutMs: action.timeoutMs })
    return {
      id: `${action.command}:step`,
      index: calls.length - 1,
      action: {
        schema: "wp-codebox/runtime-episode-action/v1",
        id: `${action.command}:action`,
        kind: action.kind ?? "command",
        command: action.command,
        args: action.args ?? [],
        digest: { algorithm: "sha256", value: action.command },
      },
      actionRef: { kind: "action", id: `${action.command}:action` },
      execution: {
        id: `${action.command}:execution`,
        command: action.command,
        args: action.args ?? [],
        exitCode: 0,
        stdout: "{}\n",
        stderr: "",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z",
      },
      executionRef: { kind: "execution", id: `${action.command}:execution` },
    }
  },
}

await setupWordPressPlugin(fakeEpisode, { action: "install", plugin: "query-monitor", activate: true, timeout_ms: 1000 })
await setWordPressPluginState(fakeEpisode, { action: "deactivate", plugin: "query-monitor" })
await setupWordPressTheme(fakeEpisode, { action: "switch", theme: "twentytwentysix" })

assert.deepEqual(calls.map((call) => call.command), ["wordpress.plugin-setup", "wordpress.plugin-state", "wordpress.theme-setup"])
assert.deepEqual(calls[0]?.args, ["action=install", "plugin=query-monitor", "activate=true"])
assert.equal(calls[0]?.timeoutMs, 1000)
assert.deepEqual(calls[1]?.args, ["action=deactivate", "plugin=query-monitor"])
assert.deepEqual(calls[2]?.args, ["action=switch", "theme=twentytwentysix"])
assert.doesNotMatch(JSON.stringify([pluginSetup, themeSetup]), /homeboy|woocommerce|hbx/i)

console.log("setup command primitives ok")
