import { D1OperationRepository } from "./d1-operation-repository.js"
import { routeProvisioningApi, type ProvisioningEnv } from "./provisioning-api.js"

interface ControlEnv extends ProvisioningEnv {
  WORDPRESS_STATE_DATABASE: D1Database
}

export default {
  async fetch(request: Request, env: ControlEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (pathname !== "/v1" && !pathname.startsWith("/v1/")) {
      return Response.json({ schema: "wp-codebox/provisioning-api/v1", error: { code: "not_found", message: "The API resource is unavailable." } }, { status: 404 })
    }
    return routeProvisioningApi(request, env, new D1OperationRepository(env.WORDPRESS_STATE_DATABASE))
  },
}
