import type { WorkspaceRecipeRuntimeOverlay } from "@automattic/wp-codebox-core"
import type { PreparedRuntimeOverlay } from "./recipe-sources.js"

export interface RuntimeOverlayDescriptor {
  kind: string
  library: string
  strategy: string
  defaultTarget: string
  prepare: (overlay: WorkspaceRecipeRuntimeOverlay, recipeDirectory: string, index: number) => Promise<PreparedRuntimeOverlay>
}

const runtimeOverlayDescriptors = new Map<string, RuntimeOverlayDescriptor>()

export function registerRuntimeOverlayDescriptor(descriptor: RuntimeOverlayDescriptor): void {
  runtimeOverlayDescriptors.set(runtimeOverlayDescriptorKey(descriptor), descriptor)
}

export function registeredRuntimeOverlayDescriptors(): RuntimeOverlayDescriptor[] {
  return [...runtimeOverlayDescriptors.values()]
}

export function runtimeOverlayDescriptor(overlay: Pick<WorkspaceRecipeRuntimeOverlay, "kind" | "library" | "strategy">): RuntimeOverlayDescriptor | undefined {
  return runtimeOverlayDescriptors.get(runtimeOverlayDescriptorKey(overlay))
}

export function runtimeOverlayTarget(overlay: WorkspaceRecipeRuntimeOverlay): string {
  return overlay.target ?? runtimeOverlayDescriptor(overlay)?.defaultTarget ?? ""
}

function runtimeOverlayDescriptorKey(descriptor: Pick<RuntimeOverlayDescriptor, "kind" | "library" | "strategy">): string {
  return `${descriptor.kind}\u0000${descriptor.library}\u0000${descriptor.strategy}`
}
