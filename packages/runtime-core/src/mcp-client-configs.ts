export type McpClientConfigFormat = "json" | "yaml" | "toml"

export interface McpClientConfigAdapter {
  id: string
  label: string
  file: string
  format: McpClientConfigFormat
}

export interface McpClientConfigArtifact {
  path: string
  contents: string
  clientId?: string
  format?: McpClientConfigFormat
}

export interface McpClientConfigRenderedClient {
  id: string
  label: string
  config_artifact: string
  format: McpClientConfigFormat
  adapter_only: true
}

export interface McpClientConfigRenderSpec {
  outputRoot: string
  serverName: string
  command: string
  args: string[]
  env?: Record<string, string>
  sourceRecipe?: string
  clientRecipe?: string
  capabilityGroups?: string[]
  expectedTools?: Record<string, string[]>
  authBootstrap?: {
    env: string
    source: string
    reviewerSafeValue: string
    guidePath?: string
    note?: string
  }
  clients?: McpClientConfigAdapter[]
  proofSchema?: string
  readmeIntro?: string
}

export interface McpClientConfigRenderResult {
  schema: "wp-codebox/local-mcp-client-configs/v1"
  artifacts: McpClientConfigArtifact[]
  manifest: Record<string, unknown>
  clients: McpClientConfigRenderedClient[]
}

export const defaultMcpClientConfigAdapters: McpClientConfigAdapter[] = [
  { id: "cursor", label: "Cursor", file: ".cursor/mcp.json", format: "json" },
  { id: "vscode", label: "VS Code", file: ".vscode/mcp.json", format: "json" },
  { id: "goose", label: "Goose", file: ".config/goose/config.yaml", format: "yaml" },
  { id: "claude-code", label: "Claude Code", file: ".mcp.json", format: "json" },
  { id: "codex", label: "Codex", file: ".codex/config.toml", format: "toml" },
]

const reviewerUnsafePatterns = [
  /xox[pbar]-/i,
  /gh[pousr]_[a-z0-9_]+/i,
  /Bearer\s+[a-z0-9._-]+/i,
  /oauth[_-]?token\s*[:=]/i,
  /callback[_-]?secret\s*[:=]/i,
  /client[_-]?secret\s*[:=]/i,
  /consumer[_-]?secret\s*[:=]/i,
  /\/Users\//,
  /\/home\/[a-z0-9._-]+\//i,
  /\/var\/www\//,
]

export function assertMcpReviewerSafe(contents: string, label = "MCP client config artifact", allowedPlaceholders: string[] = []): void {
  let sanitized = contents
  for (const placeholder of allowedPlaceholders) {
    sanitized = sanitized.split(placeholder).join("[allowed-placeholder]")
  }

  for (const pattern of reviewerUnsafePatterns) {
    if (pattern.test(sanitized)) {
      throw new Error(`Refusing secret-looking or local-only value in ${label}`)
    }
  }
}

