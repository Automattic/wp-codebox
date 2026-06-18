import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"

import {
  discoverRuntimePresetRegistryManifests,
  runtimePresetById,
  runtimePresetRegistryManifest,
  runtimePresetRegistryPathList,
} from "../packages/runtime-core/src/index.js"
import { withTempDir } from "../scripts/test-kit.js"

const manifest = runtimePresetRegistryManifest({
  schema: "wp-codebox/runtime-preset-registry/v1",
  presets: [{
    id: "example-provider-runtime",
    label: "Example provider runtime",
    components: [{ source: "./components/example-component", slug: "example-component", capabilities: ["component/example", "component/example"] }],
    provider: {
      plugins: [{ source: "./providers/example-provider", slug: "example-provider", requiredCapabilities: ["wp-ai-client/provider"] }],
      capabilities: ["text-generation"],
    },
    requiredEnv: { runtime: ["WP_ENVIRONMENT_TYPE"], secret: ["EXAMPLE_PROVIDER_API_KEY"] },
    modelDefaults: { provider: "example", model: "example-large", agent: "wp-codebox-sandbox", mode: "sandbox", maxTurns: 6, timeoutSeconds: 120 },
    expectedSchemas: {
      abilityResult: "example/ability-result/v1",
      runtimeTask: { $id: "example/runtime-task/v1", type: "object" },
      artifacts: { report: "example/report/v1" },
    },
    runtimeOverlays: [{ kind: "provider-runtime", library: "example-provider", strategy: "provider-owned-bundle", source: "./overlays/example-provider" }],
  }],
}, { availableCapabilities: ["wp-ai-client/provider"], availableEnv: ["WP_ENVIRONMENT_TYPE", "EXAMPLE_PROVIDER_API_KEY"] })

const preset = runtimePresetById(manifest, "example-provider-runtime")
assert.equal(preset?.provider?.plugins?.[0].slug, "example-provider")
assert.deepEqual(preset?.components?.[0].capabilities, ["component/example"])
assert.equal(preset?.modelDefaults?.model, "example-large")
assert.equal(preset?.runtimeOverlays?.[0].library, "example-provider")

assert.throws(() => runtimePresetRegistryManifest({
  schema: "wp-codebox/runtime-preset-registry/v1",
  presets: [{ id: "duplicate", provider: { requiredCapabilities: ["missing/provider"] } }],
}, { availableCapabilities: ["wp-ai-client/provider"] }), /requires unavailable capabilities/)

assert.throws(() => runtimePresetRegistryManifest({
  schema: "wp-codebox/runtime-preset-registry/v1",
  presets: [{ id: "duplicate" }, { id: "duplicate" }],
}), /duplicate preset id/)

assert.throws(() => runtimePresetRegistryManifest({
  schema: "wp-codebox/runtime-preset-registry/v1",
  presets: [{ id: "bad-env", requiredEnv: { secret: ["not-valid"] } }],
}), /environment variable names/)

await withTempDir("wp-codebox-runtime-presets-", async (root) => {
  const packageRoot = join(root, "provider-package")
  await mkdir(join(packageRoot, "codebox"), { recursive: true })
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ wpCodebox: { runtimePresetRegistry: "codebox/runtime-presets.json" } }))
  await writeFile(join(packageRoot, "codebox", "runtime-presets.json"), JSON.stringify({
    schema: "wp-codebox/runtime-preset-registry/v1",
    presets: [{ id: "package-provider", provider: { plugin: { source: "./provider", slug: "package-provider" } } }],
  }))

  const discovered = discoverRuntimePresetRegistryManifests({ packages: [packageRoot] })
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].manifest.presets[0].id, "package-provider")
})

assert.deepEqual(runtimePresetRegistryPathList(`/one${delimiter}/two`), ["/one", "/two"])

console.log("runtime preset registry ok")
