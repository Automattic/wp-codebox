import assert from "node:assert/strict"
import test from "node:test"
import { buildWordPressPhpunitRecipe } from "../packages/runtime-core/src/recipe-builders.js"
import { phpunitRunCode } from "../packages/runtime-playground/src/phpunit-command-handlers.js"
import { runPhpunitCommand } from "../packages/runtime-playground/src/wordpress-command-runners.js"
import { recipeHasPhpunitDiscoveryOnly } from "../packages/cli/src/commands/recipe-runtime-setup.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

test("wordpress.phpunit discovery-only returns canonical files before execution", () => {
  const recipe = buildWordPressPhpunitRecipe({
    pluginSlug: "fixture",
    pluginSource: "/workspace/fixture",
    discoveryOnly: true,
  })
  assert.ok(recipe.workflow.steps[0].args.includes("discovery-only=1"))

  const code = phpunitRunCode({
    pluginSlug: "fixture",
    cwd: "/wordpress/wp-content/plugins/fixture",
    autoloadFile: "/wp-codebox-vendor/autoload.php",
    testsDir: "/wp-codebox-vendor/wp-phpunit/wp-phpunit",
    testRoot: "/wordpress/wp-content/plugins/fixture/tests",
    phpunitXml: "/wordpress/wp-content/plugins/fixture/phpunit.xml.dist",
    phpunitXmlIsDefault: false,
    selectedTestFile: "",
    changedTestFiles: [],
    discoveryOnly: true,
    phpunitArgs: [],
    env: {},
    wpConfigDefines: {},
    dependencyMounts: [],
    bootstrapFiles: [],
    bootstrapMode: "managed",
    projectBootstrap: "",
    multisite: false,
    databaseType: "sqlite",
  })

  const discover = code.indexOf("$test_files = wp_codebox_phpunit_discover(")
  const output = code.indexOf("DISCOVERY_RESULT_JSON:", discover)
  const boot = code.indexOf("$config_path = pg_run_boot_stage", output)
  assert.ok(discover >= 0 && output > discover)
  assert.ok(boot > output, "discovery output must terminate before WordPress, component, or test bootstrap")
  assert.match(code, /sort\(\$test_files, SORT_STRING\)/)
  assert.match(code, /'schema' => 'wp-codebox\/phpunit-discovery\/v1'/)
  assert.match(code, /DISCOVERY_RESULT_JSON:/)
  assert.match(code, /\$discovery_only = true;/)
})

test("discovery-only rejects selectors before starting a runtime", async () => {
  let invoked = false
  await assert.rejects(runPhpunitCommand({
    artifactRoot: "/tmp/artifacts",
    mounts: [],
    runPlaygroundCommand: async () => {
      invoked = true
      return { exitCode: 0, errors: "", text: "" }
    },
    runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.phpunit"] }),
    server: {} as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=fixture", "discovery-only=1", "test-file=tests/FixtureTest.php"] },
  }), /discovery-only cannot be combined/)
  assert.equal(invoked, false)
})

test("discovery-only returns its schema-bound result directly", async () => {
  const payload = {
    schema: "wp-codebox/phpunit-discovery/v1",
    plugin_slug: "fixture",
    phpunit_xml: "/wordpress/wp-content/plugins/fixture/phpunit.xml.dist",
    test_root: "/wordpress/wp-content/plugins/fixture/tests",
    selected_testsuites: [],
    files: ["/wordpress/wp-content/plugins/fixture/tests/FixtureTest.php"],
  }
  const output = await runPhpunitCommand({
    artifactRoot: "/tmp/artifacts",
    mounts: [],
    runPlaygroundCommand: async () => ({ exitCode: 0, errors: "", text: "private runtime output" }),
    runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.phpunit"] }),
    server: { playground: { readFileAsText: async () => `DISCOVERY_RESULT_JSON:${JSON.stringify(payload)}\n` } } as never,
    spec: { command: "wordpress.phpunit", args: ["plugin-slug=fixture", "discovery-only=1"] },
  })
  assert.deepEqual(JSON.parse(output), payload)
})

test("recipe setup uses canonical boolean parsing and rejects mixed workflows", () => {
  const recipe = buildWordPressPhpunitRecipe({ pluginSlug: "fixture", discoveryOnly: true })
  const args = recipe.workflow.steps[0].args
  const index = args.indexOf("discovery-only=1")
  args[index] = "discovery-only= true "
  assert.equal(recipeHasPhpunitDiscoveryOnly(recipe), true)

  recipe.workflow.after = [{ command: "wordpress.wp-cli", args: ["command=plugin list"] }]
  assert.throws(() => recipeHasPhpunitDiscoveryOnly(recipe), /must be the recipe's sole workflow step/)
})
