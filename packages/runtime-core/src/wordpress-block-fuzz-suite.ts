import { fuzzCoveragePlanContract, type FuzzCoveragePlanContract, type FuzzCoveragePlanItem, type FuzzCoveragePlanParameterGenerationHook } from "./fuzz-coverage-plan-contracts.js"
import { fuzzSuiteContract, type FuzzSuiteCase, type FuzzSuiteContract } from "./fuzz-suite-contracts.js"
import { stripUndefined } from "./object-utils.js"
import type { WordPressBlockAttributeDescriptor, WordPressBlockEditorTargetDiscovery, WordPressBlockTypeDescriptor, WordPressEditorPostTypeDescriptor } from "./wordpress-runtime-discovery-contracts.js"

export interface WordPressBlockFuzzSuiteOptions {
  id?: string
  version?: string
  includeServerRender?: boolean
  includeEditorInsert?: boolean
  editorPostType?: string
  capture?: readonly string[]
}

const DEFAULT_BLOCK_FUZZ_SUITE_ID = "wordpress-block-discovery"
const BLOCK_SERVER_RENDER_CAPABILITIES = ["target:runtime", "runtime"] as const
const BLOCK_EDITOR_INSERT_CAPABILITIES = ["target:runtime", "runtime", "runtime-action:editor_open"] as const
const BLOCK_ATTRIBUTE_PARAMETER_GENERATION_HOOK: FuzzCoveragePlanParameterGenerationHook = {
  id: "wordpress.block-attribute-samples",
  label: "WordPress block attribute sample generator",
  description: "Placeholder hook for consumers that can generate concrete attribute samples from a discovered block schema.",
}

export function wordpressBlockDiscoveryToFuzzSuite(discovery: WordPressBlockEditorTargetDiscovery, options: WordPressBlockFuzzSuiteOptions = {}): FuzzSuiteContract {
  const includeServerRender = options.includeServerRender ?? true
  const includeEditorInsert = options.includeEditorInsert ?? true
  const editorPostType = selectEditorPostType(discovery.editorPostTypes, options.editorPostType)
  const cases: FuzzSuiteCase[] = []

  for (const block of discovery.blocks) {
    if (includeServerRender) {
      cases.push(serverRenderCase(block))
    }

    if (includeEditorInsert && editorPostType && block.supportsInserter) {
      cases.push(editorInsertCase(block, editorPostType))
    }
  }

  return fuzzSuiteContract({
    id: options.id ?? DEFAULT_BLOCK_FUZZ_SUITE_ID,
    version: options.version,
    cases,
    coveragePlan: wordpressBlockDiscoveryToCoveragePlan(discovery, options),
    metadata: stripUndefined({
      sourceSchema: discovery.schema,
      builder: "wp-codebox/wordpress-block-fuzz-suite-builder/v1",
      blocks: discovery.blocks.length,
      editorPostTypes: discovery.editorPostTypes.map((postType) => postType.name),
      editorPostType: includeEditorInsert ? editorPostType?.name : undefined,
      operations: [
        includeServerRender ? "server-render" : undefined,
        includeEditorInsert ? "editor-insert" : undefined,
      ].filter((operation): operation is string => Boolean(operation)),
      requiredRunnerCapabilities: stripUndefined({
        capabilities: [...new Set([
          ...(includeServerRender ? BLOCK_SERVER_RENDER_CAPABILITIES : []),
          ...(includeEditorInsert ? BLOCK_EDITOR_INSERT_CAPABILITIES : []),
        ])],
        targetKinds: ["runtime"],
        runtimeActionTypes: includeEditorInsert ? ["editor_open"] : undefined,
        commands: [
          includeServerRender ? "wordpress.block-render" : undefined,
          includeEditorInsert ? "wordpress.block-exercise" : undefined,
        ].filter((command): command is string => Boolean(command)),
      }),
    }),
  })
}

