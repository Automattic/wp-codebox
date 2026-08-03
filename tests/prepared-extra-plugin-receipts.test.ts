import assert from "node:assert/strict"
import { preparedExtraPluginReceipts } from "../packages/cli/src/commands/recipe-run.js"

const plugin = {
  source: "/tmp/plugin",
  slug: "example-plugin",
  target: "/wordpress/wp-content/plugins/example-plugin",
  pluginFile: "example-plugin/example.php",
  activate: true,
  loadAs: "plugin" as const,
  cleanupPaths: [],
  provenance: { kind: "https_zip" as const, original: "https://example.test/plugin.zip", resolvedUrl: "https://example.test/plugin.zip", digest: { sha256: "a".repeat(64), verified: true } },
}

const receipts = preparedExtraPluginReceipts([plugin], [{ schema: "wp-codebox/recipe-phase-evidence/v1", name: "activate_plugins", status: "completed", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z", durationMs: 1, data: { activePlugins: [plugin.pluginFile] } }], [])
assert.deepEqual(receipts, [{ schema: "wp-codebox/prepared-extra-plugin/v1", slug: plugin.slug, source: plugin.source, target: plugin.target, pluginFile: plugin.pluginFile, loadAs: "plugin", activate: true, provenance: plugin.provenance, activationStatus: "activated", failures: [] }])
console.log("prepared extra plugin receipts ok")
