import assert from "node:assert/strict"

import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

const result = await runPhpJson<any>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/class-wp-codebox-browser-task-builder.php`)};

function wp_create_nonce( $action = -1 ) {
	return 'test-rest-nonce';
}

$blueprint_ref = WP_Codebox_Browser_Task_Builder::browser_blueprint_ref(
	array(
		'cache_key'  => 'studio-proof',
		'input_hash' => str_repeat( 'a', 64 ),
	)
);

$runtime_ref = WP_Codebox_Browser_Task_Builder::executable_blueprint_ref(
	array(
		'session' => array(
			'runtime' => array(
				'prepared_runtime' => array(
					'schema'     => 'wp-codebox/browser-prepared-runtime/v1',
					'cache_key'  => 'runtime-proof',
					'input_hash' => str_repeat( 'b', 64 ),
					'status'     => 'ready',
				),
			),
		),
	)
);

$boot_config = WP_Codebox_Browser_Task_Builder::browser_preview_boot_config(
	array(
		'playground' => array(
			'scope'             => 'runtime-proof-scope',
			'client_module_url' => 'https://playground.wordpress.net/client/index.js',
			'remote_url'        => 'https://playground.wordpress.net/remote.html',
		),
		'runtime' => array(
			'prepared_runtime' => array(
				'schema'     => 'wp-codebox/browser-prepared-runtime/v1',
				'cache_key'  => 'boot-runtime-proof',
				'input_hash' => str_repeat( 'c', 64 ),
				'status'     => 'ready',
			),
		),
	)
);

echo json_encode( array( 'blueprint_ref' => $blueprint_ref, 'runtime_ref' => $runtime_ref, 'boot_config' => $boot_config ), JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.blueprint_ref.schema, "wp-codebox/browser-blueprint-ref/v1")
assert.equal(result.blueprint_ref.ref, "prepared:studio-proof:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
assert.match(result.blueprint_ref.hydration_endpoint, /\/wp-codebox\/v1\/browser-blueprint-ref\?ref=prepared%3Astudio-proof%3A[a]{64}&_wpnonce=test-rest-nonce$/)
assert.equal(result.runtime_ref.ref, "prepared:runtime-proof:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
assert.equal(result.boot_config.blueprint_ref_dto.ref, "prepared:boot-runtime-proof:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
assert.match(result.boot_config.blueprint_ref_dto.hydration_endpoint, /\/wp-codebox\/v1\/browser-blueprint-ref\?ref=prepared%3Aboot-runtime-proof%3A[c]{64}&_wpnonce=test-rest-nonce$/)

console.log("browser blueprint ref endpoint ok")
