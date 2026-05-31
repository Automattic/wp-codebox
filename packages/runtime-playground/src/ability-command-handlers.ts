import { argValue } from "./command-args.js"

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
    throw new RuntimeException( $result->get_error_message() );
}
echo wp_json_encode( array(
    'command' => 'wordpress.ability',
    'name' => ${JSON.stringify(name)},
    'input' => json_decode( ${JSON.stringify(JSON.stringify(input))}, true ),
    'result' => $result,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}
