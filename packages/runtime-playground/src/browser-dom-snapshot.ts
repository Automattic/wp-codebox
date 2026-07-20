import type { BrowserProbeViewport } from "./browser-artifacts.js"
import type { Page } from "playwright"

const BROWSER_DOM_SNAPSHOT_STYLE_PROPERTIES = ["display", "position", "box-sizing", "top", "right", "bottom", "left", "z-index", "width", "height", "min-width", "max-width", "min-height", "max-height", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "overflow", "overflow-x", "overflow-y", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-content", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-auto-flow", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "white-space", "color", "background-color", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "object-fit", "object-position", "opacity", "transform", "visibility"] as const
const BROWSER_DOM_SNAPSHOT_ATTRIBUTE_NAMES = ["id", "class", "role", "aria-label", "title", "href", "src", "type", "name"] as const

export interface BrowserDomElementSnapshot {
  path: string
  tag: string
  text: string
  attributes: Record<string, string>
  boundingBox: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

export interface BrowserDomSelectorSnapshot {
  selector: string
  matched: number
  captured: number
  paths: string[]
  error?: string
}

export interface BrowserDomSvgImagePayloadSnapshot {
  imagePath: string
  sha256: string
  byteCount: number
  textNodeCount: number
  fontFamilyAttributes: string[]
  fontSizeAttributes: string[]
  fontStyleAttributes: string[]
  fontWeightAttributes: string[]
  letterSpacingAttributes: string[]
  fontFaceRuleCount: number
  styleText: { sha256: string; byteCount: number }
}

export interface BrowserDomSnapshot {
  url: string
  title: string
  elementCount: number
  capturedElements: BrowserDomElementSnapshot[]
  selectors?: BrowserDomSelectorSnapshot[]
  svgImagePayloads?: BrowserDomSvgImagePayloadSnapshot[]
  truncated: boolean
}

export interface BrowserDomSnapshotArtifact {
  schema: "wp-codebox/browser-dom-snapshot/v1"
  command: "wordpress.browser-actions" | "wordpress.visual-compare"
  screenshot: string
  step?: { index: number; name?: string; kind: string }
  finalUrl: string
  viewport: BrowserProbeViewport | null
  capturedAt: string
  limits: { maxElements: number }
  summary: { elementCount: number; capturedElements: number; truncated: boolean }
  snapshot: BrowserDomSnapshot
}

export async function captureBrowserDomSnapshot(page: Page, maxElements: number, selectors: string[] = []): Promise<BrowserDomSnapshot> {
  return page.evaluate(async ({ maxElements: maxElementsInput, styleProperties, attributeNames, selectors: selectorInputs }) => {
    const maxElements = Math.max(1, Number(maxElementsInput) || 1)
    const elements = Array.from(document.body?.querySelectorAll("*") ?? [])
    const visibleElements = elements
      .map((element) => elementSnapshot(element, styleProperties, attributeNames))
      .filter((element): element is BrowserDomElementSnapshot => Boolean(element))
    const capturedByPath = new Map(visibleElements.slice(0, maxElements).map((element) => [element.path, element]))
    const selectorSnapshots = selectorInputs.map((selector) => selectorSnapshot(selector, capturedByPath, styleProperties, attributeNames))
    const svgImagePayloads = await Promise.all(Array.from(document.images).map((image) => svgImagePayloadSnapshot(image)))

    return {
      url: window.location.href,
      title: document.title || "",
      elementCount: visibleElements.length,
      capturedElements: [...capturedByPath.values()],
      ...(selectorSnapshots.length > 0 ? { selectors: selectorSnapshots } : {}),
      ...(svgImagePayloads.some((payload): payload is BrowserDomSvgImagePayloadSnapshot => Boolean(payload)) ? { svgImagePayloads: svgImagePayloads.filter((payload): payload is BrowserDomSvgImagePayloadSnapshot => Boolean(payload)) } : {}),
      truncated: visibleElements.length > maxElements,
    }

    function selectorSnapshot(selector: string, captured: Map<string, BrowserDomElementSnapshot>, styles: string[], attributes: string[]): BrowserDomSelectorSnapshot {
      try {
        const matches = Array.from(document.querySelectorAll(selector))
        const snapshots = matches.map((element) => elementSnapshot(element, styles, attributes)).filter((element): element is BrowserDomElementSnapshot => Boolean(element))
        for (const snapshot of snapshots) {
          captured.set(snapshot.path, snapshot)
        }
        return { selector, matched: matches.length, captured: snapshots.length, paths: snapshots.map((snapshot) => snapshot.path) }
      } catch (error) {
        return { selector, matched: 0, captured: 0, paths: [], error: error instanceof Error ? error.message : String(error) }
      }
    }

    function elementSnapshot(element: Element, styles: string[], attributes: string[]): BrowserDomElementSnapshot | null {
      const rect = element.getBoundingClientRect()
      const computed = window.getComputedStyle(element)
      if (rect.width <= 0 || rect.height <= 0 || computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
        return null
      }
      return {
        path: elementPath(element),
        tag: element.tagName.toLowerCase(),
        text: compactText(element.textContent || "", 180),
        attributes: Object.fromEntries(attributes.flatMap((name) => {
          const value = element.getAttribute(name)
          return value === null ? [] : [[name, compactText(redactPayloadUrl(value), 180)]]
        })),
        boundingBox: {
          x: roundNumber(rect.x),
          y: roundNumber(rect.y),
          width: roundNumber(rect.width),
          height: roundNumber(rect.height),
        },
        styles: Object.fromEntries(styles.map((name) => [name, computed.getPropertyValue(name)])),
      }
    }

    function elementPath(element: Element): string {
      const parts: string[] = []
      let current: Element | null = element
      while (current && current !== document.body && parts.length < 6) {
        let part = current.tagName.toLowerCase()
        const id = current.getAttribute("id")
        if (id) {
          part += `#${cssEscape(id)}`
          parts.unshift(part)
          break
        }
        const classes = Array.from(current.classList || []).slice(0, 2).map(cssEscape)
        if (classes.length > 0) {
          part += `.${classes.join(".")}`
        }
        const parent: Element | null = current.parentElement
        if (parent) {
          const sameTagSiblings = Array.from(parent.children).filter((child: Element) => child.tagName === current?.tagName)
          if (sameTagSiblings.length > 1) {
            part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`
          }
        }
        parts.unshift(part)
        current = parent
      }
      return parts.length > 0 ? parts.join(" > ") : element.tagName.toLowerCase()
    }

    function compactText(value: string, maxLength: number): string {
      const compact = value.replace(/\s+/g, " ").trim()
      return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
    }

    function redactPayloadUrl(value: string): string {
      return /^\s*(?:blob:|data:)/i.test(value) ? "[payload URL redacted]" : value
    }

    async function svgImagePayloadSnapshot(image: HTMLImageElement): Promise<BrowserDomSvgImagePayloadSnapshot | undefined> {
      // Match the readiness normalizer: responsive sources are left untouched, while
      // same-document blobs and same-origin standalone SVGs are safe to inspect.
      if (!crypto.subtle || image.srcset || image.parentElement?.tagName === "PICTURE") {
        return undefined
      }
      const source = image.currentSrc || image.src
      let parsed: URL
      try {
        parsed = new URL(source, document.baseURI)
      } catch {
        return undefined
      }
      if (parsed.protocol !== "blob:" && (parsed.origin !== location.origin || !/\.svg$/i.test(parsed.pathname))) {
        return undefined
      }
      const maxBytes = 2 * 1024 * 1024
      try {
        const response = await fetch(parsed.href)
        const contentLength = Number(response.headers.get("content-length"))
        if (!response.ok || (Number.isFinite(contentLength) && contentLength > maxBytes)) {
          return undefined
        }
        const reader = response.body?.getReader()
        if (!reader) {
          return undefined
        }
        const chunks: Uint8Array[] = []
        let byteCount = 0
        while (true) {
          const next = await reader.read()
          if (next.done) {
            break
          }
          byteCount += next.value.byteLength
          if (byteCount > maxBytes) {
            await reader.cancel()
            return undefined
          }
          chunks.push(next.value)
        }
        const bytes = new Uint8Array(byteCount)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        const sourceText = new TextDecoder().decode(bytes)
        if (!/\bimage\/svg\+xml\b/i.test(response.headers.get("content-type") ?? "") && !/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(sourceText)) {
          return undefined
        }
        const svg = new DOMParser().parseFromString(sourceText, "image/svg+xml")
        if (svg.querySelector("parsererror")) {
          return undefined
        }
        const styleText = Array.from(svg.querySelectorAll("style")).map((style) => style.textContent ?? "").join("\n")
        const styleBytes = new TextEncoder().encode(styleText)
        function attributeValues(name: string): string[] {
          return [...new Set(Array.from(svg.querySelectorAll("*")).flatMap((element) => {
            const value = element.getAttribute(name)?.trim()
            return value ? [value] : []
          }))].sort()
        }
        async function digest(value: Uint8Array): Promise<string> {
          const result = await crypto.subtle.digest("SHA-256", value as Uint8Array<ArrayBuffer>)
          return Array.from(new Uint8Array(result)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
        }
        const walker = svg.createTreeWalker(svg, NodeFilter.SHOW_TEXT)
        let textNodeCount = 0
        while (walker.nextNode()) {
          textNodeCount += 1
        }
        const [sha256, styleSha256] = await Promise.all([digest(bytes), digest(styleBytes)])
        return {
          imagePath: elementPath(image),
          sha256,
          byteCount,
          textNodeCount,
          fontFamilyAttributes: attributeValues("font-family"),
          fontSizeAttributes: attributeValues("font-size"),
          fontStyleAttributes: attributeValues("font-style"),
          fontWeightAttributes: attributeValues("font-weight"),
          letterSpacingAttributes: attributeValues("letter-spacing"),
          fontFaceRuleCount: (styleText.match(/@font-face\b/gi) ?? []).length,
          styleText: { sha256: styleSha256, byteCount: styleBytes.byteLength },
        }
      } catch {
        // Snapshot evidence is diagnostic only; inaccessible payloads must not block capture.
        return undefined
      }
    }

    function roundNumber(value: number): number {
      return Math.round(value * 100) / 100
    }

    function cssEscape(value: string): string {
      if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
        return globalThis.CSS.escape(String(value))
      }
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
    }
  }, { maxElements, styleProperties: [...BROWSER_DOM_SNAPSHOT_STYLE_PROPERTIES], attributeNames: [...BROWSER_DOM_SNAPSHOT_ATTRIBUTE_NAMES], selectors })
}

export function normalizeBrowserDomSnapshotArtifact(input: unknown, requestedPath: string, label = "Browser DOM snapshot"): BrowserDomSnapshotArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be a JSON object: ${requestedPath}`)
  }
  const record = input as Partial<BrowserDomSnapshotArtifact> & { snapshot?: unknown }
  if (record.schema !== "wp-codebox/browser-dom-snapshot/v1") {
    throw new Error(`${label} has unsupported schema: ${requestedPath}`)
  }
  const snapshot = record.snapshot
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error(`${label} is missing snapshot object: ${requestedPath}`)
  }
  const typedSnapshot = snapshot as Partial<BrowserDomSnapshot>
  if (!Array.isArray(typedSnapshot.capturedElements)) {
    throw new Error(`${label} capturedElements must be an array: ${requestedPath}`)
  }
  return record as BrowserDomSnapshotArtifact
}