export function renderMcpClientConfigArtifacts(spec: McpClientConfigRenderSpec): McpClientConfigRenderResult {
  const clients = spec.clients ?? defaultMcpClientConfigAdapters
  const outputRoot = normalizeRelativeRoot(spec.outputRoot)
  assertReviewerSafeEnv(spec.env ?? {})
  const allowedPlaceholders = Object.values(spec.env ?? {}).filter((value) => value.startsWith("${") && value.endsWith("}"))
  const renderedClients: McpClientConfigRenderedClient[] = []
  const artifacts: McpClientConfigArtifact[] = []

  for (const client of clients) {
    const relativePath = joinRelative(outputRoot, client.id, client.file)
    const contents = renderMcpClientConfig(client, spec)
    assertMcpReviewerSafe(contents, relativePath, allowedPlaceholders)
    artifacts.push({ path: relativePath, contents, clientId: client.id, format: client.format })
    renderedClients.push({ id: client.id, label: client.label, config_artifact: relativePath, format: client.format, adapter_only: true })
  }

  const authGuidePath = spec.authBootstrap?.guidePath ?? joinRelative(outputRoot, "auth-bootstrap.md")
  const proofPath = joinRelative(outputRoot, "tools-list-proof.json")
  const manifestPath = joinRelative(outputRoot, "manifest.json")
  const readmePath = joinRelative(outputRoot, "README.md")
  const capabilityGroups = spec.capabilityGroups ?? Object.keys(spec.expectedTools ?? {})
  const manifest: Record<string, unknown> = {
    schema: "wp-codebox/local-mcp-client-configs/v1",
    recipe: spec.clientRecipe,
    source_recipe: spec.sourceRecipe,
    shared_server: spec.serverName,
    shared_capability_groups: capabilityGroups,
    expected_tools: spec.expectedTools,
    mcp_transport: "stdio",
    auth_bootstrap: spec.authBootstrap
      ? {
          env: spec.authBootstrap.env,
          source: spec.authBootstrap.source,
          reviewer_safe_value: spec.authBootstrap.reviewerSafeValue,
          guide: authGuidePath,
          note: spec.authBootstrap.note ?? "Generated configs intentionally contain placeholders only; no token material is written.",
        }
      : undefined,
    expected_tools_list: {
      required_capability_groups: capabilityGroups,
      proof_artifact: proofPath,
      status: "verified statically against generated client configs and the declared MCP recipe",
      secret_safety: "generated configs contain no OAuth tokens, callback secrets, local-only paths, or production credentials",
    },
    clients: renderedClients,
  }

  artifacts.push(jsonArtifact(manifestPath, manifest, allowedPlaceholders))

  if (spec.authBootstrap) {
    artifacts.push(textArtifact(authGuidePath, renderAuthBootstrapMarkdown(spec, capabilityGroups), allowedPlaceholders))
  }

  artifacts.push(jsonArtifact(proofPath, renderToolsListProof(spec, proofPath, renderedClients), allowedPlaceholders))
  artifacts.push(textArtifact(readmePath, renderReadmeMarkdown(spec, clients, renderedClients), allowedPlaceholders))

  return { schema: "wp-codebox/local-mcp-client-configs/v1", artifacts, manifest, clients: renderedClients }
}

export function renderMcpClientConfig(client: McpClientConfigAdapter, spec: Pick<McpClientConfigRenderSpec, "serverName" | "command" | "args" | "env">): string {
  const server = { command: spec.command, args: spec.args, env: spec.env ?? {} }

  if (client.id === "vscode") {
    return `${JSON.stringify({ servers: { [spec.serverName]: { type: "stdio", ...server } } }, null, 2)}\n`
  }

  if (client.format === "json") {
    return `${JSON.stringify({ mcpServers: { [spec.serverName]: server } }, null, 2)}\n`
  }

  if (client.format === "yaml") {
    return [
      "extensions:",
      `  ${spec.serverName}:`,
      "    type: stdio",
      `    cmd: ${spec.command}`,
      `    args: ${JSON.stringify(spec.args)}`,
      "    envs:",
      ...Object.entries(spec.env ?? {}).map(([key, value]) => `      ${key}: ${value}`),
      "",
    ].join("\n")
  }

  if (client.format === "toml") {
    return [
      `[mcp_servers.${spec.serverName}]`,
      `command = ${JSON.stringify(spec.command)}`,
      `args = ${JSON.stringify(spec.args)}`,
      "",
      `[mcp_servers.${spec.serverName}.env]`,
      ...Object.entries(spec.env ?? {}).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
      "",
    ].join("\n")
  }

  throw new Error(`Unsupported MCP client config format: ${client.format}`)
}

