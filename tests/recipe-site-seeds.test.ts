import assert from "node:assert/strict"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"

import { importRecipeSiteSeeds } from "../packages/cli/src/commands/recipe-site-seeds.js"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.js"
import type { ExecutionResult, Runtime, WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

await withTempDir("wp-codebox-recipe-site-seeds-", async (recipeDirectory) => {
  const fixturePath = join(recipeDirectory, "content.json")
  await writeFile(fixturePath, JSON.stringify({
    posts: [
      { slug: "home", title: "Home" },
      { slug: "draft", title: "Draft" },
    ],
    options: {
      blogname: "Seeded Site",
      admin_email: "private@example.test",
    },
    users: [
      { login: "fixture-user", role: "subscriber" },
    ],
  }))

  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      siteSeeds: [
        {
          type: "fixture",
          name: "demo-content",
          source: "content.json",
          format: "json",
          deterministicIds: {
            strategy: "platform-identifiers",
            onUnsupported: "block",
          },
          scopes: {
            posts: { slugs: ["home"], maxRecords: 1 },
            options: { names: ["blogname"] },
            users: { names: ["fixture-user"], anonymize: true },
          },
        },
      ],
    },
    workflow: { steps: [] },
  }

  const executions: ExecutionResult[] = []
  const executed: Array<{ command: string; args: string[] }> = []
  const runtime = fakeRuntime(async (spec) => {
    executed.push({ command: spec.command, args: spec.args })
    return {
      id: "seed-import",
      command: spec.command,
      args: spec.args,
      exitCode: 0,
      stdout: JSON.stringify({
        schema: "wp-codebox/site-seed-import/v1",
        name: "demo-content",
        counts: { posts: 1, options: 1, users: 1 },
        warnings: ["fixture warning"],
        provenance: { importer: "json" },
      }),
      stderr: "",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.001Z",
    }
  })

  const siteSeeds = await importRecipeSiteSeeds(recipe, recipeDirectory, runtime, executions)

  assert.equal(executed.length, 1)
  assert.equal(executed[0].command, "wordpress.run-php")
  assert.deepEqual(siteSeeds, [
    {
      index: 0,
      type: "fixture",
      name: "demo-content",
      source: fixturePath,
      format: "json",
      importer: "json",
      deterministicIds: {
        schema: "wp-codebox/fixture-import-deterministic-ids/v1",
        strategy: "platform-identifiers",
        onUnsupported: "block",
        status: "supported",
        supportedIdentifiers: {
          posts: ["slug", "post_name"],
          terms: ["slug", "taxonomy", "name"],
          options: ["name"],
          users: ["user_login", "login", "user_email", "email"],
          media: ["slug", "post_name"],
          activePlugins: ["pluginFile", "file"],
          activeTheme: ["stylesheet", "slug"],
        },
        unsupported: [],
      },
      scopes: recipe.inputs?.siteSeeds?.[0]?.scopes,
      bounded: true,
      privacy: {
        exportsParentSiteData: false,
        importsIntoSandbox: true,
        includesRecordData: true,
        secrets: "excluded-by-default",
      },
      action: "imported",
      counts: {
        fixturePostsIncluded: 1,
        fixturePostsExcluded: 1,
        fixtureOptionsIncluded: 1,
        fixtureOptionsExcluded: 1,
        fixtureTermsIncluded: 0,
        fixtureTermsExcluded: 0,
        fixtureUsersIncluded: 1,
        fixtureUsersExcluded: 0,
        fixtureMediaIncluded: 0,
        fixtureMediaExcluded: 0,
        fixtureActivePluginsIncluded: 0,
        fixtureActivePluginsExcluded: 0,
        fixtureActiveThemeIncluded: 0,
        fixtureActiveThemeExcluded: 0,
        posts: 1,
        options: 1,
        users: 1,
      },
      warnings: ["fixture warning"],
      provenance: {
        importer: "json",
        source: fixturePath,
      },
    },
  ])
  assert.equal(executions[0].recipePhase, "setup")
  assert.equal(executions[0].recipeStepIndex, 0)
})

await withTempDir("wp-codebox-recipe-site-seed-ids-", async (recipeDirectory) => {
  const fixturePath = join(recipeDirectory, "content.json")
  await writeFile(fixturePath, JSON.stringify({ posts: [{ id: 7, slug: "home", title: "Home" }] }))

  const recipe: WorkspaceRecipe = {
    schema: "wp-codebox/workspace-recipe/v1",
    inputs: {
      siteSeeds: [
        {
          type: "fixture",
          name: "numeric-id-content",
          source: "content.json",
          deterministicIds: {
            strategy: "platform-identifiers",
            onUnsupported: "block",
          },
          scopes: {
            posts: { slugs: ["home"] },
          },
        },
      ],
    },
    workflow: { steps: [] },
  }

  const issues = await validateWorkspaceRecipeSemantics(recipe, join(recipeDirectory, "recipe.json"))
  assert.deepEqual(issues.filter((issue) => issue.code === "unsupported-deterministic-site-seed-ids"), [
    {
      code: "unsupported-deterministic-site-seed-ids",
      path: "$.inputs.siteSeeds[0].deterministicIds",
      message: "Fixture import deterministic ID blocker for numeric-id-content: posts[0].id: Numeric primary-key assignment is not supported by WordPress insert APIs.",
    },
  ])
})

function fakeRuntime(execute: Runtime["execute"]): Runtime {
  return {
    info: async () => ({ id: "fake-runtime", backend: "playground", createdAt: "2026-01-01T00:00:00.000Z" }),
    mount: async () => undefined,
    execute,
    observe: async () => ({ id: "observation", kind: "filesystem", result: {} }),
    snapshot: async () => ({ id: "snapshot", createdAt: "2026-01-01T00:00:00.000Z" }),
    collectArtifacts: async () => ({ schema: "wp-codebox/artifact-bundle/v1", root: "", files: [], createdAt: "2026-01-01T00:00:00.000Z" }),
    destroy: async () => undefined,
  } as Runtime
}

console.log("recipe site seeds ok")
