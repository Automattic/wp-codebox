import assert from "node:assert/strict"

import { validateHostDelegationRequestContract, validateHostDelegationResultContract } from "../packages/runtime-core/src/index.js"
import { phpStringLiteral, repoRoot, runPhpJson } from "../scripts/test-kit.js"

assert.deepEqual(validateHostDelegationRequestContract({ schema: "wp-codebox/host-delegation-request/v1", goal: "Check", source_digest: "a".repeat(64) }), { valid: true, issues: [] })
assert.equal(validateHostDelegationRequestContract({ schema: "wrong", goal: "Check" }).issues[0].code, "schema-invalid")
assert.equal(validateHostDelegationRequestContract({ schema: "wp-codebox/host-delegation-request/v1" }).issues[0].code, "request-invalid")
assert.equal(validateHostDelegationResultContract(
  { request_id: "req-1", sandbox_session_id: "sandbox-a", source_digest: "a".repeat(64) },
  { schema: "wp-codebox/host-delegation-result/v1", status: "completed", request_id: "req-1", result: { sandbox_session_id: "sandbox-b" } },
).issues[0].code, "scope-mismatch")
assert.equal(validateHostDelegationResultContract(
  { request_id: "req-1", sandbox_session_id: "sandbox-a", source_digest: "a".repeat(64) },
  { schema: "wp-codebox/host-delegation-result/v1", status: "completed", request_id: "req-1", result: { source_digest: "b".repeat(64) } },
).issues[0].code, "source-digest-mismatch")

const result = await runPhpJson<any>(`
define('ABSPATH', ${phpStringLiteral(repoRoot)});

class WP_Error {
	public function __construct( public string $code = '', public string $message = '', public mixed $data = null ) {}
	public function get_error_code() { return $this->code; }
	public function get_error_message() { return $this->message; }
	public function get_error_data() { return $this->data; }
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function sanitize_key( $value ) { return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $value ) ); }
function apply_filters( $tag, $value, ...$args ) {
	if ( 'wp_codebox_host_delegation_request' === $tag ) {
		return $GLOBALS['wp_codebox_test_host_delegation_provider_result'] ?? null;
	}
	return $value;
}

require ${phpStringLiteral(`${repoRoot}/packages/wordpress-plugin/src/trait-wp-codebox-abilities-execution.php`)};

class WP_Codebox_Test_Host_Delegation_Abilities {
	use WP_Codebox_Abilities_Execution;
	private static int $next_id = 0;
	private static function safe_key( string $value ): string { return sanitize_key( $value ); }
	private static function generate_id(): string { self::$next_id++; return 'generated-' . self::$next_id; }
}

$base_request = array(
	'schema'             => 'wp-codebox/host-delegation-request/v1',
	'request_id'         => 'delegation-proof',
	'goal'               => 'Run host-side validation',
	'sandbox_session_id' => 'sandbox-proof',
	'source_digest'      => str_repeat( 'a', 64 ),
);

$unavailable = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( $base_request );

$missing_goal = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( array(
	'schema'             => 'wp-codebox/host-delegation-request/v1',
	'request_id'         => 'missing-goal-proof',
	'sandbox_session_id' => 'sandbox-proof',
) );

$bad_digest = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( array_merge( $base_request, array(
	'request_id'    => 'bad-digest-proof',
	'source_digest' => 'not-a-sha256',
) ) );

$GLOBALS['wp_codebox_test_host_delegation_provider_result'] = array(
	'schema'     => 'wp-codebox/host-delegation-result/v1',
	'request_id' => 'delegation-proof',
	'status'     => 'maybe',
);
$invalid_status = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( $base_request );

$GLOBALS['wp_codebox_test_host_delegation_provider_result'] = array(
	'schema'             => 'wp-codebox/host-delegation-result/v1',
	'request_id'         => 'delegation-proof',
	'status'             => 'completed',
	'sandbox_session_id' => 'sandbox-other',
	'result'             => array( 'ok' => true ),
);
$scope_mismatch = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( $base_request );

$GLOBALS['wp_codebox_test_host_delegation_provider_result'] = array(
	'schema'        => 'wp-codebox/host-delegation-result/v1',
	'request_id'    => 'delegation-proof',
	'status'        => 'completed',
	'source_digest' => str_repeat( 'b', 64 ),
	'result'        => array( 'ok' => true ),
);
$digest_mismatch = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( $base_request );

$GLOBALS['wp_codebox_test_host_delegation_provider_result'] = array(
	'schema'             => 'wp-codebox/host-delegation-result/v1',
	'request_id'         => 'delegation-proof',
	'status'             => 'completed',
	'sandbox_session_id' => 'sandbox-proof',
	'source_digest'      => str_repeat( 'a', 64 ),
	'provider'           => 'test-provider',
	'result'             => array( 'ok' => true ),
);
$completed = WP_Codebox_Test_Host_Delegation_Abilities::request_host_delegation( $base_request );

echo json_encode( array(
	'unavailable'     => $unavailable,
	'missing_goal'    => $missing_goal,
	'bad_digest'      => $bad_digest,
	'invalid_status'  => $invalid_status,
	'scope_mismatch'  => $scope_mismatch,
	'digest_mismatch' => $digest_mismatch,
	'completed'       => $completed,
), JSON_UNESCAPED_SLASHES );
`)

for (const key of ["unavailable", "missing_goal", "bad_digest", "invalid_status", "scope_mismatch", "digest_mismatch", "completed"] as const) {
  assert.equal(result[key].schema, "wp-codebox/host-delegation-result/v1")
  assert.equal(result[key].execution, "host-delegation")
  assert.equal(Array.isArray(result[key].events), true)
}

assert.equal(result.unavailable.success, false)
assert.equal(result.unavailable.status, "unavailable")
assert.equal(result.unavailable.error.code, "wp_codebox_host_delegation_unavailable")

assert.equal(result.missing_goal.success, false)
assert.equal(result.missing_goal.status, "failed")
assert.equal(result.missing_goal.error.code, "wp_codebox_host_delegation_request_invalid")
assert.equal(result.missing_goal.events.at(-1).event, "host-delegation.failed")

assert.equal(result.bad_digest.success, false)
assert.equal(result.bad_digest.error.code, "wp_codebox_host_delegation_source_digest_invalid")

assert.equal(result.invalid_status.success, false)
assert.equal(result.invalid_status.error.code, "wp_codebox_host_delegation_provider_status_invalid")
assert.equal(result.invalid_status.result, undefined)

assert.equal(result.scope_mismatch.success, false)
assert.equal(result.scope_mismatch.error.code, "wp_codebox_host_delegation_scope_mismatch")
assert.equal(result.scope_mismatch.result, undefined)

assert.equal(result.digest_mismatch.success, false)
assert.equal(result.digest_mismatch.error.code, "wp_codebox_host_delegation_source_digest_mismatch")
assert.equal(result.digest_mismatch.result, undefined)

assert.equal(result.completed.success, true)
assert.equal(result.completed.status, "completed")
assert.equal(result.completed.provider, "test-provider")
assert.equal(result.completed.result.ok, true)

console.log("host delegation validation ok")
