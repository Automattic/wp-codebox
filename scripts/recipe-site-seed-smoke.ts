import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-site-seed-smoke")
const recipePath = resolve(workspace, "recipe.json")
const fixtureSeedPath = resolve(workspace, "fixture-seed.json")

mkdirSync(workspace, { recursive: true })
writeFileSync(fixtureSeedPath, `${JSON.stringify({
  posts: [
    {
      post_type: "page",
      slug: "site-seed-smoke-page",
      title: "Site Seed Smoke Page",
      content: "Seeded by WP Codebox siteSeeds.",
      status: "publish",
    },
    {
      post_type: "page",
      slug: "site-seed-smoke-excluded-page",
      title: "Excluded Site Seed Page",
      status: "publish",
    },
  ],
  options: {
    blogname: "WP Codebox Seeded Sandbox",
    admin_email: "private@example.test",
  },
  activePlugins: ["simple-plugin/simple-plugin.php"],
  activeTheme: "twentytwentyfive",
  terms: [
    {
      taxonomy: "category",
      slug: "site-seed-smoke-category",
      name: "Site Seed Smoke Category",
    },
  ],
}, null, 2)}\n`)

writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-site-seed-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    mounts: [
      {
        source: "../../examples/simple-plugin",
        target: "/wordpress/wp-content/plugins/simple-plugin",
        mode: "readonly",
      },
    ],
    siteSeeds: [
      {
        type: "fixture",
        name: "site-seed-smoke-fixture",
        source: "./fixture-seed.json",
        format: "json",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["site-seed-smoke-page"], maxRecords: 1 },
          options: { names: ["blogname"], maxRecords: 1 },
          terms: { taxonomies: ["category"], slugs: ["site-seed-smoke-category"], maxRecords: 1 },
          activePlugins: true,
          activeTheme: true,
        },
      },
      {
        type: "parent_site",
        name: "bounded-parent-declaration",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["front-page"], maxRecords: 1 },
          options: { names: ["blogname"], maxRecords: 1 },
        },
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [
          "code=$page = get_page_by_path('site-seed-smoke-page', OBJECT, 'page'); if (!$page) { throw new RuntimeException('seeded page missing'); } if (get_page_by_path('site-seed-smoke-excluded-page', OBJECT, 'page')) { throw new RuntimeException('unscoped page imported'); } if (get_option('blogname') !== 'WP Codebox Seeded Sandbox') { throw new RuntimeException('seeded option missing'); } if (!term_exists('site-seed-smoke-category', 'category')) { throw new RuntimeException('seeded term missing'); } if (!is_plugin_active('simple-plugin/simple-plugin.php')) { throw new RuntimeException('seeded plugin not active'); } if (get_stylesheet() !== 'twentytwentyfive') { throw new RuntimeException('seeded theme not active: ' . get_stylesheet()); } echo wp_json_encode(array('page' => $page->post_name, 'blogname' => get_option('blogname'), 'pluginActive' => is_plugin_active('simple-plugin/simple-plugin.php'), 'stylesheet' => get_stylesheet()));",
        ],
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
  resolve(workspace, "artifacts"),
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)
const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.siteSeeds.length, 2)
assert.equal(output.siteSeeds[0].action, "imported")
assert.equal(output.siteSeeds[0].privacy.importsIntoSandbox, true)
assert.equal(output.siteSeeds[0].counts.posts, 1)
assert.equal(output.siteSeeds[0].counts.options, 1)
assert.equal(output.siteSeeds[0].counts.terms, 1)
assert.equal(output.siteSeeds[0].counts.activePlugins, 1)
assert.equal(output.siteSeeds[0].counts.activeTheme, 1)
assert.equal(output.siteSeeds[0].counts.fixturePostsExcluded, 1)
assert.equal(output.siteSeeds[0].counts.fixtureActivePluginsIncluded, 1)
assert.equal(output.siteSeeds[0].counts.fixtureActiveThemeIncluded, 1)
assert.equal(output.siteSeeds[1].action, "skipped")
assert.equal(output.siteSeeds[1].bounded, true)
assert.equal(output.siteSeeds[1].privacy.exportsParentSiteData, false)
assert.equal(output.executions.length, 2)

const workflowResult = JSON.parse(output.executions[1].stdout)
assert.equal(workflowResult.page, "site-seed-smoke-page")
assert.equal(workflowResult.blogname, "WP Codebox Seeded Sandbox")
assert.equal(workflowResult.pluginActive, true)
assert.equal(workflowResult.stylesheet, "twentytwentyfive")

console.log("recipe site seed smoke passed")
