export type BenchmarkMetricUnit = "ms" | "bytes" | "count" | "unitless" | (string & {})

export type BenchmarkScenarioSource = "in_tree" | "config" | (string & {})

export type BenchmarkDiagnosticSeverity = "error" | "warning" | "notice" | "info" | (string & {})

export interface BenchmarkMetricSamplesSummary {
  count: number
  mean: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  standard_deviation?: number
  relative_standard_deviation?: number
  values?: number[]
}

export interface BenchmarkMetricRecord {
  unit: BenchmarkMetricUnit
  samples: BenchmarkMetricSamplesSummary
  rawSamplesRef?: BenchmarkArtifactRef
  metadata?: Record<string, unknown>
}

export interface BenchmarkDiagnostic {
  severity: BenchmarkDiagnosticSeverity
  message: string
  code?: string
  source?: string
  details?: Record<string, unknown>
}

export interface BenchmarkArtifactRef {
  path: string
  kind: string
  contentType?: string
  sha256?: string
  bytes?: number
  source?: "scenario-artifact" | "metric-source" | "browser-artifact" | "sample-artifact" | (string & {})
  name?: string
  metric?: string
  sampleIndex?: number
  metadata?: Record<string, unknown>
}

export interface BenchmarkInlineArtifact {
  schema: string
  [key: string]: unknown
}

export interface BenchmarkScenarioRecord {
  id: string
  source: BenchmarkScenarioSource
  file?: string
  iterations: number
  metrics: Record<string, BenchmarkMetricRecord>
  memory?: {
    peak_bytes?: number
  }
  diagnostics: BenchmarkDiagnostic[]
  artifactRefs?: BenchmarkArtifactRef[]
  steps?: Array<Record<string, unknown>>
  artifacts?: Record<string, BenchmarkArtifactRef | BenchmarkInlineArtifact>
  metadata?: Record<string, unknown>
  provenance?: Record<string, unknown>
}

export interface BenchmarkRunProvenance {
  command: "wordpress.bench" | (string & {})
  generated_at?: string
  component: {
    id: string
    plugin_slug?: string
    dependency_slugs?: string[]
    bootstrap_files?: string[]
  }
  runtime?: {
    wordpress_version?: string
    php_version?: string
  }
  definition?: BenchmarkDefinition
  metadata?: Record<string, unknown>
}

export interface BenchResults {
  schema: "wp-codebox/bench-results/v1"
  component_id: string
  iterations: number
  warmup_iterations: number
  lifecycle?: {
    phases: string[]
    diagnostics: BenchmarkDiagnostic[]
  }
  reset_policy?: {
    betweenIterations: string
    betweenScenarios: string
    events?: Array<Record<string, unknown>>
  }
  scenarios: BenchmarkScenarioRecord[]
  diagnostics: BenchmarkDiagnostic[]
  artifacts?: Record<string, BenchmarkArtifactRef>
  provenance: BenchmarkRunProvenance
}

