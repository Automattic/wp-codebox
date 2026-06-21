export const AGENT_WORKLOAD_SCHEMA = "wp-codebox/agent-workload/v1" as const

export const AGENT_WORKLOAD_JSON_SCHEMA = {
  $id: AGENT_WORKLOAD_SCHEMA,
  type: "object",
  required: ["schema", "task"],
  properties: {
    schema: {
      type: "string",
      const: AGENT_WORKLOAD_SCHEMA,
      description: "Public WP Codebox agent workload envelope schema id.",
    },
    agent_runtime: {
      type: ["object", "string"],
      description: "Codebox agent runtime selection. Use a string agent id, or an object with agent, mode, runtime_profile, runtime_packages, runtime_capabilities, and runtime_task.",
    },
    task: {
      type: ["object", "string"],
      description: "Task for the sandboxed agent. Use a string for the user-facing goal, or an object with goal, target, context, expected_artifacts, and structured_artifacts.",
    },
    tools: {
      type: "array",
      description: "Codebox tool ids the sandboxed agent may use.",
      items: { type: "string" },
    },
    provider: {
      type: "string",
      description: "AI provider id to seed into the Codebox runtime.",
    },
    model: {
      type: "string",
      description: "AI model id to seed into the Codebox runtime.",
    },
    target: {
      type: "object",
      description: "Bounded target for the task, such as a repo, site, plugin, or theme.",
    },
    artifacts: {
      type: "array",
      description: "Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.",
      items: { type: "string" },
    },
    policy: {
      type: "object",
      description: "Caller policy hints for approvals, apply-back, sandboxing, and risk controls.",
    },
    context: {
      type: "object",
      description: "Additional non-secret caller context for the sandboxed task.",
    },
  },
} as const
