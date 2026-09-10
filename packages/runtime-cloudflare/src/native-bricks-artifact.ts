/** Immutable native document envelope shared with Build's bricks-site-artifact/v1 producer. */
export const MAX_NATIVE_BRICKS_ARTIFACT_BYTES = 12 * 1024 * 1024
const MAX_MEDIA_BYTES = 8 * 1024 * 1024
const ids = /^[A-Za-z0-9_-]{1,160}$/u
const hashes = /^[a-f0-9]{64}$/u
type JsonObject = Record<string, unknown>
export interface NativeBricksElement { id: string; name: string; settings: JsonObject; children: NativeBricksElement[] }
interface NativeDocument { logical_id: string; title: string; status: "draft" | "publish"; elements: NativeBricksElement[]; sha256: string }
export interface NativeBricksArtifact {
  schema: "wp-codebox/bricks-site-artifact/v1"
  site: { site_id: string; customer_id: string; title: string; starter_id: string }
  runtime: { version: string; sha256: string }
  evidence_inputs: {
    dossier: { revision: number; sha256: string }
    creative_provenance: { version: string; canonicalCommit: string; guideSha256: string; catalogSha256: string; references: { id: string; sha256: string }[] }
    authorized_asset_hashes: string[]
  }
  design_system: {
    version: string; palette: { id: string; name: string; value: string }[]
    typography: { body_font_family: string; heading_font_family: string; root_font_size: string }
    global_classes: { id: string; name: string; settings: JsonObject; sha256: string }[]
    global_variables: { id: string; name: string; type: "color" | "number" | "string"; value: string; sha256: string }[]
    theme_style: { settings: JsonObject; sha256: string }
  }
  documents: { pages: (NativeDocument & { slug: string })[]; templates: (NativeDocument & { type: "header" | "footer" | "section" | "single" | "archive"; conditions: JsonObject[] })[] }
  assets: { logical_id: string; filename: string; mime_type: "image/png" | "image/jpeg" | "image/webp"; alt_text: string; sha256: string; bytes: number; content_base64: string }[]
  editing: { granularity: "native_bricks_elements"; target_role: { role_slug: string; required_capabilities: string[] }; acceptance_sequence: ["edit", "publish", "public_observation", "restore", "reopen"] }
}

export function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, normalize(entry)])) : item
  return JSON.stringify(normalize(value))
}
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes)
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)), byte => byte.toString(16).padStart(2, "0")).join("")
}
function requireValue(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(`Invalid native Bricks artifact: ${detail}`) }
function object(value: unknown, keys?: string[]): JsonObject {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "object required")
  const result = value as JsonObject
  if (keys) requireValue(Object.keys(result).length === keys.length && keys.every(key => Object.hasOwn(result, key)), `expected fields ${keys.join(",")}`)
  return result
}
function list(value: unknown, max: number, min = 0): unknown[] { requireValue(Array.isArray(value) && value.length >= min && value.length <= max, "collection limit"); return value }
function text(value: unknown, max: number, min = 1): string { requireValue(typeof value === "string" && value.length >= min && value.length <= max && (min === 0 || value.trim() === value), "text limit"); return value }
function identifier(value: unknown): string { const result = text(value, 160); requireValue(ids.test(result), "identifier"); return result }
function digest(value: unknown): string { const result = text(value, 64); requireValue(hashes.test(result), "SHA-256"); return result }
function oneOf(value: unknown, choices: string[]): void { requireValue(typeof value === "string" && choices.includes(value), "enum value") }
function unique(values: unknown[], field: string): void { requireValue(new Set(values).size === values.length, `duplicate ${field}`) }
async function component(value: JsonObject): Promise<void> {
  const { sha256, ...payload } = value
  requireValue(await sha256Hex(stableJson(payload)) === digest(sha256), "component hash mismatch")
}

