import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { validateWorkspaceRecipeSemantics, validateWorkspaceRecipeShape } from "../packages/cli/src/recipe-validation.js"
import { cleanupRecipePreparedSources, prepareExtraThemes, prepareRecipeExtraThemes } from "../packages/cli/src/recipe-sources.js"
import type { WorkspaceRecipe, WorkspaceRecipeExtraTheme } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const execFileAsync = promisify(execFile)

async function zip(directory: string, archive: string, entries: string[]): Promise<void> {
  await execFileAsync("zip", ["-q", "-r", archive, ...entries], { cwd: directory })
}

function themeRecipe(themes: WorkspaceRecipeExtraTheme[]): WorkspaceRecipe {
  return {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: { extra_themes: themes },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  }
}

async function writeThemeFiles(directory: string, options: { themeName?: string; template?: string; entrypoint?: string } = {}): Promise<void> {
  await mkdir(directory, { recursive: true })
  const headerLines = [
    "/*",
    `Theme Name: ${options.themeName ?? "Example Theme"}`,
    ...(options.template ? [`Template: ${options.template}`] : []),
    "*/",
  ]
  await writeFile(join(directory, "style.css"), `${headerLines.join("\n")}\n`)
  await writeFile(join(directory, options.entrypoint ?? "index.php"), "<?php\n// theme entrypoint\n")
}

// A local directory theme source materializes, mounts, and activates correctly.
// This is the same shape the pre-existing generic `mounts` primitive already
// supports for local themes; extra_themes must not regress that baseline.
await withTempDir("wp-codebox-extra-theme-local-dir-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "storefront-clone"))
  const recipe = themeRecipe([{ source: "storefront-clone", slug: "storefront-clone", activate: true }])

  assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json")), [])
  validateWorkspaceRecipeShape(recipe, join(recipeDirectory, "recipe.json"))

  const [theme] = await prepareRecipeExtraThemes(recipe, recipeDirectory)
  assert.equal(theme.slug, "storefront-clone")
  assert.equal(theme.target, "/wordpress/wp-content/themes/storefront-clone")
  assert.equal(theme.activate, true)
  assert.equal(theme.themeName, "Example Theme")
  assert.equal(theme.template, undefined)
  assert.equal((await stat(join(theme.source, "style.css"))).isFile(), true)
  assert.equal(theme.provenance.kind, "local")

  await cleanupRecipePreparedSources([], [], [], [], [], [theme])
})

// Regression: the pre-existing generic `mounts` primitive (not extra_themes)
// still validates a local theme directory unaffected by the extra_themes
// schema/validation additions.
await withTempDir("wp-codebox-generic-theme-mount-regression-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "classic-theme"))
  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      mounts: [{ source: "classic-theme", target: "/wordpress/wp-content/themes/classic-theme", type: "directory" }],
    },
    workflow: { steps: [{ command: "inspect-mounted-inputs" }] },
  }
  assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json")), [])
})

// sha256 pinning is enforced for a local zip theme source (same code path a
// downloaded https zip theme source resolves through in prepareRecipeSource),
// and a mismatched hash is rejected.
await withTempDir("wp-codebox-extra-theme-local-zip-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "zipped-theme"))
  await zip(recipeDirectory, "zipped-theme.zip", ["zipped-theme"])
  const digest = createHash("sha256").update(await readFile(join(recipeDirectory, "zipped-theme.zip"))).digest("hex")

  const recipe = themeRecipe([{ source: "zipped-theme.zip", slug: "zipped-theme", sha256: digest }])
  assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json")), [])
  const [theme] = await prepareRecipeExtraThemes(recipe, recipeDirectory)
  assert.equal(theme.themeName, "Example Theme")
  assert.equal((await stat(join(theme.source, "style.css"))).isFile(), true)
  assert.deepEqual(theme.provenance.digest, { sha256: digest, expected: digest, verified: true })
  await cleanupRecipePreparedSources([], [], [], [], [], [theme])

  const mismatchedRecipe = themeRecipe([{ source: "zipped-theme.zip", slug: "zipped-theme", sha256: "0".repeat(64) }])
  await assert.rejects(() => prepareRecipeExtraThemes(mismatchedRecipe, recipeDirectory), /sha256 mismatch/)
})

