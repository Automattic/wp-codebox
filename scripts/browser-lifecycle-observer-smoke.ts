import assert from "node:assert/strict"
import { createServer } from "node:http"
import vm from "node:vm"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { browserProbeLifecycleInitScript } from "../packages/runtime-playground/src/browser-lifecycle.js"
import { runBrowserProbeCommand } from "../packages/runtime-playground/src/browser-command-runners.js"
import type { PlaygroundCliServer } from "../packages/runtime-playground/src/preview-server.js"

const repoRoot = resolve(import.meta.dirname, "..")
const artifactRoot = resolve(repoRoot, "artifacts", "browser-lifecycle-observer-smoke")

await rm(artifactRoot, { recursive: true, force: true })
await mkdir(artifactRoot, { recursive: true })

smokeEarlyInstallationBeforeDocumentElement()
await smokeDelayedLifecycleMetrics()

console.log(`Browser lifecycle observer smoke passed: ${artifactRoot}`)

function smokeEarlyInstallationBeforeDocumentElement(): void {
  const mutationObservers: Array<{ target?: unknown; options?: unknown; callback: () => void; disconnected: boolean }> = []
  const documentListeners = new Map<string, () => void>()
  let performanceNow = 0
  const delayedElement = fakeElement({ children: [fakeElement(), fakeElement()], iframes: [fakeElement()], buttons: [fakeElement()] })
  const fakeDocument = {
    documentElement: null as null | ReturnType<typeof fakeElement>,
    addEventListener(name: string, callback: () => void) {
      documentListeners.set(name, callback)
    },
    querySelectorAll() {
      return this.documentElement ? [delayedElement] : []
    },
  }
  const context = vm.createContext({
    document: fakeDocument,
    globalThis: {},
    performance: { now: () => performanceNow },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    MutationObserver: class {
      readonly record = { callback: () => undefined, disconnected: false } as { target?: unknown; options?: unknown; callback: () => void; disconnected: boolean }

      constructor(callback: () => void) {
        this.record.callback = callback
        mutationObservers.push(this.record)
      }

      observe(target: unknown, options: unknown) {
        this.record.target = target
        this.record.options = options
      }

      disconnect() {
        this.record.disconnected = true
      }
    },
  })

  assert.doesNotThrow(() => vm.runInContext(browserProbeLifecycleInitScript(["#early"]), context))
  assert.equal(mutationObservers[0]?.target, fakeDocument, "observer should wait on the document when the root is missing")

  performanceNow = 20
  fakeDocument.documentElement = fakeElement()
  mutationObservers[0]?.callback()
  documentListeners.get("DOMContentLoaded")?.()

  const lifecycle = vm.runInContext("globalThis.__wpCodeboxBrowserProbe.collectLifecycle()", context) as {
    selectors: Record<string, { first_seen_ms: number | null; first_visible_ms: number | null; final_child_count: number; final_iframe_count: number; final_button_count: number }>
  }
  assert.equal(lifecycle.selectors["#early"].first_seen_ms, 20)
  assert.equal(lifecycle.selectors["#early"].first_visible_ms, 20)
  assert.equal(lifecycle.selectors["#early"].final_child_count, 2)
  assert.equal(lifecycle.selectors["#early"].final_iframe_count, 1)
  assert.equal(lifecycle.selectors["#early"].final_button_count, 1)
}