export function wordpressBlockDiscoveryToCoveragePlan(discovery: WordPressBlockEditorTargetDiscovery, options: WordPressBlockFuzzSuiteOptions = {}): FuzzCoveragePlanContract {
  const includeServerRender = options.includeServerRender ?? true
  const includeEditorInsert = options.includeEditorInsert ?? true
  const editorPostType = selectEditorPostType(discovery.editorPostTypes, options.editorPostType)
  const discovered = discovery.blocks.flatMap((block) => blockCoveragePlanItems(block, includeServerRender, includeEditorInsert, editorPostType))
  const executable = discovered.filter((item) => item.input !== undefined && !item.reason)
  const untested = discovered.filter((item) => item.reason)

  return fuzzCoveragePlanContract({
    id: `${options.id ?? DEFAULT_BLOCK_FUZZ_SUITE_ID}-coverage-plan`,
    version: options.version,
    discovered,
    generated: discovered,
    executable,
    untested,
    parameterGenerationHooks: [BLOCK_ATTRIBUTE_PARAMETER_GENERATION_HOOK],
    metadata: stripUndefined({
      sourceSchema: discovery.schema,
      builder: "wp-codebox/wordpress-block-fuzz-suite-builder/v1",
      blocks: discovery.blocks.length,
      editorPostTypes: discovery.editorPostTypes.map((postType) => postType.name),
      editorPostType: includeEditorInsert ? editorPostType?.name : undefined,
    }),
  })
}

function serverRenderCase(block: WordPressBlockTypeDescriptor): FuzzSuiteCase {
  const attributes = blockAttributeSamples(block)
  const sampleKind = Object.keys(attributes).length ? "sample-attributes" : "empty-attributes"

  return {
    id: `block-${caseIdPart(block.name)}-server-render-${sampleKind}`,
    target: { kind: "runtime", entrypoint: "wordpress.block-render" },
    input: {
      args: [
        `block-name=${block.name}`,
        `attrs-json=${JSON.stringify(attributes)}`,
        "source=wordpress-block-fuzz-suite",
      ],
    },
    description: `Render ${block.name} through render_block with ${sampleKind.replace("-", " ")}.`,
    metadata: blockCaseMetadata(block, "server-render", { attributes }),
  }
}

function editorInsertCase(block: WordPressBlockTypeDescriptor, postType: WordPressEditorPostTypeDescriptor): FuzzSuiteCase {
  const attributes = blockAttributeSamples(block)
  const sampleKind = Object.keys(attributes).length ? "sample-attributes" : "empty-attributes"

  return {
    id: `block-${caseIdPart(block.name)}-editor-insert-${caseIdPart(postType.name)}-${sampleKind}`,
    target: { kind: "runtime", entrypoint: "wordpress.block-exercise" },
    input: {
      args: [
        `block-name=${block.name}`,
        `attrs-json=${JSON.stringify(attributes)}`,
        "mode=editor-insert-save",
        "source=wordpress-block-fuzz-suite",
      ],
    },
    description: `Insert ${block.name} into a new ${postType.name} editor canvas with ${sampleKind.replace("-", " ")}.`,
    metadata: blockCaseMetadata(block, "editor-insert", { attributes, editorPostType: postType.name }),
  }
}

function blockCoveragePlanItems(block: WordPressBlockTypeDescriptor, includeServerRender: boolean, includeEditorInsert: boolean, editorPostType: WordPressEditorPostTypeDescriptor | undefined): FuzzCoveragePlanItem[] {
  return [
    includeServerRender ? serverRenderCoveragePlanItem(block) : undefined,
    includeEditorInsert ? editorInsertCoveragePlanItem(block, editorPostType) : undefined,
  ].filter((item): item is FuzzCoveragePlanItem => Boolean(item))
}

function serverRenderCoveragePlanItem(block: WordPressBlockTypeDescriptor): FuzzCoveragePlanItem {
  const fuzzCase = serverRenderCase(block)
  return stripUndefined({ ...fuzzCase, parameterGeneration: { hook: BLOCK_ATTRIBUTE_PARAMETER_GENERATION_HOOK.id, metadata: { sample: "emptyAttributes" } } })
}

