import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-fixture-probes-smoke")

rmSync(workspace, { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })

const fixtureSql = resolve(workspace, "fixture.sql")
writeFileSync(fixtureSql, `CREATE TABLE IF NOT EXISTS wp_codebox_fixture_items (id INTEGER PRIMARY KEY, label TEXT);
INSERT INTO wp_codebox_fixture_items (id, label) VALUES (1, 'fixture-row');
`)

const passingRecipe = resolve(workspace, "passing-recipe.json")
writeRecipe(passingRecipe, {
  probes: [
    {
      name: "fixture-count",
      expectJson: true,
      step: {
        command: "wordpress.run-php",
        args: ["code=global $wpdb; $count = (int) $wpdb->get_var('SELECT COUNT(*) FROM wp_codebox_fixture_items'); if (1 !== $count) { throw new RuntimeException('fixture reset failed: ' . $count); } echo wp_json_encode(array('count' => $count));"],
      },
    },
    {
      name: "artifact-writer",
      expectJson: true,
      step: {
        command: "wordpress.run-php",
        args: ["code=$path = '/tmp/wp-codebox-probe-result.json'; file_put_contents($path, wp_json_encode(array('probe' => 'artifact-writer', 'ok' => true))); echo wp_json_encode(array('artifact' => $path));"],
      },
    },
  ],
  artifacts: {
    paths: [
      {
        name: "probe-json",
        path: "/tmp/wp-codebox-probe-result.json",
        parseJson: true,
      },
    ],
  },
})

const passing = runRecipe(passingRecipe)
assert.equal(passing.success, true, passing.error?.message)
assert.equal(passing.fixtureDatabases.length, 2)
assert.equal(passing.fixtureDatabases[0].identity.name, "toy-fixture-db")
assert.equal(passing.fixtureDatabases[0].identity.version, "2026-06-05")
assert.match(passing.fixtureDatabases[0].identity.sourceSha256, /^[a-f0-9]{64}$/)
assert.equal(passing.fixtureDatabases[1].counts.statements, 2)
assert.equal(passing.probes.length, 2)
assert.equal(passing.probes[0].status, "passed")
assert.equal(passing.probes[0].parsedJson.count, 1)
assert.equal(passing.declaredArtifacts[0].status, "collected")
assert.equal(passing.declaredArtifacts[0].parsedJson.ok, true)

const manifest = JSON.parse(readFileSync(resolve(passing.artifacts.directory, "manifest.json"), "utf8"))
assertManifestFile(manifest, "files/runtime-evidence/fixture-databases.json", "fixture-database-results")
assertManifestFile(manifest, "files/runtime-evidence/recipe-probes.json", "recipe-probe-results")
assertManifestFile(manifest, "files/runtime-evidence/recipe-declared-artifacts.json", "recipe-declared-artifact-results")

const fixtureEvidence = JSON.parse(readFileSync(resolve(passing.artifacts.directory, "files/runtime-evidence/fixture-databases.json"), "utf8"))
assert.equal(fixtureEvidence.fixtures[0].identity.version, "2026-06-05")
const probeEvidence = JSON.parse(readFileSync(resolve(passing.artifacts.directory, "files/runtime-evidence/recipe-probes.json"), "utf8"))
assert.equal(probeEvidence.passed, true)
const declaredArtifactEvidence = JSON.parse(readFileSync(resolve(passing.artifacts.directory, "files/runtime-evidence/recipe-declared-artifacts.json"), "utf8"))
assert.equal(declaredArtifactEvidence.passed, true)

const failingProbeRecipe = resolve(workspace, "failing-probe-recipe.json")
writeRecipe(failingProbeRecipe, {
  probes: [
    {
      name: "expects-json",
      expectJson: true,
      step: {
        command: "wordpress.run-php",
        args: ["code=echo 'not json';"],
      },
    },
  ],
})

const failingProbe = runRecipe(failingProbeRecipe, false)
assert.equal(failingProbe.success, false)
assert.equal(failingProbe.error.code, "recipe-probe-failed")
assert.equal(failingProbe.probes[0].status, "failed")
assert.equal(failingProbe.phaseEvidence.some((phase: { name: string }) => phase.name === "run_probes"), true)

const missingArtifactRecipe = resolve(workspace, "missing-artifact-recipe.json")
writeRecipe(missingArtifactRecipe, {
  artifacts: {
    paths: [
      {
        name: "missing-required-artifact",
        path: "/tmp/wp-codebox-missing-artifact.json",
      },
    ],
  },
})

const missingArtifact = runRecipe(missingArtifactRecipe, false)
assert.equal(missingArtifact.success, false)
assert.equal(missingArtifact.error.code, "recipe-artifact-collection-failed")
assert.equal(missingArtifact.declaredArtifacts[0].status, "missing")

const dryRun = runRecipe(passingRecipe, true, ["--dry-run"])
assert.equal(dryRun.success, true)
assert.equal(dryRun.plan.fixtureDatabases.length, 2)
assert.equal(dryRun.plan.probes.length, 2)
assert.equal(dryRun.plan.artifacts.paths.length, 1)

console.log("Recipe fixture/probes smoke passed")

function writeRecipe(path: string, overrides: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      backend: "wordpress-playground",
      name: "recipe-fixture-probes-smoke",
      wp: "7.0",
      blueprint: { steps: [] },
    },
    inputs: {
      fixtureDatabases: [
        fixtureDeclaration(),
        fixtureDeclaration(),
      ],
    },
    workflow: {
      steps: [
        {
          command: "wordpress.run-php",
          args: ["code=echo wp_json_encode(array('workflow' => 'ok'));"],
        },
      ],
    },
    ...overrides,
  }, null, 2)}\n`)
}

function fixtureDeclaration(): Record<string, unknown> {
  return {
    name: "toy-fixture-db",
    version: "2026-06-05",
    source: "./fixture.sql",
    format: "sql",
    reset: {
      strategy: "truncate-tables",
      tables: ["wp_codebox_fixture_items"],
    },
  }
}

function runRecipe(recipePath: string, expectSuccess = true, extraArgs: string[] = []): any {
  const result = spawnSync(process.execPath, [
    cli,
    "recipe-run",
    "--recipe",
    recipePath,
    "--artifacts",
    resolve(workspace, "artifacts", recipePath.split("/").pop() ?? "run"),
    "--json",
    ...extraArgs,
  ], { cwd: root, encoding: "utf8" })

  if (expectSuccess) {
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } else {
    assert.notEqual(result.status, 0, result.stdout)
  }
  assert.ok(result.stdout, result.stderr)
  return JSON.parse(result.stdout)
}

function assertManifestFile(manifest: { files: Array<{ path: string; kind: string }> }, path: string, kind: string): void {
  assert.ok(manifest.files.some((file) => file.path === path && file.kind === kind), `Expected manifest entry ${kind} at ${path}`)
}
