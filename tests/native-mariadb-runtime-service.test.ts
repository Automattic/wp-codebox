import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { assertNativeMariaDbEngines, assertNativeMariaDbFilesystemGeometry, assertNativeMariaDbUnprivilegedHost, nativeMariaDbHostReadiness, provisionRuntimeServices, RuntimeServiceProvisionError, runtimeServicePlan, type RuntimeServiceDependencies } from "../packages/cli/src/runtime-services.ts"
import { validateWorkspaceRecipeSemantics } from "../packages/cli/src/recipe-validation.ts"
import { validateWorkspaceRecipeJsonSchema, type WorkspaceRecipeRuntimeService } from "../packages/runtime-core/src/index.ts"

const service: WorkspaceRecipeRuntimeService = {
  id: "native-db",
  kind: "mysql",
  configuration: { provider: "native", engine: "mariadb" },
  outputs: { host: "DB_HOST", port: "DB_PORT", username: "DB_USER", password: "NATIVE_DB_PASSWORD", database: "DB_NAME" },
}

async function assertProcessTerminated(pid: number, message: string): Promise<void> {
  if (process.platform === "linux") {
    try {
      const processStat = await readFile(`/proc/${pid}/stat`, "utf8")
      const commandEnd = processStat.lastIndexOf(")")
      const state = commandEnd >= 0 ? processStat.slice(commandEnd + 2).trim().split(/\s+/)[0] : undefined
      assert.ok(state === "Z" || state === "X" || state === "x", message)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return
  }
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", message)
}

assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [service] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, true)
assert.deepEqual(runtimeServicePlan([service]), [{ id: "native-db", kind: "mysql", provider: "native", version: "mariadb:native", bind: "loopback", port: "ephemeral", persistentVolume: false, configuration: service.configuration, outputs: service.outputs }])
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, configuration: { provider: "native", engine: "mysql" } }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, false)
const forbiddenConfiguration = { ...service, configuration: { ...service.configuration, hostEnv: "PRODUCTION_DB_HOST", image: "mariadb:latest" } }
const forbiddenIssues = await validateWorkspaceRecipeSemantics({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [forbiddenConfiguration] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }, "recipe.json")
assert.equal(forbiddenIssues.filter((issue) => issue.code === "unsupported-native-runtime-service-option").length, 2)
assert.throws(() => assertNativeMariaDbUnprivilegedHost(0), /unprivileged/)
assert.doesNotThrow(() => assertNativeMariaDbUnprivilegedHost(1000))
assert.throws(() => assertNativeMariaDbFilesystemGeometry(1, 1, 256 * 1024 * 1024, 4_096), /geometry/)
assert.throws(() => assertNativeMariaDbFilesystemGeometry(2, 1, 257 * 1024 * 1024, 4_096), /geometry/)
assert.throws(() => assertNativeMariaDbFilesystemGeometry(2, 1, 256 * 1024 * 1024, 4_097), /geometry/)
assert.doesNotThrow(() => assertNativeMariaDbFilesystemGeometry(2, 1, 256 * 1024 * 1024, 4_096))
assert.doesNotThrow(() => assertNativeMariaDbEngines("InnoDB\tDEFAULT\tTransactional\nFEDERATED\tNO\tOutbound\nMEMORY\tYES\tMemory\n"))
assert.throws(() => assertNativeMariaDbEngines("InnoDB\tDEFAULT\tTransactional\nFEDERATED\tYES\tOutbound\n"), /outbound-capable/)
assert.throws(() => assertNativeMariaDbEngines("InnoDB\tNO\tTransactional\n"), /cannot be proven/)
assert.equal(validateWorkspaceRecipeJsonSchema({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, id: "one" }, { ...service, id: "two" }, { ...service, id: "three" }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }).valid, false)
const budgetIssues = await validateWorkspaceRecipeSemantics({ schema: "wp-codebox/workspace-recipe/v1", inputs: { services: [{ ...service, id: "one" }, { ...service, id: "two" }, { ...service, id: "three" }] }, workflow: { steps: [{ command: "wordpress.run-php" }] } }, "recipe.json")
assert.equal(budgetIssues.some((issue) => issue.code === "native-runtime-service-budget-exceeded"), true)

