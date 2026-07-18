import { createRuntimeCommandResultEnvelope } from "@automattic/wp-codebox-core/runtime-command-result"

export const CLOUDFLARE_RUNTIME_HEALTH_SCHEMA = "wp-codebox/cloudflare-runtime-health/v1" as const
export const CLOUDFLARE_RUNTIME_HEALTH_MARKER = "wp-codebox-cloudflare-runtime-health" as const

export interface CloudflareRuntimeHealth {
  schema: typeof CLOUDFLARE_RUNTIME_HEALTH_SCHEMA
  marker: typeof CLOUDFLARE_RUNTIME_HEALTH_MARKER
  wordpressVersion: string
  phpVersion: string
  runtime: { backend: "wordpress-playground"; environment: "wordpress" }
  evidence: { initialization: "completed"; execution: "completed"; initializationScope: "isolate" }
}

export function cloudflareRuntimeHealthResponse(health: CloudflareRuntimeHealth): Response {
  const execution = createRuntimeCommandResultEnvelope({
    status: "ok",
    json: health,
    diagnostics: [{ schema: "wp-codebox/runtime-diagnostic/v1", code: "wordpress_runtime_initialized", severity: "info", message: "WordPress boot and PHP execution completed." }],
  })

  return Response.json({ ...health, execution })
}
