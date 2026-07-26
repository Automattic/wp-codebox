export type WorkerRequestRoute =
  | { kind: "wordpress" }
  | { kind: "health" }
  | { kind: "r2-state" }
  | { kind: "r2-mutate" }
  | { kind: "operator-reset" }
  | { kind: "operator-restore" }
  | { kind: "operator-adopt" }
  | { kind: "operator-fence"; action: "status" | "acquire" | "renew" | "release" }
  | { kind: "operator-static-artifact-import" }
  | { kind: "operator-static-artifact-operation"; operationId: string }
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
  if (phase === "operator-fence-status") return { kind: "operator-fence", action: "status" }
  if (phase === "operator-fence-acquire") return { kind: "operator-fence", action: "acquire" }
  if (phase === "operator-fence-renew") return { kind: "operator-fence", action: "renew" }
  if (phase === "operator-fence-release") return { kind: "operator-fence", action: "release" }
  if (phase === "operator-static-artifact-import") return { kind: "operator-static-artifact-import" }
  if (phase === "operator-static-artifact-operation") {
    const operationId = new URL(request.url).searchParams.get("operationId")
    return operationId ? { kind: "operator-static-artifact-operation", operationId } : { kind: "probe", phase }
  }
  if (phase === "operator-publish") return { kind: "operator-publish" }
  return { kind: "probe", phase }
}
