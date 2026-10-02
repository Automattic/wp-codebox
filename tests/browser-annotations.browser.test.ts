import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { validateBrowserInteractionScript } from "../packages/runtime-core/src/browser-interaction.js"
import { runBrowserActionsCommand } from "../packages/runtime-playground/src/browser-actions-runner.js"
import { wordpressRuntimeSpec } from "../scripts/test-kit.js"

test("annotation shapes and clear validate", () => {
  for (const step of [
    { kind: "annotate", shape: "highlight", selector: "button" },
    { kind: "annotate", shape: "spotlight", selector: "button" },
    { kind: "annotate", shape: "arrow", selector: "button", direction: "bottom-left" },
    { kind: "annotate", shape: "label", text: "Continue", anchor: { selector: "button" } },
    { kind: "annotate", shape: "caption", text: "Next" },
    { kind: "annotate", clear: ["one"] },
    { kind: "annotate", clear: true },
  ]) assert.equal(validateBrowserInteractionScript([step]).valid, true)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "label", text: "x" }]).valid, false)
  assert.equal(validateBrowserInteractionScript([{ kind: "annotate", shape: "arrow", selector: "button", direction: "nearby" }]).valid, false)
})

test("annotation renders in isolated overlay, follows scrolling, passes clicks, and clears by id", async () => {
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end('<button id="target" style="margin-top:900px">press</button><div style="height:2000px"></div>') })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}`
  const fixture = { serverUrl: url, playground: { async run() { return { text: "", exitCode: 0 } } }, async [Symbol.asyncDispose]() {} }
  const artifactRoot = await mkdtemp(join(tmpdir(), "wp-codebox-annotations-"))
  try {
    await runBrowserActionsCommand({ artifactRoot, runtimeSpec: wordpressRuntimeSpec({ commands: ["wordpress.browser-actions"] }), server: fixture, spec: { command: "wordpress.browser-actions", args: [] }, plan: {
      steps: [{ kind: "navigate", url }, { kind: "annotate", id: "focus", shape: "highlight", selector: "#target" }, { kind: "click", selector: "#target" }, { kind: "press", key: "PageDown" }, { kind: "waitFor", waitFor: "duration", duration: "100ms" }, { kind: "annotate", clear: ["focus"] }],
      capture: new Set(["steps"]), stepTimeoutMs: 2000, totalTimeoutMs: 10000, networkSettleTimeoutMs: 100, maxDomSnapshotElements: 20,
    } })
    const records = (await readFile(join(artifactRoot, "files/browser/steps.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(records[1].kind, "annotate")
    assert.equal(records[2].status, "ok", "overlay must not intercept target click")
    assert.equal(records[4].status, "ok", "target scroll should complete while annotation is active")
    assert.equal(records[5].status, "ok", "annotation should clear by id")
  } finally { await rm(artifactRoot, { recursive: true, force: true }); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})
