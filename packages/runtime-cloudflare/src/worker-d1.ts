import { D1RevisionCoordinator } from "./d1-revision-coordinator.js"
import { createCloudflareRuntime, type RuntimeEnv } from "./worker.js"

interface D1RuntimeEnv extends RuntimeEnv {
  WORDPRESS_STATE_DATABASE: D1Database
}

export default createCloudflareRuntime<D1RuntimeEnv>((env) => (
  new D1RevisionCoordinator(env.WORDPRESS_STATE_DATABASE)
))
