export interface OverlayPrepareContext<TPrepared> {
  index: number
  recipeDirectory: string
  prepare: () => Promise<TPrepared>
}

export type OverlayPreparer<TOverlay, TPrepared> = (overlay: TOverlay, context: OverlayPrepareContext<TPrepared>) => Promise<TPrepared>

export class OverlayPreparerRegistry<TOverlay, TPrepared> {
  private preparers = new Map<string, OverlayPreparer<TOverlay, TPrepared>>()

  register(key: string, preparer: OverlayPreparer<TOverlay, TPrepared>): void {
    this.preparers.set(key, preparer)
  }

  async prepare(key: string, overlay: TOverlay, context: OverlayPrepareContext<TPrepared>): Promise<TPrepared> {
    const preparer = this.preparers.get(key)
    if (!preparer) {
      throw new Error(`Unsupported runtime overlay: ${key}`)
    }

    return preparer(overlay, context)
  }

  has(key: string): boolean {
    return this.preparers.has(key)
  }
}
