import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withTempDir } from "../scripts/test-kit.js"
import {
  COMPOSER_SOURCE_PACKAGE_INSTALL_ARGS,
  compileRecipeTemplate,
  composerManagedHostCommandConfig,
  fixtureImportDeterministicIdPlan,
  prepareRecipeSourcePackageSync,
  sourcePackagePathAllowed,
} from "../packages/runtime-core/src/index.js"

assert.equal(sourcePackagePathAllowed("src/index.php", ["src*"], ["src/secrets*"]), true)
assert.equal(sourcePackagePathAllowed("src/secrets/key.php", ["src*"], ["src/secrets*"]), false)
assert.equal(sourcePackagePathAllowed("src", ["src/index.php"], []), true)

assert.deepEqual(compileRecipeTemplate({ sourcePackages: [{ name: "", source: "./fixture", target: "fixtures/plugin" }] }).blockers.map((blocker) => blocker.code), ["invalid-source-package-name"])

const template = compileRecipeTemplate({
  sourcePackages: [{ name: "fixture", source: "./fixture", target: "fixtures/plugin", allow: ["src*"], artifact: true }],
})
assert.deepEqual(template.blockers, [])
assert.deepEqual(template.sourcePackages[0]?.stagedFile, { source: "./fixture", target: "/workspace/fixtures/plugin" })
assert.equal(template.recipe.inputs?.sourcePackages?.[0]?.target, "fixtures/plugin")
assert.equal(template.recipe.artifacts?.paths?.[0]?.name, "source-package-fixture")
assert.equal(template.recipe.artifacts?.paths?.[0]?.path, "/workspace/fixtures/plugin/.wp-codebox-source-package.json")

const composerPolicy = composerManagedHostCommandConfig({ cwd: process.cwd(), allowedCwdRoots: [process.cwd()], label: "composer policy test" })
assert.equal(composerPolicy.command, "composer")
assert.deepEqual(composerPolicy.inheritedEnv, ["HOME", "COMPOSER_HOME"])
assert.equal(composerPolicy.allowedCwdRoots?.[0], process.cwd())

// Hydration produces an autoloader; it must never execute package-supplied
// code, and must not depend on the host's `allow-plugins` configuration.
// Without `--no-plugins`, any `"type": "wordpress-plugin"` package requiring
// `composer/installers` aborts with a PluginManager error.
assert.ok(composerPolicy.args?.includes("--no-scripts"), "composer hydration must not run package scripts")
assert.ok(composerPolicy.args?.includes("--no-plugins"), "composer hydration must not run Composer plugins")
assert.deepEqual(composerPolicy.args, [...COMPOSER_SOURCE_PACKAGE_INSTALL_ARGS])
assert.ok(COMPOSER_SOURCE_PACKAGE_INSTALL_ARGS.includes("--no-plugins"))

await withTempDir("wp-codebox-composer-source-", async (composerSourceRoot) => {
  await writeFile(join(composerSourceRoot, "composer.json"), JSON.stringify({ name: "example/plugin" }))
  assert.throws(
    () => prepareRecipeSourcePackageSync({ source: composerSourceRoot, slug: "example-plugin", artifactsRoot: "" }),
    /requires Composer dependencies but no artifacts directory/,
  )
})

const deterministicPlan = fixtureImportDeterministicIdPlan({
  type: "fixture",
  name: "content",
  source: "fixtures/content.json",
  format: "json",
  deterministicIds: { strategy: "platform-identifiers", onUnsupported: "block" },
  scopes: { posts: { postTypes: ["page"] } },
}, { posts: [{ id: 42, slug: "home" }] })
assert.equal(deterministicPlan?.schema, "wp-codebox/fixture-import-deterministic-ids/v1")
assert.equal(deterministicPlan?.status, "blocked")
assert.deepEqual(deterministicPlan?.unsupported, [{ scope: "posts", index: 0, field: "id", reason: "Numeric primary-key assignment is not supported by WordPress insert APIs." }])
assert.deepEqual(deterministicPlan?.supportedIdentifiers.posts, ["slug", "post_name"])

const semanticPlan = fixtureImportDeterministicIdPlan({
  type: "fixture",
  name: "content",
  source: "fixtures/content.json",
  deterministicIds: { strategy: "platform-identifiers", onUnsupported: "block" },
  scopes: { posts: { slugs: ["home"] } },
}, { posts: [{ slug: "home" }] })
assert.equal(semanticPlan?.status, "supported")

const numericPlan = fixtureImportDeterministicIdPlan({
  type: "fixture",
  name: "content",
  source: "fixtures/content.json",
  deterministicIds: { strategy: "numeric", onUnsupported: "warn" },
  scopes: { posts: { slugs: ["home"] } },
})
assert.equal(numericPlan?.status, "best_effort")
