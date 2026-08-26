import type { RuntimeCreateSpec } from "@automattic/wp-codebox-core"
import { phpLiteral } from "./php-snippets.js"

export function databaseBootstrapWpConfig(spec: RuntimeCreateSpec): string | undefined {
  if (spec.environment.databaseSetup === "custom-drop-in") {
    return `<?php
define('DB_NAME', 'custom_drop_in');
define('DB_USER', 'custom_drop_in');
define('DB_PASSWORD', '');
define('DB_HOST', 'localhost');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
$table_prefix = 'wp_';
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`
  }
  if (spec.environment.databaseSetup !== "external") return undefined
  const host = spec.runtimeEnv?.DB_HOST
  if (!host) return undefined
  const port = spec.runtimeEnv?.DB_PORT
  const values = {
    DB_NAME: spec.runtimeEnv?.DB_NAME ?? "runtime",
    DB_USER: spec.runtimeEnv?.DB_USER ?? "root",
    DB_HOST: port ? `${host}:${port}` : host,
  }
  return `<?php
define('DB_NAME', ${phpLiteral(values.DB_NAME)});
define('DB_USER', ${phpLiteral(values.DB_USER)});
define('DB_PASSWORD', (string) getenv('DB_PASSWORD'));
define('DB_HOST', ${phpLiteral(values.DB_HOST)});
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
$table_prefix = 'wp_';
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`
}
