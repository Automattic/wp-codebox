import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-dry-run-smoke")
const recipePath = resolve(workspace, "recipe.json")
const invalidRecipePath = resolve(workspace, "invalid-recipe.json")
const externalRecipePath = resolve(workspace, "external-recipe.json")
const externalDisabledRecipePath = resolve(workspace, "external-disabled-recipe.json")
const externalUntrustedHostRecipePath = resolve(workspace, "external-untrusted-host-recipe.json")
const externalStrictDigestRecipePath = resolve(workspace, "external-strict-digest-recipe.json")
const legacyExtraPluginsRecipePath = resolve(workspace, "legacy-extra-plugins-recipe.json")
const distributionRecipePath = resolve(workspace, "distribution-recipe.json")
const invalidDistributionRecipePath = resolve(workspace, "invalid-distribution-recipe.json")
const invalidSiteSeedRecipePath = resolve(workspace, "invalid-site-seed-recipe.json")
const fixtureSeedPath = resolve(workspace, "fixture-seed.json")
const fixtureMountPath = resolve(workspace, "fixture-mount.json")
const fixtureMountDir = resolve(workspace, "fixture-mount-dir")
const distributionSourceDir = resolve(workspace, "toy-distribution")
const serviceFakePath = resolve(workspace, "service-fake.php")
const dryRunArtifacts = resolve(workspace, "dry-run-artifacts")
const multisiteCookbookRecipePath = resolve(root, "examples/recipes/cookbook/multisite-network.json")

