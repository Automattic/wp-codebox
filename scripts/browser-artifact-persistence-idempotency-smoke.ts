import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "wp-codebox-browser-artifact-idempotency-"))
const smokePhp = join(dir, "smoke.php")
const jsonPath = new URL("../packages/wordpress-plugin/src/class-wp-codebox-json.php", import.meta.url).pathname
const pathPolicyClassPath = new URL("../packages/wordpress-plugin/src/class-wp-codebox-path-policy.php", import.meta.url).pathname
const classPath = new URL("../packages/wordpress-plugin/src/class-wp-codebox-artifacts.php", import.meta.url).pathname

writeFileSync(smokePhp, `<?php
define('ABSPATH', __DIR__);

class WP_Error {
	private string $code;
	private string $message;
	private mixed $data;

	public function __construct(string $code = '', string $message = '', mixed $data = '') {
		$this->code = $code;
		$this->message = $message;
		$this->data = $data;
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_message(): string {
		return $this->message;
	}

	public function get_error_data(): mixed {
		return $this->data;
	}
}

function is_wp_error(mixed $value): bool {
	return $value instanceof WP_Error;
}

function smoke_assert(bool $condition, string $message): void {
	if (!$condition) {
		throw new RuntimeException($message);
	}
}

function smoke_remove_tree(string $path): void {
	if (!is_dir($path)) {
		return;
	}

	$items = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ($items as $item) {
		$item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
	}
	rmdir($path);
}

require ${JSON.stringify(jsonPath)};
require ${JSON.stringify(pathPolicyClassPath)};
require ${JSON.stringify(classPath)};

$root = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'wp-codebox-artifacts-' . bin2hex(random_bytes(8));
$input = array(
	'artifacts_path' => $root,
	'authorization' => array('caller' => 'smoke-caller', 'scope' => 'artifact:write'),
	'schema_id' => 'smoke/browser-artifact/v1',
	'root' => 'website',
	'entrypoint' => 'website/index.html',
	'session' => array('id' => 'smoke-session'),
	'files' => array(
		array(
			'path' => 'website/index.html',
			'content' => '<!doctype html><title>Smoke</title>',
			'encoding' => 'utf-8',
		),
	),
);

try {
	$artifacts = new WP_Codebox_Artifacts();
	$created = $artifacts->persist_browser_bundle($input);
	smoke_assert(!is_wp_error($created), 'first persistence should not return WP_Error');
	smoke_assert('created' === ($created['status'] ?? ''), 'first persistence should return status=created');
	smoke_assert('' !== (string) ($created['artifact_id'] ?? ''), 'first persistence should return artifact_id');
	smoke_assert('' !== (string) ($created['content_digest'] ?? ''), 'first persistence should return content_digest');
	smoke_assert('wp-codebox/browser-artifact-ref/v1' === ($created['artifact_ref']['schema'] ?? ''), 'first persistence should return a normalized artifact_ref');
	smoke_assert(($created['artifact_id'] ?? '') === ($created['artifact_ref']['artifact_id'] ?? ''), 'artifact_ref should carry the persisted artifact id');
	smoke_assert('wp-codebox/browser-artifact-grant/v1' === ($created['grant']['schema'] ?? ''), 'first persistence should return a scoped artifact grant');
	smoke_assert('artifact:write' === ($created['grant']['authorization']['scope'] ?? ''), 'artifact grant should carry artifact write authorization');

	$existing = $artifacts->persist_browser_bundle($input);
	smoke_assert(!is_wp_error($existing), 'duplicate persistence should not return WP_Error');
	smoke_assert('existing' === ($existing['status'] ?? ''), 'duplicate persistence should return status=existing');
	smoke_assert($created['artifact_id'] === $existing['artifact_id'], 'duplicate persistence should return stable artifact_id');
	smoke_assert($created['content_digest'] === $existing['content_digest'], 'duplicate persistence should return stable content_digest');
	smoke_assert($created['artifact_ref']['artifact_id'] === $existing['artifact_ref']['artifact_id'], 'duplicate persistence should return stable artifact_ref');
	smoke_assert(is_array($existing['artifact'] ?? null), 'duplicate persistence should return existing artifact payload');
} finally {
	smoke_remove_tree($root);
}
`)

execFileSync("php", ["-l", smokePhp], { stdio: "pipe" })
execFileSync("php", [smokePhp], { stdio: "pipe" })

console.log("Browser artifact persistence idempotency smoke passed")
