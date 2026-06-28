import { readFile } from "node:fs/promises"
import { resolveCommandPath } from "@automattic/wp-codebox-core"
import { argValue } from "./commands.js"

export interface EditorOpenTarget {
  url: string
  kind: "post" | "post-new" | "site" | "url"
  postId?: number
  postType?: string
  waitSelector: string
}

export type EditorActionStep =
  | { kind: "open"; timeout?: string }
  | { kind: "waitForReady"; timeout?: string }
  | { kind: "insertBlock"; name?: string; attributes?: Record<string, unknown>; content?: string; select?: boolean; timeout?: string }
  | { kind: "selectBlock"; clientId?: string; index?: number; timeout?: string }
  | { kind: "savePost"; marker?: string; content?: string; timeout?: string }
  | { kind: "inspectState"; timeout?: string }

const DEFAULT_EDITOR_WAIT_SELECTOR = ".edit-post-visual-editor, .editor-styles-wrapper, .block-editor, .interface-interface-skeleton"

export function editorOpenTargetFromArgs(args: string[]): EditorOpenTarget {
  const explicitUrl = argValue(args, "url")?.trim()
  const waitSelector = argValue(args, "wait-selector")?.trim() || DEFAULT_EDITOR_WAIT_SELECTOR
  if (explicitUrl) {
    return { url: explicitUrl, kind: "url", waitSelector }
  }

  const target = argValue(args, "target")?.trim() || "post-new"
  if (target === "site") {
    return { url: "/wp-admin/site-editor.php", kind: "site", waitSelector }
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

  if (target !== "post-new") {
    throw new Error(`wordpress.editor-open target supports post-new, site, or url=<path-or-url>: ${target}`)
  }

  return { url: `/wp-admin/post-new.php?post_type=${encodeURIComponent(postType)}`, kind: "post-new", postType, waitSelector }
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
    if (input.clientId !== undefined && typeof input.clientId !== "string") {
      throw new Error(`wordpress.editor-actions steps-json[${index}].clientId must be a string`)
    }
    if (input.index !== undefined && (typeof input.index !== "number" || !Number.isInteger(input.index) || input.index < 0)) {
      throw new Error(`wordpress.editor-actions steps-json[${index}].index must be a non-negative integer`)
    }
    return {
      kind: "selectBlock",
      ...(typeof input.clientId === "string" ? { clientId: input.clientId } : {}),
      ...(Number.isInteger(input.index) && (input.index as number) >= 0 ? { index: input.index as number } : {}),
      ...(typeof input.timeout === "string" ? { timeout: input.timeout } : {}),
    }
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
