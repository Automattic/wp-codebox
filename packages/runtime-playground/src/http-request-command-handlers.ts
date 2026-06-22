import { argValue, jsonObjectArg } from "./command-args.js"

export interface HttpRequestCommandInput {
  command?: "wordpress.http-request" | "wordpress.server-page-load"
  method: string
  url: string
  headers: Record<string, unknown>
  body: string | undefined
  expectStatus: number | undefined
}

export function httpRequestInputFromArgs(args: string[]): HttpRequestCommandInput {
  const url = argValue(args, "url")?.trim()
  if (!url) {
    throw new Error("wordpress.http-request requires url=<path-or-url>")
  }

  return {
    method: (argValue(args, "method")?.trim() || "GET").toUpperCase(),
    command: "wordpress.http-request",
    url,
    headers: jsonObjectArg(args, "headers-json"),
    body: argValue(args, "body"),
    expectStatus: optionalStatusArg(args, "expect-status"),
  }
}

export async function runHttpRequest(input: HttpRequestCommandInput, baseUrl: string): Promise<string> {
  const startedAt = Date.now()
  const resolvedUrl = /^https?:\/\//i.test(input.url) ? input.url : new URL(input.url, baseUrl).toString()
  const response = await fetch(resolvedUrl, {
    method: input.method,
    headers: stringHeaders(input.headers),
    body: input.body,
  })
  const body = await response.text()
  const output = {
    command: input.command ?? "wordpress.http-request",
    method: input.method,
    url: input.url,
    resolvedUrl,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    bodyBytes: Buffer.byteLength(body),
    timing: { duration_ms: Date.now() - startedAt },
    performance: { schema: "wp-codebox/performance-observation/v1", command: input.command ?? "wordpress.http-request", target: input.url, source: "server-http", kind: input.command === "wordpress.server-page-load" ? "server-page-load" : "http-request", timing: { durationMs: Date.now() - startedAt }, network: { requests: 1, responses: 1, failures: response.ok ? 0 : 1, transferSizeBytes: Buffer.byteLength(body) } },
    diagnostics: {},
  }

  if (input.expectStatus !== undefined && response.status !== input.expectStatus) {
    throw new Error(`wordpress.http-request expected status ${input.expectStatus} but received ${response.status}`)
  }

  return `${JSON.stringify(output, null, 2)}\n`
}

function optionalStatusArg(args: string[], name: string): number | undefined {
  const raw = argValue(args, name)?.trim()
  if (!raw) {
    return undefined
  }
  const status = Number.parseInt(raw, 10)
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`wordpress.http-request ${name} must be an HTTP status code: ${raw}`)
  }
  return status
}

function stringHeaders(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]))
}
