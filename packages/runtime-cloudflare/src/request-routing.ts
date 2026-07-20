export type WorkerRequestRoute =
  | { kind: "wordpress" }
  | { kind: "health" }
  | { kind: "r2-state" }
  | { kind: "r2-mutate" }
  | { kind: "canonical-auth" }
  | { kind: "operator-reset" }
  | { kind: "editor-memory-probe"; phase: EditorMemoryProbePhase }
  | { kind: "probe"; phase: string }

export type EditorMemoryProbePhase = "admin" | "before-insert" | "after-insert" | "after-get-post" | "before-hooks" | "after-hooks" | "before-preload-paths" | "before-rest-preload" | "before-rest-preload-skip-global-styles" | "after-rest-preload" | "after-block-definitions" | "before-editor-settings" | "settings-before-styles" | "settings-after-presets" | "settings-after-block-classes" | "settings-before-global" | "settings-before-global-skip-custom-css" | "settings-before-global-skip-theme-styles" | "settings-before-assets" | "settings-after-assets" | "after-editor-settings" | "after-init-script" | "before-admin-header" | "after-admin-header" | "block-editor"

export function routeWorkerRequest(request: Request): WorkerRequestRoute {
  const phase = new URL(request.url).searchParams.get("phase")
  if (phase === null) return { kind: "wordpress" }
  if (phase === "health") return { kind: "health" }
  if (phase === "r2-state") return { kind: "r2-state" }
  if (phase === "r2-mutate") return { kind: "r2-mutate" }
  if (phase === "canonical-auth") return { kind: "canonical-auth" }
  if (phase === "operator-reset") return { kind: "operator-reset" }
  if (phase?.startsWith("editor-memory-")) {
    const editorPhase = phase.slice("editor-memory-".length)
    if (["admin", "before-insert", "after-insert", "after-get-post", "before-hooks", "after-hooks", "before-preload-paths", "before-rest-preload", "before-rest-preload-skip-global-styles", "after-rest-preload", "after-block-definitions", "before-editor-settings", "settings-before-styles", "settings-after-presets", "settings-after-block-classes", "settings-before-global", "settings-before-global-skip-custom-css", "settings-before-global-skip-theme-styles", "settings-before-assets", "settings-after-assets", "after-editor-settings", "after-init-script", "before-admin-header", "after-admin-header", "block-editor"].includes(editorPhase)) {
      return { kind: "editor-memory-probe", phase: editorPhase as EditorMemoryProbePhase }
    }
  }
  return { kind: "probe", phase }
}
