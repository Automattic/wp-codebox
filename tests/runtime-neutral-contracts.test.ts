import assert from "node:assert/strict"
import {
  normalizeBackendNeutralEnvironmentSpec,
  normalizeBackendNeutralReplaySpec,
  normalizeEnvironmentSpec,
  wordpressEnvironmentToBackendNeutral,
  type BackendNeutralEnvironmentSpec,
  type EnvironmentSpec,
} from "../packages/runtime-core/src/index.js"

const wordpressEnvironment: EnvironmentSpec = {
  kind: "wordpress-playground",
  name: "wp-latest",
  version: "6.8",
  phpVersion: "8.3",
  blueprint: { preferredVersions: { php: "8.3" } },
  wordpressInstallMode: "install-from-existing-files-if-needed",
  assets: {
    directory: "/workspace/site",
    archive: "/tmp/site.zip",
    wordpressDirectory: "/workspace/wordpress",
    wordpressZip: "/tmp/wordpress.zip",
  },
}

assert.deepEqual(normalizeEnvironmentSpec(wordpressEnvironment), wordpressEnvironment)

const neutral: BackendNeutralEnvironmentSpec = wordpressEnvironmentToBackendNeutral(wordpressEnvironment)
assert.deepEqual(neutral, {
  kind: "wordpress-playground",
  name: "wp-latest",
  version: "6.8",
  assets: {
    directory: "/workspace/site",
    archive: "/tmp/site.zip",
  },
})

assert.deepEqual(normalizeBackendNeutralEnvironmentSpec(wordpressEnvironment), neutral)

assert.deepEqual(normalizeBackendNeutralReplaySpec({
  status: "runtime-state-artifact",
  environment: wordpressEnvironment,
  artifactRefs: [{ path: "runtime/state.json", kind: "runtime-state", sha256: "abc123" }],
}), {
  status: "runtime-state-artifact",
  environment: neutral,
  artifactRefs: [{ path: "runtime/state.json", kind: "runtime-state", sha256: "abc123" }],
})

assert.throws(() => normalizeBackendNeutralReplaySpec({ status: "runtime-state-artifact", artifactRefs: "runtime/state.json" }), /replay\.artifactRefs must be an array/)
assert.throws(() => normalizeEnvironmentSpec({ kind: "test", assets: { wordpressDirectory: 123 } }), /environment\.assets\.wordpressDirectory/)

console.log("runtime neutral contract normalization passed")
