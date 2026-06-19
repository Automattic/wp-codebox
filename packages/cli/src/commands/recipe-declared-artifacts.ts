import { Buffer } from "node:buffer"
import { DEFAULT_CAPTURED_ARTIFACT_MAX_BYTES, STRUCTURED_ARTIFACT_SCHEMA, TYPED_ARTIFACT_INDEX_SCHEMA, materializeStructuredArtifactFiles, redactJsonValue, workspaceRecipeRuntimeCollectedArtifacts, type ArtifactBundle, type Runtime, type StructuredArtifactPayload, type TypedArtifactRef, type WorkspaceRecipe, type WorkspaceRecipeDeclaredArtifact, type WorkspaceRecipeTypedArtifact } from "@automattic/wp-codebox-core"
import { stripUndefined } from "@automattic/wp-codebox-core/internals"
import { appendRecipeRuntimeEvidenceFiles } from "../recipe-evidence.js"
import { serializeRecipeRunError, RecipeDeclaredArtifactFailureError, RecipeProbeFailureError } from "./recipe-run-output.js"
import type { RecipeRunDeclaredArtifact, RecipeRunDistributionSetupArtifact, RecipeRunDistributionStartupProbe, RecipeRunFixtureDatabase, RecipeRunProbe } from "./recipe-run-types.js"

const DECLARED_ARTIFACT_CAPTURE_MAX_BYTES = DEFAULT_CAPTURED_ARTIFACT_MAX_BYTES
const declaredArtifactContents = new WeakMap<RecipeRunDeclaredArtifact, Buffer>()

export async function collectRecipeDeclaredArtifacts(recipe: WorkspaceRecipe, runtime: Runtime): Promise<RecipeRunDeclaredArtifact[]> {
  const results: RecipeRunDeclaredArtifact[] = []
  for (const { kind, index, artifact } of workspaceRecipeRuntimeCollectedArtifacts(recipe)) {
    results.push(kind === "typed"
      ? await collectRecipeTypedArtifact(runtime, artifact, index)
      : await collectRecipeDeclaredArtifact(runtime, artifact, index))
  }
  return results
}

