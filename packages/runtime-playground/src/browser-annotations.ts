import type { Page } from "playwright"
import type { BrowserInteractionStep } from "@automattic/wp-codebox-core"

type AnnotationSpec = {
  id?: string
  shape?: string
  selector?: string
  text?: string
  clear?: string[] | true
  durationMs?: number
  animate?: string
  direction?: string
  position?: string
  style?: { variant?: string; padding?: number }
  anchor?: { selector?: string; placement?: string }
  theme?: BrowserAnnotationTheme
}

export type BrowserAnnotationTheme = { accentColor?: string; textColor?: string; background?: string; fontFamily?: string; fontSize?: number; strokeWidth?: number; radius?: number }
let annotationTheme: BrowserAnnotationTheme = {}
export function setBrowserAnnotationTheme(theme: BrowserAnnotationTheme): void { annotationTheme = theme }

export async function executeBrowserAnnotation(page: Page, step: BrowserInteractionStep): Promise<void> {
  if (step.clear !== undefined) {
    await page.evaluate((ids) => {
      const host = document.querySelector<HTMLElement>("#__wp_codebox_annotations") as (HTMLElement & { __annotations?: Map<string, { remove: () => void }> }) | null
      const annotations = host?.__annotations
      if (!annotations) return
      const selected = ids === true ? [...annotations.keys()] : ids
      for (const id of selected) { annotations.get(id)?.remove(); annotations.delete(id) }
      if (annotations.size === 0) host?.remove()
    }, step.clear)
    return
  }
  if (step.selector) await page.locator(step.selector).waitFor({ state: "visible" })
  if (step.anchor?.selector) await page.locator(step.anchor.selector).waitFor({ state: "visible" })
  const spec: AnnotationSpec = {
    id: step.id, shape: step.shape, selector: step.selector, text: step.text, durationMs: step.durationMs,
    animate: step.animate, direction: step.direction, position: step.position,
    style: step.style, anchor: step.anchor, theme: annotationTheme,
  }
  await page.evaluate("globalThis.__name ??= (value) => value")
  await page.evaluate<void, AnnotationSpec>((spec) => {
    type Annotation = { remove: () => void }
    type AnnotationHost = HTMLElement & { __annotations?: Map<string, Annotation> }
    let host = document.querySelector<HTMLElement>("#__wp_codebox_annotations") as AnnotationHost | null
    if (!host) {
      host = document.createElement("div") as AnnotationHost
      host.id = "__wp_codebox_annotations"
      host.setAttribute("aria-hidden", "true")
      Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" })
      document.documentElement.append(host)
      const root = host.attachShadow({ mode: "open" })
      const layer = document.createElement("div")
      root.append(layer)
      ;(host as AnnotationHost & { __layer?: HTMLElement }).__layer = layer
      host.__annotations = new Map()
    }
    const layer = (host as AnnotationHost & { __layer?: HTMLElement }).__layer!
    Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", fontFamily: "system-ui, sans-serif", color: "#fff" })
    ;(host as AnnotationHost & { __layer?: HTMLElement }).__layer = layer
    const annotations = host.__annotations ??= new Map()
    const id = spec.id || `annotation-${Date.now()}-${Math.random()}`
    annotations.get(id)?.remove()
    const node = document.createElement("div")
    const target = spec.shape === "label" ? document.querySelector(spec.anchor?.selector || "") : spec.selector ? document.querySelector(spec.selector) : null
    if (["highlight", "spotlight", "arrow", "label"].includes(String(spec.shape)) && !target) throw new Error("Annotation target was not found")
    const theme = spec.theme ?? {}
    const color = String(theme.accentColor || "#64748b")
    const textColor = String(theme.textColor || "#fff")
    const background = String(theme.background || "rgba(15, 23, 42, .94)")
    function rect() { return target?.getBoundingClientRect() }
    function setRect(value: DOMRect) {
      const padding = Number(spec.style?.padding ?? 0)
      Object.assign(node.style, { left: `${value.left - padding}px`, top: `${value.top - padding}px`, width: `${value.width + padding * 2}px`, height: `${value.height + padding * 2}px` })
    }
    function render() {
      const value = rect()
      if (!value) return
      if (spec.shape === "highlight") setRect(value)
      if (spec.shape === "label") Object.assign(node.style, { left: `${value.left}px`, top: `${spec.anchor?.placement === "bottom" ? value.bottom + 8 : value.top - 44}px` })
      if (spec.shape === "spotlight") { const p = Number(spec.style?.padding ?? 8); const l=value.left-p,t=value.top-p,w=value.width+p*2,h=value.height+p*2; Object.assign(node.style,{clipPath:`polygon(0 0,100% 0,100% 100%,0 100%,0 0,${l}px ${t}px,${l}px ${t+h}px,${l+w}px ${t+h}px,${l+w}px ${t}px,${l}px ${t}px)`,background:"rgba(0,0,0,.62)"}) }
      if (spec.shape === "arrow") {
        const direction = spec.direction || "bottom-left"
        const [vertical, horizontal] = direction.split("-").length === 2 ? direction.split("-") : [direction, "center"]
        Object.assign(node.style, { left: `${horizontal === "left" ? value.left - 50 : horizontal === "right" ? value.right + 10 : value.left + value.width / 2}px`, top: `${vertical === "top" ? value.top - 50 : vertical === "bottom" ? value.bottom + 10 : value.top + value.height / 2}px` })
      }
    }
    Object.assign(node.style, { position: "fixed", boxSizing: "border-box", pointerEvents: "none", transition: spec.animate === "fade" || spec.animate === undefined ? "opacity .25s ease" : "none", opacity: "1" })
    if (spec.shape === "highlight") Object.assign(node.style, { border: `${Number(theme.strokeWidth ?? 3)}px solid ${color}`, borderRadius: spec.style?.variant === "box" ? `${Number(theme.radius ?? 0)}px` : "999px" })
    if (spec.shape === "spotlight") Object.assign(node.style, { inset: "0" })
    if (spec.shape === "arrow") { const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"); svg.setAttribute("width","88");svg.setAttribute("height","64");svg.setAttribute("viewBox","0 0 88 64");const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d","M4 56 Q30 52 72 12 M54 12 L72 12 L72 30");path.setAttribute("fill","none");path.setAttribute("stroke",color);path.setAttribute("stroke-width",String(theme.strokeWidth??3));path.setAttribute("stroke-linecap","round");path.setAttribute("stroke-linejoin","round");if(spec.animate==="draw"){path.setAttribute("stroke-dasharray","120");path.setAttribute("stroke-dashoffset","120");path.animate([{strokeDashoffset:"120"},{strokeDashoffset:"0"}],{duration:600,fill:"forwards"})}svg.append(path);node.append(svg);Object.assign(node.style,{transform:spec.direction?.startsWith("top")?"rotate(180deg)":spec.direction?.startsWith("left")?"rotate(90deg)":spec.direction?.startsWith("right")?"rotate(-90deg)":"none"}) }
    if (spec.shape === "label" || spec.shape === "caption") {
      node.textContent = spec.text || ""
      Object.assign(node.style, { padding: "8px 12px", borderRadius: `${Number(theme.radius ?? 6)}px`, color: textColor, background, fontFamily: theme.fontFamily ?? "system-ui, sans-serif", fontSize: `${Number(theme.fontSize ?? 16)}px`, whiteSpace: "nowrap" })
      if (spec.shape === "caption") Object.assign(node.style, { left: "10%", right: "10%", top: spec.position === "top" ? "8%" : spec.position === "center" ? "45%" : "auto", bottom: spec.position === "bottom" || !spec.position ? "8%" : "auto", textAlign: "center" })
    }
    node.dataset.annotationId = id
    layer.append(node)
    let frame = 0
    function update() { render(); frame = requestAnimationFrame(update) }
    render()
    if (target) frame = requestAnimationFrame(update)
    const remove = () => { cancelAnimationFrame(frame); node.remove() }
    annotations.set(id, { remove })
    if ((spec.durationMs ?? 0) > 0) setTimeout(() => { remove(); annotations.delete(id) }, spec.durationMs)
  }, spec)
}
