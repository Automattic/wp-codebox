import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"

const wordpressDevelopDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-wordpress-develop-"))
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-artifacts-"))
const calls: Parameters<PlaygroundCliModule["runCLI"]>[0][] = []

const cliModule: PlaygroundCliModule = {
  async runCLI(options) {
    calls.push(options)
    return {
      serverUrl: "http://127.0.0.1:65535",
      playground: {
        async run() {
          return { text: "" }
        },
      },
      async [Symbol.asyncDispose]() {},
    }
  },
}

try {
  const spec: RuntimeCreateSpec = {
    backend: "wordpress-playground",
    environment: {
      version: "mounted-wordpress-source",
      phpVersion: "8.4",
      wordpressInstallMode: "do-not-attempt-installing",
      assets: { wordpressDirectory: wordpressDevelopDirectory },
      extensions: [{ manifest: "/tmp/sodium/manifest.json" }],
      blueprint: {},
    },
    policy: {
      network: "deny",
      filesystem: "readwrite-mounts",
      commands: ["wordpress.run-php"],
      secrets: "none",
      approvals: "never",
    },
    metadata: {
      recipe: {
        inputs: {
          pluginRuntime: {
            php: {
              iniEntries: { memory_limit: "512M" },
              bootstrapIniEntries: { "opcache.file_cache": "/tmp/opcache" },
            },
          },
        },
      },
    },
    artifactsDirectory,
  }

  const server = await startPlaygroundCliServer(spec, [], { cliModule })
  await server[Symbol.asyncDispose]()

  assert.equal(calls.length, 1)
  assert.equal(calls[0]["mount-before-install"]?.length, 2)
  assert.equal(calls[0]["mount-before-install"]?.[0]?.vfsPath, "/internal/shared")
  // A wordpress-develop checkout is the runtime root, not an ordinary post-startup mount.
  assert.deepEqual(calls[0]["mount-before-install"]?.[1], { hostPath: wordpressDevelopDirectory, vfsPath: "/wordpress" })
  assert.deepEqual(calls[0].mount, [])
  assert.equal(calls[0].workers, 6)
  assert.equal(calls[0].wordpressInstallMode, "do-not-attempt-installing")
  assert.deepEqual(calls[0].phpIniEntries, { memory_limit: "512M" })
  assert.deepEqual(calls[0].phpExtension, ["/tmp/sodium/manifest.json"])
  const sharedMount = calls[0]["mount-before-install"]?.[0]?.hostPath
  assert.equal(typeof sharedMount, "string")
  const sharedPhpIni = await readFile(join(sharedMount as string, "php.ini"), "utf8")
  assert.match(sharedPhpIni, /opcache\.file_cache = \/tmp\/opcache/)
  // The runtime default memory ceiling stays high enough for collect_artifacts to
  // base64 heavy snapshot/declared-artifact files without a hard PHP fatal.
  assert.match(sharedPhpIni, /memory_limit=512M/)
  assert.match(await readFile(join(sharedMount as string, "auto_prepend_file.php"), "utf8"), /<\?php/)
  assert.equal((await stat(join(sharedMount as string, "mu-plugins"))).isDirectory(), true)
  assert.equal((await stat(join(sharedMount as string, "preload"))).isDirectory(), true)

  calls.length = 0
  const defaultRuntimeIniSpec: RuntimeCreateSpec = {
    ...spec,
    metadata: {},
  }

  const defaultRuntimeIniServer = await startPlaygroundCliServer(defaultRuntimeIniSpec, [], { cliModule })
  await defaultRuntimeIniServer[Symbol.asyncDispose]()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].phpIniEntries, { memory_limit: "512M" })

  calls.length = 0
  const distributionOnlySpec: RuntimeCreateSpec = {
    ...spec,
    metadata: {
      recipe: {
        distribution: {
          name: "branch-preview",
          wordpress: { root: "/wordpress" },
          env: { WPCOM_BRANCH: "feature/example", FEATURE_ENABLED: true, EMPTY_VALUE: null },
          constants: { WPCOM_IS_BRANCH_PREVIEW: true, WPCOM_BRANCH_ID: 123 },
        },
      },
    },
  }

  const distributionOnlyServer = await startPlaygroundCliServer(distributionOnlySpec, [], { cliModule })
  await distributionOnlyServer[Symbol.asyncDispose]()

  assert.equal(calls.length, 1)
  const distributionSharedMount = calls[0]["mount-before-install"]?.[0]?.hostPath
  assert.equal(typeof distributionSharedMount, "string")
  const distributionAutoPrepend = await readFile(join(distributionSharedMount as string, "auto_prepend_file.php"), "utf8")
  assert.match(distributionAutoPrepend, /putenv\("WPCOM_BRANCH=feature\/example"\);/)
  assert.match(distributionAutoPrepend, /putenv\("FEATURE_ENABLED=true"\);/)
  assert.match(distributionAutoPrepend, /putenv\("EMPTY_VALUE="\);/)
  assert.match(distributionAutoPrepend, /define\("WPCOM_IS_BRANCH_PREVIEW", true\)/)
  assert.match(distributionAutoPrepend, /define\("WPCOM_BRANCH_ID", 123\)/)
} finally {
  await rm(wordpressDevelopDirectory, { recursive: true, force: true })
  await rm(artifactsDirectory, { recursive: true, force: true })
}

console.log("playground cli runner bootstrap ini ok")
