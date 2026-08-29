import { Buffer } from "node:buffer"
import type { ProjectedPluginPackageDescriptor, Runtime, WorkspaceRecipe, WorkspaceRecipeExtraPlugin, WorkspaceRecipePluginPackageProjection, WorkspaceRecipeStep } from "@automattic/wp-codebox-core"
import { recipeSource } from "../recipe-sources.js"
import { collectRecipeTypedArtifact } from "./recipe-declared-artifacts.js"
import type { RecipePhasedPluginInputStage, RecipeRunDeclaredArtifact } from "./recipe-run-types.js"

const MAX_PHASED_PLUGINS = 20
const MAX_REGISTRY_RESPONSE_BYTES = 1024 * 1024

export class RecipePhasedPluginInputError extends Error {
  readonly code = "recipe-phased-plugin-input-failed"

  constructor(message: string, readonly stage: RecipePhasedPluginInputStage, readonly context: Record<string, unknown> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "RecipePhasedPluginInputError"
  }
}

export async function collectPhasedPluginArtifact(recipe: WorkspaceRecipe, step: WorkspaceRecipeStep, runtime: Runtime): Promise<RecipeRunDeclaredArtifact> {
  const artifactName = step.pluginInput?.artifact
  const index = (recipe.artifacts?.typed ?? []).findIndex((artifact) => artifact.name === artifactName)
  const declaration = index >= 0 ? recipe.artifacts?.typed?.[index] : undefined
  if (!declaration) throw new RecipePhasedPluginInputError("Phased plugin input references an unknown typed artifact.", "collect", { artifact: artifactName })
  const artifact = await collectRecipeTypedArtifact(runtime, declaration, index, declaration.path, { redact: false })
  if (artifact.status !== "collected" || artifact.parsedJson === undefined) {
    throw new RecipePhasedPluginInputError("Phased plugin input artifact could not be collected as JSON.", "collect", { artifact: artifactName, status: artifact.status })
  }
  return artifact
}

export function projectPhasedPluginPackages(input: unknown, projection: WorkspaceRecipePluginPackageProjection): ProjectedPluginPackageDescriptor[] {
  const selected = pointerValue(input, projection.items)
  if (!selected.found || !Array.isArray(selected.value)) throw new RecipePhasedPluginInputError("Phased plugin package items pointer must resolve to an array.", "project", { pointer: projection.items })
  if (selected.value.length > MAX_PHASED_PLUGINS) throw new RecipePhasedPluginInputError(`Phased plugin input exceeds the ${MAX_PHASED_PLUGINS}-plugin bound.`, "project")
  const resolver = projection.resolver ?? "immutable-archive"
  const slugs = new Set<string>()
  return selected.value.map((item, index) => {
    const slug = projectedString(item, projection.map.slug, `items[${index}].slug`, true)
    const source = projectedString(item, projection.map.source, `items[${index}].source`, resolver === "immutable-archive")
    const sha256 = projectedString(item, projection.map.sha256, `items[${index}].sha256`, resolver === "immutable-archive")
    const pluginFile = projectedString(item, projection.map.pluginFile, `items[${index}].pluginFile`, false)
    const activate = projectedBoolean(item, projection.map.activate, `items[${index}].activate`)
    const loadAs = projectedString(item, projection.map.loadAs, `items[${index}].loadAs`, false)
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(slug)) throw new RecipePhasedPluginInputError(`items[${index}].slug is invalid.`, "project", { slug })
    if (slugs.has(slug)) throw new RecipePhasedPluginInputError(`items[${index}].slug duplicates ${slug}.`, "project", { slug })
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new RecipePhasedPluginInputError(`items[${index}].sha256 must be a 64-character hexadecimal digest.`, "project")
    if (pluginFile && (!pluginFile.startsWith(`${slug}/`) || !/^[^/][^:]*\.php$/.test(pluginFile) || pluginFile.includes(".."))) throw new RecipePhasedPluginInputError(`items[${index}].pluginFile must stay under ${slug}/.`, "project")
    if (loadAs && loadAs !== "plugin") throw new RecipePhasedPluginInputError(`items[${index}].loadAs must be plugin.`, "project")
    if (source) {
      try {
        if (recipeSource(source, sha256).type === "local") throw new Error("local source")
      } catch (error) {
        throw new RecipePhasedPluginInputError(`items[${index}].source must be an HTTPS plugin archive.`, "project", { source }, error)
      }
    }
    slugs.add(slug)
    return { slug, ...(source ? { source } : {}), ...(sha256 ? { sha256: sha256.toLowerCase() } : {}), ...(pluginFile ? { pluginFile } : {}), ...(activate !== undefined ? { activate } : {}), loadAs: "plugin" }
  })
}

