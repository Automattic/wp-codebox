import { DurableObjectRevisionCoordinator, WordPressStateCoordinator } from "./state-coordinator.js"
import type { SiteContext } from "./site-context.js"
import { createCloudflareRuntime, type RuntimeEnv } from "./worker.js"

interface DurableObjectRuntimeEnv extends RuntimeEnv {
  WORDPRESS_STATE: DurableObjectNamespace
}

export { WordPressStateCoordinator }

export default createCloudflareRuntime<DurableObjectRuntimeEnv>((env, site: SiteContext) => (
  new DurableObjectRevisionCoordinator(env.WORDPRESS_STATE.getByName(site.id), site.id)
))
