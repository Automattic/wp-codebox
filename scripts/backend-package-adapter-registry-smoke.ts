import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validateWorkspaceRecipeJsonSchema, type WorkspaceRecipe } from "../packages/runtime-core/src/index.js"
import { prepareRecipeRuntimeBackendPackage } from "../packages/cli/src/recipe-backend-package.js"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function assertRejects(operation: () => Promise<unknown>, messageIncludes: string): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(message.includes(messageIncludes), `Expected error to include ${messageIncludes}; got ${message}`)
    return
  }

  throw new Error(`Expected operation to reject with ${messageIncludes}`)
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "wp-codebox-backend-package-"))
  try {
    const packageDirectory = join(root, "playground-backend")
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(join(root, "invalid.js"), "export const notRunCLI = true\n")
    await mkdir(packageDirectory)
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "local-playground-backend", version: "1.2.3", type: "module", exports: "./index.js" }))
    await writeFile(join(packageDirectory, "index.js"), "export async function runCLI() { return { php: { requestHandler: {} } } }\n")

    const genericSchemaResult = validateWorkspaceRecipeJsonSchema({
      schema: "wp-codebox/workspace-recipe/v1",
      runtime: {
        backendPackage: { kind: "future-backend-package", source: "./future", futureOption: true },
      },
      workflow: { steps: [{ command: "wp/version" }] },
    })
    assert(genericSchemaResult.valid, `Expected generic backendPackage schema to accept future kinds: ${JSON.stringify(genericSchemaResult.issues)}`)

    const recipe = {
      schema: "wp-codebox/workspace-recipe/v1",
      runtime: {
        backend: "wordpress-playground",
        backendPackage: { kind: "playground", source: "./playground-backend", package: "local-playground-backend" },
      },
    } satisfies WorkspaceRecipe
    const prepared = await prepareRecipeRuntimeBackendPackage(recipe, root, "wordpress-playground")
    assert(prepared?.provenance.kind === "playground", "Expected Playground backend package provenance kind")
    assert(typeof (prepared.runtimeBackendContext.cliModule as { runCLI?: unknown }).runCLI === "function", "Expected Playground adapter to expose cliModule.runCLI")
    assert(prepared.provenance.diagnostics.some((diagnostic) => diagnostic.message === "Entrypoint exports runCLI"), "Expected Playground runCLI diagnostic")

    await assertRejects(() => prepareRecipeRuntimeBackendPackage({
      schema: "wp-codebox/workspace-recipe/v1",
      runtime: { backendPackage: { kind: "playground", source: "./invalid.js" } },
    }, root, "wordpress-playground"), "must export runCLI")

    await assertRejects(() => prepareRecipeRuntimeBackendPackage({
      schema: "wp-codebox/workspace-recipe/v1",
      runtime: { backendPackage: { kind: "future", source: "./invalid.js" } },
    }, root, "future-runtime"), "Unsupported runtime backend package backend: future-runtime")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
