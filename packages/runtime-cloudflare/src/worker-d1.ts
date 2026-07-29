import { D1RevisionCoordinator } from "./d1-revision-coordinator.js"
import { D1OperationRepository } from "./d1-operation-repository.js"
import type { SiteContext } from "./site-context.js"
import { createCloudflareRuntime, type RuntimeEnv } from "./worker.js"

interface D1RuntimeEnv extends RuntimeEnv {
  WORDPRESS_STATE_DATABASE: D1Database
}

export default createCloudflareRuntime<D1RuntimeEnv>((env, site: SiteContext) => (
  new D1RevisionCoordinator(env.WORDPRESS_STATE_DATABASE, site.id)
), undefined, (env) => new D1OperationRepository(env.WORDPRESS_STATE_DATABASE))
