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

echo json_encode( $blueprint_ref, JSON_UNESCAPED_SLASHES );
`)

assert.equal(result.schema, "wp-codebox/browser-blueprint-ref/v1")
assert.equal(result.ref, "prepared:studio-proof:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
assert.match(result.hydration_endpoint, /\/wp-codebox\/v1\/browser-blueprint-ref\?ref=prepared%3Astudio-proof%3A[a]{64}&_wpnonce=test-rest-nonce$/)

console.log("browser blueprint ref endpoint ok")
