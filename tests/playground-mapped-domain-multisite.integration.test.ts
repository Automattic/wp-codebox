import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "wp-codebox-mapped-domain-multisite-"))
const recipePath = join(root, "recipe.json")
const seedPath = join(root, "seed.json")
const pluginPath = join(root, "mapped-topology-fixture.php")
const artifactsPath = join(root, "artifacts")

try {
  await writeFile(seedPath, JSON.stringify({ options: { blogdescription: "mapped topology fixture" } }))
  await writeFile(pluginPath, mappedTopologyFixturePlugin())
  await writeFile(recipePath, `${JSON.stringify(mappedTopologyRecipe())}\n`)

  const output = await runRecipe()
  if (output) {
    assert.equal(output.success, true, JSON.stringify(output))
    const topology = output.siteSeeds?.[0]?.topology
    assert.equal(topology?.effective?.multisite, true)
    assert.equal(topology?.effective?.install, "subdomain")
    assert.deepEqual(topology?.browser?.routeHosts, ["alpha.example.test", "beta.example.test"])
    assert.equal(topology?.auth?.anonymous, "exact")
    assert.equal(topology?.auth?.crossDomainCookieParity, "not-claimed")
    assert.deepEqual(topology?.effective?.sites?.map((site) => `${site.domain}${site.path}`), ["alpha.example.test/", "beta.example.test/"])

    const probes = output.executions?.filter((execution) => execution.command === "wordpress.browser-probe") ?? []
    assert.equal(probes.length, 3)
    const alpha = JSON.parse(probes[0]!.stdout).summary.scriptResult
    const beta = JSON.parse(probes[1]!.stdout).summary.scriptResult
    const redirect = JSON.parse(probes[2]!.stdout)
    assert.deepEqual(alpha, { page: "alpha.example.test", subresource: "alpha.example.test", rest: "alpha.example.test", blogId: 1 })
    assert.deepEqual(beta, { page: "beta.example.test", subresource: "beta.example.test", rest: "beta.example.test", blogId: 2 })
    assert.equal(new URL(redirect.finalUrl).hostname, "beta.example.test")
    assert.deepEqual(redirect.summary.scriptResult, { page: "beta.example.test", subresource: "beta.example.test", rest: "beta.example.test", blogId: 2 })
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

function mappedTopologyRecipe(): Record<string, unknown> {
  const probeScript = `
const rest = await fetch('/wp-json/wp-codebox/v1/mapped-site').then((response) => response.json());
const subresource = await fetch('/mapped-subresource.txt').then((response) => response.text());
return { page: document.body.dataset.domain, subresource, rest: rest.domain, blogId: rest.blogId };`
  return {
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: { backend: "wordpress-playground", wp: "6.5" },
    inputs: {
      stagedFiles: [{ source: pluginPath, target: "/wordpress/wp-content/mu-plugins/mapped-topology-fixture.php" }],
      siteSeeds: [{
        type: "fixture",
        name: "mapped-network",
        source: seedPath,
        scopes: { options: { names: ["blogdescription"] } },
        bootstrap: {
          multisite: {
            enabled: true,
            install: "subdomain",
            sites: [
              { domain: "alpha.example.test", path: "/", title: "Alpha" },
              { domain: "beta.example.test", path: "/", title: "Beta" },
            ],
          },
          domains: [
            { domain: "alpha.example.test", path: "/", primary: true },
            { domain: "beta.example.test", path: "/" },
          ],
        },
      }],
    },
    workflow: {
      steps: [
        { command: "wordpress.browser-probe", args: ["url=http://alpha.example.test/mapped-page", "wait-for=load", `script=${probeScript}`, "capture=html,network"] },
        { command: "wordpress.browser-probe", args: ["url=http://beta.example.test/mapped-page", "wait-for=load", `script=${probeScript}`, "capture=html,network"] },
        { command: "wordpress.browser-probe", args: ["url=http://alpha.example.test/mapped-redirect", "wait-for=load", `script=${probeScript}`, "capture=html,network"] },
      ],
    },
  }
}

function mappedTopologyFixturePlugin(): string {
  return `<?php
add_action('rest_api_init', static function (): void {
    register_rest_route('wp-codebox/v1', '/mapped-site', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => static function (): array {
        return array('blogId' => get_current_blog_id(), 'domain' => wp_parse_url(home_url('/'), PHP_URL_HOST));
    }));
});
add_action('template_redirect', static function (): void {
    $path = wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $domain = wp_parse_url(home_url('/'), PHP_URL_HOST);
    if ('/mapped-redirect' === $path) {
        wp_redirect('http://beta.example.test/mapped-page');
        exit;
    }
    if ('/mapped-subresource.txt' === $path) {
        header('Content-Type: text/plain');
        echo $domain;
        exit;
    }
    if ('/mapped-page' === $path) {
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><body data-domain="' . esc_attr($domain) . '"><link rel="preload" href="/mapped-subresource.txt" as="fetch" crossorigin></body>';
        exit;
    }
});
`
}

async function runRecipe(): Promise<RecipeRunOutput | undefined> {
  try {
    const result = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--artifacts", artifactsPath, "--json"], { cwd: process.cwd(), timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(result.stdout) as RecipeRunOutput
  } catch (error) {
    const output = recipeRunOutput(error && typeof error === "object" && "stdout" in error ? error.stdout : undefined)
    const message = output?.phaseEvidence?.find((phase) => phase.name === "runtime_startup")?.error?.message ?? ""
    if (/Unable to resolve Playground startup asset.*fetch failed|Could not resolve host|network is unreachable/i.test(message)) {
      console.log("playground mapped-domain multisite integration skipped: WordPress runtime source unavailable")
      return undefined
    }
    throw error
  }
}

function recipeRunOutput(value: unknown): RecipeRunOutput | undefined {
  if (typeof value !== "string") return undefined
  try { return JSON.parse(value) as RecipeRunOutput } catch { return undefined }
}

interface RecipeRunOutput {
  success?: boolean
  siteSeeds?: Array<{ topology?: { effective?: { multisite?: boolean; install?: string; sites?: Array<{ domain: string; path: string }> }; browser?: { routeHosts?: string[] }; auth?: { anonymous?: string; crossDomainCookieParity?: string } } }>
  executions?: Array<{ command?: string; stdout: string }>
  phaseEvidence?: Array<{ name?: string; error?: { message?: string } }>
}
