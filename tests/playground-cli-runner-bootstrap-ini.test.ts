import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { shouldUseProgrammaticPlaygroundRunner, startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
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
      databaseSetup: "external",
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
    runtimeEnv: { TC_MYSQL_PORT: "33060" },
    artifactsDirectory,
  }

  const server = await startPlaygroundCliServer(spec, [], { cliModule })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]["mount-before-install"]?.length, 2)
  assert.equal(calls[0]["mount-before-install"]?.[0]?.vfsPath, "/internal/wp-codebox")
  // A wordpress-develop checkout is the runtime root, not an ordinary post-startup mount.
  assert.deepEqual(calls[0]["mount-before-install"]?.[1], { hostPath: wordpressDevelopDirectory, vfsPath: "/wordpress" })
  assert.deepEqual(calls[0].mount, [])
  assert.equal(calls[0].workers, 6)
  assert.equal(calls[0].wordpressInstallMode, "do-not-attempt-installing")
  assert.equal(calls[0].skipSqliteSetup, true)
  assert.equal(shouldUseProgrammaticPlaygroundRunner(spec), false)
  assert.deepEqual(calls[0].phpIniEntries, {
    memory_limit: "512M",
    "opcache.file_cache": "/tmp/opcache",
    auto_prepend_file: "/internal/wp-codebox/auto_prepend_file.php",
  })
  assert.deepEqual(calls[0].phpExtension, ["/tmp/sodium/manifest.json"])
  const bootstrapMount = calls[0]["mount-before-install"]?.[0]?.hostPath
  assert.equal(typeof bootstrapMount, "string")
  const autoPrepend = await readFile(join(bootstrapMount as string, "auto_prepend_file.php"), "utf8")
  assert.match(autoPrepend, /putenv\("TC_MYSQL_PORT=33060"\);/)
  assert.match(autoPrepend, /require_once '\/internal\/shared\/auto_prepend_file\.php';/)
  await server[Symbol.asyncDispose]()
  await assert.rejects(stat(bootstrapMount as string), /ENOENT/)

  calls.length = 0
  const defaultRuntimeIniSpec: RuntimeCreateSpec = {
    ...spec,
    environment: { ...spec.environment, databaseSetup: undefined },
    metadata: {},
  }

  const defaultRuntimeIniServer = await startPlaygroundCliServer(defaultRuntimeIniSpec, [], { cliModule })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].phpIniEntries, {
    memory_limit: "512M",
    auto_prepend_file: "/internal/wp-codebox/auto_prepend_file.php",
  })
  assert.equal(calls[0].skipSqliteSetup, false)
  assert.equal(shouldUseProgrammaticPlaygroundRunner(defaultRuntimeIniSpec), true)
  await defaultRuntimeIniServer[Symbol.asyncDispose]()

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

  assert.equal(calls.length, 1)
  const distributionBootstrapMount = calls[0]["mount-before-install"]?.[0]?.hostPath
  assert.equal(typeof distributionBootstrapMount, "string")
  const distributionAutoPrepend = await readFile(join(distributionBootstrapMount as string, "auto_prepend_file.php"), "utf8")
  assert.match(distributionAutoPrepend, /putenv\("WPCOM_BRANCH=feature\/example"\);/)
  assert.match(distributionAutoPrepend, /putenv\("FEATURE_ENABLED=true"\);/)
  assert.match(distributionAutoPrepend, /putenv\("EMPTY_VALUE="\);/)
  assert.match(distributionAutoPrepend, /define\("WPCOM_IS_BRANCH_PREVIEW", true\)/)
  assert.match(distributionAutoPrepend, /define\("WPCOM_BRANCH_ID", 123\)/)
  assert.match(distributionAutoPrepend, /require_once '\/internal\/shared\/auto_prepend_file\.php';/)
  await distributionOnlyServer[Symbol.asyncDispose]()
} finally {
  await rm(wordpressDevelopDirectory, { recursive: true, force: true })
  await rm(artifactsDirectory, { recursive: true, force: true })
}

console.log("playground cli runner bootstrap ini ok")