async function collectRecipeDeclaredArtifact(runtime: Runtime, artifact: WorkspaceRecipeDeclaredArtifact, index: number): Promise<RecipeRunDeclaredArtifact> {
  const required = artifact.required !== false
  try {
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${declaredArtifactReadCode(artifact.path, artifact.parseJson === true, false)}`],
    })
    const collected = JSON.parse(execution.stdout.trim() || "{}") as Record<string, unknown>
    const exists = collected.exists === true
    return stripUndefined({
      schema: "wp-codebox/recipe-declared-artifact-result/v1" as const,
      index,
      name: artifact.name,
      path: artifact.path,
      required,
      status: declaredArtifactCollectionStatus(collected, exists),
      exists,
      type: collected.type,
      size: collected.size,
      sha256: collected.sha256,
      parsedJson: collected.parsedJson === undefined ? undefined : redactJsonValue(collected.parsedJson),
      metadata: artifact.metadata,
      diagnostics: declaredArtifactDiagnostics(collected),
    }) as RecipeRunDeclaredArtifact
  } catch (error) {
    return stripUndefined({
      schema: "wp-codebox/recipe-declared-artifact-result/v1" as const,
      index,
      name: artifact.name,
      path: artifact.path,
      required,
      status: "failed" as const,
      exists: false,
      error: serializeRecipeRunError(error),
      metadata: artifact.metadata,
    }) as RecipeRunDeclaredArtifact
  }
}

async function collectRecipeTypedArtifact(runtime: Runtime, artifact: WorkspaceRecipeTypedArtifact, index: number): Promise<RecipeRunDeclaredArtifact> {
  try {
    const execution = await runtime.execute({
      command: "wordpress.run-php",
      args: [`code=${declaredArtifactReadCode(artifact.path, artifact.parseJson === true, true)}`],
    })
    const collected = JSON.parse(execution.stdout.trim() || "{}") as Record<string, unknown>
    const exists = collected.exists === true
    const result = stripUndefined({
      schema: "wp-codebox/recipe-declared-artifact-result/v1" as const,
      index,
      name: artifact.name,
      path: artifact.path,
      required: artifact.required !== false,
      status: declaredArtifactCollectionStatus(collected, exists),
      exists,
      type: collected.type,
      size: collected.size,
      sha256: collected.sha256,
      parsedJson: collected.parsedJson === undefined ? undefined : redactJsonValue(collected.parsedJson),
      typedArtifact: {
        name: artifact.name,
        type: artifact.type,
        payloadSchema: artifact.payloadSchema,
        contentType: artifact.contentType ?? typedArtifactContentType(artifact),
      },
      metadata: artifact.metadata,
      diagnostics: declaredArtifactDiagnostics(collected),
    }) as RecipeRunDeclaredArtifact
    if (result.status === "collected" && typeof collected.contentBase64 === "string" && collected.contentBase64.length > 0) {
      declaredArtifactContents.set(result, Buffer.from(collected.contentBase64, "base64"))
    }
    return result
  } catch (error) {
    return stripUndefined({
      schema: "wp-codebox/recipe-declared-artifact-result/v1" as const,
      index,
      name: artifact.name,
      path: artifact.path,
      required: artifact.required !== false,
      status: "failed" as const,
      exists: false,
      metadata: artifact.metadata,
      error: serializeRecipeRunError(error),
    }) as RecipeRunDeclaredArtifact
  }
}

export async function materializeTypedRecipeDeclaredArtifacts(artifacts: ArtifactBundle, declaredArtifacts: RecipeRunDeclaredArtifact[]): Promise<void> {
  const inputs: Array<{ artifact: RecipeRunDeclaredArtifact; ref: StructuredArtifactPayload; contents: Buffer; contentType: string }> = []
  for (const artifact of declaredArtifacts) {
    const typedArtifact = recipeRunTypedArtifactDeclaration(artifact)
    const contents = declaredArtifactContents.get(artifact)
    if (!typedArtifact || artifact.status !== "collected" || !contents) {
      continue
    }

    const ref: StructuredArtifactPayload = stripUndefined({
      schema: STRUCTURED_ARTIFACT_SCHEMA,
      name: typedArtifact.name,
      type: typedArtifact.type,
      payload_schema: typedArtifact.payloadSchema,
      payload: artifact.parsedJson,
      metadata: artifact.metadata ?? {},
      provenance: {
        direction: "output" as const,
        source: artifact.path,
      },
    })
    inputs.push({ artifact, ref, contents, contentType: typedArtifact.contentType })
  }

  if (inputs.length === 0) {
    return
  }

  const materialized = materializeStructuredArtifactFiles<StructuredArtifactPayload, TypedArtifactRef>({
    artifacts: inputs.map((input) => input.ref),
    artifactPathPrefix: "files/runtime-evidence/typed-artifacts",
    artifactKind: "typed-artifact",
    indexKind: "typed-artifacts-index",
    indexSchema: TYPED_ARTIFACT_INDEX_SCHEMA,
    contentType: (_artifact, index) => inputs[index].contentType,
    contents: (_artifact, index) => inputs[index].contents,
  })
  for (const [index, ref] of materialized.refs.entries()) {
    inputs[index].artifact.materialized = ref
    delete (inputs[index].artifact as RecipeRunDeclaredArtifact & { typedArtifact?: unknown }).typedArtifact
  }

  const files = materialized.files.map((file) => ({
    filename: file.path.replace(/^files\/runtime-evidence\//, ""),
    kind: file.kind,
    contentType: file.contentType,
    contents: file.contents,
    maxBytes: DECLARED_ARTIFACT_CAPTURE_MAX_BYTES,
  }))
  await appendRecipeRuntimeEvidenceFiles(artifacts, files)
}

function recipeRunTypedArtifactDeclaration(artifact: RecipeRunDeclaredArtifact): { name: string; type: string; contentType: string; payloadSchema?: string | Record<string, unknown> } | undefined {
  const typedArtifact = (artifact as RecipeRunDeclaredArtifact & { typedArtifact?: unknown }).typedArtifact
  if (!typedArtifact || typeof typedArtifact !== "object") {
    return undefined
  }
  const record = typedArtifact as Record<string, unknown>
  if (typeof record.name !== "string" || typeof record.type !== "string" || typeof record.contentType !== "string") {
    return undefined
  }
  return stripUndefined({
    name: record.name,
    type: record.type,
    contentType: record.contentType,
    payloadSchema: typeof record.payloadSchema === "string" || isRecordValue(record.payloadSchema) ? record.payloadSchema : undefined,
  })
}

function typedArtifactContentType(artifact: WorkspaceRecipeTypedArtifact): string {
  return artifact.parseJson === true ? "application/json" : "application/octet-stream"
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function declaredArtifactCollectionStatus(collected: Record<string, unknown>, exists: boolean): RecipeRunDeclaredArtifact["status"] {
  if (!exists) return "missing"
  if (collected.oversized === true) return "oversized"
  if (collected.sensitive === true) return "sensitive"
  if (collected.skipped === true) return "skipped"
  return "collected"
}

function declaredArtifactDiagnostics(collected: Record<string, unknown>): Record<string, unknown> | undefined {
  const diagnostics = stripUndefined({
    capture: {
      schema: "wp-codebox/declared-artifact-capture-diagnostics/v1",
      status: collected.oversized === true ? "oversized" : collected.sensitive === true ? "sensitive" : collected.skipped === true ? "skipped" : collected.exists === true ? "captured" : "missing",
      reason: typeof collected.reason === "string" ? collected.reason : undefined,
      maxBytes: typeof collected.maxBytes === "number" ? collected.maxBytes : undefined,
      binary: typeof collected.binary === "boolean" ? collected.binary : undefined,
      redacted: collected.redacted === true,
    },
  })
  return Object.keys(diagnostics.capture).length > 1 ? diagnostics : undefined
}

export function recipeDeclaredArtifactFailure(declaredArtifacts: RecipeRunDeclaredArtifact[]): RecipeDeclaredArtifactFailureError | undefined {
  return declaredArtifacts.some((artifact) => artifact.required && artifact.status !== "collected") ? new RecipeDeclaredArtifactFailureError(declaredArtifacts) : undefined
}

export function recipeRuntimeEvidenceFiles(fixtureDatabases: RecipeRunFixtureDatabase[], distributionSetupArtifacts: RecipeRunDistributionSetupArtifact[], distributionStartupProbes: RecipeRunDistributionStartupProbe[], probes: RecipeRunProbe[], declaredArtifacts: RecipeRunDeclaredArtifact[]): Array<{ filename: string; kind: string; value: unknown }> {
  return [
    ...(fixtureDatabases.length > 0 ? [{ filename: "fixture-databases.json", kind: "fixture-database-results", value: { schema: "wp-codebox/fixture-database-results/v1", fixtures: fixtureDatabases } }] : []),
    ...(distributionSetupArtifacts.length > 0 ? [{ filename: "distribution-setup-artifacts.json", kind: "distribution-setup-artifact-results", value: { schema: "wp-codebox/distribution-setup-artifact-results/v1", artifacts: distributionSetupArtifacts } }] : []),
    ...(distributionStartupProbes.length > 0 ? [{ filename: "distribution-startup-probes.json", kind: "distribution-startup-probe-results", value: { schema: "wp-codebox/distribution-startup-probe-results/v1", passed: !distributionStartupProbeFailure(distributionStartupProbes), probes: distributionStartupProbes } }] : []),
    ...(probes.length > 0 ? [{ filename: "recipe-probes.json", kind: "recipe-probe-results", value: { schema: "wp-codebox/recipe-probe-results/v1", passed: !recipeProbeFailure(probes), probes } }] : []),
    ...(declaredArtifacts.length > 0 ? [{ filename: "recipe-declared-artifacts.json", kind: "recipe-declared-artifact-results", value: { schema: "wp-codebox/recipe-declared-artifact-results/v1", passed: !recipeDeclaredArtifactFailure(declaredArtifacts), artifacts: declaredArtifacts } }] : []),
  ]
}

function distributionStartupProbeFailure(probes: RecipeRunDistributionStartupProbe[]): boolean {
  return probes.some((probe) => probe.status === "failed")
}

export function recipeProbeFailure(probes: RecipeRunProbe[]): RecipeProbeFailureError | undefined {
  return probes.some((probe) => probe.status === "failed" && !probe.allowFailure) ? new RecipeProbeFailureError(probes) : undefined
}

function declaredArtifactReadCode(path: string, parseJson: boolean, includeContents: boolean): string {
  const encodedPath = JSON.stringify(path)
  const maxBytes = DECLARED_ARTIFACT_CAPTURE_MAX_BYTES
  return `
$path = ${encodedPath};
$parse_json = ${parseJson ? "true" : "false"};
$include_contents = ${includeContents ? "true" : "false"};
$max_bytes = ${maxBytes};
$result = array('exists' => file_exists($path));
if (!$result['exists']) {
    echo wp_json_encode($result);
    return;
}
$result['type'] = is_dir($path) ? 'directory' : (is_file($path) ? 'file' : 'other');
if (is_file($path)) {
    $file_size = filesize($path);
    if (false === $file_size) {
        throw new RuntimeException('Unable to stat declared artifact path: ' . $path);
    }
    $result['size'] = $file_size;
    $result['maxBytes'] = $max_bytes;
    if ($file_size > $max_bytes) {
        $result['oversized'] = true;
        $result['reason'] = 'max-bytes-exceeded';
        echo wp_json_encode($result);
        return;
    }
    $contents = file_get_contents($path);
    if (false === $contents) {
        throw new RuntimeException('Unable to read declared artifact path: ' . $path);
    }
    $result['sha256'] = hash('sha256', $contents);
    $result['binary'] = 1 !== preg_match('//u', $contents);
    if (preg_match('/\\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\\b/', $contents)) {
        $result['sensitive'] = true;
        $result['reason'] = 'secret-like-value';
        echo wp_json_encode($result);
        return;
    }
    if ($parse_json) {
        $decoded = json_decode($contents, true);
        if (JSON_ERROR_NONE !== json_last_error()) {
            throw new RuntimeException('Declared artifact JSON parse failed for ' . $path . ': ' . json_last_error_msg());
        }
        $result['parsedJson'] = $decoded;
    }
    if ($include_contents) {
        $result['contentBase64'] = base64_encode($contents);
    }
} elseif (is_dir($path)) {
    $entries = array_values(array_diff(scandir($path) ?: array(), array('.', '..')));
    sort($entries);
    $result['size'] = count($entries);
    $result['sha256'] = hash('sha256', wp_json_encode($entries));
}
echo wp_json_encode($result);`
}