const fixture = await mkdtemp(join(tmpdir(), "wp-codebox-native-provider-fake-"))
const nodeShebang = `#!${process.execPath}`
const serverScript = `${nodeShebang}
const fs = require('node:fs'); const net = require('node:net');
if (process.argv.includes('--version')) { console.log('mariadbd Ver 10.11.14-MariaDB'); process.exit(0); }
const value = (name) => process.argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
const port = Number(value('--port')); const log = value('--log-error'); const socket = value('--socket');
fs.writeFileSync(value('--pid-file'), '1');
fs.writeFileSync(value('--pid-file') + '.actual', String(process.pid));
const server = net.createServer(); server.on('error', (error) => { fs.appendFileSync(log, error.code === 'EADDRINUSE' ? 'address already in use' : 'daemon crash: ' + error.code); process.exit(1); });
server.listen(port, '127.0.0.1'); const timer = setInterval(() => { if (fs.existsSync(socket + '.shutdown')) { clearInterval(timer); server.close(() => process.exit(0)); } }, 10);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
const limiterScript = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "prlimit from util-linux 2.39.3"; exit 0; fi
for arg in "$@"; do case "$arg" in */mariadbd) printf '%s\n' "$@" > "$HOME/daemon-prlimit-args";; esac; done
while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done
shift
exec "$@"
`
const fuseScript = `${nodeShebang}
const fs = require('node:fs'); const mount = process.argv.at(-1);
fs.writeFileSync(mount + '/.fuse.actual', String(process.pid));
const timer = setInterval(() => { if (fs.existsSync(mount + '/.unmount')) { clearInterval(timer); process.exit(0); } }, 10);
process.on('SIGTERM', () => process.exit(0));
`
const initializerScript = `${nodeShebang}
const fs = require('node:fs');
if (process.argv.includes('--help')) { console.log('Usage: mariadb-install-db --auth-root-authentication-method --skip-test-db'); process.exit(0); }
fs.writeFileSync(process.env.HOME + '/initializer-args', process.argv.slice(2).join('\\n'));
`
try {
  for (const name of ["mariadbd", "mariadb-install-db", "mariadb", "prlimit", "truncate", "mkfs.ext4", "fuse2fs", "fusermount3"]) {
    const path = join(fixture, name)
    await writeFile(path, name === "mariadbd" ? serverScript : name === "prlimit" ? limiterScript : name === "fuse2fs" ? fuseScript : name === "mariadb-install-db" ? initializerScript : `${nodeShebang}\nsetInterval(() => {}, 1000)\n`)
    await chmod(path, 0o700)
  }

  const calls: Array<{ command: string; args: string[]; stdin?: string; env?: NodeJS.ProcessEnv }> = []
  const dependencies: RuntimeServiceDependencies = {
    nativeBinaryDirectories: [fixture],
    async verifyNativeFilesystem() {},
    randomBytes: (size) => Buffer.alloc(size, 0x5a),
    async waitForReady() {},
    async execute(command, args, options) {
      calls.push({ command, args, stdin: options.stdin, env: options.env })
      if (basename(command) === "prlimit" && args[0] === "--version") return { stdout: "prlimit from util-linux 2.39.3\n" }
      const separator = basename(command) === "prlimit" ? args.indexOf("--") : -1
      const effectiveCommand = separator >= 0 ? args[separator + 1] ?? command : command
      const effectiveArgs = separator >= 0 ? args.slice(separator + 2) : args
      if (basename(effectiveCommand) === "mariadbd" && effectiveArgs.includes("--version")) return { stdout: "mariadbd Ver 10.11.14-MariaDB\n" }
      if (basename(effectiveCommand) === "mariadb-install-db" && effectiveArgs.includes("--help")) return { stdout: "Usage: mariadb-install-db --auth-root-authentication-method --skip-test-db\n" }
      if (basename(effectiveCommand) === "mariadb" && effectiveArgs.includes("--version")) return { stdout: "mariadb Distrib 10.11.14-MariaDB\n" }
      if (["truncate", "mkfs.ext4", "fuse2fs", "fusermount3"].includes(basename(effectiveCommand)) && effectiveArgs.some((arg) => arg === "--version" || arg === "-V")) return { stdout: `${basename(effectiveCommand)} fixture\n` }
      if (basename(effectiveCommand) === "fusermount3" && effectiveArgs.includes("--unmount")) await writeFile(join(effectiveArgs.at(-1) ?? "", ".unmount"), "")
      if (options.stdin === "SHUTDOWN;\n") {
        const socket = args.find((arg) => arg.startsWith("--socket="))?.slice("--socket=".length)
        assert.ok(socket)
        await writeFile(`${socket}.shutdown`, "")
      }
      if (basename(effectiveCommand) === "mariadb" && options.stdin === "SELECT 1;\n") await new Promise((resolve) => setTimeout(resolve, 200))
      if (options.stdin === "SHOW ENGINES;\n") return { stdout: "InnoDB\tDEFAULT\tTransactional\nFEDERATED\tNO\tOutbound\nMEMORY\tYES\tMemory\n" }
      return { stdout: options.stdin === "SELECT 1;\n" ? "1\n" : "" }
    },
  }

  assert.deepEqual(await nativeMariaDbHostReadiness(dependencies), { status: "ready" })
  assert.equal(calls.every((call) => call.env?.PATH === "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"), true, "native commands ignore the caller PATH")

  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("wp-codebox-mariadb-")))
  const provisioned = await provisionRuntimeServices([service], { dependencies })
  const password = Buffer.alloc(24, 0x5a).toString("base64url")
  assert.equal(provisioned.env.DB_HOST, "127.0.0.1")
  assert.equal(provisioned.env.DB_USER, "runtime")
  assert.equal(provisioned.env.DB_NAME, "runtime")
  assert.equal(provisioned.env.NATIVE_DB_PASSWORD, undefined)
  assert.equal(provisioned.secretEnv.NATIVE_DB_PASSWORD, password)
  assert.deepEqual(provisioned.secretEnvTargets, { DB_PASSWORD: "NATIVE_DB_PASSWORD" })
  assert.equal(JSON.stringify(provisioned.evidence).includes(password), false)
  assert.equal(provisioned.evidence[0]?.provider, "native")
  assert.equal(provisioned.evidence[0]?.memory?.budgetMiB, 2048)
  const daemonInvocation = await readFile(join((await readdir(tmpdir())).filter((name) => name.startsWith("wp-codebox-mariadb-") && !before.has(name)).map((name) => join(tmpdir(), name))[0] ?? "", "storage", "tmp", "daemon-prlimit-args"), "utf8")
  const daemonArgs = daemonInvocation.trim().split("\n")
  const datadir = daemonArgs.find((arg) => arg.startsWith("--datadir="))?.slice("--datadir=".length)
  assert.ok(datadir)
  const initializerArgs = (await readFile(join(dirname(datadir), "tmp", "initializer-args"), "utf8")).trim().split("\n")
  assert.ok(initializerArgs.includes("--no-defaults"))
  assert.ok(initializerArgs.some((arg) => arg === `--datadir=${datadir}`))
  assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith("truncate")) && call.args.includes("268435456")), "the provider creates a fixed 256 MiB backing image")
  assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith("mkfs.ext4")) && call.args.includes("-N") && call.args.includes("4096")), "the provider creates a fixed 4096-inode filesystem")
  assert.ok(daemonArgs.includes("--as=2147483648"))
  assert.ok(daemonArgs.includes("--cpu=300"))
  assert.ok(daemonArgs.includes("--fsize=134217728"))
  assert.ok(daemonArgs.includes("--nofile=512"))
  assert.ok(daemonArgs.includes("--nproc=512"))
  assert.ok(daemonArgs.includes(`--plugin-dir=${join(dirname(datadir), "plugins")}`))
  assert.ok(daemonArgs.includes(`--secure-file-priv=${join(dirname(datadir), "files")}`))
  assert.ok(daemonArgs.every((arg) => !arg.startsWith("--socket=") || arg.startsWith(`--socket=${dirname(datadir)}/runtime/`)))
  assert.equal(daemonArgs.includes(password), false)
  const createUser = calls.find((call) => call.stdin?.includes("CREATE USER"))
  assert.ok(createUser?.stdin?.includes(password), "the generated credential is delivered only over client stdin")
  assert.equal(createUser?.args.includes(password), false)
  await provisioned.release()
  await provisioned.release()
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("wp-codebox-mariadb-") && !before.has(name))
  assert.deepEqual(after, [], "successful release recursively removes every provider-owned root")

  const descendantInitializerScript = `${nodeShebang}
const fs = require('node:fs'); const { spawn } = require('node:child_process');
if (process.argv.includes('--help')) { console.log('Usage: mariadb-install-db --auth-root-authentication-method --skip-test-db'); process.exit(0); }
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.HOME + '/initializer-child-pid', String(child.pid)); child.unref();
`
  await writeFile(join(fixture, "mariadb-install-db"), descendantInitializerScript)
  await chmod(join(fixture, "mariadb-install-db"), 0o700)
  const descendantProvisioned = await provisionRuntimeServices([{ ...service, id: "initializer-descendant" }], { dependencies })
  const descendantRoot = (await readdir(tmpdir())).find((name) => name.startsWith("wp-codebox-mariadb-") && !before.has(name))
  assert.ok(descendantRoot)
  const descendantPid = Number(await readFile(join(tmpdir(), descendantRoot, "storage", "tmp", "initializer-child-pid"), "utf8"))
  await assertProcessTerminated(descendantPid, "initializer descendants are terminated before provisioning continues")
  await descendantProvisioned.release()
  await writeFile(join(fixture, "mariadb-install-db"), initializerScript)
  await chmod(join(fixture, "mariadb-install-db"), 0o700)

  const occupied = createServer()
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
  const address = occupied.address()
  assert.ok(address && typeof address !== "string")
  let allocations = 0
  const collision = await provisionRuntimeServices([service], { dependencies: { ...dependencies, allocateNativePort: async () => ++allocations === 1 ? address.port : 45127 } })
  assert.equal(allocations, 2, "a loopback bind collision allocates a fresh port")
  await collision.release()
  await new Promise<void>((resolve) => occupied.close(() => resolve()))

  const staleLogPort = createServer()
  await new Promise<void>((resolve) => staleLogPort.listen(0, "127.0.0.1", resolve))
  const staleAddress = staleLogPort.address()
  assert.ok(staleAddress && typeof staleAddress !== "string")
  let staleAllocations = 0
  await assert.rejects(provisionRuntimeServices([service], { dependencies: { ...dependencies, allocateNativePort: async () => ++staleAllocations === 1 ? staleAddress.port : 70_000 } }), RuntimeServiceProvisionError)
  assert.equal(staleAllocations, 2, "a stale bind error cannot classify the next daemon crash as retryable")
  await new Promise<void>((resolve) => staleLogPort.close(() => resolve()))

  const concurrent = await Promise.all([provisionRuntimeServices([{ ...service, id: "one" }], { dependencies }), provisionRuntimeServices([{ ...service, id: "two" }], { dependencies })])
  assert.notEqual(concurrent[0].env.DB_PORT, concurrent[1].env.DB_PORT)
  await Promise.all(concurrent.map(async (managed) => await managed.release()))

  for (const phase of ["preflight", "readiness", "administration", "runtime-account"] as const) {
    const phaseCancellation = new AbortController()
    if (phase === "preflight") phaseCancellation.abort()
    const phaseDependencies: RuntimeServiceDependencies = { ...dependencies, async execute(command, args, options) {
      const isSocketReadiness = options.stdin === "SELECT 1;\n" && args.some((arg) => arg === "--protocol=SOCKET")
      const isAdministration = options.stdin?.includes("CREATE DATABASE") === true
      const isRuntimeAccount = options.stdin === "SELECT 1;\n" && args.some((arg) => arg === "--protocol=TCP")
      if ((phase === "readiness" && isSocketReadiness) || (phase === "administration" && isAdministration) || (phase === "runtime-account" && isRuntimeAccount)) phaseCancellation.abort()
      return await dependencies.execute(command, args, options)
    } }
    await assert.rejects(provisionRuntimeServices([{ ...service, id: `cancel-${phase}` }], { dependencies: phaseDependencies, signal: phaseCancellation.signal }), (error: unknown) => error instanceof RuntimeServiceProvisionError && error.evidence[0]?.diagnostic?.code === "interrupted" && error.evidence[0]?.teardown === "completed", `cancellation during ${phase} cleans the private root`)
  }

  const missing: RuntimeServiceDependencies = { ...dependencies, nativeBinaryDirectories: [join(fixture, "missing")] }
  await assert.rejects(provisionRuntimeServices([service], { dependencies: missing }), RuntimeServiceProvisionError)
  assert.deepEqual(await nativeMariaDbHostReadiness({ ...dependencies, nativeBinaryDirectories: [join(fixture, "missing")] }), { status: "unavailable", reason: "trusted-containment-tools-unavailable" })

  const partialConcurrency = await Promise.allSettled([
    provisionRuntimeServices([{ ...service, id: "partial-success" }], { dependencies }),
    provisionRuntimeServices([{ ...service, id: "partial-failure" }], { dependencies: { ...dependencies, nativeBinaryDirectories: [join(fixture, "missing")] } }),
  ])
  const partialSuccesses = partialConcurrency.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof provisionRuntimeServices>>> => result.status === "fulfilled").map((result) => result.value)
  assert.equal(partialSuccesses.length, 1)
  await Promise.allSettled(partialSuccesses.map(async (peer) => await peer.release()))
  assert.equal(partialConcurrency.some((result) => result.status === "rejected"), true)

  let removalAttempts = 0
  const cleanupFailure = await provisionRuntimeServices([service], { dependencies: { ...dependencies, removeNativeRoot: async (root) => {
    removalAttempts += 1
    if (removalAttempts === 1) throw new Error("remove denied")
    await rm(root, { recursive: true, force: false })
  } } })
  const concurrentCleanup = await Promise.allSettled([cleanupFailure.release(), cleanupFailure.release()])
  assert.equal(concurrentCleanup.every((result) => result.status === "rejected"), true)
  assert.equal(removalAttempts, 1, "concurrent cleanup callers share one teardown attempt")
  assert.equal(cleanupFailure.evidence[0]?.teardown, "failed")
  await cleanupFailure.release()
  assert.equal(removalAttempts, 2)
  assert.equal(cleanupFailure.evidence[0]?.teardown, "completed")
  assert.equal(cleanupFailure.evidence[0]?.lifecycle, "released")
  assert.equal(cleanupFailure.evidence[0]?.diagnostic, undefined)

  let stopRoot: string | undefined
  const stopFailureDependencies: RuntimeServiceDependencies = { ...dependencies, signalNativeProcess: () => false, async execute(command, args, options) {
    const stopSocket = args.find((arg) => arg.startsWith("--socket="))?.slice("--socket=".length)
    if (stopSocket) stopRoot = dirname(dirname(dirname(stopSocket)))
    if (options.stdin === "SHUTDOWN;\n") throw new Error("socket shutdown failed")
    return await dependencies.execute(command, args, options)
  } }
  const stopFailure = await provisionRuntimeServices([{ ...service, id: "stop-failure" }], { dependencies: stopFailureDependencies })
  await assert.rejects(stopFailure.release(), /teardown failed/)
  assert.equal(stopFailure.evidence[0]?.teardown, "failed")
  assert.ok(stopRoot)
  const actualPid = Number(await readFile(join(stopRoot, "storage", "runtime", "server.pid.actual"), "utf8"))
  const fusePid = Number(await readFile(join(stopRoot, "storage", ".fuse.actual"), "utf8"))
  assert.doesNotThrow(() => process.kill(actualPid, 0), "failed stop retains a live owned process instead of clearing its handle")
  process.kill(actualPid, "SIGKILL")
  process.kill(fusePid, "SIGKILL")
  await new Promise((resolve) => setTimeout(resolve, 50))
  await rm(stopRoot, { recursive: true, force: true })

  let attackedRoot: string | undefined
  const outside = join(fixture, "outside-sentinel")
  await writeFile(outside, "must survive")
  const symlinkDependencies: RuntimeServiceDependencies = { ...dependencies, async execute(command, args, options) {
    const result = await dependencies.execute(command, args, options)
    const socket = args.find((arg) => arg.startsWith("--socket="))?.slice("--socket=".length)
    if (options.stdin?.includes("CREATE DATABASE") && socket) {
      const storageRoot = dirname(dirname(socket))
      attackedRoot = dirname(storageRoot)
      await symlink(outside, join(storageRoot, "database", "host-path-attack"))
    }
    return result
  } }
  const attacked = await provisionRuntimeServices([service], { dependencies: symlinkDependencies })
  await assert.rejects(attacked.release(), /teardown failed/, "cleanup refuses a symlinked private datadir")
  assert.equal(await import("node:fs/promises").then(async ({ readFile }) => await readFile(outside, "utf8")), "must survive")
  if (attackedRoot) await rm(attackedRoot, { recursive: true, force: true })
} finally {
  await rm(fixture, { recursive: true, force: true })
}

console.log("native MariaDB runtime service fake tests passed")
