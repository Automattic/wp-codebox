import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

// Proves the plugin registers its own `agents-md` context section on a
// minimal stand-in for WP_Agent_Context_Section_Registry (the Agents API
// substrate), that the render body carries routing/safety/discovery guidance
// with the host-filtered WP-CLI prefix, and that registration is a no-op
// when the substrate class is absent.
const output = execFileSync(
  "php",
  [
    "-r",
    String.raw`
define('ABSPATH', '/srv/site/');

$GLOBALS['actions'] = array();
$GLOBALS['filters'] = array();
function add_action(string $hook, callable $cb, int $priority = 10, int $accepted_args = 1): void { $GLOBALS['actions'][$hook][] = $cb; }
function do_action(string $hook, ...$args): void { foreach ($GLOBALS['actions'][$hook] ?? array() as $cb) { $cb(); } }
function add_filter(string $hook, callable $cb, int $priority = 10, int $accepted_args = 1): void { $GLOBALS['filters'][$hook][] = $cb; }
function apply_filters(string $hook, $value, ...$args) { foreach ($GLOBALS['filters'][$hook] ?? array() as $cb) { $value = $cb($value); } return $value; }

require __DIR__ . '/packages/wordpress-plugin/src/class-wp-codebox-agents-md-section.php';

// 1. Without the substrate class, firing the hook registers nothing and does not fatal.
WP_Codebox_Agents_Md_Section::register();
do_action('agents_api_context_sections');
$without_substrate_ok = true;

$registered_before_substrate = isset($GLOBALS['registered']) ? count($GLOBALS['registered']) : 0;

// 2. With a minimal substrate stand-in, the section registers with the expected shape.
// Declared inside a block so PHP does not hoist it above step 1.
if (true) {
	final class WP_Agent_Context_Section_Registry {
		public static array $registered = array();
		public static function register(string $context, string $slug, int $priority, callable $callback, array $args = array()) {
			self::$registered[] = compact('context', 'slug', 'priority', 'callback', 'args');
			return self::$registered[count(self::$registered) - 1];
		}
	}
}
do_action('agents_api_context_sections');

add_filter('wp_codebox_agents_md_wp_cli_cmd', static function ($cmd) { return 'wp --allow-root --path=/srv/site'; });

$reg = WP_Agent_Context_Section_Registry::$registered[0] ?? null;
$rendered = $reg ? ($reg['callback'])(array(), array()) : '';

echo json_encode(array(
	'without_substrate_ok' => $without_substrate_ok && 0 === $registered_before_substrate,
	'count' => count(WP_Agent_Context_Section_Registry::$registered),
	'context' => $reg['context'] ?? null,
	'slug' => $reg['slug'] ?? null,
	'priority' => $reg['priority'] ?? null,
	'label' => $reg['args']['label'] ?? null,
	'owner' => $reg['args']['meta']['owner'] ?? null,
	'freshness' => $reg['args']['meta']['freshness'] ?? null,
	'default_cmd' => 'wp --path=/srv/site',
	'rendered' => $rendered,
), JSON_UNESCAPED_SLASHES);
`,
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" }
)

const result = JSON.parse(output)

assert.equal(result.without_substrate_ok, true)
assert.equal(result.count, 1, "registers exactly one section")
assert.equal(result.context, "agents-md")
assert.equal(result.slug, "wp-codebox")
assert.equal(result.priority, 40)
assert.equal(result.label, "WP Codebox")
assert.equal(result.owner, "wp-codebox")
assert.equal(result.freshness, "generated")

const rendered: string = result.rendered
assert.ok(rendered.startsWith("## WP Codebox\n"), "section starts with its heading")
for (const heading of ["**Default routing**", "**Safety**", "**Discovery**"]) {
  assert.ok(rendered.includes(heading), `contains ${heading}`)
}
for (const verb of [
  "codebox run-agent-task",
  "codebox run-agent-task-fanout",
  "codebox run-wordpress-workload",
  "codebox resolve-runtime-requirements",
  "codebox artifacts inspect",
  "codebox artifacts preflight-apply",
  "codebox artifacts apply",
  "codebox browser-session create",
  "codebox --help",
]) {
  assert.ok(rendered.includes(verb), `routes to ${verb}`)
}
assert.ok(
  rendered.includes("wp --allow-root --path=/srv/site codebox"),
  "uses the host-filtered WP-CLI prefix"
)
assert.ok(!rendered.includes(result.default_cmd + " codebox"), "filtered prefix replaces the default")
assert.ok(!/datamachine|DataMachine/.test(rendered), "no host composer names leak into generic guidance")

console.log("php-agents-md-section: OK")