function editorInsertCoveragePlanItem(block: WordPressBlockTypeDescriptor, postType: WordPressEditorPostTypeDescriptor | undefined): FuzzCoveragePlanItem {
  if (!postType) {
    return stripUndefined({
      id: `block-${caseIdPart(block.name)}-editor-insert-untested`,
      target: { kind: "runtime", entrypoint: "wordpress.block-exercise" },
      description: `Insert ${block.name} into an editor canvas with empty attributes.`,
      reason: { code: "block_editor_post_type_unavailable", message: "No discovered editor post type is available for editor-insert fuzz coverage.", data: { unsupportedCapabilities: ["runtime-action:editor_open"] } },
      parameterGeneration: { hook: BLOCK_ATTRIBUTE_PARAMETER_GENERATION_HOOK.id, metadata: { sample: "emptyAttributes" } },
      metadata: blockCaseMetadata(block, "editor-insert", { emptyAttributes: {} }),
    })
  }
  if (!block.supportsInserter) {
    return stripUndefined({
      id: `block-${caseIdPart(block.name)}-editor-insert-${caseIdPart(postType.name)}-empty-attributes`,
      target: { kind: "runtime", entrypoint: "wordpress.block-exercise" },
      description: `Insert ${block.name} into a new ${postType.name} editor canvas with empty attributes.`,
      reason: { code: "block_inserter_unsupported", message: "The block does not support inserter-based editor coverage.", data: { unsupportedCapabilities: ["block:inserter"] } },
      parameterGeneration: { hook: BLOCK_ATTRIBUTE_PARAMETER_GENERATION_HOOK.id, metadata: { sample: "emptyAttributes" } },
      metadata: blockCaseMetadata(block, "editor-insert", { emptyAttributes: {}, editorPostType: postType.name }),
    })
  }
  return stripUndefined({ ...editorInsertCase(block, postType), parameterGeneration: { hook: BLOCK_ATTRIBUTE_PARAMETER_GENERATION_HOOK.id, metadata: { sample: "emptyAttributes" } } })
}

function blockCaseMetadata(block: WordPressBlockTypeDescriptor, operation: string, extra: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
    source: "wordpress-block-discovery",
    operation,
    block: {
      name: block.name,
      title: block.title,
      category: block.category,
      supportsInserter: block.supportsInserter,
      attributes: block.attributes,
    },
    samples: extra,
  })
}

function selectEditorPostType(postTypes: readonly WordPressEditorPostTypeDescriptor[], requested: string | undefined): WordPressEditorPostTypeDescriptor | undefined {
  if (requested) {
    return postTypes.find((postType) => postType.name === requested)
  }
  return postTypes.find((postType) => postType.name === "post") ?? postTypes[0]
}

function blockAttributeSamples(block: WordPressBlockTypeDescriptor): Record<string, unknown> {
  return Object.fromEntries(block.attributes.flatMap((attribute) => {
    const sample = blockAttributeSample(attribute, block.exampleAttributes?.[attribute.name])
    return sample === undefined ? [] : [[attribute.name, sample]]
  }))
}

function blockAttributeSample(attribute: WordPressBlockAttributeDescriptor, example: unknown): unknown {
  if (attribute.defaultPresent) {
    return attribute.default
  }
  if (attribute.enum?.length) {
    return attribute.enum[0]
  }
  if (example !== undefined) {
    return example
  }

  const type = Array.isArray(attribute.type) ? attribute.type.find((candidate) => candidate !== "null") : attribute.type
  if (type === "string") {
    return "sample"
  }
  if (type === "integer" || type === "number") {
    return 1
  }
  if (type === "boolean") {
    return true
  }
  if (type === "array") {
    return []
  }
  if (type === "object") {
    return {}
  }

  return undefined
}

function caseIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed"
}
