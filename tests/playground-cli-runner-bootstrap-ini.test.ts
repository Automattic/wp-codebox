import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { shouldUseProgrammaticPlaygroundRunner, startPlaygroundCliServer, type PlaygroundCliModule } from "../packages/runtime-playground/src/playground-cli-runner.js"
import type { RuntimeCreateSpec } from "../packages/runtime-core/src/index.js"

const wordpressDevelopDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-wordpress-develop-"))
const artifactsDirectory = await mkdtemp(join(tmpdir(), "wp-codebox-artifacts-"))
const calls: Parameters<PlaygroundCliModule["runCLI"]>[0][] = []
const runs: Array<({ code: string } | { scriptPath: string }) & { env?: Record<string, string> }> = []

const cliModule: PlaygroundCliModule = {
  async runCLI(options) {
    calls.push(options)
    return {
      serverUrl: "http://127.0.0.1:65535",
      playground: {
        async run(runOptions) {
          runs.push(runOptions)
          return { text: options.phpEnv?.DB_PASSWORD ?? "" }
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
              memoryLimit: "2G",
              iniEntries: { max_input_vars: 2048 },
              bootstrapIniEntries: { "opcache.file_cache": "/tmp/opcache" },
            },
          },
        },
      },
    },
    runtimeEnv: { TC_MYSQL_PORT: "33060", DB_HOST: "127.0.0.1", DB_PORT: "33061", DB_USER: "runtime", DB_NAME: "runtime" },
    secretEnv: { DB_PASSWORD: "secret" },
    secretEnvTargets: { DB_PASSWORD: "DB_PASSWORD" },
    artifactsDirectory,
  }

  await assert.rejects(startPlaygroundCliServer({
    ...spec,
    metadata: { recipe: { distribution: { name: "shadow", wordpress: { root: "/wordpress" }, env: { DB_PASSWORD: "shadow" } } } },
  }, [], { cliModule }), /collides with injected environment/)
  assert.equal(calls.length, 0, "distribution target shadows fail before Playground startup")

  const server = await startPlaygroundCliServer(spec, [], { cliModule })
  assert.equal((await server.playground.run({ code: "<?php echo getenv('DB_PASSWORD');" })).text, "secret")
  await server[Symbol.asyncDispose]()

  assert.equal(calls.length, 1)
  assert.equal(calls[0]["mount-before-install"]?.length, 4)
  assert.equal(calls[0]["mount-before-install"]?.[0]?.vfsPath, "/internal/shared/php.ini")
  assert.equal(calls[0]["mount-before-install"]?.[1]?.vfsPath, "/internal/shared/wp-codebox-auto-prepend.php")
  // A wordpress-develop checkout is the runtime root, not an ordinary post-startup mount.
  assert.equal(calls[0]["mount-before-install"]?.[2]?.vfsPath, "/wordpress/wp-config.php")
  assert.deepEqual(calls[0]["mount-before-install"]?.[3], { hostPath: wordpressDevelopDirectory, vfsPath: "/wordpress" })
  assert.deepEqual(calls[0].mount, [])
  assert.equal(calls[0].workers, 6)
  assert.equal(calls[0].wordpressInstallMode, "do-not-attempt-installing")
  assert.equal(calls[0].skipSqliteSetup, true)
  assert.equal(calls[0].phpEnv?.DB_PASSWORD, "secret")
  assert.equal(shouldUseProgrammaticPlaygroundRunner(spec), false)
  assert.deepEqual(calls[0].phpIniEntries, { memory_limit: "2G", max_input_vars: "2048" })
  assert.deepEqual(calls[0].phpExtension, ["/tmp/sodium/manifest.json"])
  const sharedPhpIniPath = calls[0]["mount-before-install"]?.[0]?.hostPath
  const sharedAutoPrependPath = calls[0]["mount-before-install"]?.[1]?.hostPath
  assert.equal(typeof sharedPhpIniPath, "string")
  assert.equal(typeof sharedAutoPrependPath, "string")
  const sharedPhpIni = await readFile(sharedPhpIniPath as string, "utf8")
  assert.match(sharedPhpIni, /opcache\.file_cache = \/tmp\/opcache/)
  // The runtime default memory ceiling stays high enough for collect_artifacts to
  // base64 heavy snapshot/declared-artifact files without a hard PHP fatal.
  assert.match(sharedPhpIni, /memory_limit = 2G/)
  assert.match(sharedPhpIni, /auto_prepend_file=\/internal\/shared\/wp-codebox-auto-prepend\.php/)
  const sharedAutoPrepend = await readFile(sharedAutoPrependPath as string, "utf8")
  assert.match(sharedAutoPrepend, /require_once '\/internal\/shared\/auto_prepend_file\.php'/)
  assert.match(sharedAutoPrepend, /putenv\("TC_MYSQL_PORT=33060"\);/)
  const externalWpConfigPath = calls[0]["mount-before-install"]?.[2]?.hostPath
  assert.equal(typeof externalWpConfigPath, "string")
  const externalWpConfig = await readFile(externalWpConfigPath as string, "utf8")
  assert.match(externalWpConfig, /define\('DB_HOST', "127\.0\.0\.1:33061"\)/)
  assert.match(externalWpConfig, /define\('DB_PASSWORD', \(string\) getenv\('DB_PASSWORD'\)\)/)
  assert.doesNotMatch(externalWpConfig, /secret/)

  calls.length = 0
  const passwordlessExternalServer = await startPlaygroundCliServer({ ...spec, secretEnv: {}, secretEnvTargets: {} }, [], { cliModule })
  assert.equal((await passwordlessExternalServer.playground.run({ code: "<?php echo getenv('DB_PASSWORD');" })).text, "", "connector secrets do not leak across runtime instances")
  await passwordlessExternalServer[Symbol.asyncDispose]()
  assert.equal(calls[0]?.phpEnv, undefined)

  calls.length = 0
  const defaultRuntimeIniSpec: RuntimeCreateSpec = {
    ...spec,
    environment: { ...spec.environment, databaseSetup: undefined },
    metadata: {},
  }

  const defaultRuntimeIniServer = await startPlaygroundCliServer(defaultRuntimeIniSpec, [], { cliModule })
  await defaultRuntimeIniServer[Symbol.asyncDispose]()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].phpIniEntries, { memory_limit: "512M" })
  assert.equal(calls[0].skipSqliteSetup, false)
  assert.equal(shouldUseProgrammaticPlaygroundRunner(defaultRuntimeIniSpec), true)

  calls.length = 0
  const downloadedWordPressSpec: RuntimeCreateSpec = {
    ...defaultRuntimeIniSpec,
    environment: {
      ...defaultRuntimeIniSpec.environment,
      version: "latest",
      wordpressInstallMode: undefined,
      assets: undefined,
    },
  }

  const downloadedWordPressServer = await startPlaygroundCliServer(downloadedWordPressSpec, [], { cliModule })
  await downloadedWordPressServer[Symbol.asyncDispose]()

  assert.equal(calls.length, 1)
  assert.equal(calls[0]["mount-before-install"], undefined)
  assert.equal(calls[0].wordpressInstallMode, undefined)
  assert.equal(shouldUseProgrammaticPlaygroundRunner(downloadedWordPressSpec), false)

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
  const distributionAutoPrependPath = calls[0]["mount-before-install"]?.[1]?.hostPath
  assert.equal(typeof distributionAutoPrependPath, "string")
  const distributionAutoPrepend = await readFile(distributionAutoPrependPath as string, "utf8")
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
