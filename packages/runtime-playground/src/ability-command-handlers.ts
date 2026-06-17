import { argValue } from "./command-args.js"
import { createRuntimeCommandResultEnvelope, type RuntimeCommandResultEnvelope } from "@automattic/wp-codebox-core"

export const WORDPRESS_ABILITY_RESULT_SCHEMA = "wp-codebox/wordpress-ability-result/v1" as const

interface WordPressAbilityResult {
  schema?: typeof WORDPRESS_ABILITY_RESULT_SCHEMA
  command?: "wordpress.ability"
  status?: "ok" | "error"
  name?: string
  input?: unknown
  result?: unknown
  error?: {
    code?: string
    message?: string
    data?: unknown
  }
}

export function abilityInputFromArgs(args: string[]): unknown {
  const raw = argValue(args, "input")
  if (!raw) {
    return {}
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`wordpress.ability input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function abilityPhpCode(name: string, input: unknown): string {
  return `wp_set_current_user( 1 );
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
    'result' => $result,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}

export function abilityResponseToCommandEnvelope(text: string, name: string, input: unknown): RuntimeCommandResultEnvelope {
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
      diagnostics: { command: "wordpress.ability", ability: parsed.name ?? name, input },
    })
  }

  return createRuntimeCommandResultEnvelope({
    status: "ok",
    stdout: `${JSON.stringify(parsed, null, 2)}\n`,
    json: parsed,
    diagnostics: { command: "wordpress.ability", ability: parsed.name ?? name, input },
  })
}
