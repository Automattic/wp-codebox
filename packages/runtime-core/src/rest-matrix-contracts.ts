import { stripUndefined } from "./object-utils.js"
import { fuzzSuiteContract, type FuzzSuiteContract, type FuzzSuiteResultEnvelope, type FuzzSuiteTargetRef } from "./fuzz-suite-contracts.js"
import { runFuzzSuite, type FuzzSuiteRunOptions } from "./fuzz-suite-runner.js"

export const WORDPRESS_REST_MATRIX_SCHEMA = "wp-codebox/wordpress-rest-matrix/v1" as const
export const WORDPRESS_REST_MATRIX_RESULT_SCHEMA = "wp-codebox/wordpress-rest-matrix-result/v1" as const

export interface WordPressRestMatrixCase {
  id: string
  method: string
  path: string
  params?: Record<string, unknown>
  headers?: Record<string, unknown>
  body?: string
  bodyJson?: unknown
  user?: string
  session?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface WordPressRestMatrixContract {
  schema: typeof WORDPRESS_REST_MATRIX_SCHEMA
  id: string
  version?: string
  cases: WordPressRestMatrixCase[]
  metadata?: Record<string, unknown>
}

export interface WordPressRestMatrixResultEnvelope extends Omit<FuzzSuiteResultEnvelope, "schema"> {
  schema: typeof WORDPRESS_REST_MATRIX_RESULT_SCHEMA
  sourceSchema: typeof WORDPRESS_REST_MATRIX_SCHEMA
}

const REST_REQUEST_TARGET: FuzzSuiteTargetRef = {
  kind: "rest",
  id: "wordpress.rest-request",
  entrypoint: "wordpress.rest-request",
  label: "WordPress REST request",
}

export function wordpressRestMatrixContract(input: {
  id: string
  version?: string
  cases?: WordPressRestMatrixCase[]
  metadata?: Record<string, unknown>
}): WordPressRestMatrixContract {
  return stripUndefined({
    schema: WORDPRESS_REST_MATRIX_SCHEMA,
    id: input.id,
    version: input.version,
    cases: input.cases ?? [],
    metadata: input.metadata,
  })
}

export function wordpressRestMatrixToFuzzSuite(matrix: WordPressRestMatrixContract): FuzzSuiteContract {
  return fuzzSuiteContract({
    id: matrix.id,
    version: matrix.version,
    target: REST_REQUEST_TARGET,
    cases: matrix.cases.map((item) => ({
      id: item.id,
      target: REST_REQUEST_TARGET,
      description: item.description,
      input: { args: wordpressRestMatrixCaseArgs(item) },
      metadata: stripUndefined({ ...item.metadata, restMatrix: { method: item.method, path: item.path } }),
    })),
    metadata: stripUndefined({ ...matrix.metadata, sourceSchema: matrix.schema }),
  })
}

export async function runWordPressRestMatrix(matrix: WordPressRestMatrixContract, options: FuzzSuiteRunOptions = {}): Promise<WordPressRestMatrixResultEnvelope> {
  const result = await runFuzzSuite(wordpressRestMatrixToFuzzSuite(matrix), {
    ...options,
    supportedTargetKinds: options.supportedTargetKinds ?? ["rest"],
    metadata: stripUndefined({ ...options.metadata, sourceSchema: matrix.schema, runner: "wp-codebox/wordpress-rest-matrix-runner/v1" }),
  })

  return stripUndefined({
    ...result,
    schema: WORDPRESS_REST_MATRIX_RESULT_SCHEMA,
    sourceSchema: WORDPRESS_REST_MATRIX_SCHEMA,
  }) as WordPressRestMatrixResultEnvelope
}

function wordpressRestMatrixCaseArgs(item: WordPressRestMatrixCase): string[] {
  const args = [`method=${item.method.toUpperCase()}`, `path=${item.path}`]
  if (item.headers !== undefined) args.push(`headers-json=${JSON.stringify(item.headers)}`)
  if (item.params !== undefined) args.push(`params-json=${JSON.stringify(item.params)}`)
  if (item.bodyJson !== undefined) args.push(`body-json=${JSON.stringify(item.bodyJson)}`)
  else if (item.body !== undefined) args.push(`body=${item.body}`)
  if (item.user !== undefined) args.push(`user=${item.user}`)
  if (item.session !== undefined) args.push(`session=${item.session}`)
  return args
}