export interface BenchmarkDefinitionWorkloadStep {
  type: "php" | "wp-cli" | "rest-request" | "rest-db-query-profiler" | "db-inventory" | "external-http-guardrail" | "artifact-postprocess" | "ability" | (string & {})
  action?: "install" | "collect" | "reset" | (string & {})
  code?: string
  file?: string
  command?: string
  parse?: "json" | (string & {})
  allowlistDomains?: string[]
  blockNetwork?: boolean
  redactUrls?: boolean
  blockResponse?: { code?: number; message?: string; body?: string }
  sampleLimit?: number
  queryLengthLimit?: number
  helper?: string
  helperPath?: string
  script?: string
  scriptPath?: string
  args?: string[]
  env?: Record<string, unknown>
  inputArtifactRoot?: string
  "input-artifact-root"?: string
  artifactRoot?: string
  "artifact-root"?: string
  outputArtifactPath?: string
  "output-artifact-path"?: string
  maxInputBytes?: number
  "max-input-bytes"?: number
  maxArtifacts?: number
  "max-artifacts"?: number
  expectedOutputSchema?: string
  "expected-output-schema"?: string
  artifactName?: string
  artifactKind?: string
  semantic?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface BenchmarkDefinitionRestRouteMatrixEntry {
  id?: string
  method?: string
  path?: string
  route?: string
  params?: Record<string, unknown>
  headers?: Record<string, unknown>
  body?: unknown
  "body-json"?: unknown
  "capture-response"?: boolean
  "metric-prefix"?: string
  metadata?: Record<string, unknown>
}

export interface BenchmarkDefinitionRestRequestCaseEntry extends BenchmarkDefinitionRestRouteMatrixEntry {
  case_id?: string
  caseId?: string
}

export interface BenchmarkDefinitionWorkload {
  id: string
  source?: BenchmarkScenarioSource
  file?: string
	run?: BenchmarkDefinitionWorkloadStep[]
	route_matrix?: BenchmarkDefinitionRestRouteMatrixEntry[]
	rest_request_cases?: BenchmarkDefinitionRestRequestCaseEntry[]
	request_cases?: BenchmarkDefinitionRestRequestCaseEntry[]
	artifacts?: Record<string, BenchmarkArtifactRef>
  metadata?: Record<string, unknown>
}

export interface BenchmarkDefinition {
  schema: "wp-codebox/benchmark-definition/v1"
  component_id: string
  plugin_slug: string
  iterations?: number
  warmup_iterations?: number
  dependency_slugs?: string[]
  env?: Record<string, unknown>
  bootstrap_files?: string[]
  workloads?: BenchmarkDefinitionWorkload[]
  lifecycle?: Record<string, unknown>
  reset_policy?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type BenchmarkJsonSchema = Record<string, unknown>

export function createBenchResultsJsonSchema(): BenchmarkJsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "wp-codebox/bench-results/v1",
    title: "WP Codebox benchmark results",
    type: "object",
    additionalProperties: false,
    required: ["schema", "component_id", "iterations", "warmup_iterations", "scenarios", "diagnostics", "provenance"],
    properties: {
      schema: { const: "wp-codebox/bench-results/v1" },
      component_id: { type: "string", minLength: 1 },
      iterations: { type: "integer", minimum: 1 },
      warmup_iterations: { type: "integer", minimum: 0 },
      lifecycle: { $ref: "#/$defs/lifecycle" },
      reset_policy: { $ref: "#/$defs/resetPolicy" },
      scenarios: { type: "array", items: { $ref: "#/$defs/scenario" } },
      diagnostics: { type: "array", items: { $ref: "#/$defs/diagnostic" } },
      artifacts: { $ref: "#/$defs/artifactMap" },
      provenance: { $ref: "#/$defs/provenance" },
    },
    $defs: benchmarkSchemaDefs(),
  }
}

export function createBenchmarkDefinitionJsonSchema(): BenchmarkJsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "wp-codebox/benchmark-definition/v1",
    title: "WP Codebox benchmark definition",
    type: "object",
    additionalProperties: false,
    required: ["schema", "component_id", "plugin_slug"],
    properties: {
      schema: { const: "wp-codebox/benchmark-definition/v1" },
      component_id: { type: "string", minLength: 1 },
      plugin_slug: { type: "string", minLength: 1 },
      iterations: { type: "integer", minimum: 1 },
      warmup_iterations: { type: "integer", minimum: 0 },
      dependency_slugs: { type: "array", items: { type: "string", minLength: 1 } },
      env: { type: "object", additionalProperties: true },
      bootstrap_files: { type: "array", items: { type: "string", minLength: 1 } },
      workloads: { type: "array", items: { $ref: "#/$defs/workload" } },
      lifecycle: { type: "object", additionalProperties: true },
      reset_policy: { type: "object", additionalProperties: true },
      metadata: { type: "object", additionalProperties: true },
    },
    $defs: benchmarkSchemaDefs(),
  }
}

