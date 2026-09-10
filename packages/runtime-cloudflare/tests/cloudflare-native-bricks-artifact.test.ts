import test from "node:test"
import assert from "node:assert/strict"
import { validateNativeBricksArtifact, stableJson, sha256Hex, MAX_NATIVE_BRICKS_ARTIFACT_BYTES } from "../src/native-bricks-artifact.js"

const hash = "a".repeat(64)
const encoder = new TextEncoder()
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5e8AAAAASUVORK5CYII="
const hashed = async (value: any) => ({ ...value, sha256: await sha256Hex(stableJson(value)) })
const bytes = (value: unknown) => encoder.encode(stableJson(value))
async function fixture(): Promise<any> {
  const imageBytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
  const imageHash = await sha256Hex(imageBytes)
  return {
    schema: "wp-codebox/bricks-site-artifact/v1",
    site: { site_id: "native-fixture", customer_id: "fixture-customer", title: "Fixture", starter_id: "fixture" },
    runtime: { version: "2.4-rc", sha256: hash },
    evidence_inputs: { dossier: { revision: 1, sha256: hash }, creative_provenance: { version: "v1", canonicalCommit: "b".repeat(40), guideSha256: hash, catalogSha256: hash, references: [{ id: "reference-one", sha256: hash }] }, authorized_asset_hashes: [imageHash] },
    design_system: { version: "v1", palette: [{ id: "primary", name: "Primary", value: "#123456" }], typography: { body_font_family: "sans-serif", heading_font_family: "serif", root_font_size: "16px" }, global_classes: [await hashed({ id: "content", name: "content", settings: {} })], global_variables: [await hashed({ id: "color", name: "color", type: "color", value: "#123456" })], theme_style: await hashed({ settings: {} }) },
    documents: { pages: [await hashed({ logical_id: "home", title: "Home", slug: "home", status: "draft", elements: [{ id: "image1", name: "image", settings: { image: { asset_ref: "logo", size: "full" } }, children: [] }] })], templates: [await hashed({ logical_id: "header", title: "Header", type: "header", status: "draft", conditions: [], elements: [{ id: "head1", name: "heading", settings: { text: "Fixture" }, children: [] }] })] },
    assets: [{ logical_id: "logo", filename: "logo.png", mime_type: "image/png", alt_text: "Fixture", content_base64: png, bytes: imageBytes.length, sha256: imageHash }],
    editing: { granularity: "native_bricks_elements", target_role: { role_slug: "editor", required_capabilities: ["edit_pages"] }, acceptance_sequence: ["edit", "publish", "public_observation", "restore", "reopen"] },
  }
}

test("canonical native artifact preserves authored payload and independent runtime identity", async () => {
  const value = await fixture()
  assert.deepEqual(await validateNativeBricksArtifact(bytes(value)), value)
  assert.notEqual(await sha256Hex(bytes(value)), value.runtime.sha256)
  assert.equal(stableJson({ z: 1, a: { d: 3, b: 2 } }), '{"a":{"b":2,"d":3},"z":1}')
})

test("rejects noncanonical, oversized, unknown-field and deeply nested envelopes before execution", async () => {
  const value = await fixture()
  await assert.rejects(validateNativeBricksArtifact(encoder.encode(JSON.stringify(value, null, 2))), /noncanonical/)
  await assert.rejects(validateNativeBricksArtifact(new Uint8Array(MAX_NATIVE_BRICKS_ARTIFACT_BYTES + 1)), /byte limit/)
  await assert.rejects(validateNativeBricksArtifact(bytes({ ...value, extra: true })), /expected fields/)
  let nested: any = {}; for (let i = 0; i < 90; i++) nested = { child: nested }
  value.documents.pages[0].elements[0].settings.extra = nested
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /complexity/)
})

test("rejects changed document, design and media bytes and unbound asset authority", async () => {
  for (const mutate of [
    (v: any) => { v.documents.pages[0].title = "Altered" },
    (v: any) => { v.design_system.theme_style.settings.color = "red" },
    (v: any) => { v.assets[0].sha256 = hash },
    (v: any) => { v.evidence_inputs.authorized_asset_hashes = [hash] },
  ]) { const value = await fixture(); mutate(value); await assert.rejects(validateNativeBricksArtifact(bytes(value)), /hash mismatch|authority mismatch/) }
})

test("rejects unresolved, raw-ID and unused media without substituting foreign assets", async () => {
  let value = await fixture(); value.documents.pages[0].elements[0].settings.image.asset_ref = "missing"
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /unknown asset_ref/)
  value = await fixture(); value.documents.pages[0].elements[0].settings.image.id = 99
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /expected fields/)
  value = await fixture(); const page = value.documents.pages[0]; delete page.sha256; page.elements[0] = { id: "text1", name: "heading", settings: { text: "Hello" }, children: [] }; value.documents.pages[0] = await hashed(page)
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /unused staged asset/)
})

test("rejects duplicate native IDs, unsupported code elements and invalid media files", async () => {
  let value = await fixture(); value.documents.templates[0].elements[0].id = "image1"
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /duplicate element ID/)
  value = await fixture(); value.documents.pages[0].elements[0].name = "code"
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /enum/)
  value = await fixture(); value.assets[0].filename = "../logo.png"
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /filename/)
  value = await fixture(); value.assets[0].mime_type = "image/jpeg"
  await assert.rejects(validateNativeBricksArtifact(bytes(value)), /MIME/)
})