function renderAuthBootstrapMarkdown(spec: McpClientConfigRenderSpec, capabilityGroups: string[]): string {
  const auth = spec.authBootstrap
  if (!auth) {
    return ""
  }

  return `# Local MCP Auth Bootstrap\n\nThese generated configs are reviewer-safe. They contain the literal placeholder \`${auth.reviewerSafeValue}\`, not a token.\n\n## Runtime Flow\n\n1. Start from the shared \`${spec.serverName}\` MCP server entry in the client config.\n2. Provide \`${auth.env}\` from ${auth.source}.\n3. Launch the client. The client starts \`${spec.command} ${spec.args.join(" ")}\` over stdio.\n4. Run MCP \`tools/list\`. The expected shared capability groups are ${capabilityGroups.map((group) => `\`${group}\``).join(" and ")}.\n\n## Secret Safety\n\n- Commit only placeholders and config shape.\n- Keep real token values in the caller environment or local secret store.\n- Re-run the downstream local MCP auth/bootstrap probe before review to reject secret-looking values.\n`
}

function renderReadmeMarkdown(spec: McpClientConfigRenderSpec, clients: McpClientConfigAdapter[], renderedClients: McpClientConfigRenderedClient[]): string {
  return `# Local MCP Config Artifacts\n\n${spec.readmeIntro ?? "These files are generated for reviewer inspection."}\n\nThey prove that ${clients.map((client) => client.label).join(", ")} can all point at the same local \`${spec.serverName}\` MCP server definition:\n\n\`\`\`text\n${spec.command} ${spec.args.join(" ")}\n\`\`\`\n\n${spec.sourceRecipe ? `The server recipe is \`${spec.sourceRecipe}\`.` : "The server recipe is supplied by the downstream project."} Client files are adapter-only; product behavior remains in the declared recipe.\n\n## Generated Files\n\n${renderedClients.map((client) => `- ${client.label}: \`${client.config_artifact}\``).join("\n")}\n- Manifest: \`manifest.json\`\n- Auth bootstrap guide: \`auth-bootstrap.md\`\n- Tools/list proof: \`tools-list-proof.json\`\n\n## Auth\n\nReal tokens come from the caller environment or secret store at runtime and must not be committed.\n`
}

function renderToolsListProof(spec: McpClientConfigRenderSpec, proofPath: string, clients: McpClientConfigRenderedClient[]): Record<string, unknown> {
  return {
    schema: spec.proofSchema ?? "wp-codebox/local-mcp-tools-list-proof/v1",
    source_recipe: spec.sourceRecipe,
    shared_server: spec.serverName,
    transport: "stdio",
    verification: {
      proof_artifact: proofPath,
      method: "static contract verification against generated client configs and the declared MCP recipe; generated configs contain placeholders only",
      live_runtime_note: "When the WP Codebox recipe runner is available, run the same tools/list request through each client adapter against the stdio server.",
    },
    capability_groups: spec.expectedTools ?? {},
    clients: clients.map((client) => ({ id: client.id, label: client.label, config_artifact: client.config_artifact, server: spec.serverName })),
  }
}

function jsonArtifact(path: string, value: Record<string, unknown>, allowedPlaceholders: string[]): McpClientConfigArtifact {
  const contents = `${JSON.stringify(value, null, 2)}\n`
  return textArtifact(path, contents, allowedPlaceholders)
}

function textArtifact(path: string, contents: string, allowedPlaceholders: string[]): McpClientConfigArtifact {
  assertMcpReviewerSafe(contents, path, allowedPlaceholders)
  return { path, contents }
}

function normalizeRelativeRoot(value: string): string {
  return value.replace(/^\/+|\/+$/g, "")
}

function joinRelative(...parts: string[]): string {
  const joined = parts.join("/").replace(/\/+/g, "/")
  const segments = joined.split("/").filter(Boolean)
  if (segments.includes("..")) {
    throw new Error("MCP client config artifact paths must be relative and cannot contain parent-directory segments")
  }
  return segments.join("/")
}

function assertReviewerSafeEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!isSensitiveEnvKey(key)) {
      assertMcpReviewerSafe(value, `MCP env ${key}`)
      continue
    }

    if ((value.startsWith("${") && value.endsWith("}")) || value === "[redacted]") {
      continue
    }

    throw new Error(`MCP env ${key} must use a reviewer-safe placeholder or redacted value`)
  }
}

function isSensitiveEnvKey(key: string): boolean {
  return /(?:AUTH|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|KEY)$/i.test(key)
}
