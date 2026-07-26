import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_SITE_CONTEXT, parseSiteContexts, resolveSiteContext, resolveSiteContextFromRequest, siteStorageKeys } from "../packages/runtime-cloudflare/src/site-context.js"

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