export async function resolvePhasedPluginPackages(descriptors: ProjectedPluginPackageDescriptor[], projection: WorkspaceRecipePluginPackageProjection, fetcher = fetch): Promise<WorkspaceRecipeExtraPlugin[]> {
  const resolver = projection.resolver ?? "immutable-archive"
  if (resolver === "immutable-archive") return descriptors.map((descriptor) => ({ ...descriptor, activate: descriptor.activate !== false })) as WorkspaceRecipeExtraPlugin[]
  const plugins: WorkspaceRecipeExtraPlugin[] = []
  for (const descriptor of descriptors) {
    const infoUrl = new URL("https://api.wordpress.org/plugins/info/1.2/")
    infoUrl.searchParams.set("action", "plugin_information")
    infoUrl.searchParams.set("request[slug]", descriptor.slug)
    const response = await fetcher(infoUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get("content-type") || "")) throw new RecipePhasedPluginInputError(`WordPress.org plugin info failed for ${descriptor.slug}.`, "resolve", { slug: descriptor.slug, status: response.status })
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (contentLength > MAX_REGISTRY_RESPONSE_BYTES) throw new RecipePhasedPluginInputError(`WordPress.org plugin info exceeded the response bound for ${descriptor.slug}.`, "resolve", { slug: descriptor.slug, content_length: contentLength })
    const responseText = await response.text()
    if (Buffer.byteLength(responseText) > MAX_REGISTRY_RESPONSE_BYTES) throw new RecipePhasedPluginInputError(`WordPress.org plugin info exceeded the response bound for ${descriptor.slug}.`, "resolve", { slug: descriptor.slug })
    let info: { version?: unknown; download_link?: unknown }
    try { info = JSON.parse(responseText) as typeof info } catch (error) { throw new RecipePhasedPluginInputError(`WordPress.org plugin info was malformed for ${descriptor.slug}.`, "resolve", { slug: descriptor.slug }, error) }
    const version = typeof info.version === "string" ? info.version : ""
    const source = typeof info.download_link === "string" ? info.download_link : ""
    let sourceUrl: URL
    try { sourceUrl = new URL(source) } catch (error) { throw new RecipePhasedPluginInputError(`WordPress.org returned an invalid package URL for ${descriptor.slug}.`, "resolve", { slug: descriptor.slug }, error) }
    if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "downloads.wordpress.org" || !sourceUrl.pathname.startsWith("/plugin/") || !version || !/^\d[0-9A-Za-z._+-]*$/.test(version)) throw new RecipePhasedPluginInputError(`WordPress.org returned an invalid immutable package for ${descriptor.slug}.`, "resolve", { slug: descriptor.slug, version, source })
    plugins.push({
      source: sourceUrl.toString(),
      slug: descriptor.slug,
      ...(descriptor.pluginFile ? { pluginFile: descriptor.pluginFile } : {}),
      activate: descriptor.activate !== false,
      loadAs: "plugin",
      metadata: { phased_input: { resolver, version, source_url: sourceUrl.toString() } },
    })
  }
  return plugins
}

function projectedString(item: unknown, pointer: string | undefined, field: string, required: boolean): string {
  if (!pointer) {
    if (required) throw new RecipePhasedPluginInputError(`${field} mapping is required.`, "project")
    return ""
  }
  const selected = pointerValue(item, pointer)
  if (!selected.found || typeof selected.value !== "string" || (required && !selected.value)) throw new RecipePhasedPluginInputError(`${field} must resolve to${required ? " a non-empty" : ""} string.`, "project", { pointer })
  return selected.value
}

function projectedBoolean(item: unknown, pointer: string | undefined, field: string): boolean | undefined {
  if (!pointer) return undefined
  const selected = pointerValue(item, pointer)
  if (!selected.found || typeof selected.value !== "boolean") throw new RecipePhasedPluginInputError(`${field} must resolve to a boolean.`, "project", { pointer })
  return selected.value
}

function pointerValue(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value }
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) return { found: false }
  let current = value
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= current.length) return { found: false }
      current = current[Number(segment)]
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment]
    else return { found: false }
  }
  return { found: true, value: current }
}
