import { D1RevisionCoordinator } from "./d1-revision-coordinator.js"
import { DurableObjectRevisionCoordinator, WordPressStateCoordinator } from "./state-coordinator.js"
export { WordPressStateCoordinator }
import type { SiteContext } from "./site-context.js"
import { createCloudflareRuntime, type RuntimeEnv } from "./worker.js"

interface D1RuntimeEnv extends RuntimeEnv {
  WORDPRESS_STATE_DATABASE: D1Database
  WORDPRESS_STATE: DurableObjectNamespace
}

export default createCloudflareRuntime<D1RuntimeEnv>((env, site: SiteContext) => (
  new D1RevisionCoordinator(env.WORDPRESS_STATE_DATABASE, site.id)
), (env, site: SiteContext, selector) => (
  selector === "durable-object" ? new DurableObjectRevisionCoordinator(env.WORDPRESS_STATE.getByName(site.id), site.id) : undefined
))
