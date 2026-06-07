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

export const smokeGroups = {
  core: {
    description: "Build and core command contract smoke checks.",
    commands: [
      npmScript("build"),
      npmScript("command-registry-smoke"),
      npmScript("host-tool-registry-smoke"),
      npmScript("sandbox-tool-policy-smoke"),
      npmScript("task-input-contract-smoke"),
      npmScript("discovery-command-smoke"),
      npmScript("theme-check-normalization-smoke"),
      npmScript("agent-sandbox-code-smoke"),
      npmScript("agent-runtime-failure-smoke"),
    ],
  },
  policy: {
    description: "Workspace and runtime policy smoke checks.",
    commands: [
      npmScript("policy-validation-smoke"),
      npmScript("workspace-policy-smoke"),
      npmScript("wordpress-plugin-smoke"),
      npmScript("browser-runtime-operation-smoke"),
    ],
  },
  package: {
    description: "Package distribution smoke checks.",
    commands: [npmScript("package-distribution-smoke")],
  },
  artifact: {
    description: "Artifact contract and normalization smoke checks.",
    commands: [
      npmScript("artifact-bundle-verifier-smoke"),
      npmScript("artifact-redaction-smoke"),
      npmScript("artifact-patch-git-apply-smoke"),
      npmScript("artifact-contract-smoke"),
      npmScript("external-adapter-contract-smoke"),
    ],
  },
  runtime: {
    description: "Runtime state, action, and reference smoke checks.",
    commands: [
      npmScript("runtime-episode-smoke"),
      npmScript("runtime-snapshot-restore-smoke"),
      npmScript("runtime-action-adapter-smoke"),
      npmScript("runtime-reference-index-smoke"),
      npmScript("core-phpunit-command-smoke"),
      npmScript("plugin-check-normalization-smoke"),
    ],
  },
  recipe: {
    description: "Recipe, benchmark, and Playground runtime smoke checks.",
    commands: [
      npmScript("recipe-bench-smoke"),
      npmScript("recipe-browser-bench-metrics-smoke"),
      npmScript("recipe-dry-run-smoke"),
      npmScript("recipe-workflow-phases-smoke"),
      npmScript("recipe-site-seed-smoke"),
      npmScript("recipe-staged-files-smoke"),
      npmScript("recipe-workspace-seed-excludes-smoke"),
      npmScript("recipe-runtime-evidence-smoke"),
      npmScript("recipe-playground-boot-failure-smoke"),
      npmScript("runtime-stack-mount-smoke"),
      npmScript("runtime-overlay-php-ai-client-smoke"),
      npmScript("recipe-interruption-artifacts-smoke"),
      npmScript("recipe-heavyweight-plugin-runtime-smoke"),
    ],
  },
  preview: {
    description: "Preview server smoke checks.",
    commands: [
      npmScript("preview-options-contract-smoke"),
      npmScript("preview-port-smoke"),
      npmScript("preview-public-url-canonical-smoke"),
      npmScript("preview-response-body-smoke"),
      npmScript("browser-startup-progress-smoke"),
      npmScript("boot-preview-smoke"),
      npmScript("blueprint-validation-smoke"),
    ],
  },
  browser: {
    description: "Browser probe and agent recipe smoke checks.",
    commands: [
      npmScript("browser-probe-artifact-smoke"),
      npmScript("browser-probe-pre-page-script-smoke"),
      npmScript("browser-actions-artifact-smoke"),
      npmScript("browser-scenario-artifact-smoke"),
      npmScript("headless-browser-agent-recipe-smoke"),
      {
        name: "simple-plugin-run-php-smoke",
        command: "npm",
        args: [
          "run",
          "wp-codebox",
          "--",
          "run",
          "--mount",
          "./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin",
          "--command",
          "wordpress.run-php",
          "--arg",
          "code-file=./examples/simple-plugin/probe.php",
          "--artifacts",
          "./artifacts",
          "--json",
        ],
      },
    ],
  },
} satisfies Record<string, SmokeGroupDefinition>

export const smokeManifest = {
  groups: smokeGroups,
  aggregateGroups: {
    check: ["core", "policy", "package", "artifact", "runtime", "recipe", "preview", "browser"],
  },
} as const

export type SmokeGroupName = keyof typeof smokeGroups
export type SmokeAggregateGroupName = keyof typeof smokeManifest.aggregateGroups
