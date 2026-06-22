import { commandArgValue, createRuntimeCommandResultEnvelope, parseCommandJson, type RuntimeCommandResultEnvelope } from "@automattic/wp-codebox-core"
import { wordpressFixtureUserPhpCode, type WordPressUserSessionResolution } from "./wordpress-user-sessions.js"

export const WORDPRESS_ABILITY_RESULT_SCHEMA = "wp-codebox/wordpress-ability-result/v1" as const
export const GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA = "wp-codebox/generic-ability-runtime-run-result/v1" as const

interface WordPressAbilityResult {
  schema?: typeof WORDPRESS_ABILITY_RESULT_SCHEMA
  command?: "wordpress.ability"
  status?: "ok" | "error"
  name?: string
  input?: unknown
  principal?: unknown
  result?: unknown
  error?: {
    code?: string
    message?: string
    data?: unknown
  }
}

export interface WordPressAbilityPrincipalInput {
  userId?: number
  metadata?: Record<string, unknown>
}

export interface WordPressAbilityCommandInput {
  name: string
  input: unknown
  userSession?: WordPressUserSessionResolution
  principal?: WordPressAbilityPrincipalInput
}

export function abilityInputFromArgs(args: string[]): unknown {
  const raw = commandArgValue(args, "input")
  if (!raw) {
    return {}
  }

  return parseCommandJson(raw, "wordpress.ability input")
}

export function expectedAbilityResultSchemaFromArgs(args: string[]): string | Record<string, unknown> | undefined {
  const raw = commandArgValue(args, "expected-result-schema")
  if (!raw) {
    return undefined
  }

  return parseCommandJson(raw, "wordpress.ability expected result schema") as string | Record<string, unknown>
}

export function abilityPrincipalFromArgs(args: string[]): WordPressAbilityPrincipalInput | undefined {
  const raw = commandArgValue(args, "principal-json") ?? commandArgValue(args, "principal")
  if (!raw) {
    return undefined
  }

  const parsed = parseCommandJson(raw, "wordpress.ability principal")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("wordpress.ability principal must be a JSON object")
  }

  const record = parsed as Record<string, unknown>
  const rawUserId = record.userId ?? record.user_id
  const userId = typeof rawUserId === "number" && Number.isInteger(rawUserId) && rawUserId > 0 ? rawUserId : undefined
  if (rawUserId !== undefined && userId === undefined) {
    throw new Error("wordpress.ability principal userId must be a positive integer")
  }

  return {
    ...(userId ? { userId } : {}),
    metadata: safePrincipalMetadata(record),
  }
}

