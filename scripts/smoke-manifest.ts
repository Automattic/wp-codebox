export type SmokeCommand = {
  name: string
  command: string
  args: string[]
}

type SmokeGroupDefinition = {
  description: string
  commands: SmokeCommand[]
}

function npmScript(name: string): SmokeCommand {
  return {
    name,
    command: "npm",
    args: ["run", name],
  }
}

function tsxSmoke(name: string, script = name): SmokeCommand {
  return {
    name,
    command: "tsx",
    args: [`scripts/${script}.ts`],
  }
}

export const smokeGroups = {
  core: {
    description: "Build and core command contract smoke checks.",
    commands: [
      npmScript("build"),
      tsxSmoke("runtime-backend-registry-smoke"),
      tsxSmoke("command-registry-smoke"),
      tsxSmoke("command-args-smoke"),
      tsxSmoke("host-tool-registry-smoke"),
      tsxSmoke("host-command-tool-smoke"),
      tsxSmoke("task-input-contract-smoke"),
      tsxSmoke("discovery-command-smoke"),
      tsxSmoke("doctor-command-smoke"),
      tsxSmoke("source-checkout-entrypoint-smoke"),
      tsxSmoke("cli-unsettled-command-smoke"),
      tsxSmoke("php-snippets-smoke"),
      tsxSmoke("agent-runtime-failure-smoke"),
      tsxSmoke("recipe-run-terminal-phase-failure-smoke"),
    ],
  },
  policy: {
    description: "Workspace and runtime policy smoke checks.",
    commands: [
      tsxSmoke("policy-validation-smoke"),
      tsxSmoke("workspace-policy-smoke"),
    ],
  },
  artifact: {
    description: "Artifact contract and normalization smoke checks.",
    commands: [
      tsxSmoke("artifact-bundle-verifier-smoke"),
      tsxSmoke("artifact-apply-adapter-smoke"),
      tsxSmoke("transfer-proof-smoke"),
      tsxSmoke("artifact-redaction-smoke"),
      tsxSmoke("artifact-patch-git-apply-smoke"),
      tsxSmoke("artifact-reference-normalization-smoke"),
      tsxSmoke("artifact-diagnostics-normalizer-smoke"),
      tsxSmoke("typed-artifacts-smoke"),
      tsxSmoke("artifact-browser-error-collection-smoke"),
      tsxSmoke("partial-artifact-discovery-smoke"),
      tsxSmoke("mounted-workspace-diff-smoke"),
      tsxSmoke("replay-export-blueprint-smoke"),
      tsxSmoke("replay-export-manifest-integrity-smoke"),
      tsxSmoke("materialize-replay-package-smoke"),
    ],
  },
  runtime: {
    description: "Runtime state, action, reference, and WordPress command smoke checks.",
    commands: [
      tsxSmoke("run-registry-smoke"),
      tsxSmoke("wordpress-state-contract-smoke"),
      tsxSmoke("playground-command-errors-smoke"),
      tsxSmoke("replay-export-snapshot-scoping-smoke"),
      tsxSmoke("runtime-overlay-validation-smoke"),
      tsxSmoke("composer-backed-source-hydration-smoke"),
      tsxSmoke("recipe-run-composer-autoload-extra-plugin-smoke"),
      tsxSmoke("runtime-component-lifecycle-replay-smoke"),
    ],
  },
  package: {
    description: "Package build contract smoke checks.",
    commands: [
      npmScript("build"),
    ],
  },
  agent: {
    description: "Agent task, fanout, and delegation contract smoke checks.",
    commands: [
      tsxSmoke("agent-runtime-workload-normalizer-smoke"),
      tsxSmoke("agent-runtime-signal-smoke"),
      tsxSmoke("agent-runtime-ability-lifecycle-smoke"),
      tsxSmoke("agent-runtime-ability-tools-smoke"),
      tsxSmoke("agent-sandbox-incomplete-scope-smoke"),
      tsxSmoke("recipe-run-summary-smoke"),
      tsxSmoke("fanout-contract-smoke"),
      tsxSmoke("host-delegation-contract-smoke"),
      tsxSmoke("codex-agent-recipe-smoke"),
      tsxSmoke("claude-code-agent-recipe-smoke"),
      tsxSmoke("component-contracts-agent-task-smoke"),
      tsxSmoke("fanout-aggregation-contract-smoke"),
      tsxSmoke("agent-fanout-execution-smoke"),
    ],
  },
} satisfies Record<string, SmokeGroupDefinition>

export const smokeManifest = {
  groups: smokeGroups,
  aggregateGroups: {
    check: ["core", "policy", "artifact", "runtime", "package", "agent"],
  },
} as const

export type SmokeGroupName = keyof typeof smokeGroups
export type SmokeAggregateGroupName = keyof typeof smokeManifest.aggregateGroups