export async function validateNativeBricksArtifact(bytes: Uint8Array): Promise<NativeBricksArtifact> {
  requireValue(bytes.byteLength > 0 && bytes.byteLength <= MAX_NATIVE_BRICKS_ARTIFACT_BYTES, "artifact byte limit")
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  const parsed: unknown = JSON.parse(source)
  // Bound arbitrary settings before any recursive canonicalization or native-tree traversal.
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    requireValue(++nodes <= 200_000 && depth <= 80, "JSON complexity limit")
    if (typeof value === "number") requireValue(Number.isFinite(value), "finite number required")
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        requireValue(!["__proto__", "prototype", "constructor"].includes(key), "unsupported object key")
        pending.push({ value: entry, depth: depth + 1 })
      }
    }
  }
  const root = object(parsed, ["schema", "site", "runtime", "evidence_inputs", "design_system", "documents", "assets", "editing"])
  requireValue(root.schema === "wp-codebox/bricks-site-artifact/v1", "schema")
  requireValue(source === stableJson(root), "noncanonical JSON")
  const site = object(root.site, ["site_id", "customer_id", "title", "starter_id"])
  requireValue(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(text(site.site_id, 63)), "site DNS label")
  identifier(site.customer_id); identifier(site.starter_id); text(site.title, 200)
  const runtime = object(root.runtime, ["version", "sha256"]); text(runtime.version, 120); digest(runtime.sha256)
  const evidence = object(root.evidence_inputs, ["dossier", "creative_provenance", "authorized_asset_hashes"])
  const dossier = object(evidence.dossier, ["revision", "sha256"])
  requireValue(Number.isSafeInteger(dossier.revision) && Number(dossier.revision) > 0, "dossier revision"); digest(dossier.sha256)
  const provenance = object(evidence.creative_provenance, ["version", "canonicalCommit", "guideSha256", "catalogSha256", "references"])
  text(provenance.version, 120); requireValue(/^[a-f0-9]{40}$/u.test(text(provenance.canonicalCommit, 40)), "canonical source commit")
  digest(provenance.guideSha256); digest(provenance.catalogSha256)
  const references = list(provenance.references, 32).map(item => { const row = object(item, ["id", "sha256"]); identifier(row.id); digest(row.sha256); return row })
  unique(references.map(row => row.id), "reference ID"); unique(references.map(row => row.sha256), "reference hash")
  const authorized = list(evidence.authorized_asset_hashes, 100).map(digest)
  const design = object(root.design_system, ["version", "palette", "typography", "global_classes", "global_variables", "theme_style"])
  text(design.version, 200)
  const palette = list(design.palette, 100, 1).map(item => { const row = object(item, ["id", "name", "value"]); identifier(row.id); text(row.name, 120); text(row.value, 120); return row })
  unique(palette.map(row => row.id), "palette ID")
  const typography = object(design.typography, ["body_font_family", "heading_font_family", "root_font_size"])
  text(typography.body_font_family, 200); text(typography.heading_font_family, 200); text(typography.root_font_size, 40)
  const classes = list(design.global_classes, 500).map(item => { const row = object(item, ["id", "name", "settings", "sha256"]); identifier(row.id); text(row.name, 120); object(row.settings); return row })
  unique(classes.map(row => row.id), "global class ID")
  for (const row of classes) await component(row)
  const variables = list(design.global_variables, 500).map(item => { const row = object(item, ["id", "name", "type", "value", "sha256"]); identifier(row.id); text(row.name, 120); oneOf(row.type, ["color", "number", "string"]); text(row.value, 2000, 0); return row })
  unique(variables.map(row => row.id), "global variable ID")
  for (const row of variables) await component(row)
  const theme = object(design.theme_style, ["settings", "sha256"]); object(theme.settings); await component(theme)
  const assets = list(root.assets, 100).map(item => object(item, ["logical_id", "filename", "mime_type", "alt_text", "sha256", "bytes", "content_base64"]))
  unique(assets.map(row => identifier(row.logical_id)), "asset ID")
  let mediaBytes = 0
  for (const asset of assets) {
    const filename = text(asset.filename, 255)
    requireValue(!/[/\\\u0000-\u001f]/u.test(filename) && filename !== "." && filename !== "..", "media filename")
    oneOf(asset.mime_type, ["image/png", "image/jpeg", "image/webp"]); text(asset.alt_text, 500, 0)
    const encoded = text(asset.content_base64, MAX_NATIVE_BRICKS_ARTIFACT_BYTES)
    requireValue(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(encoded), "base64 encoding")
    // Avoid Uint8Array.from(string): its iterator can allocate an intermediate
    // array far larger than the media itself inside a Worker isolate.
    const decoded = atob(encoded)
    const raw = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index++) raw[index] = decoded.charCodeAt(index)
    requireValue(raw.byteLength > 0 && raw.byteLength === asset.bytes && (mediaBytes += raw.byteLength) <= MAX_MEDIA_BYTES, "media byte limit")
    requireValue(await sha256Hex(raw) === digest(asset.sha256), "media hash mismatch")
    const signature = asset.mime_type === "image/png" ? [137,80,78,71,13,10,26,10].every((v,i) => raw[i] === v)
      : asset.mime_type === "image/jpeg" ? raw[0] === 255 && raw[1] === 216 && raw[2] === 255
      : new TextDecoder().decode(raw.slice(0,4)) === "RIFF" && new TextDecoder().decode(raw.slice(8,12)) === "WEBP"
    requireValue(signature, "media MIME signature mismatch")
  }
  requireValue(stableJson(assets.map(asset => asset.sha256)) === stableJson(authorized), "asset authority mismatch")
  const assetIds = new Set(assets.map(asset => asset.logical_id))
  const usedAssets = new Set<string>()
  const documents = object(root.documents, ["pages", "templates"])
  const elementIds = new Set<string>()
  const supported = ["container", "section", "block", "div", "heading", "text-basic", "text", "text-link", "button", "icon", "image", "form", "svg"]
  const visit = (entries: unknown, depth = 0): void => {
    requireValue(depth <= 32, "native tree depth")
    for (const item of list(entries, 2000)) {
      const element = object(item, ["id", "name", "settings", "children"])
      const eid = identifier(element.id); requireValue(!elementIds.has(eid), "duplicate element ID"); elementIds.add(eid)
      requireValue(elementIds.size <= 5000, "native element count")
      oneOf(element.name, supported); const settings = object(element.settings)
      const stack: unknown[] = [settings]
      while (stack.length) { const entry = stack.pop(); if (entry && typeof entry === "object") for (const [key, value] of Object.entries(entry)) { if (key === "asset_ref") { requireValue(assetIds.has(identifier(value)), "unknown asset_ref"); usedAssets.add(value as string) } else if (value && typeof value === "object") stack.push(value) } }
      if (element.name === "image") { const image = object(settings.image, ["asset_ref", "size"]); requireValue(assetIds.has(identifier(image.asset_ref)), "image requires asset_ref"); requireValue(image.size === "full", "image size must be full") }
      visit(element.children, depth + 1)
    }
  }
  for (const kind of ["pages", "templates"] as const) {
    const rows = list(documents[kind], 500, 1)
    const logicalIds: string[] = []; const slugs: string[] = []
    for (const item of rows) {
      const row = object(item, ["logical_id", "title", "status", "elements", "sha256", ...(kind === "pages" ? ["slug"] : ["type", "conditions"])])
      logicalIds.push(identifier(row.logical_id)); text(row.title, 200); oneOf(row.status, ["draft", "publish"])
      if (kind === "pages") { const slug = text(row.slug, 64); requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug), "page slug"); slugs.push(slug) }
      else { oneOf(row.type, ["header", "footer", "section", "single", "archive"]); for (const condition of list(row.conditions, 100)) object(condition) }
      list(row.elements, 2000, 1); visit(row.elements); await component(row)
    }
    unique(logicalIds, `${kind} logical ID`); unique(slugs, "page slug")
  }
  requireValue(assetIds.size === usedAssets.size, "unused staged asset")
  const editing = object(root.editing, ["granularity", "target_role", "acceptance_sequence"])
  requireValue(editing.granularity === "native_bricks_elements", "native editing required")
  const role = object(editing.target_role, ["role_slug", "required_capabilities"]); identifier(role.role_slug)
  unique(list(role.required_capabilities, 32, 1).map(identifier), "role capability")
  requireValue(stableJson(editing.acceptance_sequence) === stableJson(["edit", "publish", "public_observation", "restore", "reopen"]), "editing sequence")
  return root as unknown as NativeBricksArtifact
}