export function abilityPhpCode(commandInput: WordPressAbilityCommandInput): string {
  const { name, input, userSession, principal } = commandInput
  const userSessionMetadata = userSession?.metadata
  return `${userSession ? wordpressFixtureUserPhpCode(userSession.user) : principal?.userId ? `wp_set_current_user( ${principal.userId} );` : ""}
$wp_codebox_ability_principal_input = json_decode( ${JSON.stringify(JSON.stringify(principal?.metadata ?? null))}, true );
$wp_codebox_ability_user_session = json_decode( ${JSON.stringify(JSON.stringify(userSessionMetadata ?? null))}, true );
$wp_codebox_ability_current_user = function_exists( 'wp_get_current_user' ) ? wp_get_current_user() : null;
$wp_codebox_ability_principal = array(
    'schema' => 'wp-codebox/wordpress-ability-principal/v1',
    'source' => is_array( $wp_codebox_ability_user_session ) ? (string) ( $wp_codebox_ability_user_session['source'] ?? 'session' ) : ( is_array( $wp_codebox_ability_principal_input ) ? 'principal' : 'ambient' ),
    'userId' => is_object( $wp_codebox_ability_current_user ) && isset( $wp_codebox_ability_current_user->ID ) ? (int) $wp_codebox_ability_current_user->ID : 0,
    'roles' => is_object( $wp_codebox_ability_current_user ) && isset( $wp_codebox_ability_current_user->roles ) ? array_values( array_map( 'strval', (array) $wp_codebox_ability_current_user->roles ) ) : array(),
);
if ( is_array( $wp_codebox_ability_user_session ) ) {
    $wp_codebox_ability_principal['userSession'] = $wp_codebox_ability_user_session;
}
if ( is_array( $wp_codebox_ability_principal_input ) ) {
    $wp_codebox_ability_principal['requested'] = $wp_codebox_ability_principal_input;
}

if ( ! function_exists( 'wp_get_ability' ) ) {
    throw new RuntimeException( 'The WordPress Abilities API is not available in this runtime.' );
}
$ability = wp_get_ability( ${JSON.stringify(name)} );
if ( ! $ability ) {
    throw new RuntimeException( sprintf( 'Ability is not registered: %s', ${JSON.stringify(name)} ) );
}
$result = $ability->execute( json_decode( ${JSON.stringify(JSON.stringify(input))}, true ) );
if ( is_wp_error( $result ) ) {
    $code = $result->get_error_code();
    echo wp_json_encode( array(
        'schema' => ${JSON.stringify(WORDPRESS_ABILITY_RESULT_SCHEMA)},
        'command' => 'wordpress.ability',
        'status' => 'error',
        'name' => ${JSON.stringify(name)},
        'input' => json_decode( ${JSON.stringify(JSON.stringify(input))}, true ),
        'principal' => $wp_codebox_ability_principal,
        'error' => array(
            'code' => $code,
            'message' => $result->get_error_message( $code ),
            'data' => $result->get_error_data( $code ),
        ),
    ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
    return;
}
echo wp_json_encode( array(
    'schema' => ${JSON.stringify(WORDPRESS_ABILITY_RESULT_SCHEMA)},
    'command' => 'wordpress.ability',
    'status' => 'ok',
    'name' => ${JSON.stringify(name)},
    'input' => json_decode( ${JSON.stringify(JSON.stringify(input))}, true ),
    'principal' => $wp_codebox_ability_principal,
    'result' => $result,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}

export function abilityResponseToCommandEnvelope(text: string, name: string, input: unknown, expectedResultSchema?: string | Record<string, unknown>): RuntimeCommandResultEnvelope {
  const parsed = JSON.parse(text) as WordPressAbilityResult
  if (parsed.status === "error") {
    const code = parsed.error?.code || "wordpress-ability-error"
    const message = parsed.error?.message || "WordPress ability failed"
    return createRuntimeCommandResultEnvelope({
      status: "error",
      stdout: `${JSON.stringify(parsed, null, 2)}\n`,
      json: parsed,
      error: {
        code,
        message,
        ...("data" in (parsed.error ?? {}) ? { data: parsed.error?.data } : {}),
      },
      diagnostics: { command: "wordpress.ability", ability: parsed.name ?? name, input, principal: parsed.principal },
    })
  }

  if (expectedResultSchema !== undefined) {
    const schemaCheck = validateExpectedResultSchema(parsed.result, expectedResultSchema)
    const result = {
      schema: GENERIC_ABILITY_RUNTIME_RUN_RESULT_SCHEMA,
      command: "wordpress.ability",
      ability: parsed.name ?? name,
      input,
      principal: parsed.principal,
      expectedResultSchema,
      result: parsed.result,
      resultEnvelope: parsed.result,
      evidenceEnvelope: evidenceEnvelopeFromResult(parsed.result),
      diagnostics: schemaCheck.valid ? [] : [{ code: "unexpected-result-schema", message: schemaCheck.message }],
    }
    return createRuntimeCommandResultEnvelope({
      status: schemaCheck.valid ? "ok" : "error",
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      json: result,
      ...(schemaCheck.valid ? {} : { error: { code: "unexpected-result-schema", message: schemaCheck.message } }),
      diagnostics: { command: "wordpress.ability", ability: parsed.name ?? name, input, principal: parsed.principal, expectedResultSchema },
    })
  }

  return createRuntimeCommandResultEnvelope({
    status: "ok",
    stdout: `${JSON.stringify(parsed, null, 2)}\n`,
    json: parsed,
    diagnostics: { command: "wordpress.ability", ability: parsed.name ?? name, input, principal: parsed.principal },
  })
}

function safePrincipalMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const rawUserId = record.userId ?? record.user_id
  const metadata: Record<string, unknown> = {}
  if (typeof rawUserId === "number" && Number.isInteger(rawUserId) && rawUserId > 0) {
    metadata.userId = rawUserId
  }
  for (const key of ["source", "type", "name", "role"] as const) {
    if (typeof record[key] === "string" && record[key].trim() !== "") {
      metadata[key] = record[key]
    }
  }
  return metadata
}

function validateExpectedResultSchema(result: unknown, expected: string | Record<string, unknown>): { valid: true } | { valid: false; message: string } {
  const expectedSchema = typeof expected === "string" ? expected : typeof expected.$id === "string" ? expected.$id : typeof expected["const"] === "string" ? expected["const"] : ""
  if (!expectedSchema) {
    return { valid: true }
  }
  const actualSchema = result && typeof result === "object" && !Array.isArray(result) && typeof (result as Record<string, unknown>).schema === "string"
    ? String((result as Record<string, unknown>).schema)
    : ""
  if (actualSchema === expectedSchema) {
    return { valid: true }
  }
  return { valid: false, message: `Expected ability result schema ${expectedSchema}, received ${actualSchema || "<missing>"}.` }
}

function evidenceEnvelopeFromResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
  const record = result as Record<string, unknown>
  return record.evidenceEnvelope ?? record.evidence_envelope ?? record.evidence
}
