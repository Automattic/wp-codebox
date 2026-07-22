import { DurableObjectRevisionCoordinator, WordPressStateCoordinator } from "./state-coordinator.js"
import { createCloudflareRuntime, type RuntimeEnv } from "./worker.js"

interface DurableObjectRuntimeEnv extends RuntimeEnv {
  WORDPRESS_STATE: DurableObjectNamespace
}

export { WordPressStateCoordinator }

export default createCloudflareRuntime<DurableObjectRuntimeEnv>((env) => (
  new DurableObjectRevisionCoordinator(env.WORDPRESS_STATE.getByName("default"))
))