mkdirSync(workspace, { recursive: true })
mkdirSync(fixtureMountDir, { recursive: true })
mkdirSync(distributionSourceDir, { recursive: true })
writeFileSync(fixtureSeedPath, `${JSON.stringify({ posts: [{ slug: "fixture-page" }] }, null, 2)}\n`)
writeFileSync(fixtureMountPath, `${JSON.stringify({ ok: true }, null, 2)}\n`)
writeFileSync(resolve(distributionSourceDir, "index.php"), "<?php // Toy external distribution fixture.\n")
writeFileSync(serviceFakePath, "<?php file_put_contents('/tmp/toy-service-effects.jsonl', json_encode(['fake' => 'active']) . PHP_EOL, FILE_APPEND);\n")
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "dry-run-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    secretEnv: ["DRY_RUN_TOKEN"],
    workspaces: [
      {
        sourceMode: "site-backed",
        seed: {
          type: "plugin_scaffold",
          slug: "dry-run-plugin",
        },
      },
    ],
    extraPlugins: [
      {
        source: "../../examples/simple-plugin",
        slug: "simple-plugin",
        pluginFile: "simple-plugin/simple-plugin.php",
      },
      {
        source: "../../examples/simple-plugin",
        slug: "simple-runtime",
        pluginFile: "simple-runtime/simple-plugin.php",
        activate: false,
        loadAs: "mu-plugin",
      },
    ],
    siteSeeds: [
      {
        type: "fixture",
        name: "fixture-editorial-shape",
        source: "./fixture-seed.json",
        format: "json",
        scopes: {
          posts: { slugs: ["fixture-page"], maxRecords: 1 },
        },
      },
      {
        type: "parent_site",
        name: "bounded-parent-shape",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["sample-page"], maxRecords: 1 },
          options: { names: ["blogname"], maxRecords: 1 },
          users: { roles: ["administrator"], maxRecords: 1, anonymize: true },
          activePlugins: true,
          activeTheme: true,
        },
      },
    ],
    mounts: [
      {
        type: "file",
        source: "./fixture-mount.json",
        target: "/wordpress/wp-content/plugins/example/fixture-mount.json",
        mode: "readonly",
      },
      {
        source: "./fixture-mount-dir",
        target: "/wordpress/wp-content/plugins/example/fixture-mount-dir",
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'dry run';"],
      },
      {
        command: "wordpress.wp-cli",
        args: ["command=option get home"],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(invalidRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(invalidSiteSeedRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    siteSeeds: [
      {
        type: "parent_site",
        name: "unsafe-parent-users",
        scopes: {
          users: { roles: ["administrator"], anonymize: false },
        },
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'invalid seed';"],
      },
    ],
  },
}, null, 2)}\n`)

const externalRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "external-source-dry-run-smoke",
    wp: "7.0",
  },
  inputs: {
    extraPlugins: [
      {
        source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        pluginFile: "bbpress/bbpress.php",
        activate: false,
      },
      {
        source: "https://example.com/example-plugin.zip",
        slug: "example-plugin",
        pluginFile: "example-plugin/example-plugin.php",
        activate: false,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'external dry run';"],
      },
    ],
  },
}

writeFileSync(externalRecipePath, `${JSON.stringify(externalRecipe, null, 2)}\n`)
writeFileSync(externalDisabledRecipePath, `${JSON.stringify(externalRecipe, null, 2)}\n`)
writeFileSync(legacyExtraPluginsRecipePath, `${JSON.stringify({
  ...externalRecipe,
  inputs: {
    extraPlugins: [
      {
        source: "../../examples/simple-plugin",
        slug: "simple-plugin",
        pluginFile: "simple-plugin/simple-plugin.php",
        activate: false,
      },
    ],
  },
}, null, 2)}\n`)
writeFileSync(externalUntrustedHostRecipePath, `${JSON.stringify({
  ...externalRecipe,
  inputs: {
    extraPlugins: [
      {
        source: "https://evil.example/plugin.zip",
        slug: "evil-plugin",
        pluginFile: "evil-plugin/evil-plugin.php",
      },
    ],
  },
}, null, 2)}\n`)
writeFileSync(externalStrictDigestRecipePath, `${JSON.stringify({
  ...externalRecipe,
  inputs: {
    extraPlugins: [
      {
        source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        pluginFile: "bbpress/bbpress.php",
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(distributionRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  distribution: {
    name: "toy-distribution",
    sourceMounts: [
      {
        source: "./toy-distribution",
        target: "/workspace/toy-distribution",
        mode: "readonly",
        role: "wordpress-root",
        ref: "fixture-ref",
      },
    ],
    wordpress: {
      root: "/workspace/toy-distribution",
      bootstrap: "external",
      config: "wp-config.codebox.php",
      bootstrapFile: "/workspace/toy-distribution/index.php",
    },
    env: {
      TOY_DISTRIBUTION: "1",
    },
    constants: {
      TOY_DISTRIBUTION_BOOT: true,
    },
    serviceFakes: [
      {
        name: "toy-service",
        source: "./service-fake.php",
        load: "pre-bootstrap",
        sideEffectsArtifact: "fake-services/toy-service.jsonl",
      },
    ],
    routeAliases: [
      {
        name: "toy-api",
        host: "api.toy.test",
        path: "/toy-api",
        target: "/wp-json/toy/v1",
        targetType: "wordpress-rest",
      },
    ],
    startupProbes: [
      {
        name: "toy-home",
        type: "http",
        url: "/",
        expectStatus: 200,
      },
      {
        name: "toy-options",
        type: "wp-cli",
        command: "option get home",
      },
    ],
    artifacts: [
      {
        path: "probe-results/toy.json",
        kind: "probe-results",
      },
    ],
    safety: {
      network: "declared",
      allowedHosts: ["api.toy.test"],
      secretEnv: ["TOY_SERVICE_TOKEN"],
    },
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'toy distribution';"],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(invalidDistributionRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  distribution: {
    name: "invalid-distribution",
    wordpress: {
      root: "/workspace/invalid-distribution",
    },
    routeAliases: [
      {
        target: "/wp-json/toy/v1",
      },
    ],
    safety: {
      allowedHosts: ["api.toy.test"],
    },
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'invalid distribution';"],
      },
    ],
  },
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  dryRunArtifacts,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, DRY_RUN_TOKEN: "redacted-value" } })

assert.equal(result.status, 0, result.stderr || result.stdout)
assert.equal(existsSync(dryRunArtifacts), false, "dry-run must not create artifact directories")

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.schema, "wp-codebox/recipe-run-dry-run/v1")
assert.equal(output.dryRun, true)
assert.equal(output.valid, true)
assert.equal(output.plan.runtime.backend, "wordpress-playground")
assert.equal(output.plan.workspaces.length, 1)
assert.equal(output.plan.workspaces[0].generated, true)
assert.equal(output.plan.workspaces[0].source, undefined)
assert.equal(output.plan.workspaces[0].sourceMode, "site-backed")
assert.equal(output.plan.workspaces[0].metadata.workspaceRoot, "/workspace")
assert.equal(output.plan.workspaces[0].metadata.sourceMode, "site-backed")
assert.equal(output.plan.extra_plugins[0].target, "/wordpress/wp-content/plugins/simple-plugin")
assert.equal(output.plan.extra_plugins[0].loadAs, "plugin")
assert.equal(output.plan.extra_plugins[1].target, "/wordpress/wp-content/mu-plugins/wp-codebox-runtime/simple-runtime")
assert.equal(output.plan.extra_plugins[1].loadAs, "mu-plugin")
assert.deepEqual(output.plan.runtime.blueprint.steps[0], {
  step: "setSiteOptions",
  options: { active_plugins: ["simple-plugin/simple-plugin.php"] },
})
assert.equal(output.plan.siteSeeds.length, 2)
assert.equal(output.plan.siteSeeds[0].source, fixtureSeedPath)
assert.equal(output.plan.siteSeeds[0].dryRunOnly, false)
assert.equal(output.plan.siteSeeds[0].privacy.importsIntoSandbox, true)
assert.equal(output.plan.siteSeeds[0].privacy.includesRecordData, true)
assert.equal(output.plan.siteSeeds[1].type, "parent_site")
assert.equal(output.plan.siteSeeds[1].bounded, true)
assert.equal(output.plan.siteSeeds[1].dryRunOnly, true)
assert.equal(output.plan.siteSeeds[1].privacy.exportsParentSiteData, false)
assert.equal(output.plan.siteSeeds[1].privacy.importsIntoSandbox, false)
assert.equal(output.plan.mounts.some((mount: { type: string; source?: string; target: string; mode: string }) => mount.type === "file" && mount.source === fixtureMountPath && mount.target === "/wordpress/wp-content/plugins/example/fixture-mount.json" && mount.mode === "readonly"), true)
assert.equal(output.plan.mounts.some((mount: { type: string; source?: string; target: string; mode: string }) => mount.type === "directory" && mount.source === fixtureMountDir && mount.target === "/wordpress/wp-content/plugins/example/fixture-mount-dir" && mount.mode === "readwrite"), true)
assert.equal(output.plan.secretEnv[0].name, "DRY_RUN_TOKEN")
assert.equal(Object.prototype.hasOwnProperty.call(output.plan.secretEnv[0], "value"), false)
assert.equal(output.plan.secretEnv[0].available, true)
assert.equal(output.plan.workflow.steps.length, 3)
assert.equal(output.plan.workflow.steps[0].command, "install-mu-plugins")
assert.equal(output.plan.workflow.steps[0].policy.status, "allowed")
assert.equal(output.plan.workflow.steps[1].resolvedCommand, "wordpress.run-php")
assert.equal(output.plan.workflow.steps[1].resolvedParsedArgs.code, "echo 'dry run';")
assert.equal(output.plan.workflow.steps[2].parsedArgs.command, "option get home")
assert.equal(output.plan.workflow.steps[2].policy.status, "allowed")
assert.equal(output.runtime, undefined)
assert.equal(output.executions, undefined)
assert.equal(output.artifacts, undefined)

const invalidResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  invalidRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(invalidResult.status, 1, invalidResult.stderr || invalidResult.stdout)
const invalidOutput = JSON.parse(invalidResult.stdout)
assert.equal(invalidOutput.success, false)
assert.equal(invalidOutput.valid, false)
assert.equal(invalidOutput.validation.issues[0].code, "missing-code")

const invalidSiteSeedResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  invalidSiteSeedRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(invalidSiteSeedResult.status, 1, invalidSiteSeedResult.stderr || invalidSiteSeedResult.stdout)
const invalidSiteSeedOutput = JSON.parse(invalidSiteSeedResult.stdout)
assert.equal(invalidSiteSeedOutput.success, false)
assert.equal(invalidSiteSeedOutput.validation.issues.some((issue: { code: string }) => issue.code === "unsafe-site-seed-users"), true)

const externalResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "1", WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS: "downloads.wordpress.org,example.com" } })

