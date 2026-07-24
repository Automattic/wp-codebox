import assert from "node:assert/strict"
import test from "node:test"
import { chromium } from "playwright"

import { getCommandDefinition } from "../packages/runtime-core/src/command-registry.js"
import {
  BROWSER_ACTION_CORPUS_ARTIFACT_SCHEMA,
  BROWSER_ACTION_CORPUS_SCHEMA,
  browserActionCorpusArtifact,
  browserActionCorpusContract,
  planBrowserActionCorpus,
  type BrowserActionCorpusDescriptor,
} from "../packages/runtime-core/src/browser-interaction.js"
import { discoverBrowserActionCorpusDescriptors } from "../packages/runtime-playground/src/browser-actions-runner.js"

const representativeFormDescriptors: BrowserActionCorpusDescriptor[] = [
  { id: "input:#title::Title", kind: "input", selector: "#title", label: "Title", name: "title", type: "text", formId: "post" },
  { id: "textarea:#content::Content", kind: "textarea", selector: "#content", label: "Content", name: "content", formId: "post" },
  { id: "input:#email::Email", kind: "input", selector: "#email", label: "Email", name: "email", type: "email", formId: "post" },
  { id: "select:#status::Status", kind: "select", selector: "#status", label: "Status", name: "status", formId: "post", optionValues: ["draft", "publish"] },
  { id: "button:#save::Save", kind: "button", selector: "#save", label: "Save", type: "submit", formId: "post" },
  { id: "link:#preview::Preview", kind: "link", selector: "#preview", label: "Preview", href: "https://example.test/?preview=true" },
]

test("browser action corpus command contract is public on browser-actions", () => {
  const definition = getCommandDefinition("wordpress.browser-actions")
  const actionCorpusArg = definition?.acceptedArgs.find((arg) => arg.name === "action-corpus-json")

  assert.equal(actionCorpusArg?.format, "JSON object")
  assert.match(actionCorpusArg?.description ?? "", /discovers visible links, buttons, inputs, textareas, and selects/)
})

test("seeded browser action corpus generation is deterministic for a representative form", () => {
  const contract = browserActionCorpusContract({ seed: "admin-form-seed", context: "admin", maxSteps: 5, generatorPrefix: "sample" })
  const first = planBrowserActionCorpus(contract, representativeFormDescriptors)
  const second = planBrowserActionCorpus(contract, representativeFormDescriptors)
  const differentSeed = planBrowserActionCorpus({ ...contract, seed: "different-seed" }, representativeFormDescriptors)

  assert.equal(contract.schema, BROWSER_ACTION_CORPUS_SCHEMA)
  assert.deepEqual(second.steps, first.steps)
  assert.notDeepEqual(differentSeed.steps, first.steps)
  assert.equal(first.status, "planned")
  assert.equal(first.steps.length, 5)
  assert.equal(first.observations.descriptorsDiscovered, representativeFormDescriptors.length)
  assert.ok(first.observations.fillSteps >= 1)
  assert.ok(first.observations.clickSteps + first.observations.selectSteps >= 1)
  assert.ok(first.steps.every((step) => typeof step.selector === "string" && step.selector.length > 0))
  assert.ok(first.steps.filter((step) => step.kind === "fill").every((step) => typeof step.value === "string" && step.value.includes("sample")))
})

test("browser action corpus artifact records replayable steps and correlated observations", () => {
  const capturedAt = "2026-06-29T16:00:00.000Z"
  const artifact = browserActionCorpusArtifact({ seed: "replay-seed", context: "admin", maxSteps: 4, startUrl: "/wp-admin/post-new.php" }, representativeFormDescriptors, capturedAt)

  assert.equal(artifact.schema, BROWSER_ACTION_CORPUS_ARTIFACT_SCHEMA)
  assert.equal(artifact.capturedAt, capturedAt)
  assert.equal(artifact.plan.replay.schema, BROWSER_ACTION_CORPUS_SCHEMA)
  assert.deepEqual(artifact.plan.replay.steps, artifact.plan.steps)
  assert.equal(artifact.plan.replay.descriptorIds.length, artifact.plan.steps.length)
  assert.equal(artifact.plan.observations.stepsPlanned, artifact.plan.steps.length)
  assert.equal(artifact.plan.observations.descriptorsSelected, artifact.plan.replay.descriptorIds.length)
  assert.equal(artifact.plan.replay.startUrl, "/wp-admin/post-new.php")
  assert.ok(artifact.plan.descriptors.some((descriptor) => descriptor.formId === "post"))
})

