import assert from "node:assert/strict"

import {
  BROWSER_REVIEW_DECISION_MESSAGE,
  buildBrowserReviewDecision,
  postBrowserReviewDecision,
  renderBrowserReviewOverlay,
  type BrowserReviewBridgeMetadata,
} from "@chubes4/wp-codebox-core"

class FakeDocument {
  readonly body = new FakeElement("body")

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<() => void>>()
  style = { cssText: "" }
  textContent = ""
  type = ""

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener()
    }
  }

  findButtons(): FakeElement[] {
    return [
      ...(this.tagName === "button" ? [this] : []),
      ...this.children.flatMap((child) => child.findButtons()),
    ]
  }
}

const metadata: BrowserReviewBridgeMetadata = {
  schema: "wp-codebox/browser-review-bridge/v1",
  artifactId: "artifact-bundle-sha256-test",
  sessionId: "session-123",
  approvedFiles: ["/wordpress/wp-content/plugins/example/generated.txt", ""],
  contentDigest: "content-digest-123",
  applyTarget: { repo: "chubes4/wp-codebox" },
  requester: "agent:test",
  context: { source: "smoke" },
  labels: { title: "Custom review", approve: "Ship it", reject: "Nope" },
}

const decision = buildBrowserReviewDecision(metadata, {
  action: "approve",
  approver: "user:1",
  context: { channel: "browser" },
  decidedAt: "2026-06-02T00:00:00.000Z",
})
assert.equal(decision.schema, "wp-codebox/browser-review-decision/v1")
assert.equal(decision.action, "approve")
assert.equal(decision.artifactId, metadata.artifactId)
assert.deepEqual(decision.approvedFiles, ["/wordpress/wp-content/plugins/example/generated.txt"])
assert.deepEqual(decision.applyTarget, { repo: "chubes4/wp-codebox" })
assert.deepEqual(decision.context, { source: "smoke", channel: "browser" })

const messages: Array<{ message: unknown; targetOrigin: string }> = []
const fakeWindow = {
  parent: {
    postMessage(message: unknown, targetOrigin: string) {
      messages.push({ message, targetOrigin })
    },
  },
  postMessage() {
    throw new Error("expected parent.postMessage to be used")
  },
} as unknown as Window

let observedDecision: unknown
postBrowserReviewDecision(
  {
    metadata,
    targetOrigin: "https://parent.example",
    window: fakeWindow,
    onDecision: (payload) => {
      observedDecision = payload
    },
  },
  { action: "reject", reason: "Needs another pass", decidedAt: "2026-06-02T00:00:01.000Z" },
)

assert.equal(messages.length, 1)
assert.equal(messages[0]?.targetOrigin, "https://parent.example")
assert.equal((messages[0]?.message as { type?: string }).type, BROWSER_REVIEW_DECISION_MESSAGE)
assert.equal(((messages[0]?.message as { payload?: { action?: string } }).payload)?.action, "reject")
assert.equal(((messages[0]?.message as { payload?: { reason?: string } }).payload)?.reason, "Needs another pass")
assert.equal(observedDecision, (messages[0]?.message as { payload?: unknown }).payload)

const fakeDocument = new FakeDocument()
const overlay = renderBrowserReviewOverlay({ metadata, document: fakeDocument as unknown as Document, window: fakeWindow, actions: ["approve", "request-changes", "reject"] })
assert.equal(overlay.attributes.get("data-wp-codebox-browser-review"), "true")
assert.equal(fakeDocument.body.children.includes(overlay), true)
assert.deepEqual(
  overlay.findButtons().map((button) => button.textContent),
  ["Ship it", "Request changes", "Nope"],
)

overlay.findButtons()[0]?.click()
assert.equal(messages.length, 2)
assert.equal(((messages[1]?.message as { payload?: { action?: string } }).payload)?.action, "approve")

console.log("Browser review bridge smoke passed")
