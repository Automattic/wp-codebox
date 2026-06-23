import { fuzzSuiteContract, type FuzzSuiteCase, type FuzzSuiteContract } from "./fuzz-suite-contracts.js"
import { stripUndefined } from "./object-utils.js"
import type { WordPressBlockEditorTargetDiscovery, WordPressBlockTypeDescriptor, WordPressEditorPostTypeDescriptor } from "./wordpress-runtime-discovery-contracts.js"

export interface WordPressBlockFuzzSuiteOptions {
  id?: string
  version?: string
  includeServerRender?: boolean
  includeEditorInsert?: boolean
  editorPostType?: string
  capture?: readonly string[]
}

const DEFAULT_BLOCK_FUZZ_SUITE_ID = "wordpress-block-discovery"
const DEFAULT_EDITOR_CAPTURE = ["editor-state", "errors"] as const
const BLOCK_SERVER_RENDER_CAPABILITIES = ["target:runtime", "runtime"] as const
const BLOCK_EDITOR_INSERT_CAPABILITIES = ["target:runtime", "runtime", "runtime-action:editor_open"] as const

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
      cases.push(editorInsertCase(block, editorPostType, options.capture ?? DEFAULT_EDITOR_CAPTURE))
    }
  }

  return fuzzSuiteContract({
    id: options.id ?? DEFAULT_BLOCK_FUZZ_SUITE_ID,
    version: options.version,
    cases,
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
          includeServerRender ? "wordpress.run-php" : undefined,
          includeEditorInsert ? "wordpress.editor-open" : undefined,
        ].filter((command): command is string => Boolean(command)),
      }),
    }),
  })
}

function serverRenderCase(block: WordPressBlockTypeDescriptor): FuzzSuiteCase {
  return {
    id: `block-${caseIdPart(block.name)}-server-render-empty-attributes`,
    target: { kind: "runtime", entrypoint: "wordpress.run-php" },
    input: {
      args: [
        `code=${serverRenderPhp(block.name)}`,
        "bootstrap=wordpress",
      ],
    },
    description: `Render ${block.name} through render_block with empty attributes.`,
    metadata: blockCaseMetadata(block, "server-render", { emptyAttributes: {} }),
  }
}

function editorInsertCase(block: WordPressBlockTypeDescriptor, postType: WordPressEditorPostTypeDescriptor, capture: readonly string[]): FuzzSuiteCase {
  return {
    id: `block-${caseIdPart(block.name)}-editor-insert-${caseIdPart(postType.name)}-empty-attributes`,
    target: { kind: "runtime", entrypoint: "wordpress.editor-actions" },
    input: {
      args: [
        "target=post-new",
        `post-type=${postType.name}`,
        `steps-json=${JSON.stringify([{ kind: "insertBlock", name: block.name, attributes: {} }, { kind: "inspectState" }])}`,
        `capture=${capture.join(",")}`,
      ],
    },
    description: `Insert ${block.name} into a new ${postType.name} editor canvas with empty attributes.`,
    metadata: blockCaseMetadata(block, "editor-insert", { emptyAttributes: {}, editorPostType: postType.name }),
  }
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

function serverRenderPhp(blockName: string): string {
  return `$block = array('blockName' => ${JSON.stringify(blockName)}, 'attrs' => array(), 'innerBlocks' => array(), 'innerHTML' => '', 'innerContent' => array()); $rendered = render_block($block); if (!is_string($rendered)) { exit(1); }`
}

function caseIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed"
}
