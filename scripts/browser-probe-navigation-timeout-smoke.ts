import assert from "node:assert/strict"

import { navigateBrowserProbe } from "../packages/runtime-playground/src/browser-probe.js"

type GotoCall = {
  readonly url: string
  readonly options: { readonly waitUntil: string; readonly timeout: number }
}

function fakePage() {
  const gotoCalls: GotoCall[] = []
  const waitForCalls: { readonly timeout: number }[] = []

  return {
    page: {
      async goto(url: string, options: GotoCall["options"]) {
        gotoCalls.push({ url, options })
      },
      locator(selector: string) {
        assert.equal(selector, ".ready")
        return {
          first() {
            return {
              async waitFor(options: { readonly timeout: number }) {
                waitForCalls.push(options)
              },
            }
          },
        }
      },
      async waitForTimeout() {},
    },
    gotoCalls,
    waitForCalls,
  }
}

const navigationTimeoutMs = 180_000

{
  const { page, gotoCalls } = fakePage()
  await navigateBrowserProbe(page as never, "http://example.test/", "domcontentloaded", 0, navigationTimeoutMs)
  assert.equal(gotoCalls[0]?.options.timeout, navigationTimeoutMs)
}

{
  const { page, gotoCalls, waitForCalls } = fakePage()
  await navigateBrowserProbe(page as never, "http://example.test/", "selector:.ready", 0, navigationTimeoutMs)
  assert.equal(gotoCalls[0]?.options.timeout, navigationTimeoutMs)
  assert.equal(waitForCalls[0]?.timeout, navigationTimeoutMs)
}

console.log("browser-probe navigation timeout smoke passed")
