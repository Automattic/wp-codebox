export type WorkerRequestRoute =
  | { kind: "wordpress" }
  | { kind: "health" }
  | { kind: "r2-state" }
  | { kind: "r2-mutate" }
  | { kind: "canonical-auth" }
  | { kind: "operator-reset" }
  | { kind: "editor-probe"; phase: EditorProbePhase }
  | { kind: "probe"; phase: string }

export type EditorProbePhase = "admin" | "auto-draft" | "block-editor"

export function routeWorkerRequest(request: Request): WorkerRequestRoute {
  const phase = new URL(request.url).searchParams.get("phase")
  if (phase === null) return { kind: "wordpress" }
  if (phase === "health") return { kind: "health" }
  if (phase === "r2-state") return { kind: "r2-state" }
  if (phase === "r2-mutate") return { kind: "r2-mutate" }
  if (phase === "canonical-auth") return { kind: "canonical-auth" }
  if (phase === "operator-reset") return { kind: "operator-reset" }
  if (phase === "editor-probe-admin") return { kind: "editor-probe", phase: "admin" }
  if (phase === "editor-probe-auto-draft") return { kind: "editor-probe", phase: "auto-draft" }
  if (phase === "editor-probe-block-editor") return { kind: "editor-probe", phase: "block-editor" }
  return { kind: "probe", phase }
}
