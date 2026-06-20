import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { repoRoot } from "../scripts/test-kit.js"

const source = readFileSync(join(repoRoot, "packages/wordpress-plugin/src/class-wp-codebox-abilities.php"), "utf8")

assert.match(source, /'permission_callback'\s*=>\s*array\(\s*self::class,\s*'can_hydrate_browser_blueprint_ref'\s*\)/)
assert.match(source, /public static function can_hydrate_browser_blueprint_ref\(\): bool/)
assert.match(source, /is_user_logged_in\(\)\s*\|\|\s*current_user_can\(\s*'manage_options'\s*\)/)

console.log("browser blueprint ref permission ok")
