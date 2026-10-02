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
       if (spec.shape === "label") {
         const gap = 12
         const width = node.offsetWidth
         const height = node.offsetHeight
         const placement = spec.anchor?.placement === "bottom" ? "bottom" : "top"
         const canPlace = (side: string) => side === "top" ? value.top >= height + gap : innerHeight - value.bottom >= height + gap
        const opposite = placement === "top" ? "bottom" : "top"
        const side = canPlace(placement) ? placement : canPlace(opposite) ? opposite : placement
         const left = Math.max(8, Math.min(value.left, innerWidth - width - 8))
         const top = Math.max(8, Math.min(side === "bottom" ? value.bottom + gap : value.top - height - gap, innerHeight - height - 8))
         Object.assign(node.style, { left: `${left}px`, top: `${top}px` })
       }
       if (spec.shape === "spotlight") { const p = Number(spec.style?.padding ?? 8); const l=value.left-p,t=value.top-p,w=value.width+p*2,h=value.height+p*2; Object.assign(node.style,{clipPath:`polygon(0 0,100% 0,100% 100%,0 100%,0 0,${l}px ${t}px,${l}px ${t+h}px,${l+w}px ${t+h}px,${l+w}px ${t}px,${l}px ${t}px)`,background:"rgba(0,0,0,.62)"}) }
       if (spec.shape === "arrow") {
         const direction = spec.direction || "bottom-left"
         const [dx, dy] = direction === "left" ? [-1, 0] : direction === "right" ? [1, 0] : direction === "top" ? [0, -1] : direction === "bottom" ? [0, 1] : direction === "top-left" ? [-1, -1] : direction === "top-right" ? [1, -1] : direction === "bottom-right" ? [1, 1] : [-1, 1]
         const length = 56
         const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy)
         const endX = value.left + value.width / 2 - ux * (dx && dy ? value.width / 2 / Math.SQRT2 : dx ? value.width / 2 : 0)
         const endY = value.top + value.height / 2 - uy * (dx && dy ? value.height / 2 / Math.SQRT2 : dy ? value.height / 2 : 0)
         const startX = endX + ux * length, startY = endY + uy * length
         const bounds = { left: Math.min(startX, endX) - 10, top: Math.min(startY, endY) - 10 }
         node.style.left = `${bounds.left}px`; node.style.top = `${bounds.top}px`
         const svg = node.querySelector("svg")!
         const shaft = svg.querySelector("path")!
         const sx = startX - bounds.left, sy = startY - bounds.top, ex = endX - bounds.left, ey = endY - bounds.top
         const head = 10, angle = Math.atan2(ey - sy, ex - sx), spread = Math.PI / 6
         shaft.setAttribute("d", `M ${sx} ${sy} L ${ex} ${ey} M ${ex - head * Math.cos(angle - spread)} ${ey - head * Math.sin(angle - spread)} L ${ex} ${ey} L ${ex - head * Math.cos(angle + spread)} ${ey - head * Math.sin(angle + spread)}`)
         svg.setAttribute("width", "80"); svg.setAttribute("height", "80"); svg.setAttribute("viewBox", "0 0 80 80")
       }
    }
    Object.assign(node.style, { position: "fixed", boxSizing: "border-box", pointerEvents: "none", transition: spec.animate === "fade" || spec.animate === undefined ? "opacity .25s ease" : "none", opacity: "1" })
    if (spec.shape === "highlight") Object.assign(node.style, { border: `${Number(theme.strokeWidth ?? 3)}px solid ${color}`, borderRadius: spec.style?.variant === "box" ? `${Number(theme.radius ?? 0)}px` : "999px" })
    if (spec.shape === "spotlight") Object.assign(node.style, { inset: "0" })
     if (spec.shape === "arrow") { const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"); svg.setAttribute("width","80");svg.setAttribute("height","80");svg.setAttribute("viewBox","0 0 80 80");const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("fill","none");path.setAttribute("stroke",color);path.setAttribute("stroke-width",String(theme.strokeWidth??3));path.setAttribute("stroke-linecap","round");path.setAttribute("stroke-linejoin","round");if(spec.animate==="draw"){path.setAttribute("stroke-dasharray","120");path.setAttribute("stroke-dashoffset","120");path.animate([{strokeDashoffset:"120"},{strokeDashoffset:"0"}],{duration:600,fill:"forwards"})}svg.append(path);node.append(svg) }
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
