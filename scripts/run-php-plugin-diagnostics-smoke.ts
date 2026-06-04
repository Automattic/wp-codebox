import assert from "node:assert/strict"
import { bootstrapPhpCode } from "../packages/runtime-playground/src/php-bootstrap.js"
import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"

const spec = {
  backend: "wordpress-playground",
  environment: { kind: "wordpress" },
  policy: { network: "none", filesystem: "sandbox", secrets: "none" },
  metadata: {
    recipe: {
      inputs: {
        extra_plugins: [
          {
            slug: "missing-plugin",
            pluginFile: "missing-plugin/missing-plugin.php",
            target: "/wordpress/wp-content/plugins/missing-plugin",
            activate: true,
            loadAs: "plugin",
          },
        ],
      },
    },
  },
} satisfies RuntimeCreateSpec

const code = bootstrapPhpCode(spec, "echo 'unreachable';", [])

assert.match(code, /wp-codebox\/run-php-plugin-load-diagnostic\/v1/)
assert.match(code, /wordpress\.run-php cannot include recipe plugin file/)
assert.match(code, /missing or unreadable plugin file/)
assert.match(code, /'mounted_path' => isset\(\$plugin\['target'\]\)/)
assert.match(code, /'active' => function_exists\('is_plugin_active'\) \? is_plugin_active\(\$plugin_file\) : null/)
assert.match(code, /'included' => \$included/)
const encodedPluginMetadata = Buffer.from(JSON.stringify([{ slug: "missing-plugin", pluginFile: "missing-plugin/missing-plugin.php", target: "/wordpress/wp-content/plugins/missing-plugin", activate: true, loadAs: "plugin" }]), "utf8").toString("base64")
assert.match(code, new RegExp(encodedPluginMetadata))

console.log("run-php plugin diagnostics smoke passed")
