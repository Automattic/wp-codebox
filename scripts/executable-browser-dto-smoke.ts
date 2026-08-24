import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "wp-codebox-executable-browser-dto-"))
const smokePhp = join(dir, "smoke.php")
const browserTaskBuilderPath = new URL("../packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php", import.meta.url).pathname
const contractServicePath = new URL("../packages/wordpress-plugin/src/class-wp-codebox-browser-task-contract-service.php", import.meta.url).pathname

writeFileSync(smokePhp, `<?php
define('ABSPATH', __DIR__);

class WP_Codebox_Redaction_Policy {
	public static function key_should_redact(string $profile, string $key): bool {
		return false;
	}
}

function smoke_assert(bool $condition, string $message): void {
	if (!$condition) {
		throw new RuntimeException($message);
	}
}

function is_wp_error(mixed $value): bool {
	return false;
}

require ${JSON.stringify(browserTaskBuilderPath)};
require ${JSON.stringify(contractServicePath)};

$helpers = array(
	'create_browser_playground_session' => static function(array $input): array {
		return array(
			'success' => true,
			'session' => array(
				'id' => 'session-123',
				'authorization' => array('mode' => 'runtime-principal'),
			),
			'task_input' => $input['task_input'],
			'task_payload' => $input['task_payload'],
		);
	},
	'normalize_agent_bundles' => static function(mixed $bundles): array {
		$normalized = array();
		foreach (is_array($bundles) ? $bundles : array() as $bundle) {
			if (!is_array($bundle)) {
				continue;
			}
			$source = isset($bundle['source']) ? trim((string) $bundle['source']) : '';
			$inline = is_array($bundle['bundle'] ?? null) ? $bundle['bundle'] : null;
			if ('' === $source && null === $inline) {
				continue;
			}
			$entry = array('on_conflict' => 'upgrade');
			if ('' !== $source) {
				$entry['source'] = $source;
			}
			if (null !== $inline) {
				$entry['bundle'] = $inline;
			}
			if (isset($bundle['slug'])) {
				$entry['slug'] = (string) $bundle['slug'];
			}
			$normalized[] = $entry;
		}
		return $normalized;
	},
);

$service = new WP_Codebox_Browser_Task_Contract_Service(
	static function(string $name, array $args) use ($helpers): mixed {
		smoke_assert(isset($helpers[$name]), 'fixture helper call must exist: ' . $name);
		return $helpers[$name](...$args);
	}
);

$input = array(
	'task_input' => array(
		'schema' => 'wp-codebox/agent-task-input/v1',
		'goal' => 'Build a site',
		'agent_bundles' => array(
			array(
				'source' => 'https://example.test/agent-bundle.json',
				'slug' => 'example-agent',
			),
		),
	),
	'task_payload' => array(
		'schema' => 'wp-codebox/browser-agent-task-payload/v1',
		'agent' => 'wp-codebox-sandbox',
		'session_id' => 'session-123',
		'agent_bundles' => array(
			array(
				'bundle' => array('schema' => 'agents/runtime-bundle/v1', 'agent' => array('slug' => 'inline-agent')),
				'slug' => 'inline-agent',
			),
		),
	),
);

$fixture_calls = array('create_browser_materializer_contract' => $input);
$fixture_outputs = array();
foreach ($fixture_calls as $method => $args) {
	smoke_assert(method_exists($service, $method), 'generated fixture call must exist on contract service: ' . $method);
	$fixture_outputs[$method] = $service->{$method}($args);
	$encoded = json_encode($fixture_outputs[$method], JSON_UNESCAPED_SLASHES);
	smoke_assert(is_string($encoded) && strlen($encoded) <= 4096, 'generated fixture output must remain bounded to 4096 bytes: ' . $method);
}
$compact = $fixture_outputs['create_browser_materializer_contract'];

smoke_assert('wp-codebox/browser-materializer-product-dto/v1' === ($compact['schema'] ?? ''), 'summary DTO schema should remain product DTO');
smoke_assert(!isset($compact['task_payload']['agent_bundles'][0]['bundle']), 'summary task_payload should not include inline bundle payloads');
smoke_assert(!isset($compact['task_input']['agent_bundles'][0]['source']), 'summary task_input should not include executable sources');
smoke_assert('wp-codebox/browser-materializer-executable-dto/v1' === ($compact['executable']['schema'] ?? ''), 'executable DTO should be explicit');
smoke_assert('session-123' === ($compact['executable']['session_id'] ?? ''), 'executable DTO should carry session id');
smoke_assert('inline-agent' === ($compact['executable']['task_payload']['agent_bundles'][0]['slug'] ?? ''), 'executable DTO should carry bundle slug');
smoke_assert('agents/runtime-bundle/v1' === ($compact['executable']['task_payload']['agent_bundles'][0]['bundle']['schema'] ?? ''), 'executable DTO should carry inline bundle payload');
smoke_assert('agents/runtime-bundle/v1' === ($compact['executable']['task_input']['agent_bundles'][0]['bundle']['schema'] ?? ''), 'executable task input should carry importable bundle payload');
`)

execFileSync("php", ["-l", smokePhp], { stdio: "pipe" })
execFileSync("php", [smokePhp], { stdio: "pipe" })

console.log("Executable browser DTO smoke passed")