assert.equal(externalResult.status, 0, externalResult.stderr || externalResult.stdout)
const externalOutput = JSON.parse(externalResult.stdout)
assert.equal(externalOutput.success, true)
assert.equal(externalOutput.plan.extra_plugins[0].slug, "bbpress")
assert.equal(externalOutput.plan.extra_plugins[0].sourceType, "wporg_plugin_zip")
assert.equal(externalOutput.plan.extra_plugins[0].provenance.resolvedUrl, "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip")
assert.equal(externalOutput.plan.extra_plugins[1].sourceType, "https_zip")
assert.equal(externalOutput.plan.extra_plugins[1].provenance.kind, "https_zip")
assert.equal(externalOutput.plan.extra_plugins[1].provenance.policy.host, "example.com")

const legacyExtraPluginsResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  legacyExtraPluginsRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(legacyExtraPluginsResult.status, 0, legacyExtraPluginsResult.stderr || legacyExtraPluginsResult.stdout)
const legacyExtraPluginsOutput = JSON.parse(legacyExtraPluginsResult.stdout)
assert.equal(legacyExtraPluginsOutput.success, true)
assert.equal(legacyExtraPluginsOutput.plan.extra_plugins.length, 1)
assert.equal(legacyExtraPluginsOutput.plan.extra_plugins[0].slug, "simple-plugin")

const externalUntrustedHostResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalUntrustedHostRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "1" } })

assert.equal(externalUntrustedHostResult.status, 1, externalUntrustedHostResult.stderr || externalUntrustedHostResult.stdout)
const externalUntrustedHostOutput = JSON.parse(externalUntrustedHostResult.stdout)
assert.equal(externalUntrustedHostOutput.success, false)
assert.equal(externalUntrustedHostOutput.validation.issues[0].code, "download-host-not-allowed")

const externalStrictDigestResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalStrictDigestRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "1", WP_CODEBOX_REQUIRE_SOURCE_SHA256: "1" } })

assert.equal(externalStrictDigestResult.status, 1, externalStrictDigestResult.stderr || externalStrictDigestResult.stdout)
const externalStrictDigestOutput = JSON.parse(externalStrictDigestResult.stdout)
assert.equal(externalStrictDigestOutput.success, false)
assert.equal(externalStrictDigestOutput.validation.issues[0].code, "missing-source-sha256")

const externalDisabledResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalDisabledRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "" } })

assert.equal(externalDisabledResult.status, 1, externalDisabledResult.stderr || externalDisabledResult.stdout)
const externalDisabledOutput = JSON.parse(externalDisabledResult.stdout)
assert.equal(externalDisabledOutput.success, false)
assert.equal(externalDisabledOutput.validation.issues[0].code, "network-downloads-disabled")

const distributionResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  distributionRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, TOY_SERVICE_TOKEN: "redacted-value" } })

