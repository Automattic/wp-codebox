import { readFile } from "node:fs/promises"
import { resolveCommandPath, type RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { argValue } from "./commands.js"
import { bootstrapPhpCode } from "./php-bootstrap.js"
import { assertPlaygroundResponseOk, type PlaygroundRunResponse } from "./playground-command-errors.js"
import type { PlaygroundCliServer } from "./preview-server.js"
import { cleanWpCliOutput } from "./wp-cli-command-handlers.js"

// Callback shape every editor command already holds for running PHP/WP-CLI inside
// the sandbox (the same one used to mint admin auth cookies).
export type RunPlaygroundCommand = (
  command: string,
  server: PlaygroundCliServer,
  options: { code: string } | { scriptPath: string },
) => Promise<PlaygroundRunResponse>

export interface EditorOpenTarget {
  url: string
  kind: "post" | "post-new" | "site" | "url" | "front-page" | "post-slug"
  postId?: number
  postSlug?: string
  postType?: string
  waitSelector?: string
}

export const DEFAULT_EDITOR_WAIT_SELECTOR = ".edit-post-visual-editor, .editor-styles-wrapper, .block-editor, .interface-interface-skeleton"

export type EditorActionStep =
  | { kind: "open"; timeout?: string }
  | { kind: "waitForReady"; timeout?: string }
  | { kind: "insertBlock"; name?: string; attributes?: Record<string, unknown>; content?: string; select?: boolean; timeout?: string }
  | ({ kind: "selectBlock"; timeout?: string } & EditorBlockTarget)
  | ({ kind: "updateBlockAttributes"; attributes: Record<string, unknown>; timeout?: string } & EditorBlockTarget)
  | ({ kind: "removeBlock"; timeout?: string } & EditorBlockTarget)
  | ({ kind: "moveBlock"; position: number; timeout?: string } & EditorBlockTarget)
  | ({ kind: "duplicateBlock"; timeout?: string } & EditorBlockTarget)
  | ({ kind: "replaceBlock"; block: EditorBlockSpec; timeout?: string } & EditorBlockTarget)
  | ({ kind: "replaceInnerBlocks"; blocks: EditorBlockSpec[]; timeout?: string } & EditorBlockTarget)
  | { kind: "undo"; timeout?: string }
  | { kind: "redo"; timeout?: string }
  | { kind: "reload"; timeout?: string }
  | { kind: "reopen"; timeout?: string }
  | { kind: "savePost"; marker?: string; content?: string; timeout?: string }
  | { kind: "inspectState"; timeout?: string }

export interface EditorBlockTarget {
  clientId?: string
  index?: number
  path?: number[]
}

export interface EditorBlockSpec {
  name: string
  attributes?: Record<string, unknown>
  innerBlocks?: EditorBlockSpec[]
}

export function editorOpenTargetFromArgs(args: string[]): EditorOpenTarget {
  const explicitUrl = argValue(args, "url")?.trim()
  const waitSelector = argValue(args, "wait-selector")?.trim() || undefined
  if (explicitUrl) {
    return { url: explicitUrl, kind: "url", waitSelector }
  }

  const target = argValue(args, "target")?.trim() || "post-new"
  if (target === "site") {
    return { url: "/wp-admin/site-editor.php", kind: "site", waitSelector }
  }
  // The site's static front page (`page_on_front`). Its concrete post id is only
  // known at runtime — e.g. after an importer materializes pages and points
  // `page_on_front` at the imported home page — so the URL is resolved against
  // the running WordPress by `resolveEditorOpenTarget` before navigation,
  // turning into `post.php?post=<page_on_front>&action=edit`. This lets a recipe
  // open and validate the actual imported front page without knowing its id when
  // the recipe is built.
  if (target === "front-page") {
    return { url: "", kind: "front-page", waitSelector }
  }

  const postType = argValue(args, "post-type")?.trim() || "post"
  if (!/^[a-zA-Z0-9_-]+$/.test(postType)) {
    throw new Error(`wordpress.editor-open post-type must be a WordPress post type slug: ${postType}`)
  }

  const postIdRaw = argValue(args, "post-id")?.trim()
  if (postIdRaw) {
    const postId = Number.parseInt(postIdRaw, 10)
    if (!Number.isInteger(postId) || postId <= 0) {
      throw new Error(`wordpress.editor-open post-id must be a positive integer: ${postIdRaw}`)
    }
    return { url: `/wp-admin/post.php?post=${postId}&action=edit`, kind: "post", postId, postType, waitSelector }
  }

  const postSlug = argValue(args, "post-slug")?.trim()
  if (postSlug) {
    if (!/^[a-zA-Z0-9_\-/]+$/.test(postSlug)) {
      throw new Error(`wordpress.editor-open post-slug must be a WordPress post slug or path: ${postSlug}`)
    }
    return { url: "", kind: "post-slug", postSlug, postType, waitSelector }
  }

  if (target !== "post-new") {
    throw new Error(`wordpress.editor-open target supports post-new, site, front-page, post-slug=<slug>, or url=<path-or-url>: ${target}`)
  }

  return { url: `/wp-admin/post-new.php?post_type=${encodeURIComponent(postType)}`, kind: "post-new", postType, waitSelector }
}

// Resolve an editor-open target that can only be pinned to a concrete editor URL
// at runtime. Today that is `kind: "front-page"`, which asks the running
// WordPress for its static front page (`page_on_front`) and rewrites the target
// to `post.php?post=<id>&action=edit` so the editor opens the real page. Targets
// that already carry a concrete URL (post, post-new, site, url) are returned
// unchanged. Throws when `front-page` is requested but the site has no static
// front page configured (`show_on_front` is not `page`, or `page_on_front` is
// unset) — that is a real misconfiguration the caller must surface, not paper
// over by silently opening an empty editor.
export async function resolveEditorOpenTarget(
  target: EditorOpenTarget,
  context: {
    command: string
    runPlaygroundCommand?: RunPlaygroundCommand
    runtimeSpec?: RuntimeCreateSpec
    server: PlaygroundCliServer
  },
): Promise<EditorOpenTarget> {
  if (target.kind !== "front-page" && target.kind !== "post-slug") {
    return target
  }
  const { command, runPlaygroundCommand, runtimeSpec, server } = context
  if (!runPlaygroundCommand) {
    throw new Error(`${command} ${target.kind} target requires Playground PHP command support`)
  }
  if (!runtimeSpec) {
    throw new Error(`${command} ${target.kind} target requires a runtime spec`)
  }

  const resolveCommand = target.kind === "front-page" ? `${command}.resolve-front-page` : `${command}.resolve-post-slug`
  const response = await runPlaygroundCommand(resolveCommand, server, {
    code: bootstrapPhpCode(runtimeSpec, target.kind === "front-page" ? frontPagePostIdPhpCode() : postSlugPostIdPhpCode(target.postSlug ?? "", target.postType ?? "post"), []),
  })
  assertPlaygroundResponseOk(resolveCommand, response)

  const postId = Number.parseInt(cleanWpCliOutput(response.text).trim(), 10)
  if (!Number.isInteger(postId) || postId <= 0) {
    if (target.kind === "post-slug") {
      throw new Error(`${command} post-slug=${target.postSlug ?? ""} post-type=${target.postType ?? "post"} resolved no editable post.`)
    }
    throw new Error(
      `${command} target=front-page found no static front page: WordPress has show_on_front != "page" or page_on_front is unset. Configure a static front page (e.g. an importer that sets page_on_front) before validating the front page.`,
    )
  }

  return {
    ...target,
    kind: "post",
    postId,
    url: `/wp-admin/post.php?post=${postId}&action=edit`,
  }
}

// PHP that echoes the static front page id, or `0` when the site is not
// configured to show a static page on the front.
function frontPagePostIdPhpCode(): string {
  return `
$front_page_id = 0;
if ( 'page' === get_option( 'show_on_front' ) ) {
    $front_page_id = (int) get_option( 'page_on_front' );
}
echo $front_page_id;
`
}

function postSlugPostIdPhpCode(postSlug: string, postType: string): string {
  return `
$post = get_page_by_path(${JSON.stringify(postSlug)}, OBJECT, ${JSON.stringify(postType)});
echo $post instanceof WP_Post ? (int) $post->ID : 0;
`
}

export const EDITOR_VALIDATE_BLOCKS_DEFAULT_PROVIDER = "wordpress-block-editor"

export async function editorValidateContentFromArgs(args: string[]): Promise<string | undefined> {
  const inline = argValue(args, "content")
  if (typeof inline === "string") {
    return inline
  }
  const file = argValue(args, "content-file")?.trim()
  if (file) {
    return readFile(resolveCommandPath(file), "utf8")
  }
  return undefined
}

export function editorValidateProviderFromArgs(args: string[]): string {
  return argValue(args, "validation-provider")?.trim() || EDITOR_VALIDATE_BLOCKS_DEFAULT_PROVIDER
}

export async function editorActionStepsFromArgs(args: string[]): Promise<EditorActionStep[]> {
  const stepsRaw = argValue(args, "steps-json")?.trim()
  if (!stepsRaw) {
    throw new Error("wordpress.editor-actions requires steps-json=<array>")
  }

  let text = stepsRaw
  if (stepsRaw.startsWith("@")) {
    text = await readFile(resolveCommandPath(stepsRaw.slice(1)), "utf8")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`wordpress.editor-actions steps-json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error("wordpress.editor-actions steps-json must be a JSON array")
  }

  return parsed.map((step, index) => normalizeEditorActionStep(step, index))
}

function normalizeEditorActionStep(step: unknown, index: number): EditorActionStep {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`wordpress.editor-actions steps-json[${index}] must be an object`)
  }

  const input = step as Record<string, unknown>
  if (input.kind === "open") {
    return { kind: "open", ...(typeof input.timeout === "string" ? { timeout: input.timeout } : {}) }
  }
  if (input.kind === "insertBlock") {
    if (input.name !== undefined && typeof input.name !== "string") {
      throw new Error(`wordpress.editor-actions steps-json[${index}].name must be a block name string`)
    }
    if (input.attributes !== undefined && (!input.attributes || typeof input.attributes !== "object" || Array.isArray(input.attributes))) {
      throw new Error(`wordpress.editor-actions steps-json[${index}].attributes must be a JSON object`)
    }
    return {
      kind: "insertBlock",
      name: typeof input.name === "string" && input.name.length > 0 ? input.name : "core/paragraph",
      ...(typeof input.content === "string" ? { content: input.content } : {}),
      ...(input.attributes && typeof input.attributes === "object" && !Array.isArray(input.attributes) ? { attributes: input.attributes as Record<string, unknown> } : {}),
      ...(typeof input.select === "boolean" ? { select: input.select } : {}),
      ...(typeof input.timeout === "string" ? { timeout: input.timeout } : {}),
    }
  }
  if (input.kind === "waitForReady") {
    return { kind: "waitForReady", ...(typeof input.timeout === "string" ? { timeout: input.timeout } : {}) }
  }
  if (input.kind === "selectBlock") {
    return { kind: "selectBlock", ...normalizeEditorBlockTarget(input, index), ...editorActionTimeout(input) }
  }
  if (input.kind === "updateBlockAttributes") {
    return { kind: "updateBlockAttributes", ...normalizeEditorBlockTarget(input, index), attributes: normalizeAttributes(input.attributes, index), ...editorActionTimeout(input) }
  }
  if (input.kind === "removeBlock" || input.kind === "duplicateBlock") {
    return { kind: input.kind, ...normalizeEditorBlockTarget(input, index), ...editorActionTimeout(input) }
  }
  if (input.kind === "moveBlock") {
    if (typeof input.position !== "number" || !Number.isInteger(input.position) || input.position < 0) {
      throw new Error(`wordpress.editor-actions steps-json[${index}].position must be a non-negative integer`)
    }
    return { kind: "moveBlock", ...normalizeEditorBlockTarget(input, index), position: input.position, ...editorActionTimeout(input) }
  }
  if (input.kind === "replaceBlock") {
    return { kind: "replaceBlock", ...normalizeEditorBlockTarget(input, index), block: normalizeEditorBlockSpec(input.block, index, "block"), ...editorActionTimeout(input) }
  }
  if (input.kind === "replaceInnerBlocks") {
    if (!Array.isArray(input.blocks)) {
      throw new Error(`wordpress.editor-actions steps-json[${index}].blocks must be a JSON array`)
    }
    return { kind: "replaceInnerBlocks", ...normalizeEditorBlockTarget(input, index), blocks: input.blocks.map((block, blockIndex) => normalizeEditorBlockSpec(block, index, `blocks[${blockIndex}]`)), ...editorActionTimeout(input) }
  }
  if (input.kind === "undo" || input.kind === "redo" || input.kind === "reload" || input.kind === "reopen") {
    return { kind: input.kind, ...editorActionTimeout(input) }
  }
  if (input.kind === "savePost") {
    if (input.marker !== undefined && typeof input.marker !== "string") {
      throw new Error(`wordpress.editor-actions steps-json[${index}].marker must be a string`)
    }
    if (input.content !== undefined && typeof input.content !== "string") {
      throw new Error(`wordpress.editor-actions steps-json[${index}].content must be a string`)
    }
    return {
      kind: "savePost",
      ...(typeof input.marker === "string" && input.marker.length > 0 ? { marker: input.marker } : {}),
      ...(typeof input.content === "string" ? { content: input.content } : {}),
      ...(typeof input.timeout === "string" ? { timeout: input.timeout } : {}),
    }
  }
  if (input.kind === "inspectState") {
    return { kind: "inspectState", ...(typeof input.timeout === "string" ? { timeout: input.timeout } : {}) }
  }

  throw new Error(`wordpress.editor-actions step kind is not supported: ${String(input.kind)}`)
}

function normalizeEditorBlockTarget(input: Record<string, unknown>, index: number): EditorBlockTarget {
  const targetCount = Number(typeof input.clientId === "string") + Number(input.index !== undefined) + Number(input.path !== undefined)
  if (targetCount !== 1) {
    throw new Error(`wordpress.editor-actions steps-json[${index}] requires exactly one target: clientId, index, or path`)
  }
  if (typeof input.clientId === "string" && input.clientId.length > 0) return { clientId: input.clientId }
  if (typeof input.index === "number" && Number.isInteger(input.index) && input.index >= 0) return { index: input.index }
  if (Array.isArray(input.path) && input.path.length > 0 && input.path.every((part) => typeof part === "number" && Number.isInteger(part) && part >= 0)) return { path: input.path as number[] }
  throw new Error(`wordpress.editor-actions steps-json[${index}] target must be a non-empty clientId, non-negative index, or non-empty path of non-negative indexes`)
}

function normalizeAttributes(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`wordpress.editor-actions steps-json[${index}].attributes must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function normalizeEditorBlockSpec(value: unknown, index: number, field: string): EditorBlockSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`wordpress.editor-actions steps-json[${index}].${field} must be an object`)
  const input = value as Record<string, unknown>
  if (typeof input.name !== "string" || input.name.length === 0) throw new Error(`wordpress.editor-actions steps-json[${index}].${field}.name must be a block name string`)
  if (input.attributes !== undefined) normalizeAttributes(input.attributes, index)
  if (input.innerBlocks !== undefined && !Array.isArray(input.innerBlocks)) throw new Error(`wordpress.editor-actions steps-json[${index}].${field}.innerBlocks must be a JSON array`)
  return {
    name: input.name,
    ...(input.attributes !== undefined ? { attributes: input.attributes as Record<string, unknown> } : {}),
    ...(Array.isArray(input.innerBlocks) ? { innerBlocks: input.innerBlocks.map((block, childIndex) => normalizeEditorBlockSpec(block, index, `${field}.innerBlocks[${childIndex}]`)) } : {}),
  }
}

function editorActionTimeout(input: Record<string, unknown>): { timeout?: string } {
  return typeof input.timeout === "string" ? { timeout: input.timeout } : {}
}