function benchmarkSchemaDefs(): Record<string, unknown> {
  return {
    metric: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "samples"],
      properties: {
        unit: { type: "string", minLength: 1 },
        samples: { $ref: "#/$defs/samples" },
        rawSamplesRef: { $ref: "#/$defs/artifactRef" },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    samples: {
      type: "object",
      additionalProperties: false,
      required: ["count", "mean", "p50", "p95", "p99", "min", "max"],
      properties: {
        ...Object.fromEntries(["count", "mean", "p50", "p95", "p99", "min", "max", "standard_deviation", "relative_standard_deviation"].map((name) => [name, { type: "number" }])),
        values: { type: "array", items: { type: "number" } },
      },
    },
    diagnostic: {
      type: "object",
      additionalProperties: false,
      required: ["severity", "message"],
      properties: {
        severity: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        code: { type: "string" },
        source: { type: "string" },
        details: { type: "object", additionalProperties: true },
      },
    },
    artifactRef: {
      type: "object",
      additionalProperties: false,
      required: ["path", "kind"],
      properties: {
        path: { type: "string", minLength: 1 },
        kind: { type: "string", minLength: 1 },
        contentType: { type: "string" },
        sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        bytes: { type: "integer", minimum: 0 },
        source: { type: "string" },
        name: { type: "string" },
        metric: { type: "string" },
        sampleIndex: { type: "integer", minimum: 0 },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    artifactMap: {
      type: "object",
      additionalProperties: { anyOf: [{ $ref: "#/$defs/artifactRef" }, { $ref: "#/$defs/inlineBenchmarkArtifact" }] },
    },
    inlineBenchmarkArtifact: {
      type: "object",
      required: ["schema"],
      properties: {
        schema: {
          enum: [
            "wp-codebox/wordpress-db-inventory/v1",
            "wp-codebox/wordpress-external-http-guardrail/v1",
            "wp-codebox/wordpress-rest-db-query-profile/v1",
          ],
        },
      },
      additionalProperties: true,
    },
    lifecycle: {
      type: "object",
      additionalProperties: false,
      required: ["phases", "diagnostics"],
      properties: {
        phases: { type: "array", items: { type: "string" } },
        diagnostics: { type: "array", items: { $ref: "#/$defs/diagnostic" } },
      },
    },
    resetPolicy: {
      type: "object",
      additionalProperties: false,
      required: ["betweenIterations", "betweenScenarios"],
      properties: {
        betweenIterations: { type: "string" },
        betweenScenarios: { type: "string" },
        events: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    },
    scenario: {
      type: "object",
      additionalProperties: false,
      required: ["id", "source", "iterations", "metrics", "diagnostics"],
      properties: {
        id: { type: "string", minLength: 1 },
        source: { type: "string", minLength: 1 },
        file: { type: "string" },
        iterations: { type: "integer", minimum: 1 },
        metrics: { type: "object", additionalProperties: { $ref: "#/$defs/metric" } },
        memory: {
          type: "object",
          additionalProperties: false,
          properties: { peak_bytes: { type: "integer", minimum: 0 } },
        },
        diagnostics: { type: "array", items: { $ref: "#/$defs/diagnostic" } },
        artifactRefs: { type: "array", items: { $ref: "#/$defs/artifactRef" } },
        steps: { type: "array", items: { type: "object", additionalProperties: true } },
        artifacts: { $ref: "#/$defs/artifactMap" },
        metadata: { type: "object", additionalProperties: true },
        provenance: { type: "object", additionalProperties: true },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["command", "component"],
      properties: {
        command: { type: "string", minLength: 1 },
        generated_at: { type: "string" },
        component: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
            plugin_slug: { type: "string" },
            dependency_slugs: { type: "array", items: { type: "string" } },
            bootstrap_files: { type: "array", items: { type: "string" } },
          },
        },
        runtime: {
          type: "object",
          additionalProperties: false,
          properties: {
            wordpress_version: { type: "string" },
            php_version: { type: "string" },
          },
        },
        definition: { type: "object", additionalProperties: true },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    workload: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1 },
        source: { type: "string" },
        file: { type: "string" },
		run: { type: "array", items: { $ref: "#/$defs/workloadStep" } },
		route_matrix: { type: "array", items: { $ref: "#/$defs/restRouteMatrixEntry" } },
		rest_request_cases: { type: "array", items: { $ref: "#/$defs/restRequestCaseEntry" } },
		request_cases: { type: "array", items: { $ref: "#/$defs/restRequestCaseEntry" } },
		artifacts: { $ref: "#/$defs/artifactMap" },
        metadata: { type: "object", additionalProperties: true },
      },
    },
	restRouteMatrixEntry: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        method: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        route: { type: "string", minLength: 1 },
        params: { type: "object", additionalProperties: true },
        headers: { type: "object", additionalProperties: true },
        body: true,
        "body-json": true,
        "capture-response": { type: "boolean" },
        "metric-prefix": { type: "string", minLength: 1 },
        metadata: { type: "object", additionalProperties: true },
      },
		anyOf: [{ required: ["path"] }, { required: ["route"] }],
	},
	restRequestCaseEntry: {
		type: "object",
		additionalProperties: false,
		properties: {
			id: { type: "string", minLength: 1 },
			case_id: { type: "string", minLength: 1 },
			caseId: { type: "string", minLength: 1 },
			method: { type: "string", minLength: 1 },
			path: { type: "string", minLength: 1 },
			route: { type: "string", minLength: 1 },
			params: { type: "object", additionalProperties: true },
			headers: { type: "object", additionalProperties: true },
			body: true,
			"body-json": true,
			"capture-response": { type: "boolean" },
			"metric-prefix": { type: "string", minLength: 1 },
			metadata: { type: "object", additionalProperties: true },
		},
		anyOf: [{ required: ["path"] }, { required: ["route"] }],
	},
    workloadStep: {
      type: "object",
      additionalProperties: true,
      required: ["type"],
      properties: {
        type: { type: "string", minLength: 1 },
        code: { type: "string" },
        file: { type: "string" },
        command: { type: "string" },
        parse: { type: "string" },
        action: { type: "string" },
        allowlistDomains: { type: "array", items: { type: "string", minLength: 1 } },
        blockNetwork: { type: "boolean" },
        redactUrls: { type: "boolean" },
        blockResponse: {
          type: "object",
          additionalProperties: false,
          properties: {
            code: { type: "integer", minimum: 100, maximum: 599 },
            message: { type: "string" },
            body: { type: "string" },
          },
        },
        sampleLimit: { type: "integer", minimum: 0 },
        queryLengthLimit: { type: "integer", minimum: 80 },
        helper: { type: "string", minLength: 1 },
        helperPath: { type: "string", minLength: 1 },
        script: { type: "string", minLength: 1 },
        scriptPath: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" } },
        env: { type: "object", additionalProperties: true },
        inputArtifactRoot: { type: "string", minLength: 1 },
        "input-artifact-root": { type: "string", minLength: 1 },
        artifactRoot: { type: "string", minLength: 1 },
        "artifact-root": { type: "string", minLength: 1 },
        outputArtifactPath: { type: "string", minLength: 1 },
        "output-artifact-path": { type: "string", minLength: 1 },
        maxInputBytes: { type: "integer", minimum: 0 },
        "max-input-bytes": { type: "integer", minimum: 0 },
        maxArtifacts: { type: "integer", minimum: 0 },
        "max-artifacts": { type: "integer", minimum: 0 },
        expectedOutputSchema: { type: "string", minLength: 1 },
        "expected-output-schema": { type: "string", minLength: 1 },
        artifactName: { type: "string", minLength: 1 },
        artifactKind: { type: "string", minLength: 1 },
        semantic: { type: "string", minLength: 1 },
        metadata: { type: "object", additionalProperties: true },
      },
    },
  }
}
