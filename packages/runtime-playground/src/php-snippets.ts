import { isSafeEnvName } from "./commands.js"

export type PhpScalar = string | number | boolean | null

export function phpEnvAssignments(env: Record<string, unknown>): string {
  const lines = Object.entries(env)
    .filter(([name]) => isSafeEnvName(name))
    .map(([name, value]) => `putenv(${JSON.stringify(`${name}=${String(value)}`)});`)

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export function phpWpConfigDefineAssignments(defines: Record<string, unknown>): string {
  const lines = Object.entries(defines)
    .filter((entry): entry is [string, PhpScalar] => isPhpConstantName(entry[0]) && isPhpScalar(entry[1]))
    .map(([name, value]) => phpWpConfigDefineAssignment(name, value))

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export function phpWpConfigDefineAssignment(name: string, value: PhpScalar): string {
  if (!isPhpConstantName(name)) {
    throw new Error(`Invalid PHP constant name: ${name}`)
  }

  return `if (!defined(${JSON.stringify(name)})) { define(${JSON.stringify(name)}, ${phpLiteral(value)}); }`
}

export function phpLiteral(value: PhpScalar): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (value === null) {
    return "null"
  }
  return String(value)
}

export function isPhpConstantName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/i.test(name)
}

export function isPhpScalar(value: unknown): value is PhpScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
}

export function phpEnvAssignmentFunction(functionName: string, jsonFunction = "json_encode", invalidKeyLogExpression?: string): string {
  return `function ${functionName}($env): void {
    if (!is_array($env)) {
        return;
    }
    foreach ($env as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            $string_value = is_scalar($value) ? (string) $value : ${jsonFunction}($value);
            putenv($name . '=' . $string_value);
            $_ENV[$name] = $string_value;
        }${invalidKeyLogExpression ? ` else {
            ${invalidKeyLogExpression}
        }` : ""}
    }
}`
}

export function phpWpConfigDefineAppenderFunction(functionName: string, invalidKeyLogExpression?: string, includeComment = true): string {
  return `function ${functionName}(string &$config, $extra_defines): void {
    if (empty($extra_defines) || !is_array($extra_defines)) {
        return;
    }${includeComment ? `
    $config .= "\n// Recipe-declared wp-config defines.\n";
` : ""}
    foreach ($extra_defines as $name => $value) {
        if (!is_string($name) || !preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name)) {${invalidKeyLogExpression ? `
            ${invalidKeyLogExpression}` : ""}
            continue;
        }
        $config .= sprintf("if (!defined('%s')) { define('%s', %s); }\n", $name, $name, var_export($value, true));
    }
}`
}
