import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveRecipeExtraPluginFile } from "../packages/cli/src/recipe-sources.js"

const root = await mkdtemp(join(tmpdir(), "wp-codebox-extra-plugin-entry-"))

try {
  // 1. Conventional <slug>/<slug>.php is preferred when present.
  const conventional = join(root, "my-plugin")
  await mkdir(conventional, { recursive: true })
  await writeFile(join(conventional, "my-plugin.php"), "<?php\n/* Plugin Name: My Plugin */\n")
  assert.equal(
    await resolveRecipeExtraPluginFile({ source: conventional }, root),
    "my-plugin/my-plugin.php",
    "conventional <slug>/<slug>.php should resolve",
  )

  // 2. Renamed directory (e.g. a Lab-synced uniquified dir) whose entry file no
  //    longer matches the directory name: resolve by Plugin Name header.
  const renamed = join(root, "ai-provider-for-claude-code-352e5891f975-abc-123")
  await mkdir(renamed, { recursive: true })
  await writeFile(join(renamed, "readme.txt"), "not php")
  await writeFile(join(renamed, "uninstall.php"), "<?php\n// no plugin header\n")
  await writeFile(
    join(renamed, "ai-provider-for-claude-code.php"),
    "<?php\n/**\n * Plugin Name: AI Provider for Claude Code\n */\n",
  )
  assert.equal(
    await resolveRecipeExtraPluginFile({ source: renamed }, root),
    "ai-provider-for-claude-code-352e5891f975-abc-123/ai-provider-for-claude-code.php",
    "renamed dir should resolve the entry file via the Plugin Name header",
  )

  // 3. plugin.php convention still works.
  const pluginPhp = join(root, "weird-name")
  await mkdir(pluginPhp, { recursive: true })
  await writeFile(join(pluginPhp, "plugin.php"), "<?php\n/* Plugin Name: Weird */\n")
  assert.equal(
    await resolveRecipeExtraPluginFile({ source: pluginPhp }, root),
    "weird-name/plugin.php",
    "plugin.php convention should resolve",
  )

  // 4. Explicit pluginFile always wins.
  assert.equal(
    await resolveRecipeExtraPluginFile({ source: renamed, pluginFile: "custom/entry.php" }, root),
    "custom/entry.php",
    "explicit pluginFile should take precedence",
  )

  // 5. No php / no header: falls back to <slug>/<slug>.php (unchanged behavior).
  const empty = join(root, "no-entry")
  await mkdir(empty, { recursive: true })
  assert.equal(
    await resolveRecipeExtraPluginFile({ source: empty }, root),
    "no-entry/no-entry.php",
    "missing entry falls back to <slug>/<slug>.php",
  )

  console.log("extra-plugin-entry-file-smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
