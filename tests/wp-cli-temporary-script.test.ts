import assert from "node:assert/strict"
import { runWithTemporaryWpCliScript, shellArgv } from "../packages/runtime-playground/src/wp-cli-command-handlers.js"

class MemoryFilesystem {
  readonly files = new Map<string, string>()
  readonly writtenPaths: string[] = []
  readonly unlinkedPaths: string[] = []

  async writeFile(path: string, contents: string): Promise<void> {
    if (this.files.has(path)) {
      throw new Error(`Could not write to ${JSON.stringify(path)}: File exists.`)
    }
    this.files.set(path, contents)
    this.writtenPaths.push(path)
  }

  unlink(path: string): void {
    this.files.delete(path)
    this.unlinkedPaths.push(path)
  }
}

const oldPaths = Array.from({ length: 16 }, () => "/tmp/wp-codebox-wp-cli-2.php")
assert.equal(new Set(oldPaths).size, 1, "the old command-count suffix reproduces the shared wrapper path")

const filesystem = new MemoryFilesystem()
let invocationCount = 0
for (const { concurrency, iterations, repetitions } of [
  { concurrency: 2, iterations: 128, repetitions: 3 },
  { concurrency: 6, iterations: 256, repetitions: 3 },
  { concurrency: 16, iterations: 512, repetitions: 2 },
  { concurrency: 64, iterations: 1_024, repetitions: 1 },
]) {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const markers = Array.from({ length: iterations }, (_, index) => `marker-${concurrency}-${repetition}-${index.toString().padStart(6, "0")}`)
    const outputs = await runBounded(markers, concurrency, async (marker, index) => {
      invocationCount++
      return runWithTemporaryWpCliScript(
        filesystem,
        "runtime/shared/../../unsafe",
        ["eval", `echo ${JSON.stringify(marker)};`],
        async (scriptPath) => {
          await new Promise((resolve) => setTimeout(resolve, index % 5))
          const script = filesystem.files.get(scriptPath)
          assert.ok(script, `wrapper must exist while ${marker} executes`)
          assert.match(scriptPath, /^\/tmp\/wp-codebox-wp-cli-runtime-shared-------unsafe-[a-f0-9]{32}\.php$/)
          assert.ok(script.includes(marker), `${marker} must execute only its own payload`)
          const otherMarker = markers[(index + 1) % markers.length]
          assert.equal(script.includes(otherMarker), false, `${marker} must not execute ${otherMarker}`)
          return marker
        },
      )
    })
    assert.deepEqual(outputs, markers)
    assert.equal(filesystem.files.size, 0, `concurrency ${concurrency} must return the temp directory to baseline`)
  }
}

assert.equal(new Set(filesystem.writtenPaths).size, invocationCount)
assert.deepEqual(new Set(filesystem.unlinkedPaths), new Set(filesystem.writtenPaths))
assert.throws(() => shellArgv("eval 'unterminated"), /Unclosed quote/, "malformed WP-CLI input must fail before allocating a wrapper")

const nonzero = await runWithTemporaryWpCliScript(filesystem, "runtime-nonzero", ["eval", "exit(7)"], async () => ({ exitCode: 7, text: "", errors: "intentional" }))
assert.deepEqual(nonzero, { exitCode: 7, text: "", errors: "intentional" }, "structured nonzero responses must remain compatible")
assert.equal(filesystem.files.size, 0, "structured nonzero responses must clean up their wrapper")

for (const failure of [
  new Error("wrapper execution failure"),
  new Error("runtime command exceeded timeout"),
  new Error("runtime execution was aborted"),
  new Error("adapter exception"),
]) {
  await assert.rejects(
    runWithTemporaryWpCliScript(filesystem, "runtime-failures", ["eval", "broken"], async () => { throw failure }),
    failure,
  )
  assert.equal(filesystem.files.size, 0, `${failure.message} must clean up its owned wrapper`)
}

let unlinkedAfterRejectedWrite = false
await assert.rejects(
  runWithTemporaryWpCliScript({
    async writeFile() {
      throw new Error("File exists")
    },
    unlink() {
      unlinkedAfterRejectedWrite = true
    },
  }, "runtime-write-failure", ["version"], async () => "unreachable"),
  /File exists/,
)
assert.equal(unlinkedAfterRejectedWrite, false, "a rejected write must not claim or remove another invocation's file")

console.log(`WP-CLI temporary wrapper stress ok: ${invocationCount} isolated invocations at concurrency 2, 6, 16, and 64`)

async function runBounded<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const outputs = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      outputs[index] = await operation(items[index], index)
    }
  }))
  return outputs
}
