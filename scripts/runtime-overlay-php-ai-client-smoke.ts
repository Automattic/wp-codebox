import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const workspace = await mkdtemp(join(tmpdir(), "wp-codebox-runtime-overlay-"))

try {
  const source = join(workspace, "php-ai-client")
  await mkdir(join(source, "src"), { recursive: true })
  await mkdir(join(source, "src", "Providers", "Http", "Contracts"), { recursive: true })
  await mkdir(join(source, "vendor", "composer"), { recursive: true })
  await mkdir(join(source, "vendor", "nyholm", "psr7", "src", "Factory"), { recursive: true })
  await mkdir(join(source, "vendor", "psr", "http-client", "src"), { recursive: true })
  await mkdir(join(source, "vendor", "psr", "http-message", "src"), { recursive: true })
  await mkdir(join(source, "vendor", "psr", "simple-cache", "src"), { recursive: true })

  await writeFile(join(source, "src", "AdapterProbe.php"), `<?php
namespace WordPress\\AiClient;

use Nyholm\\Psr7\\Factory\\Psr17Factory;
use Psr\\Http\\Message\\RequestInterface;

final class AdapterProbe {
	public function accepts( RequestInterface $request ): RequestInterface {
		return $request;
	}

	public function factory( Psr17Factory $factory ): Psr17Factory {
		return $factory;
	}
}
`)
  await writeFile(join(source, "src", "Providers", "Http", "Contracts", "ClientWithOptionsInterface.php"), `<?php
namespace WordPress\\AiClient\\Providers\\Http\\Contracts;

interface ClientWithOptionsInterface {}
`)
  await writeFile(join(source, "composer.json"), `${JSON.stringify({
    name: "wordpress/php-ai-client",
    require: {
      "nyholm/psr7": "*",
      "psr/http-client": "*",
      "psr/http-message": "*",
      "psr/simple-cache": "*",
    },
    autoload: { "psr-4": { "WordPress\\AiClient\\": "src/" } },
  }, null, 2)}\n`)
  await writeInstalledJson(source)
  await writeFile(join(source, "vendor", "nyholm", "psr7", "src", "Factory", "Psr17Factory.php"), `<?php
namespace Nyholm\\Psr7\\Factory;

class Psr17Factory {}
`)
  await writeFile(join(source, "vendor", "psr", "http-client", "src", "ClientInterface.php"), `<?php
namespace Psr\\Http\\Client;

interface ClientInterface {}
`)
  await writeFile(join(source, "vendor", "psr", "http-message", "src", "RequestInterface.php"), `<?php
namespace Psr\\Http\\Message;

interface RequestInterface {}
`)
  await writeFile(join(source, "vendor", "psr", "simple-cache", "src", "CacheInterface.php"), `<?php
namespace Psr\\SimpleCache;

interface CacheInterface {}
`)

  const recipePath = join(workspace, "recipe.json")
  const artifacts = join(workspace, "artifacts")
  await writeFile(recipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      wp: "latest",
      overlays: [{
        kind: "bundled-library",
        library: "php-ai-client",
        source,
        target: "/wordpress/wp-content/uploads/php-ai-client-overlay",
        strategy: "wordpress-scoped-bundle",
        metadata: { ref: "overlay-smoke" },
      }],
    },
    workflow: {
      steps: [{
        command: "wordpress.run-php",
        args: ["code=require WP_CONTENT_DIR . '/uploads/php-ai-client-overlay/autoload.php'; $accepts = new ReflectionMethod('WordPress\\\\AiClient\\\\AdapterProbe', 'accepts'); $factory = new ReflectionMethod('WordPress\\\\AiClient\\\\AdapterProbe', 'factory'); echo (string) $accepts->getParameters()[0]->getType() . PHP_EOL; echo (string) $factory->getParameters()[0]->getType() . PHP_EOL; echo interface_exists('WordPress\\\\AiClientDependencies\\\\Psr\\\\Http\\\\Message\\\\RequestInterface') ? 'scoped-interface' : 'missing-interface';"],
      }],
    },
    artifacts: { directory: artifacts },
  }, null, 2)}\n`)

  const dryRun = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--dry-run", "--json"], { cwd: root })
  const dryRunOutput = JSON.parse(dryRun.stdout)
  assert.equal(dryRunOutput.success, true, dryRunOutput.error?.message)
  assert.equal(dryRunOutput.plan.mounts.some((mount: { metadata?: { kind?: string; strategy?: string }; planned?: string }) => mount.metadata?.kind === "runtime-overlay" && mount.metadata.strategy === "wordpress-scoped-bundle" && mount.planned === "generated"), true)

  const failingRecipePath = join(workspace, "failing-recipe.json")
  await writeFile(failingRecipePath, `${JSON.stringify({
    schema: "wp-codebox/workspace-recipe/v1",
    runtime: {
      overlays: [{
        kind: "bundled-library",
        library: "php-ai-client",
        source,
        strategy: "wordpress-scoped-bundle",
      }],
    },
    workflow: { steps: [{ command: "wordpress.run-php", args: ["code=echo 'must not run';"] }] },
  }, null, 2)}\n`)
  await rm(join(source, "vendor", "composer", "installed.json"), { force: true })
  const failing = await recipeRunJson(failingRecipePath, false)
  assert.equal(failing.success, false)
  assert.equal(failing.runtime, undefined, "overlay preparation failures must fail before runtime creation")
  assert.equal(failing.diagnostics[0]?.phase, "overlay-preparation")
  await writeInstalledJson(source)

  const output = await recipeRunJson(recipePath)
  assert.equal(output.success, true, output.error?.message)
  assert.equal(output.executions[0]?.stdout, "WordPress\\AiClientDependencies\\Psr\\Http\\Message\\RequestInterface\nWordPress\\AiClientDependencies\\Nyholm\\Psr7\\Factory\\Psr17Factory\nscoped-interface")

  const metadata = JSON.parse(await readFile(join(output.artifacts.directory, "metadata.json"), "utf8"))
  const overlay = metadata.context.preparedRuntimeOverlays[0]
  assert.equal(overlay.target, "/wordpress/wp-content/uploads/php-ai-client-overlay")
  assert.equal(overlay.metadata.library, "php-ai-client")
  assert.equal(overlay.metadata.strategy, "wordpress-scoped-bundle")
  assert.match(overlay.metadata.digest.sha256, /^[a-f0-9]{64}$/)

  console.log("Runtime overlay php-ai-client smoke passed")
} finally {
  await rm(workspace, { recursive: true, force: true })
}

async function writeInstalledJson(source: string): Promise<void> {
  await writeFile(join(source, "vendor", "composer", "installed.json"), `${JSON.stringify({
    packages: [{
      name: "nyholm/psr7",
      autoload: { "psr-4": { "Nyholm\\Psr7\\": "src/" } },
    }, {
      name: "psr/http-client",
      autoload: { "psr-4": { "Psr\\Http\\Client\\": "src/" } },
    }, {
      name: "psr/http-message",
      autoload: { "psr-4": { "Psr\\Http\\Message\\": "src/" } },
    }, {
      name: "psr/simple-cache",
      autoload: { "psr-4": { "Psr\\SimpleCache\\": "src/" } },
    }],
  }, null, 2)}\n`)
}

async function recipeRunJson(recipePath: string, expectSuccess = true): Promise<any> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["packages/cli/dist/index.js", "recipe-run", "--recipe", recipePath, "--json"], { cwd: root })
    return JSON.parse(stdout)
  } catch (error) {
    if (!expectSuccess && error && typeof error === "object" && "stdout" in error) {
      return JSON.parse(String((error as { stdout: string }).stdout))
    }
    throw error
  }
}