// A theme missing style.css, or with an empty/missing Theme Name header, is
// rejected -- both at prepare-time (real materialization path) and by the
// pre-download-safe local-directory semantic validation pass.
await withTempDir("wp-codebox-extra-theme-missing-contract-", async (recipeDirectory) => {
  await mkdir(join(recipeDirectory, "no-stylesheet"), { recursive: true })
  await writeFile(join(recipeDirectory, "no-stylesheet", "index.php"), "<?php\n")
  const missingStylesheet = themeRecipe([{ source: "no-stylesheet", slug: "no-stylesheet" }])
  await assert.rejects(() => prepareExtraThemes(missingStylesheet.inputs!.extra_themes!, recipeDirectory), /missing style\.css/)
  const missingStylesheetIssues = await validateWorkspaceRecipeSemantics(missingStylesheet, join(recipeDirectory, "recipe.json"))
  assert.ok(missingStylesheetIssues.some((issue) => issue.code === "invalid-theme-contract"))

  await mkdir(join(recipeDirectory, "empty-name"), { recursive: true })
  await writeFile(join(recipeDirectory, "empty-name", "style.css"), "/*\nTheme Name:\n*/\n")
  await writeFile(join(recipeDirectory, "empty-name", "index.php"), "<?php\n")
  const emptyName = themeRecipe([{ source: "empty-name", slug: "empty-name" }])
  await assert.rejects(() => prepareExtraThemes(emptyName.inputs!.extra_themes!, recipeDirectory), /non-empty Theme Name/)

  await mkdir(join(recipeDirectory, "no-entrypoint"), { recursive: true })
  await writeFile(join(recipeDirectory, "no-entrypoint", "style.css"), "/*\nTheme Name: No Entrypoint\n*/\n")
  const noEntrypoint = themeRecipe([{ source: "no-entrypoint", slug: "no-entrypoint" }])
  await assert.rejects(() => prepareExtraThemes(noEntrypoint.inputs!.extra_themes!, recipeDirectory), /missing an entrypoint/)
})

// A remote (https) extra_themes source cannot be content-inspected before it
// is downloaded, so validateWorkspaceRecipeSemantics must not reject it for
// missing style.css/Theme Name at validation time -- that check is deferred
// to prepareExtraThemes, which runs it after materialization.
await withTempDir("wp-codebox-extra-theme-remote-precheck-", async (recipeDirectory) => {
  const remoteRecipe = themeRecipe([{ source: "https://example.test/theme.zip", slug: "remote-theme" }])
  const issues = await validateWorkspaceRecipeSemantics(remoteRecipe, join(recipeDirectory, "recipe.json"))
  assert.ok(!issues.some((issue) => issue.code === "invalid-theme-contract"), "remote sources defer contract inspection past validation time")
  // The download itself is still policy-gated (network downloads disabled by default).
  assert.ok(issues.some((issue) => issue.code === "network-downloads-disabled"))
})

// A child theme whose Template parent is not itself listed in extra_themes
// is rejected.
await withTempDir("wp-codebox-extra-theme-orphan-child-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "child-theme"), { themeName: "Child Theme", template: "missing-parent" })
  const recipe = themeRecipe([{ source: "child-theme", slug: "child-theme" }])
  await assert.rejects(() => prepareRecipeExtraThemes(recipe, recipeDirectory), /Template parent must also be listed/)
})

// A child theme whose Template parent is itself a child theme (not
// standalone) is rejected.
await withTempDir("wp-codebox-extra-theme-grandchild-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "grandparent"), { themeName: "Grandparent" })
  await writeThemeFiles(join(recipeDirectory, "parent"), { themeName: "Parent", template: "grandparent" })
  await writeThemeFiles(join(recipeDirectory, "child"), { themeName: "Child", template: "parent" })
  const recipe = themeRecipe([
    { source: "grandparent", slug: "grandparent" },
    { source: "parent", slug: "parent" },
    { source: "child", slug: "child" },
  ])
  await assert.rejects(() => prepareRecipeExtraThemes(recipe, recipeDirectory), /must be a standalone theme, not itself a child theme/)
})

// A well-formed child theme whose standalone Template parent is also listed
// materializes both themes correctly.
await withTempDir("wp-codebox-extra-theme-valid-child-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "parent-theme"), { themeName: "Parent Theme" })
  await writeThemeFiles(join(recipeDirectory, "child-theme"), { themeName: "Child Theme", template: "parent-theme" })
  const recipe = themeRecipe([
    { source: "parent-theme", slug: "parent-theme" },
    { source: "child-theme", slug: "child-theme", activate: true },
  ])
  assert.deepEqual(await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json")), [])
  const themes = await prepareRecipeExtraThemes(recipe, recipeDirectory)
  const child = themes.find((theme) => theme.slug === "child-theme")
  assert.equal(child?.template, "parent-theme")
  assert.equal(child?.activate, true)
  await cleanupRecipePreparedSources([], [], [], [], [], themes)
})

// At most one active theme is enforced, both by the recipe-shape check
// (immediate, synchronous) and by prepareExtraThemes (the real materialization
// path, which also protects hand-built WorkspaceRecipeExtraTheme[] callers
// that bypass shape validation).
await withTempDir("wp-codebox-extra-theme-multiple-active-", async (recipeDirectory) => {
  await writeThemeFiles(join(recipeDirectory, "theme-a"), { themeName: "Theme A" })
  await writeThemeFiles(join(recipeDirectory, "theme-b"), { themeName: "Theme B" })
  const recipe = themeRecipe([
    { source: "theme-a", slug: "theme-a", activate: true },
    { source: "theme-b", slug: "theme-b", activate: true },
  ])
  assert.throws(() => validateWorkspaceRecipeShape(recipe, join(recipeDirectory, "recipe.json")), /permits at most one active theme/)
  await assert.rejects(() => prepareRecipeExtraThemes(recipe, recipeDirectory), /permits at most one active theme/)
})

console.log("recipe extra theme local/zip source ok")
