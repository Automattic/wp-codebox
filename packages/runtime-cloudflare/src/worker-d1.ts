import { D1RevisionCoordinator } from "./d1-revision-coordinator.js"
export { WordPressStateCoordinator } from "./state-coordinator.js"
import type { SiteContext } from "./site-context.js"
import { createCloudflareRuntime, type RuntimeEnv } from "./worker.js"

interface D1RuntimeEnv extends RuntimeEnv {
  WORDPRESS_STATE_DATABASE: D1Database
}

export default createCloudflareRuntime<D1RuntimeEnv>((env, site: SiteContext) => (
  new D1RevisionCoordinator(env.WORDPRESS_STATE_DATABASE, site.id)
))
