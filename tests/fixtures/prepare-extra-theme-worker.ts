// Worker invoked as a separate Node process by
// tests/recipe-extra-theme-remote-source.test.ts. A remote https:// recipe
// source can only be trusted by a self-signed test certificate via
// NODE_EXTRA_CA_CERTS, which Node only reads at process startup -- so the
// actual prepareExtraThemes() call against a live local HTTPS server has to
// run in a child process with that env var set before the interpreter
// starts, not by mutating process.env in the parent test process.
import { readFile } from "node:fs/promises"

import { prepareExtraThemes } from "../../packages/cli/src/recipe-sources.js"
import type { WorkspaceRecipeExtraTheme } from "../../packages/runtime-core/src/index.js"

const [, , themesJsonPath, recipeDirectory] = process.argv
if (!themesJsonPath || !recipeDirectory) {
  process.stderr.write("usage: prepare-extra-theme-worker.ts <themes.json> <recipeDirectory>")
  process.exit(2)
}

const themes = JSON.parse(await readFile(themesJsonPath, "utf8")) as WorkspaceRecipeExtraTheme[]

try {
  const prepared = await prepareExtraThemes(themes, recipeDirectory)
  process.stdout.write(JSON.stringify(prepared.map((theme) => ({
    slug: theme.slug,
    themeName: theme.themeName,
    template: theme.template ?? null,
    activate: theme.activate,
    target: theme.target,
    provenance: theme.provenance,
  }))))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