assert.equal(distributionResult.status, 0, distributionResult.stderr || distributionResult.stdout)
const distributionOutput = JSON.parse(distributionResult.stdout)
assert.equal(distributionOutput.success, true)
assert.equal(distributionOutput.plan.distribution.name, "toy-distribution")
assert.equal(distributionOutput.plan.distribution.wordpress.root, "/workspace/toy-distribution")
assert.equal(distributionOutput.plan.distribution.sourceMounts[0].source, distributionSourceDir)
assert.equal(distributionOutput.plan.distribution.sourceMounts[0].role, "wordpress-root")
assert.equal(distributionOutput.plan.distribution.env.TOY_DISTRIBUTION, "1")
assert.equal(distributionOutput.plan.distribution.constants.TOY_DISTRIBUTION_BOOT, true)
assert.equal(distributionOutput.plan.distribution.serviceFakes[0].source, serviceFakePath)
assert.equal(distributionOutput.plan.distribution.serviceFakes[0].sideEffectsArtifact, "fake-services/toy-service.jsonl")
assert.equal(distributionOutput.plan.distribution.routeAliases[0].host, "api.toy.test")
assert.equal(distributionOutput.plan.distribution.startupProbes[1].command, "wordpress.wp-cli")
assert.equal(distributionOutput.plan.distribution.startupProbes[1].args[0], "command=option get home")
assert.equal(distributionOutput.plan.distribution.artifacts[0].path, "probe-results/toy.json")
assert.equal(distributionOutput.plan.distribution.safety.secretEnv[0].name, "TOY_SERVICE_TOKEN")
assert.equal(distributionOutput.plan.distribution.safety.secretEnv[0].available, true)
assert.equal(Object.prototype.hasOwnProperty.call(distributionOutput.plan.distribution.safety.secretEnv[0], "value"), false)
assert.equal(distributionOutput.plan.distribution.safety.ambientSecrets, false)
assert.equal(distributionOutput.plan.mounts.some((mount: { target: string; metadata?: { kind?: string; role?: string } }) => mount.target === "/workspace/toy-distribution" && mount.metadata?.kind === "distribution-source-mount" && mount.metadata?.role === "wordpress-root"), true)

const invalidDistributionResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  invalidDistributionRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(invalidDistributionResult.status, 1, invalidDistributionResult.stderr || invalidDistributionResult.stdout)
const invalidDistributionOutput = JSON.parse(invalidDistributionResult.stdout)
assert.equal(invalidDistributionOutput.success, false)
assert.equal(invalidDistributionOutput.validation.issues.some((issue: { code: string }) => issue.code === "missing-route-alias-source"), true)
assert.equal(invalidDistributionOutput.validation.issues.some((issue: { code: string }) => issue.code === "undeclared-distribution-network"), true)

const multisiteCookbookResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  multisiteCookbookRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(multisiteCookbookResult.status, 0, multisiteCookbookResult.stderr || multisiteCookbookResult.stdout)
const multisiteCookbookOutput = JSON.parse(multisiteCookbookResult.stdout)
assert.equal(multisiteCookbookOutput.success, true)
assert.equal(multisiteCookbookOutput.plan.mounts.length, 2)
assert.equal(multisiteCookbookOutput.plan.mounts[0].target, "/wordpress/wp-content/plugins/plugin-under-test")
assert.equal(multisiteCookbookOutput.plan.mounts[1].target, "/tmp/wp-codebox-cookbook")
assert.equal(multisiteCookbookOutput.plan.workflow.steps.length, 2)
assert.equal(multisiteCookbookOutput.plan.workflow.steps[0].resolvedParsedArgs.command, "wp core multisite-convert --title=\"WP Codebox Network\" --base=\"/\"")
assert.equal(multisiteCookbookOutput.plan.workflow.steps[1].resolvedParsedArgs.command, "wp eval-file /tmp/wp-codebox-cookbook/multisite-network-seed.php")

console.log("recipe dry-run smoke passed")
