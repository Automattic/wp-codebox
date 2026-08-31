import assert from "node:assert/strict"
import test from "node:test"
import { allocatePreviewSiteContext, DEFAULT_SITE_CONTEXT, parseSiteContexts, previewDomain, resolvePreviewSiteContextFromRequest, resolveSiteContext, resolveSiteContextFromRequest, siteStorageKeys } from "../src/site-context.js"

test("site contexts preserve default storage paths and isolate configured sites", () => {
  assert.deepEqual(parseSiteContexts(undefined), [DEFAULT_SITE_CONTEXT])
  assert.equal(DEFAULT_SITE_CONTEXT.hostname, "wp-codebox-cloudflare-runtime.chubes.workers.dev")
  assert.equal(DEFAULT_SITE_CONTEXT.origin, "https://wp-codebox-cloudflare-runtime.chubes.workers.dev")
  assert.equal(siteStorageKeys(DEFAULT_SITE_CONTEXT).markdownCurrent, "sites/default/markdown/current.json")
  assert.equal(siteStorageKeys(DEFAULT_SITE_CONTEXT).markdownRevisionPrefix, "sites/default/markdown/revisions")
  assert.equal(siteStorageKeys(DEFAULT_SITE_CONTEXT).markdownObjectPrefix, "sites/default/markdown/objects")
  assert.equal(siteStorageKeys(DEFAULT_SITE_CONTEXT).publishedCurrent, "sites/default/publications/current.json")
  assert.equal(siteStorageKeys(DEFAULT_SITE_CONTEXT).publicationJobPrefix, "sites/default/publications/jobs")
  assert.equal(siteStorageKeys(DEFAULT_SITE_CONTEXT).staticArtifactPrefix, "sites/default/import-artifacts")
  const [first, second] = parseSiteContexts(JSON.stringify([
    { id: "alpha", hostname: "alpha.example.test", origin: "https://alpha.example.test" },
    { id: "beta", hostname: "beta.example.test", origin: "https://beta.example.test" },
  ]))
  assert.notEqual(siteStorageKeys(first).uploadObjectPrefix, siteStorageKeys(second).uploadObjectPrefix)
  assert.equal(resolveSiteContext("alpha.example.test", [first, second]), first)
})

test("site context parser rejects malformed and traversal-like configuration", () => {
  for (const value of [
    "{",
    "[]",
    '[{"id":"../other","hostname":"example.test","origin":"https://example.test"}]',
    '[{"id":"alpha","hostname":"example.test","origin":"https://example.test/path"}]',
    '[{"id":"alpha","hostname":"example.test","origin":"http://example.test"}]',
    '[{"id":"alpha","hostname":"example.test","origin":"https://example.test"},{"id":"beta","hostname":"example.test","origin":"https://example.test"}]',
  ]) assert.throws(() => parseSiteContexts(value))
  assert.doesNotThrow(() => parseSiteContexts('[{"id":"local","hostname":"localhost","origin":"http://localhost"}]'))
  assert.doesNotThrow(() => parseSiteContexts('[{"id":"local-subdomain","hostname":"alpha.localhost","origin":"http://alpha.localhost:8792"}]'))
  assert.doesNotThrow(() => parseSiteContexts('[{"id":"loopback","hostname":"::1","origin":"http://[::1]"}]'))
})

test("site context resolution only accepts exact configured hosts", () => {
  const contexts = parseSiteContexts('[{"id":"alpha","hostname":"alpha.example.test","origin":"https://alpha.example.test"}]')
  assert.equal(resolveSiteContextFromRequest(new Request("https://alpha.example.test/path"), contexts).id, "alpha")
  for (const hostname of ["alpha.example.test.evil.test", "evil-alpha.example.test", "alpha.example.test:443", "ALPHA.example.test"]) {
    assert.throws(() => resolveSiteContext(hostname, contexts), /Unknown site hostname/)
  }
})

test("signed wildcard preview hostnames resolve stably without a registry lookup", async () => {
  const domain = previewDomain("preview.example.test", "preview-host-secret-with-at-least-thirty-two-bytes")!
  const first = await allocatePreviewSiteContext(domain)
  const second = await allocatePreviewSiteContext(domain)
  assert.notEqual(first.id, second.id)
  assert.notEqual(siteStorageKeys(first).root, siteStorageKeys(second).root)
  assert.deepEqual(await resolvePreviewSiteContextFromRequest(new Request(`${first.origin}/`), domain), first)
  for (const hostname of [
    `unknown.preview.example.test`,
    `s${"0".repeat(24)}-g1-${"0".repeat(16)}.preview.example.test`,
    `s${"0".repeat(24)}-g2-${"0".repeat(16)}.preview.example.test`,
    `${first.id}.preview.example.test.evil.test`,
    `nested.${first.id}.preview.example.test`,
  ]) await assert.rejects(() => resolvePreviewSiteContextFromRequest(new Request(`https://${hostname}/`), domain), /Unknown site hostname/)
})