test("browser action corpus discovery retains only uniquely resolvable deterministic selectors", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <style>a, button, input { display: inline-block; width: 100px; height: 20px; }</style>
      <nav><a href="/shared">Open</a><a href="/news">News</a></nav>
      <main><a href="/shared">Open</a><section><a href="/feature">Feature</a></section></main>
      <form id="primary-form">
        <label>Search <input name="query" type="search"></label>
        <button aria-label='Save "draft" \\ copy' type="button">Save</button>
      </form>
      <form id="secondary-form">
        <label>Search <input name="query" type="search"></label>
        <button aria-label="Save" type="button">Save</button>
      </form>
      <input id="unique-email" name="contact" type="email">
    `)
    // tsx names nested functions with this helper before Playwright serializes page callbacks.
    await page.evaluate("globalThis.__name = value => value")

    const first = await discoverBrowserActionCorpusDescriptors(page)
    const second = await discoverBrowserActionCorpusDescriptors(page)

    assert.deepEqual(second, first)
    assert.equal(first.diagnostics.length, 0)
    assert.ok(first.descriptors.length >= 9)
    assert.ok(first.descriptors.some((descriptor) => descriptor.selector === "#unique-email"))
    assert.equal(new Set(first.descriptors.map((descriptor) => descriptor.id)).size, first.descriptors.length)
    for (const descriptor of first.descriptors) {
      const matches = await page.locator(descriptor.selector).count()
      assert.equal(matches, 1, `${descriptor.selector} must resolve uniquely`)
    }

    const sharedLinks = first.descriptors.filter((descriptor) => descriptor.href?.endsWith("/shared"))
    assert.equal(sharedLinks.length, 2)
    assert.ok(sharedLinks.every((descriptor) => descriptor.selector !== "a:nth-of-type(1)"))
    const repeatedInputs = first.descriptors.filter((descriptor) => descriptor.name === "query")
    assert.equal(repeatedInputs.length, 2)
    assert.equal(new Set(repeatedInputs.map((descriptor) => descriptor.selector)).size, 2)

    const contract = browserActionCorpusContract({ seed: "unique-selector-seed", context: "browser", maxSteps: 9 })
    assert.deepEqual(planBrowserActionCorpus(contract, second.descriptors), planBrowserActionCorpus(contract, first.descriptors))
  } finally {
    await browser.close()
  }
})

test("browser action corpus discovery rejects controls that lose unique identity", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<style>button { width: 100px; height: 20px; }</style><button id="stable">Stable</button><button id="rerendered">Rerendered</button>')
    await page.evaluate("globalThis.__name = value => value")
    await page.evaluate(() => {
      const element = document.querySelector("#rerendered")!
      const getAttribute = element.getAttribute.bind(element)
      element.getAttribute = (name: string) => {
        const value = getAttribute(name)
        if (name === "id") element.remove()
        return value
      }
    })

    const discovery = await discoverBrowserActionCorpusDescriptors(page)

    assert.deepEqual(discovery.descriptors.map((descriptor) => descriptor.selector), ["#stable"])
    assert.equal(discovery.diagnostics.length, 1)
    assert.equal(discovery.diagnostics[0]?.code, "browser_action_corpus_selector_not_unique")
    assert.equal(discovery.diagnostics[0]?.metadata?.label, "Rerendered")
  } finally {
    await browser.close()
  }
})