async function smokeDelayedLifecycleMetrics(): Promise<void> {
  const httpServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end(`<!doctype html>
      <html>
        <head><title>Lifecycle fixture</title></head>
        <body>
          <script>
            setTimeout(() => {
              const delayed = document.createElement('section');
              delayed.id = 'delayed';
              delayed.innerHTML = '<button>Ready</button><iframe src="about:blank"></iframe>';
              document.body.appendChild(delayed);
            }, 75);
            setTimeout(() => {
              const replacement = document.createElement('section');
              replacement.id = 'replacement';
              replacement.innerHTML = '<button>First</button>';
              document.body.appendChild(replacement);
            }, 125);
            setTimeout(() => {
              document.querySelector('#replacement')?.remove();
              const replacement = document.createElement('section');
              replacement.id = 'replacement';
              replacement.innerHTML = '<button>Second</button><button>Third</button>';
              document.body.appendChild(replacement);
            }, 250);
          </script>
        </body>
      </html>`)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen)
    httpServer.listen(0, "127.0.0.1", () => resolveListen())
  })

  try {
    const address = httpServer.address()
    assert.ok(address && typeof address === "object", "fixture server should expose an address")
    const serverUrl = `http://127.0.0.1:${address.port}`
    const server: PlaygroundCliServer = {
      serverUrl,
      playground: {
        async run() {
          return { text: "" }
        },
      },
      async [Symbol.asyncDispose]() {},
    }

    const result = await runBrowserProbeCommand({
      artifactRoot,
      runtimeSpec: {
        backend: "wordpress-playground",
        environment: { kind: "wordpress", name: "browser-lifecycle-observer-smoke", version: "7.0" },
        policy: {
          network: "deny",
          filesystem: "readwrite-mounts",
          commands: ["wordpress.browser-probe"],
          secrets: "none",
          approvals: "never",
        },
      },
      server,
      spec: {
        command: "wordpress.browser-probe",
        args: [
          "url=/",
          "wait-for=load",
          "duration=700ms",
          "capture=html,console,errors",
          "observe=#delayed,#replacement",
        ],
      },
    })

    assert.equal(result.artifact.files.lifecycle, "files/browser/lifecycle.json")
    assert.equal(existsSync(resolve(artifactRoot, "files", "browser", "lifecycle.json")), true, "lifecycle artifact should be written")

    const delayed = result.artifact.summary.lifecycle?.selectors["#delayed"]
    const replacement = result.artifact.summary.lifecycle?.selectors["#replacement"]
    assert.ok(delayed, "delayed selector should be summarized")
    assert.ok(replacement, "replacement selector should be summarized")
    assert.equal(typeof delayed.first_seen_ms, "number", "delayed element should be observed after load")
    assert.equal(typeof delayed.first_visible_ms, "number", "delayed visible element should be observed")
    assert.equal(delayed.final_iframe_count, 1)
    assert.equal(delayed.final_button_count, 1)
    assert.equal(replacement.removed_count, 1, "replacement should record the removed original element")
    assert.equal(replacement.peak_button_count, 2)
    assert.equal(replacement.final_button_count, 2)

    const summary = JSON.parse(await readFile(resolve(artifactRoot, "files", "browser", "summary.json"), "utf8")) as {
      observe?: string[]
      files?: { lifecycle?: string }
      summary?: { lifecycle?: { selectors?: Record<string, unknown> } }
    }
    assert.deepEqual(summary.observe, ["#delayed", "#replacement"])
    assert.equal(summary.files?.lifecycle, "files/browser/lifecycle.json")
    assert.ok(summary.summary?.lifecycle?.selectors?.["#delayed"], "summary file should include lifecycle metrics")

    const lifecycleArtifact = JSON.parse(await readFile(resolve(artifactRoot, "files", "browser", "lifecycle.json"), "utf8")) as {
      schema?: string
      selectors?: Record<string, unknown>
    }
    assert.equal(lifecycleArtifact.schema, "wp-codebox/browser-lifecycle/v1")
    assert.ok(lifecycleArtifact.selectors?.["#replacement"], "lifecycle artifact should include every observed selector")
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close((error) => error ? rejectClose(error) : resolveClose())
    })
  }
}

function fakeElement(options: { children?: ReturnType<typeof fakeElement>[]; iframes?: ReturnType<typeof fakeElement>[]; buttons?: ReturnType<typeof fakeElement>[] } = {}) {
  return {
    children: options.children ?? [],
    getClientRects: () => [true],
    querySelectorAll(selector: string) {
      if (selector === "iframe") {
        return options.iframes ?? []
      }
      if (selector.includes("button")) {
        return options.buttons ?? []
      }
      return []
    },
  }
}
