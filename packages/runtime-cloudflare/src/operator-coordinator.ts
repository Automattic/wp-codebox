import type { RevisionCoordinator } from "./revision-coordinator.js"
import type { WorkerRequestRoute } from "./request-routing.js"

export function selectOperatorCoordinator(
  active: RevisionCoordinator,
  route: WorkerRequestRoute,
  selector: string | null,
  resolve?: (selector: string) => RevisionCoordinator | undefined,
): { coordinator: RevisionCoordinator; selected: boolean } | null {
  if (!selector) return { coordinator: active, selected: false }
  if (route.kind !== "operator-adopt" && route.kind !== "operator-fence") return route.kind.startsWith("operator-") ? null : { coordinator: active, selected: false }
  const coordinator = resolve?.(selector)
  return coordinator ? { coordinator, selected: true } : null
}
