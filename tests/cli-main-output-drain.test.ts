import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const payload = "x".repeat(1024 * 1024)
const script = `
  import { runCliEntrypoint } from ${JSON.stringify(new URL("../packages/cli/src/cli-main.ts", import.meta.url).href)};
  runCliEntrypoint(["run-agent-task", "--json"], async () => {
    process.stdout.write("x".repeat(${payload.length}));
    return 1;
  });
`

const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
  encoding: "utf8",
  maxBuffer: payload.length * 20,
})

assert.equal(result.error, undefined)
assert.equal(result.signal, null)
assert.equal(result.status, 1, result.stderr)
assert.equal(result.stdout.length, payload.length)
assert.equal(result.stdout, payload)
