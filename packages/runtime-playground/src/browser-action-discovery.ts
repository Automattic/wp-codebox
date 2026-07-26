import type { BrowserActionCorpusDescriptor } from "@automattic/wp-codebox-core"
import type { Frame, Page } from "playwright"

export async function discoverBrowserActionCorpusDescriptors(page: Page | Frame): Promise<{
  descriptors: BrowserActionCorpusDescriptor[]
  diagnostics: Array<{ code: string; message: string; metadata?: Record<string, unknown> }>
}> {
  return await page.evaluate(() => {
    const MAX_REJECTION_DIAGNOSTICS = 20
    const descriptors: BrowserActionCorpusDescriptor[] = []
    const rejected: Array<{ kind: string; tag: string; label: string }> = []
    const identityOccurrences = new Map<string, number>()
    const cssEscape = (value: string) => {
      const escapeFn = (globalThis as typeof globalThis & { CSS?: { escape?: (raw: string) => string } }).CSS?.escape
      return escapeFn ? escapeFn(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
    }
    const text = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim().slice(0, 120)
    const attributeSelector = (name: string, value: string) => `[${name}=${cssEscape(value)}]`
    const uniquelySelects = (selector: string, element: Element) => {
      try {
        const matches = document.querySelectorAll(selector)
        return matches.length === 1 && matches[0] === element
      } catch {
        return false
      }
    }
    const selectorFor = (element: Element): string | undefined => {
      const tag = element.tagName.toLowerCase()
      const candidates: string[] = []
      const seen = new Set<string>()
      const addCandidate = (selector: string) => {
        if (!seen.has(selector)) {
          seen.add(selector)
          candidates.push(selector)
        }
      }
      const id = element.getAttribute("id")
      if (id) addCandidate(`#${cssEscape(id)}`)

      const attributes = new Map(["aria-label", "aria-labelledby", "name", "type", "value", "title", "href", "role"].flatMap((name) => {
        const value = element.getAttribute(name)
        return value ? [[name, value] as const] : []
      }))
      const addAttributeCombination = (...names: string[]) => {
        if (names.every((name) => attributes.has(name))) {
          addCandidate(`${tag}${names.map((name) => attributeSelector(name, attributes.get(name)!)).join("")}`)
        }
      }
      for (const names of [
        ["aria-label"], ["aria-labelledby"],
        ["name", "type", "value"], ["name", "type"], ["name", "value"], ["name"],
        ["href"], ["title"],
        ["role", "type", "value"], ["role", "type"], ["role"],
        ["type", "value"], ["value"], ["type"],
      ]) {
        addAttributeCombination(...names)
      }

      const form = (element as HTMLInputElement).form
      const formId = form?.getAttribute("id")
      if (form && formId) {
        const formSelector = `#${cssEscape(formId)}`
        if (uniquelySelects(formSelector, form)) {
          for (const candidate of [...candidates]) addCandidate(`${formSelector} ${candidate}`)
        }
      }
      for (const candidate of candidates) {
        if (uniquelySelects(candidate, element)) return candidate
      }

      const parts: string[] = []
      let current: Element | null = element
      while (current) {
        let part = current.tagName.toLowerCase()
        const parent: Element | null = current.parentElement
        if (parent) {
          const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName)
          if (sameTagSiblings.length > 1) part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`
        }
        parts.unshift(part)
        const candidate = parts.join(" > ")
        if (uniquelySelects(candidate, element)) return candidate
        current = parent
      }
      return undefined
    }
    const labelFor = (element: Element) => {
      const labelledBy = element.getAttribute("aria-labelledby")
      if (labelledBy) {
        const labelled = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(" ")
        if (text(labelled)) return text(labelled)
      }
      const aria = text(element.getAttribute("aria-label"))
      if (aria) return aria
      const id = element.getAttribute("id")
      const label = id ? document.querySelector(`label[for="${cssEscape(id)}"]`) : null
      if (label && text(label.textContent)) return text(label.textContent)
      return text(element.textContent)
    }
    const descriptorId = (kind: string, element: Element) => {
      const input = element as HTMLInputElement
      const identity = JSON.stringify({
        kind,
        label: labelFor(element),
        name: element.getAttribute("name") || "",
        role: element.getAttribute("role") || "",
        type: input.type || element.getAttribute("type") || "",
        href: element.tagName.toLowerCase() === "a" ? (element as HTMLAnchorElement).href : "",
        options: element.tagName.toLowerCase() === "select" ? Array.from((element as HTMLSelectElement).options).map((option) => option.value) : [],
      })
      const occurrence = identityOccurrences.get(identity) ?? 0
      identityOccurrences.set(identity, occurrence + 1)
      return `${kind}:${identity}:${occurrence}`
    }
    const visible = (element: Element) => {
      const htmlElement = element as HTMLElement
      const style = window.getComputedStyle(htmlElement)
      const rect = htmlElement.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    }
    document.querySelectorAll("a[href], button, input, textarea, select").forEach((element) => {
      if (!visible(element)) return
      const tag = element.tagName.toLowerCase()
      const input = element as HTMLInputElement
      const kind = tag === "a" ? "link" : tag === "button" ? "button" : tag === "textarea" ? "textarea" : tag === "select" ? "select" : "input"
      const selector = selectorFor(element)
      if (!selector) {
        rejected.push({ kind, tag, label: labelFor(element) })
        return
      }
      descriptors.push({
        id: descriptorId(kind, element),
        kind,
        selector,
        label: labelFor(element),
        name: element.getAttribute("name") || undefined,
        role: element.getAttribute("role") || undefined,
        type: input.type || element.getAttribute("type") || undefined,
        formId: (element as HTMLInputElement).form?.id || undefined,
        href: tag === "a" ? (element as HTMLAnchorElement).href : undefined,
        disabled: Boolean((element as HTMLButtonElement).disabled),
        readonly: Boolean(input.readOnly),
        optionValues: tag === "select" ? Array.from((element as HTMLSelectElement).options).map((option) => option.value).filter(Boolean) : undefined,
      })
    })
    const diagnostics: Array<{ code: string; message: string; metadata?: Record<string, unknown> }> = rejected.slice(0, MAX_REJECTION_DIAGNOSTICS).map((item) => ({
      code: "browser_action_corpus_selector_not_unique",
      message: "An actionable control was rejected because discovery could not produce a selector resolving uniquely to that element.",
      metadata: item,
    }))
    if (rejected.length > MAX_REJECTION_DIAGNOSTICS) {
      diagnostics[MAX_REJECTION_DIAGNOSTICS - 1] = {
        code: "browser_action_corpus_selector_rejections_truncated",
        message: "Additional actionable controls without unique selectors were omitted from diagnostics.",
        metadata: { rejected: rejected.length, retainedDiagnostics: MAX_REJECTION_DIAGNOSTICS - 1 },
      }
    }
    return { descriptors, diagnostics }
  })
}
