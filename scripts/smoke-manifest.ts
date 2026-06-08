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

function phpSmoke(name: string, script: string): SmokeCommand {
  return {
    name,
    command: "php",
    args: [script],
  }
}

export const smokeGroups = {
  core: {
    description: "Build and core command contract smoke checks.",
    commands: [
      npmScript("build"),
      tsxSmoke("command-registry-smoke"),
      tsxSmoke("command-args-smoke"),
      tsxSmoke("host-tool-registry-smoke"),
      tsxSmoke("host-command-tool-smoke"),
      tsxSmoke("sandbox-tool-policy-smoke"),
      tsxSmoke("task-input-contract-smoke"),
      tsxSmoke("discovery-command-smoke"),
      tsxSmoke("doctor-command-smoke"),
      tsxSmoke("agent-sandbox-code-smoke"),
      tsxSmoke("agent-runtime-failure-smoke"),
    ],
  },
  policy: {
    description: "Workspace and runtime policy smoke checks.",
    commands: [
      tsxSmoke("policy-validation-smoke"),
      tsxSmoke("workspace-policy-smoke"),
      phpSmoke("wordpress-plugin-smoke", "tests/smoke-wordpress-plugin.php"),
      tsxSmoke("browser-runtime-operation-smoke"),
    ],
  },
  package: {
    description: "Package distribution smoke checks.",
    commands: [
      tsxSmoke("package-distribution-smoke"),
      tsxSmoke("package-installed-binary-smoke"),
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
      tsxSmoke("browser-result-shapes-smoke"),
      tsxSmoke("partial-artifact-discovery-smoke"),
      tsxSmoke("interrupted-run-evidence-smoke"),
      tsxSmoke("mounted-workspace-diff-smoke"),
      tsxSmoke("artifact-contract-smoke"),
      tsxSmoke("durable-artifact-preview-smoke"),
      tsxSmoke("external-adapter-contract-smoke"),
    ],
  },
  runtime: {
    description: "Runtime state, action, reference, and WordPress command smoke checks.",
    commands: [
      tsxSmoke("run-registry-smoke"),
      tsxSmoke("runtime-episode-smoke"),
      tsxSmoke("wordpress-state-contract-smoke"),
      tsxSmoke("runtime-snapshot-restore-smoke"),
      tsxSmoke("runtime-action-adapter-smoke"),
      tsxSmoke("rest-request-runtime-smoke"),
      tsxSmoke("runtime-reference-index-smoke"),
      tsxSmoke("core-phpunit-command-smoke"),
      tsxSmoke("theme-check-normalization-smoke"),
      tsxSmoke("phpunit-diagnostic-artifact-smoke"),
      tsxSmoke("project-phpunit-bootstrap-smoke"),
      tsxSmoke("plugin-check-normalization-smoke"),
      tsxSmoke("bench-bootstrap-files-smoke"),
      tsxSmoke("benchmark-summary-smoke"),
      tsxSmoke("wordpress-recipe-builders-smoke"),
      tsxSmoke("runtime-stack-mount-smoke"),
      tsxSmoke("runtime-overlay-php-ai-client-smoke"),
    ],
  },
  benchmark: {
    description: "Benchmark substrate and comparison smoke checks.",
    commands: [
      tsxSmoke("benchmark-substrate-smoke"),
      tsxSmoke("benchmark-matrix-cli-smoke"),
      tsxSmoke("benchmark-comparison-smoke"),
      tsxSmoke("recipe-bench-smoke"),
      tsxSmoke("recipe-browser-bench-metrics-smoke"),
    ],
  },
  agent: {
    description: "Agent task, fanout, and delegation contract smoke checks.",
    commands: [
      tsxSmoke("agent-task-run-result-normalizer-smoke"),
      tsxSmoke("agent-runtime-workload-normalizer-smoke"),
      tsxSmoke("agent-sandbox-workspace-root-smoke"),
      tsxSmoke("agent-sandbox-incomplete-scope-smoke"),
      tsxSmoke("recipe-run-summary-smoke"),
      tsxSmoke("fanout-contract-smoke"),
      tsxSmoke("host-delegation-contract-smoke"),
      tsxSmoke("fanout-aggregation-contract-smoke"),
      tsxSmoke("agent-fanout-execution-smoke"),
      tsxSmoke("agent-task-run-runtime-components-smoke"),
      tsxSmoke("headless-browser-agent-recipe-smoke"),
    ],
  },
  recipe: {
    description: "Recipe and Playground runtime smoke checks.",
    commands: [
      tsxSmoke("recipe-build-cli-smoke"),
      tsxSmoke("recipe-run-php-plugin-load-smoke"),
      tsxSmoke("recipe-source-redirect-smoke"),
      tsxSmoke("extra-plugin-entry-file-smoke"),
      tsxSmoke("run-php-plugin-diagnostics-smoke"),
      tsxSmoke("recipe-browser-smoke"),
      tsxSmoke("recipe-dry-run-smoke"),
      tsxSmoke("recipe-workflow-phases-smoke"),
      tsxSmoke("recipe-verify-gate-smoke"),
      tsxSmoke("recipe-site-seed-smoke"),
      tsxSmoke("recipe-fixture-probes-smoke"),
      tsxSmoke("recipe-staged-files-smoke"),
      tsxSmoke("recipe-dependency-overlay-smoke"),
      tsxSmoke("recipe-workspace-seed-excludes-smoke"),
      tsxSmoke("recipe-runtime-evidence-smoke"),
      tsxSmoke("recipe-run-timeout-smoke"),
      tsxSmoke("recipe-playground-boot-failure-smoke"),
      tsxSmoke("recipe-backend-package-smoke"),
      tsxSmoke("recipe-interruption-artifacts-smoke"),
      tsxSmoke("recipe-heavyweight-plugin-runtime-smoke"),
    ],
  },
  playground: {
    description: "Playground package/cache/runtime bootstrap smoke checks.",
    commands: [
      tsxSmoke("playground-archive-cache-validation-smoke"),
      tsxSmoke("playground-cli-startup-output-smoke"),
      tsxSmoke("playground-wordpress-directory-asset-smoke"),
      tsxSmoke("recipe-run-concurrent-playground-cache-smoke"),
      tsxSmoke("playground-sqlite-alias-smoke"),
      tsxSmoke("php-wasm-preflight-smoke"),
    ],
  },
  preview: {
    description: "Preview server smoke checks.",
    commands: [
      tsxSmoke("preview-options-contract-smoke"),
      tsxSmoke("preview-port-smoke"),
      tsxSmoke("preview-public-url-canonical-smoke"),
      tsxSmoke("recipe-preview-routing-browser-probe-smoke"),
      tsxSmoke("preview-response-body-smoke"),
      tsxSmoke("browser-startup-progress-smoke"),
      tsxSmoke("recipe-browser-probe-liveness-smoke"),
      tsxSmoke("boot-preview-smoke"),
      tsxSmoke("blueprint-validation-smoke"),
    ],
  },
  browser: {
    description: "Browser probe, scenario, editor, and visual evidence smoke checks.",
    commands: [
      tsxSmoke("browser-probe-artifact-smoke"),
      tsxSmoke("browser-probe-assertions-smoke"),
      tsxSmoke("browser-probe-web-performance-smoke"),
      tsxSmoke("browser-probe-layout-shift-smoke"),
      tsxSmoke("browser-probe-context-smoke"),
      tsxSmoke("browser-probe-public-url-routing-smoke"),
      tsxSmoke("browser-probe-route-host-smoke"),
      tsxSmoke("browser-probe-network-policy-smoke"),
      tsxSmoke("browser-probe-profile-matrix-smoke"),
      tsxSmoke("browser-lifecycle-observer-smoke"),
      tsxSmoke("browser-probe-pre-page-script-smoke"),
      tsxSmoke("browser-actions-artifact-smoke"),
      tsxSmoke("browser-actions-painted-readiness-smoke"),
      tsxSmoke("browser-scenario-artifact-smoke"),
      tsxSmoke("browser-visual-compare-smoke"),
      tsxSmoke("browser-action-visual-compare-smoke"),
      tsxSmoke("browser-html-capture-smoke"),
      tsxSmoke("editor-canvas-probe-smoke"),
      tsxSmoke("editor-open-artifact-smoke"),
      tsxSmoke("editor-actions-artifact-smoke"),
      tsxSmoke("browser-review-bridge-smoke"),
      tsxSmoke("browser-interaction-script-validation-smoke"),
      tsxSmoke("ability-login-blueprint-smoke"),
      tsxSmoke("browser-prepared-runtime-contract-smoke"),
      {
        name: "simple-plugin-run-php-smoke",
        command: "node",
        args: [
          "packages/cli/dist/index.js",
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
    check: ["core", "policy", "package", "artifact", "runtime", "benchmark", "agent", "recipe", "playground", "preview", "browser"],
  },
} as const

export type SmokeGroupName = keyof typeof smokeGroups
export type SmokeAggregateGroupName = keyof typeof smokeManifest.aggregateGroups
