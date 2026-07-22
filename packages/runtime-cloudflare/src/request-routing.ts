export type WorkerRequestRoute =
  | { kind: "wordpress" }
  | { kind: "health" }
  | { kind: "r2-state" }
  | { kind: "r2-mutate" }
  | { kind: "operator-reset" }
  | { kind: "operator-restore" }
  | { kind: "operator-adopt" }
  | { kind: "operator-publish" }
  | { kind: "probe"; phase: string }

export function routeWorkerRequest(request: Request): WorkerRequestRoute {
  const phase = new URL(request.url).searchParams.get("phase")
  if (phase === null) return { kind: "wordpress" }
  if (phase === "health") return { kind: "health" }
  if (phase === "r2-state") return { kind: "r2-state" }
  if (phase === "r2-mutate") return { kind: "r2-mutate" }
  if (phase === "operator-reset") return { kind: "operator-reset" }
  if (phase === "operator-restore") return { kind: "operator-restore" }
  if (phase === "operator-adopt") return { kind: "operator-adopt" }
  if (phase === "operator-publish") return { kind: "operator-publish" }
  return { kind: "probe", phase }
}
