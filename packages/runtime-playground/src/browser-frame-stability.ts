import type { Page } from "playwright"

export interface FrameStabilityOptions {
  maxFrames?: number
  identicalFrames?: number
}

export interface FrameStabilityResult<T> {
  frames: number | null
  stable: boolean
  snapshot: T
}

export async function settleByFrameStability<T>(page: Pick<Page, "evaluate">, measure: () => Promise<T> | T, options: FrameStabilityOptions = {}): Promise<FrameStabilityResult<T>> {
  const maxFrames = options.maxFrames ?? 40
  const identicalFrames = options.identicalFrames ?? 2
  if (maxFrames < 1 || identicalFrames < 1) {
    throw new Error("frame stability requires positive maxFrames and identicalFrames")
  }

  let previous = await measure()
  let previousJson = JSON.stringify(previous)
  let same = 0
  for (let count = 1; count <= maxFrames; count += 1) {
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    }))
    const current = await measure()
    const currentJson = JSON.stringify(current)
    same = currentJson === previousJson ? same + 1 : 0
    previous = current
    previousJson = currentJson
    if (same >= identicalFrames) {
      return { frames: count, stable: true, snapshot: current }
    }
  }

  return { frames: null, stable: false, snapshot: previous }
}
