import assert from "node:assert/strict"

import { visualCompareLayoutDrift } from "../packages/runtime-playground/src/browser-visual-compare.js"
import type { BrowserDomElementSnapshot } from "../packages/runtime-playground/src/browser-dom-snapshot.js"

function element(path: string, y: number, height: number, options: { position?: string; tag?: string; text?: string; className?: string; x?: number; width?: number } = {}): BrowserDomElementSnapshot {
  return {
    path,
    tag: options.tag ?? "div",
    text: options.text ?? path,
    attributes: options.className ? { class: options.className } : {},
    boundingBox: { x: options.x ?? 0, y, width: options.width ?? 100, height },
    styles: { display: "block", position: options.position ?? "static", height: `${height}px` },
  }
}

{
  const source = [element("header", 0, 40), element("main", 60, 100), element("footer", 180, 20)]
  const candidate = [element("header", 0, 64), element("main", 84, 100), element("footer", 204, 20)]
  const drift = visualCompareLayoutDrift(source, candidate, true)

  assert.equal(drift?.summary.firstDivergenceType, "height-delta")
  assert.equal(drift.firstDivergence.path, "header")
  assert.equal(drift.firstDivergence.delta?.height, 24)
  assert.equal(drift.summary.maxAbsHeightDelta, 24)
  assert.equal(drift.summary.maxAbsYOffset, 24)
  assert.match(drift.summary.compact, /First layout drift: height-delta at header \(\+24px\)/)
}

{
  const source = [element("intro", 0, 40), element("body", 60, 100)]
  const candidate = [element("intro", 0, 40), element("body", 84, 100)]
  const drift = visualCompareLayoutDrift(source, candidate, true)

  assert.equal(drift?.summary.firstDivergenceType, "gap-delta")
  assert.equal(drift.firstDivergence.path, "body")
  assert.equal(drift.firstDivergence.previousPath, "intro")
  assert.equal(drift.firstDivergence.delta?.gap, 24)
}

{
  const source = [element("card", 100, 50)]
  const candidate = [element("card", 88, 50)]
  const drift = visualCompareLayoutDrift(source, candidate, true)

  assert.equal(drift?.summary.firstDivergenceType, "y-offset")
  assert.equal(drift.firstDivergence.delta?.y, -12)
}

{
  const source = [element("nav", 0, 30, { position: "fixed" }), element("main", 50, 100)]
  const candidate = [element("nav", 20, 60, { position: "fixed" }), element("main", 50, 100)]
  const drift = visualCompareLayoutDrift(source, candidate, true)

  assert.equal(drift?.summary.firstDivergenceType, "screenshot-only")
  assert.equal(drift.summary.matchedFlowElements, 1)
  assert.equal(drift.summary.changedFlowElements, 0)
}

{
  const source = [element("hero", 0, 50), element("old", 70, 20)]
  const candidate = [element("hero", 0, 50), element("new", 60, 20)]
  const drift = visualCompareLayoutDrift(source, candidate, true)

  assert.equal(drift?.summary.firstDivergenceType, "added-flow-element")
  assert.equal(drift.firstDivergence.path, "new")
  assert.equal(drift.summary.addedFlowElements, 1)
  assert.equal(drift.summary.removedFlowElements, 1)
}

{
  const source = [element("same", 0, 50)]
  const candidate = [element("same", 0, 50)]
  assert.equal(visualCompareLayoutDrift(source, candidate, false), undefined)
  assert.equal(visualCompareLayoutDrift(source, candidate, true)?.summary.firstDivergenceType, "screenshot-only")
}

console.log("browser visual compare layout-drift attribution passed")
