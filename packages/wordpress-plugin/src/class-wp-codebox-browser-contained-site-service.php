<?php
/**
 * Browser contained-site/session service.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Contained_Site_Service {

	/** @var callable(string,array<int,mixed>):mixed */
	private $helper;

	/** @param callable(string,array<int,mixed>):mixed $helper Existing abilities helper bridge. */
	public function __construct( callable $helper ) {
		$this->helper = $helper;
	}

	/** @param array<int,mixed> $args Helper arguments. @return mixed */
	public function __call( string $name, array $args ): mixed {
		return ( $this->helper )( $name, $args );
	}
public function get_browser_contained_site_status( array $input ): array|WP_Error {
	$contained_site = is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array();
	$recovery       = is_array( $contained_site['recovery']['input'] ?? null ) ? $contained_site['recovery']['input'] : array();
	$prepared       = is_array( $contained_site['prepared_runtime'] ?? null ) ? $contained_site['prepared_runtime'] : array();
	$source_digest  = is_array( $input['source_digest'] ?? null ) ? (string) ( $input['source_digest']['value'] ?? '' ) : (string) ( $input['source_digest'] ?? '' );
	if ( '' === $source_digest && is_array( $contained_site['source_digest'] ?? null ) ) {
		$source_digest = (string) ( $contained_site['source_digest']['value'] ?? '' );
	}

	$cache_key  = $this->safe_key( (string) ( $input['cache_key'] ?? $recovery['cache_key'] ?? $prepared['cache_key'] ?? $input['site_id'] ?? $contained_site['site_id'] ?? '' ) );
	$input_hash = strtolower( trim( (string) ( $input['input_hash'] ?? $recovery['input_hash'] ?? $prepared['input_hash'] ?? $source_digest ) ) );
	if ( '' === $cache_key || ! preg_match( '/^[a-f0-9]{64}$/', $input_hash ) ) {
		return new WP_Error( 'wp_codebox_browser_contained_site_ref_invalid', 'Browser contained site status requires cache_key/site_id and a 64-character source digest.', array( 'status' => 400 ) );
	}

	$prepared_ref = array(
		'cache_key'  => $cache_key,
		'input_hash' => $input_hash,
	);
	$lookup = $this->browser_prepared_runtime_cache_lookup( $prepared_ref );
	return $this->browser_contained_site_status_envelope( $cache_key, $input_hash, $lookup );
}

public function preview_reuse_decision( array $input ): array|WP_Error {
	$status = $this->get_browser_contained_site_status( $input );
	if ( is_wp_error( $status ) ) {
		return $status;
	}

	$open_mode = (string) ( $status['open_mode'] ?? 'materialize' );
	$action    = match ( $open_mode ) {
		'reuse_current' => 'reuse-current',
		'reuse_live', 'reuse_materialized', 'reuse_prepared_runtime' => 'hydrate-ref',
		'unavailable' => 'reload-required',
		default => 'create-new',
	};
	$reload_required = in_array( $action, array( 'create-new', 'reload-required' ), true );
	$identity_key    = hash( 'sha256', implode( ':', array( (string) ( $status['site_id'] ?? '' ), (string) ( $status['source_digest']['value'] ?? '' ), $open_mode ) ) );

	return array_filter(
		array(
			'success'         => true,
			'schema'          => 'wp-codebox/preview-reuse-decision/v1',
			'action'          => $action,
			'decision'        => $action,
			'identity_key'    => $identity_key,
			'reload_required' => $reload_required,
			'site_id'         => (string) ( $status['site_id'] ?? '' ),
			'open_mode'       => $open_mode,
			'reuse_level'     => (string) ( $status['reuse_level'] ?? 'none' ),
			'requires_materialization' => true === ( $status['requires_materialization'] ?? false ),
			'prepared_runtime_recoverable' => true === ( $status['prepared_runtime_recoverable'] ?? false ),
			'live'            => true === ( $status['live'] ?? false ),
			'current'         => true === ( $status['current'] ?? false ),
			'materialized'    => true === ( $status['materialized'] ?? false ),
			'status'          => (string) ( $status['status'] ?? '' ),
			'reason'          => (string) ( $status['resolution']['reason'] ?? '' ),
			'resolution'      => is_array( $status['resolution'] ?? null ) ? $status['resolution'] : array(),
			'status_result'   => $status,
			'recovery'        => is_array( $status['recovery'] ?? null ) ? $status['recovery'] : array(),
			'recovery_handle' => (string) ( $status['recovery_handle'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function open_browser_contained_site( array $input ): array|WP_Error {
	$status = $this->get_browser_contained_site_status( $input );
	if ( is_wp_error( $status ) ) {
		return $status;
	}

	$contained_site = $this->browser_contained_site_public_input( is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array() );
	$session        = $this->browser_contained_site_open_session( $input, $contained_site, $status );
	$preview_boot   = WP_Codebox_Browser_Task_Builder::preview_boot_config( $session );
	$preview_lease  = WP_Codebox_Browser_Task_Builder::preview_lease( $session );
	$blueprint_ref  = is_array( $status['blueprint_ref'] ?? null ) ? $status['blueprint_ref'] : array();
	$boot_contract  = true === ( $status['success'] ?? false ) ? WP_Codebox_Browser_Task_Builder::validate_browser_preview_boot_contract( $preview_boot, $blueprint_ref ) : array( 'valid' => false, 'reason' => '' );
	$site_id        = (string) ( $status['site_id'] ?? $contained_site['site_id'] ?? $input['site_id'] ?? '' );
	$session_id     = (string) ( $session['session']['id'] ?? '' );
	$preview_id     = (string) ( $contained_site['preview_id'] ?? $input['preview_id'] ?? '' );
	$scope          = (string) ( $preview_boot['scope'] ?? $contained_site['preview']['scope'] ?? '' );
	$resolution     = is_array( $status['resolution'] ?? null ) ? $status['resolution'] : array();
	$open_status    = (string) ( $status['status'] ?? 'miss' );
	$open_success   = true === ( $status['success'] ?? false );
	$lifecycle      = $this->browser_contained_site_lifecycle( $open_status, $resolution );
	if ( $open_success && true !== ( $boot_contract['valid'] ?? false ) ) {
		$open_success = false;
		$open_status  = 'unusable';
		$resolution   = $this->browser_contained_site_resolution( $open_status, array( 'invalidation' => array( 'reason' => (string) ( $boot_contract['reason'] ?? 'preview-boot-contract-unusable' ) ) ) );
		$lifecycle    = $this->browser_contained_site_lifecycle( $open_status, $resolution );
	}
	$recovery        = $this->browser_contained_site_open_recovery( $site_id, (string) ( $status['source_digest']['value'] ?? '' ) );
	$recovery_handle = $this->browser_contained_site_recovery_handle( $site_id, (string) ( $status['source_digest']['value'] ?? '' ) );
	$digest_refs     = $this->browser_contained_site_digest_refs( $status );

	$opened_site = array_filter(
		array_merge(
			$contained_site,
			$lifecycle,
			$digest_refs,
			array(
				'schema'           => 'wp-codebox/browser-contained-site/v1',
				'site_id'          => $site_id,
				'preview_id'       => $preview_id,
				'session_id'       => $session_id,
				'status'           => $open_status,
				'resolution'       => $resolution,
				'persistence'      => 'browser-contained',
				'source_digest'    => is_array( $status['source_digest'] ?? null ) ? $status['source_digest'] : array(),
				'prepared_runtime' => is_array( $status['prepared_runtime'] ?? null ) ? $status['prepared_runtime'] : array(),
				'blueprint_ref'    => $blueprint_ref,
				'preview_boot'     => $preview_boot,
				'preview_lease'    => $preview_lease,
				'session'          => $this->browser_contained_site_session_identity( $session_id, $preview_id, $scope ),
				'recovery'         => $recovery,
				'recovery_handle'  => $recovery_handle,
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
	$session['contained_site'] = $opened_site;
	$preview_session          = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );

	return array_filter(
		array_merge(
			$lifecycle,
			$digest_refs,
			array(
				'success'       => $open_success,
				'schema'        => 'wp-codebox/browser-contained-site-open/v1',
				'site_id'       => $site_id,
				'status'        => $open_status,
				'resolution'    => $resolution,
				'contained_site' => $opened_site,
				'source_digest' => is_array( $status['source_digest'] ?? null ) ? $status['source_digest'] : array(),
				'prepared_runtime' => is_array( $status['prepared_runtime'] ?? null ) ? $status['prepared_runtime'] : array(),
				'blueprint_ref' => $blueprint_ref,
				'preview_boot'  => $preview_boot,
				'preview_lease' => $preview_lease,
				'preview_session' => $preview_session,
				'session'       => $this->browser_contained_site_session_identity( $session_id, $preview_id, $scope ),
				'recovery'      => $recovery,
				'recovery_handle' => $recovery_handle,
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function open_or_create_browser_contained_site( array $input ): array|WP_Error {
	$mode = $this->browser_contained_site_start_mode( $input );
	if ( is_wp_error( $mode ) ) {
		return $mode;
	}

	if ( 'prepare-new' === $mode ) {
		return $this->create_browser_contained_site_start_result( $input, array(), $mode );
	}

	$decision = $this->preview_reuse_decision( $input );
	if ( is_wp_error( $decision ) ) {
		return $decision;
	}
	$decision['mode'] = $mode;

	$action = (string) ( $decision['action'] ?? 'create-new' );
	if ( in_array( $action, array( 'reuse-current', 'hydrate-ref' ), true ) ) {
		$open = $this->open_browser_contained_site( $input );
		if ( is_wp_error( $open ) ) {
			return $open;
		}

		if ( true === ( $open['success'] ?? false ) ) {
			return array_filter(
				array(
					'success'         => true,
					'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
					'mode'            => $mode,
					'action'          => 'opened',
					'decision'        => $decision,
					'identity_key'    => (string) ( $decision['identity_key'] ?? '' ),
					'reload_required' => false,
					'open'            => $open,
					'contained_site'  => is_array( $open['contained_site'] ?? null ) ? $open['contained_site'] : array(),
					'preview_boot'    => is_array( $open['preview_boot'] ?? null ) ? $open['preview_boot'] : array(),
					'preview_lease'   => is_array( $open['preview_lease'] ?? null ) ? $open['preview_lease'] : array(),
					'preview_session' => is_array( $open['preview_session'] ?? null ) ? $open['preview_session'] : array(),
					'session'         => is_array( $open['session'] ?? null ) ? $open['session'] : array(),
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			);
		}
	}

	if ( 'open-only' === $mode ) {
		return array_filter(
			array(
				'success'         => false,
				'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
				'mode'            => $mode,
				'action'          => 'unavailable',
				'decision'        => $decision,
				'identity_key'    => (string) ( $decision['identity_key'] ?? '' ),
				'reload_required' => true,
				'error'           => array(
					'code'    => 'wp_codebox_browser_contained_site_unavailable',
					'message' => 'Browser contained site cannot be reused or recovered.',
				),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	return $this->create_browser_contained_site_start_result( $input, $decision, $mode );
}

public function browser_contained_site_start_mode( array $input ): string|WP_Error {
	$mode = trim( (string) ( $input['mode'] ?? '' ) );
	if ( '' === $mode ) {
		return new WP_Error( 'wp_codebox_browser_contained_site_mode_required', 'mode is required and must be one of open-only, open-or-create, or prepare-new.', array( 'status' => 400 ) );
	}

	if ( ! in_array( $mode, array( 'open-only', 'open-or-create', 'prepare-new' ), true ) ) {
		return new WP_Error( 'wp_codebox_browser_contained_site_mode_invalid', 'mode must be one of open-only, open-or-create, or prepare-new.', array( 'status' => 400, 'mode' => $mode ) );
	}

	return $mode;
}

public function create_browser_contained_site_start_result( array $input, array $decision, string $mode ): array|WP_Error {
	$created = $this->create_browser_playground_session( $input );
	if ( is_wp_error( $created ) ) {
		return $created;
	}

	return array_filter(
		array(
			'success'         => true === ( $created['success'] ?? false ),
			'schema'          => 'wp-codebox/browser-contained-site-open-or-create/v1',
			'mode'            => $mode,
			'action'          => true === ( $created['success'] ?? false ) ? 'created' : 'blocked',
			'decision'        => $decision,
			'identity_key'    => (string) ( $decision['identity_key'] ?? '' ),
			'reload_required' => true,
			'created'         => $created,
			'contained_site'  => is_array( $created['contained_site'] ?? null ) ? $created['contained_site'] : array(),
			'preview_boot'    => is_array( $created['preview_boot'] ?? null ) ? $created['preview_boot'] : array(),
			'preview_session' => is_array( $created['preview_session'] ?? null ) ? $created['preview_session'] : array(),
			'session'         => is_array( $created['session'] ?? null ) ? $created['session'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function create_browser_contained_site_session( array $input ): array|WP_Error {
	$created = $this->create_browser_playground_session( $input );
	if ( is_wp_error( $created ) ) {
		return $created;
	}

	return $this->browser_contained_site_facade_session( $created, 'created' );
}

public function boot_browser_contained_site_session( array $input ): array|WP_Error {
	$open = $this->open_browser_contained_site( $input );
	if ( is_wp_error( $open ) ) {
		return $open;
	}

	$session = $this->browser_contained_site_facade_session( $open, true === ( $open['success'] ?? false ) ? 'opened' : 'unavailable' );
	return array_filter(
		array(
			'success'             => true === ( $session['success'] ?? false ),
			'schema'              => 'wp-codebox/browser-contained-site-boot-result/v1',
			'action'              => (string) ( $session['action'] ?? '' ),
			'boot'                => is_array( $session['boot'] ?? null ) ? $session['boot'] : array(),
			'preview_lease'       => is_array( $session['preview_lease'] ?? null ) ? $session['preview_lease'] : array(),
			'contained_site'      => is_array( $session['contained_site'] ?? null ) ? $session['contained_site'] : array(),
			'startup_diagnostics' => is_array( $session['startup_diagnostics'] ?? null ) ? $session['startup_diagnostics'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function preview_boot_ref( array $input ): array|WP_Error {
	$boot_result = $this->boot_browser_contained_site_session( $input );
	if ( is_wp_error( $boot_result ) ) {
		return $boot_result;
	}

	$boot           = is_array( $boot_result['boot'] ?? null ) ? $boot_result['boot'] : array();
	$contained_site = is_array( $boot_result['contained_site'] ?? null ) ? $boot_result['contained_site'] : array();
	$preview_lease  = is_array( $boot_result['preview_lease'] ?? null ) ? $boot_result['preview_lease'] : array();
	$diagnostics    = is_array( $boot_result['startup_diagnostics'] ?? null ) ? $boot_result['startup_diagnostics'] : array();
	$blueprint_ref  = is_array( $boot['blueprint_ref'] ?? null ) ? $boot['blueprint_ref'] : array();
	$preview        = is_array( $boot['preview'] ?? null ) ? $boot['preview'] : $preview_lease;

	$stable_boot = array_filter(
		array(
			'schema'        => 'wp-codebox/browser-contained-site-boot/v1',
			'session_id'    => (string) ( $boot['session_id'] ?? '' ),
			'site_id'       => (string) ( $boot['site_id'] ?? '' ),
			'status'        => (string) ( $boot['status'] ?? '' ),
			'preview'       => $preview,
			'blueprint_ref' => $blueprint_ref,
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);

	return array_filter(
		array(
			'success'             => true === ( $boot_result['success'] ?? false ),
			'schema'              => 'wp-codebox/preview-boot-ref/v1',
			'boot'                => $stable_boot,
			'blueprint_ref'       => $blueprint_ref,
			'preview_lease'       => $preview_lease,
			'startup_diagnostics' => $diagnostics,
			'compatibility'       => array_filter(
				array(
					'contained_site_schema' => (string) ( $contained_site['schema'] ?? '' ),
					'session_result_schema' => (string) ( $boot_result['schema'] ?? '' ),
					'legacy_contained_site' => $contained_site,
					'legacy_session_result' => $boot_result,
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function destroy_browser_contained_site_session( array $input ): array|WP_Error {
	$contained_site = $this->browser_contained_site_public_input( is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array() );
	$site_id        = (string) ( $input['site_id'] ?? $contained_site['site_id'] ?? '' );
	$source_digest  = is_array( $input['source_digest'] ?? null ) ? (string) ( $input['source_digest']['value'] ?? '' ) : (string) ( $input['source_digest'] ?? $contained_site['source_digest']['value'] ?? '' );
	$preview_lease  = WP_Codebox_Browser_Task_Builder::preview_lease( array( 'preview_lease' => array_merge( is_array( $input['preview_lease'] ?? null ) ? $input['preview_lease'] : array(), array( 'status' => 'released' ) ) ) );
	if ( ! empty( $contained_site ) ) {
		$contained_site['status'] = 'destroyed';
	}

	$diagnostics = $this->browser_contained_site_startup_diagnostics(
		array_merge( $contained_site, array( 'status' => 'destroyed', 'recovery_handle' => $this->browser_contained_site_recovery_handle( $site_id, strtolower( trim( $source_digest ) ) ) ) ),
		array(),
		$preview_lease,
		array( 'valid' => false, 'reason' => 'contained-site-session-released' )
	);

	return array_filter(
		array(
			'success'             => true,
			'schema'              => 'wp-codebox/browser-contained-site-destroy/v1',
			'action'              => '' !== $site_id ? 'released' : 'noop',
			'contained_site'      => $contained_site,
			'preview_lease'       => $preview_lease,
			'startup_diagnostics' => $diagnostics,
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function blocked_browser_playground_session( string $session_id, array $input, array $task_input, array $ready_to_code, array $browser_plugins, array $runtime, array $artifacts, array $playground, array $blueprint, array $site_blueprint_artifact ): array {
	$prepared_runtime = is_array( $runtime['prepared_runtime'] ?? null ) ? $runtime['prepared_runtime'] : array();
	$contained_site   = $this->browser_contained_site_envelope( $input, $session_id, $playground, $runtime, $prepared_runtime, 'blocked' );

	return array(
		'success'          => false,
		'schema'           => 'wp-codebox/browser-playground-session/v1',
		'execution'        => 'browser-playground',
		'execution_scope'  => 'disposable-playground',
		'permission_model' => 'runtime-principal',
		'status'           => 'blocked',
		'error'            => array(
			'code'    => 'wp_codebox_browser_prerequisites_missing',
			'message' => 'Browser Playground sandbox is missing required coding prerequisites.',
			'missing' => $ready_to_code['missing'] ?? array(),
		),
		'session'          => $this->browser_session_envelope( $session_id, 'blocked', $input ),
		'task'             => (string) $task_input['goal'],
		'task_input' => $task_input,
		'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
		'plugins'    => $browser_plugins,
		'runtime'    => $runtime,
		'contained_site' => $contained_site,
		'site_blueprint_artifact' => $site_blueprint_artifact,
		'materialization' => array(
			'schema' => 'wp-codebox/browser-materialization/v1',
			'status' => 'blocked',
			'captures' => array(),
		),
		'playground' => array(
			'client_module_url'  => $playground['client_module_url'],
			'remote_url'         => $playground['remote_url'],
			'cors_proxy_url'     => $playground['cors_proxy_url'],
			'scope'              => (string) ( $playground['scope'] ?? $session_id ),
			'artifact_base_path' => $this->browser_artifact_base_path( $playground ),
			'artifact_base_url'  => $this->browser_artifact_base_url( $playground ),
			'preview_url'        => $this->browser_preview_url( $artifacts, $playground ),
			'blueprint'          => $this->browser_playground_blueprint( $blueprint, $playground ),
			'prepared_runtime'   => $prepared_runtime,
			'contained_site'     => $contained_site,
			'capabilities'       => array(
				'compile_blueprint' => true,
				'run_blueprint'     => true,
				'write_file'        => true,
				'run_php'           => true,
			),
			'provenance'         => $playground['provenance'],
		),
		'signals'    => array(
			'ready_to_code' => $ready_to_code,
		),
		'artifacts'  => array(
			'schema'             => 'wp-codebox/browser-artifacts/v1',
			'files'              => $artifacts,
			'preview_url'        => $this->browser_preview_url( $artifacts, $playground ),
			'expected_artifacts' => $task_input['expected_artifacts'],
		),
	);
}

public function browser_session_response_for_input( array $session, array $input ): array|WP_Error {
	$product_dto = WP_Codebox_Browser_Task_Builder::product_browser_session_dto( $session );
	if ( true === ( $product_dto['success'] ?? false ) && 'ready' === (string) ( $product_dto['status'] ?? '' ) ) {
		$boot_contract = WP_Codebox_Browser_Task_Builder::validate_browser_preview_boot_contract(
			is_array( $product_dto['preview_boot'] ?? null ) ? $product_dto['preview_boot'] : array(),
			is_array( $product_dto['blueprint_ref'] ?? null ) ? $product_dto['blueprint_ref'] : array()
		);
		if ( false === ( $boot_contract['valid'] ?? false ) ) {
			return new WP_Error(
				'wp_codebox_browser_preview_boot_contract_invalid',
				'Browser preview session is missing a hydratable blueprint ref.',
				array(
					'status'        => 500,
					'schema'        => 'wp-codebox/browser-preview-boot-contract-error/v1',
					'reason'        => (string) ( $boot_contract['reason'] ?? 'preview-boot-contract-invalid' ),
					'session_id'    => (string) ( $product_dto['session_id'] ?? '' ),
					'blueprint_ref' => is_array( $product_dto['blueprint_ref'] ?? null ) ? $product_dto['blueprint_ref'] : array(),
				)
			);
		}
	}
	$evidence_ref = $this->browser_session_evidence_store( $product_dto, $session );
	if ( ! empty( $evidence_ref ) ) {
		$product_dto['evidence_ref'] = $evidence_ref;
	}
	if ( $this->include_raw_browser_session_contract( $input, $session, $product_dto ) ) {
		$session['product'] = $product_dto;
		return $session;
	}

	return $product_dto;
}

public function browser_session_evidence_store( array $product_dto, array $session ): array {
	if ( ! function_exists( 'set_transient' ) ) {
		return array();
	}

	$session_id  = (string) ( $product_dto['session_id'] ?? '' );
	$evidence_id = 'browser-session-' . substr( hash( 'sha256', $session_id . wp_json_encode( $product_dto ) ), 0, 24 );
	$ttl         = max( 1, (int) apply_filters( 'wp_codebox_browser_session_evidence_ttl', WEEK_IN_SECONDS, $product_dto, $session ) );
	$evidence    = array_filter(
		array(
			'schema'            => 'wp-codebox/browser-session-evidence/v1',
			'id'                => $evidence_id,
			'created_at'        => gmdate( 'c' ),
			'session_id'        => $session_id,
			'preview_ref'       => is_array( $product_dto['preview_ref'] ?? null ) ? $product_dto['preview_ref'] : array(),
			'preview_reference' => is_array( $product_dto['preview_reference'] ?? null ) ? $product_dto['preview_reference'] : array(),
			'preview_lease'     => is_array( $product_dto['preview_lease'] ?? null ) ? $product_dto['preview_lease'] : array(),
			'preview_boot'      => is_array( $product_dto['preview_boot'] ?? null ) ? $product_dto['preview_boot'] : array(),
			'blueprint_ref'     => is_array( $product_dto['blueprint_ref'] ?? null ) ? $product_dto['blueprint_ref'] : array(),
			'contained_site'    => is_array( $product_dto['contained_site'] ?? null ) ? $product_dto['contained_site'] : array(),
			'signals'           => is_array( $product_dto['signals'] ?? null ) ? $product_dto['signals'] : array(),
		),
		static fn( mixed $value ): bool => '' !== $value && array() !== $value
	);

	if ( ! set_transient( 'wp_codebox_browser_session_evidence_' . $evidence_id, $evidence, $ttl ) ) {
		return array();
	}

	return array(
		'schema'  => 'wp-codebox/browser-session-evidence-ref/v1',
		'id'      => $evidence_id,
		'storage' => 'transient',
		'ttl'     => $ttl,
	);
}

public function include_raw_browser_session_contract( array $input, array $session, array $product_dto ): bool {
	$include = true === ( $input['include_internal_browser_session'] ?? false );
	if ( function_exists( 'apply_filters' ) ) {
		$include = (bool) apply_filters( 'wp_codebox_include_internal_browser_session_contract', $include, $input, $session, $product_dto );
	}

	return $include;
}

public function browser_contained_site_envelope( array $input, string $session_id, array $playground, array $runtime, array $prepared_runtime, string $status ): array {
	$source_digest = $this->browser_contained_site_source_digest( $input, $playground, $runtime, $prepared_runtime );
	$caller_id     = $this->browser_contained_site_caller_id( $input );
	$artifact_meta = $this->browser_contained_site_artifact_meta( $input );
	$cache_key     = $this->safe_key( (string) ( $prepared_runtime['cache_key'] ?? '' ) );
	if ( '' === $cache_key ) {
		$cache_key = 'site-' . substr( hash( 'sha256', $caller_id . ':' . $source_digest ), 0, 16 );
	}
	$site_id    = $cache_key;
	$preview_id = 'preview-' . substr( hash( 'sha256', $site_id . ':' . $session_id ), 0, 16 );

	return array_filter(
		array(
			'schema'        => 'wp-codebox/browser-contained-site/v1',
			'site_id'       => $site_id,
			'preview_id'    => $preview_id,
			'session_id'    => $session_id,
			'caller_id'     => $caller_id,
			'status'        => $status,
			'persistence'   => 'browser-contained',
			'artifact_seed' => (string) ( $artifact_meta['seed'] ?? '' ),
			'artifact_revision' => (string) ( $artifact_meta['revision'] ?? '' ),
			'recovery'      => array(
				'ability' => 'wp-codebox/get-browser-contained-site-status',
				'input'   => array(
					'cache_key'     => $cache_key,
					'input_hash'    => $source_digest,
					'source_digest' => $source_digest,
				),
			),
			'source_digest' => array(
				'algorithm' => 'sha256',
				'value'     => $source_digest,
			),
			'preview'       => array_filter(
				array(
					'preview_public_url' => (string) ( $playground['preview_public_url'] ?? '' ),
					'local_url'          => $this->browser_preview_url( array(), $playground ),
					'scope'              => (string) ( $playground['scope'] ?? $session_id ),
				),
				static fn( string $value ): bool => '' !== $value
			),
			'prepared_runtime' => array_filter(
				array(
					'cache_key'  => $cache_key,
					'input_hash' => $source_digest,
					'status'     => (string) ( $prepared_runtime['status'] ?? '' ),
					'selected'   => (string) ( $prepared_runtime['selected'] ?? '' ),
				),
				static fn( string $value ): bool => '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_artifact_meta( array $input ): array {
	$artifact = is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array();

	return array_filter(
		array(
			'seed'     => (string) ( $input['artifact_seed'] ?? $artifact['seed'] ?? $artifact['id'] ?? $artifact['ref'] ?? '' ),
			'revision' => (string) ( $input['artifact_revision'] ?? $input['revision'] ?? $artifact['revision'] ?? $artifact['version'] ?? '' ),
		),
		static fn( string $value ): bool => '' !== $value
	);
}

public function browser_contained_site_status_envelope( string $cache_key, string $input_hash, array $lookup ): array {
	$artifact = is_array( $lookup['artifact'] ?? null ) ? $lookup['artifact'] : array();
	$status     = $this->browser_contained_site_status_from_lookup( $lookup );
	$resolution = $this->browser_contained_site_resolution( $status, $lookup );
	$lifecycle  = $this->browser_contained_site_lifecycle( $status, $resolution );
	$digest_refs = $this->browser_contained_site_digest_refs( array_merge( $lookup, array( 'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ) ) ) );

	return array_filter(
		array_merge(
			$lifecycle,
			$digest_refs,
			array(
				'success'       => 'recoverable_prepared_runtime' === $status,
				'schema'        => 'wp-codebox/browser-contained-site-status/v1',
				'site_id'       => $cache_key,
				'status'        => $status,
				'resolution'    => $resolution,
				'source_digest' => array(
					'algorithm' => 'sha256',
					'value'     => $input_hash,
				),
				'prepared_runtime' => array_filter(
					array(
						'cache_key'  => $cache_key,
						'input_hash' => $input_hash,
						'status'     => (string) ( $lookup['status'] ?? '' ),
						'reason'     => (string) ( $resolution['reason'] ?? '' ),
						'created_at' => (string) ( $artifact['created_at'] ?? '' ),
					),
					static fn( string $value ): bool => '' !== $value
				),
				'blueprint_ref' => 'recoverable_prepared_runtime' === $status ? WP_Codebox_Browser_Task_Builder::browser_blueprint_ref( array( 'cache_key' => $cache_key, 'input_hash' => $input_hash, 'status' => 'recoverable_prepared_runtime' ) ) : array(),
				'recovery'      => $this->browser_contained_site_open_recovery( $cache_key, $input_hash ),
				'recovery_handle' => $this->browser_contained_site_recovery_handle( $cache_key, $input_hash ),
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_lifecycle( string $status, array $resolution ): array {
	$prepared_runtime_recoverable = true === ( $resolution['prepared_runtime_recoverable'] ?? false );
	$live                         = true === ( $resolution['live'] ?? false );
	$current                      = true === ( $resolution['current'] ?? false );
	$materialized                 = true === ( $resolution['materialized'] ?? false );
	$open_mode                    = 'materialize';
	$reuse_level                  = 'none';

	if ( $current ) {
		$open_mode   = 'reuse_current';
		$reuse_level = 'current';
	} elseif ( $live ) {
		$open_mode   = 'reuse_live';
		$reuse_level = 'live';
	} elseif ( $prepared_runtime_recoverable ) {
		$open_mode   = 'reuse_prepared_runtime';
		$reuse_level = 'prepared_runtime';
	} elseif ( $materialized ) {
		$open_mode   = 'reuse_materialized';
		$reuse_level = 'materialized';
	} elseif ( in_array( $status, array( 'disabled', 'incompatible', 'unusable' ), true ) ) {
		$open_mode = 'unavailable';
	}

	return array(
		'open_mode'                    => $open_mode,
		'reuse_level'                  => $reuse_level,
		'requires_materialization'     => ! ( $prepared_runtime_recoverable || $live || $current || $materialized ),
		'prepared_runtime_recoverable' => $prepared_runtime_recoverable,
		'live'                         => $live,
		'current'                      => $current,
		'materialized'                 => $materialized,
	);
}

public function browser_contained_site_digest_refs( array $input ): array {
	$artifact = is_array( $input['artifact'] ?? null ) ? $input['artifact'] : array();

	return array_filter(
		array(
			'source_digest'          => $this->browser_contained_site_digest_ref( $input['source_digest'] ?? $artifact['source_digest'] ?? $input['input_hash'] ?? '' ),
			'artifact_digest'        => $this->browser_contained_site_digest_ref( $artifact['artifact_digest'] ?? $input['artifact_digest'] ?? $artifact['digest'] ?? $artifact['sha256'] ?? '' ),
			'materialization_digest' => $this->browser_contained_site_digest_ref( $artifact['materialization_digest'] ?? $input['materialization_digest'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value
	);
}

public function browser_contained_site_digest_ref( mixed $value ): array {
	if ( is_array( $value ) ) {
		$digest    = strtolower( trim( (string) ( $value['value'] ?? $value['sha256'] ?? $value['hash'] ?? '' ) ) );
		$algorithm = (string) ( $value['algorithm'] ?? 'sha256' );
	} else {
		$digest    = strtolower( trim( (string) $value ) );
		$algorithm = 'sha256';
	}

	if ( ! preg_match( '/^[a-f0-9]{64}$/', $digest ) ) {
		return array();
	}

	return array(
		'algorithm' => $algorithm,
		'value'     => $digest,
	);
}

public function browser_contained_site_status_from_lookup( array $lookup ): string {
	$lookup_status = (string) ( $lookup['status'] ?? 'miss' );
	if ( 'hit' === $lookup_status ) {
		return 'recoverable_prepared_runtime';
	}

	if ( ! empty( $lookup['invalidation'] ) ) {
		return 'incompatible';
	}

	return '' !== $lookup_status ? $lookup_status : 'miss';
}

public function browser_contained_site_resolution( string $status, array $lookup ): array {
	$invalidation = is_array( $lookup['invalidation'] ?? null ) ? $lookup['invalidation'] : array();
	$reason       = (string) ( $invalidation['reason'] ?? '' );
	if ( '' === $reason ) {
		$reason = match ( $status ) {
			'recoverable_prepared_runtime' => 'prepared-runtime-cache-hit',
			'incompatible'  => 'prepared-runtime-incompatible',
			'disabled'      => 'prepared-runtime-cache-disabled',
			default         => 'prepared-runtime-not-found-or-expired',
		};
	}

	return array_filter(
		array(
			'schema'       => 'wp-codebox/browser-contained-site-resolution/v1',
			'outcome'      => $status,
			'reason'       => $reason,
			'recoverable'  => 'recoverable_prepared_runtime' === $status,
			'prepared_runtime_recoverable' => 'recoverable_prepared_runtime' === $status,
			'live'         => in_array( $status, array( 'current', 'live' ), true ),
			'current'      => 'current' === $status,
			'materialized' => in_array( $status, array( 'current', 'live', 'materialized' ), true ),
			'reused'       => false,
			'created'      => false,
			'expired'      => 'miss' === $status ? null : false,
			'miss'         => 'miss' === $status,
			'incompatible' => 'incompatible' === $status,
		),
		static fn( mixed $value ): bool => null !== $value && array() !== $value && '' !== $value
	);
}

public function browser_contained_site_open_session( array $input, array $contained_site, array $status ): array {
	$source_digest = (string) ( $status['source_digest']['value'] ?? '' );
	$session_id    = trim( (string) ( $input['session_id'] ?? $input['sandbox_session_id'] ?? $contained_site['session_id'] ?? '' ) );
	$site_id       = (string) ( $status['site_id'] ?? $contained_site['site_id'] ?? $input['site_id'] ?? '' );
	if ( '' === $session_id && '' !== $site_id ) {
		$session_id = 'contained-' . substr( hash( 'sha256', $site_id . ':' . $source_digest ), 0, 16 );
	}

	$preview    = is_array( $contained_site['preview'] ?? null ) ? $contained_site['preview'] : array();
	$playground = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
	$playground = array_merge(
		array_filter(
			array(
				'scope'              => (string) ( $preview['scope'] ?? $session_id ),
				'preview_public_url' => (string) ( $preview['preview_public_url'] ?? '' ),
				'preview_url'        => (string) ( $preview['local_url'] ?? '' ),
				'local_url'          => (string) ( $preview['local_url'] ?? '' ),
				'site_url'           => (string) ( $preview['site_url'] ?? '' ),
			),
			static fn( string $value ): bool => '' !== $value
		),
		$playground
	);
	$playground['prepared_runtime'] = array_filter(
		array(
			'cache_key'  => $site_id,
			'input_hash' => $source_digest,
			'status'     => (string) ( $status['status'] ?? '' ),
			'created_at' => (string) ( $status['prepared_runtime']['created_at'] ?? '' ),
		),
		static fn( string $value ): bool => '' !== $value
	);

	if ( is_array( $input['preview_lease'] ?? null ) ) {
		$playground['lease'] = $input['preview_lease'];
	}

	return array(
		'success'        => true === ( $status['success'] ?? false ),
		'schema'         => 'wp-codebox/browser-contained-site-open-session/v1',
		'status'         => (string) ( $status['status'] ?? '' ),
		'execution'      => 'browser-contained-site-open',
		'execution_scope' => 'browser-contained-site',
		'session'        => array_filter( array( 'id' => $session_id ), static fn( string $value ): bool => '' !== $value ),
		'session_id'     => $session_id,
		'playground'     => $playground,
		'contained_site' => $contained_site,
	);
}

public function browser_contained_site_public_input( array $contained_site ): array {
	return array_intersect_key(
		$contained_site,
		array(
			'schema'           => true,
			'site_id'          => true,
			'preview_id'       => true,
			'session_id'       => true,
			'caller_id'        => true,
			'status'           => true,
			'persistence'      => true,
			'recovery'         => true,
			'source_digest'    => true,
			'artifact_seed'    => true,
			'artifact_revision' => true,
			'preview'          => true,
			'prepared_runtime' => true,
			'resolution'       => true,
			'blueprint_ref'    => true,
		)
	);
}

public function browser_contained_site_session_identity( string $session_id, string $preview_id, string $scope ): array {
	return array_filter(
		array(
			'schema'     => 'wp-codebox/browser-session-identity/v1',
			'session_id' => $session_id,
			'preview_id' => $preview_id,
			'scope'      => $scope,
		),
		static fn( string $value ): bool => '' !== $value
	);
}

public function browser_contained_site_facade_session( array $result, string $action ): array {
	$contained_site = is_array( $result['contained_site'] ?? null ) ? $result['contained_site'] : array();
	$preview_boot   = is_array( $result['preview_boot'] ?? null ) ? $result['preview_boot'] : array();
	$preview_lease  = is_array( $result['preview_lease'] ?? null ) ? $result['preview_lease'] : WP_Codebox_Browser_Task_Builder::preview_lease( $result );
	$blueprint_ref  = is_array( $result['blueprint_ref'] ?? null ) ? $result['blueprint_ref'] : ( is_array( $preview_boot['blueprint_ref_dto'] ?? null ) ? $preview_boot['blueprint_ref_dto'] : array() );
	$boot_contract  = WP_Codebox_Browser_Task_Builder::validate_browser_preview_boot_contract( $preview_boot, $blueprint_ref );
	$boot           = $this->browser_contained_site_boot_descriptor( $result, $contained_site, $preview_boot, $preview_lease, $blueprint_ref );

	return array_filter(
		array(
			'success'             => true === ( $result['success'] ?? false ),
			'schema'              => 'wp-codebox/browser-contained-site-session/v1',
			'action'              => $action,
			'contained_site'      => $contained_site,
			'boot'                => $boot,
			'preview_lease'       => $preview_lease,
			'startup_diagnostics' => $this->browser_contained_site_startup_diagnostics( $result, $contained_site, $preview_lease, $boot_contract ),
			'session'             => is_array( $result['session'] ?? null ) ? $result['session'] : array(),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_boot_descriptor( array $result, array $contained_site, array $preview_boot, array $preview_lease, array $blueprint_ref ): array {
	return array_filter(
		array(
			'schema'         => 'wp-codebox/browser-contained-site-boot/v1',
			'session_id'     => (string) ( $result['session']['session_id'] ?? $result['session']['id'] ?? $preview_boot['session_id'] ?? '' ),
			'site_id'        => (string) ( $result['site_id'] ?? $contained_site['site_id'] ?? '' ),
			'status'         => (string) ( $result['status'] ?? $contained_site['status'] ?? '' ),
			'preview'        => $preview_lease,
			'contained_site' => $contained_site,
			'blueprint_ref'  => $blueprint_ref,
			'debug'          => array_filter(
				array(
					'preview_boot_schema' => (string) ( $preview_boot['schema'] ?? '' ),
					'preview_boot_ref'    => (string) ( $preview_boot['blueprint_ref'] ?? '' ),
				),
				static fn( string $value ): bool => '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_startup_diagnostics( array $result, array $contained_site, array $preview_lease, array $boot_contract ): array {
	return array_filter(
		array(
			'schema'               => 'wp-codebox/browser-contained-site-startup-diagnostics/v1',
			'status'               => (string) ( $result['status'] ?? $contained_site['status'] ?? 'unknown' ),
			'open_mode'            => (string) ( $result['open_mode'] ?? $contained_site['open_mode'] ?? '' ),
			'reuse_level'          => (string) ( $result['reuse_level'] ?? $contained_site['reuse_level'] ?? '' ),
			'preview_lease_status' => WP_Codebox_Browser_Task_Builder::preview_lease_status( $preview_lease ),
			'boot_contract'        => $boot_contract,
			'recovery_handle'      => (string) ( $result['recovery_handle'] ?? $contained_site['recovery_handle'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function validate_browser_contained_site_source( array $input, string $schema ): array {
	$contained_site = $this->browser_contained_site_public_input( is_array( $input['contained_site'] ?? null ) ? $input['contained_site'] : array() );
	$site_id        = $this->safe_key( (string) ( $input['site_id'] ?? $contained_site['site_id'] ?? '' ) );
	$input_digest   = $this->browser_contained_site_digest_ref( $input['source_digest'] ?? $input['input_hash'] ?? '' );
	$site_digest    = $this->browser_contained_site_digest_ref( $contained_site['source_digest'] ?? '' );
	$source_digest  = ! empty( $input_digest ) ? $input_digest : $site_digest;

	if ( '' === $site_id || empty( $source_digest ) ) {
		return $this->browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_ref_invalid', 'Browser contained site contracts require a contained site handle/site_id and a 64-character source digest.', array( 'site_id' => $site_id ), array( 'source_digest' => $input['source_digest'] ?? $input['input_hash'] ?? $contained_site['source_digest'] ?? null ) );
	}

	if ( ! empty( $site_digest ) && ! empty( $input_digest ) && (string) $site_digest['value'] !== (string) $input_digest['value'] ) {
		return $this->browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_stale_digest', 'Browser contained site source digest does not match the requested source digest.', $site_digest, $input_digest );
	}

	$session_id       = trim( (string) ( $input['session_id'] ?? $input['sandbox_session_id'] ?? '' ) );
	$site_session_id  = trim( (string) ( $contained_site['session_id'] ?? '' ) );
	if ( '' !== $session_id && '' !== $site_session_id && $session_id !== $site_session_id ) {
		return $this->browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_session_mismatch', 'Browser contained site session does not match the requested session.', array( 'session_id' => $site_session_id ), array( 'session_id' => $session_id ) );
	}

	$scope      = trim( (string) ( $input['scope'] ?? '' ) );
	$site_scope = trim( (string) ( $contained_site['preview']['scope'] ?? $contained_site['session']['scope'] ?? '' ) );
	if ( '' !== $scope && '' !== $site_scope && $scope !== $site_scope ) {
		return $this->browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_scope_mismatch', 'Browser contained site scope does not match the requested scope.', array( 'scope' => $site_scope ), array( 'scope' => $scope ) );
	}

	$status = $this->get_browser_contained_site_status(
		array(
			'site_id'       => $site_id,
			'source_digest' => $source_digest,
		)
	);
	if ( is_wp_error( $status ) ) {
		return $this->browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_ref_invalid', 'Browser contained site status could not be resolved.', array( 'site_id' => $site_id, 'source_digest' => $source_digest ), array() );
	}
	if ( 'incompatible' === (string) ( $status['status'] ?? '' ) ) {
		return $this->browser_contained_site_contract_error( $schema, 'wp_codebox_browser_contained_site_stale_digest', 'Browser contained site source digest is stale for the prepared runtime.', array( 'source_digest' => $source_digest ), array( 'status' => $status ) );
	}

	return array_filter(
		array(
			'success'        => true,
			'schema'         => $schema,
			'contained_site' => array_filter( array_merge( $contained_site, array( 'schema' => 'wp-codebox/browser-contained-site/v1', 'site_id' => $site_id, 'source_digest' => $source_digest ) ), static fn( mixed $value ): bool => array() !== $value && '' !== $value ),
			'source_digest'  => $source_digest,
			'session'        => $this->browser_contained_site_session_identity( '' !== $site_session_id ? $site_session_id : $session_id, (string) ( $contained_site['preview_id'] ?? '' ), '' !== $site_scope ? $site_scope : $scope ),
			'status'         => $status,
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_contract_error( string $schema, string $code, string $message, array $expected, array $actual ): array {
	return array_filter(
		array(
			'success' => false,
			'schema'  => $schema,
			'error'   => array_filter(
				array(
					'code'     => $code,
					'message'  => $message,
					'expected' => $expected,
					'actual'   => $actual,
				),
				static fn( mixed $value ): bool => array() !== $value && null !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_open_recovery( string $site_id, string $source_digest ): array {
	return array_filter(
		array(
			'ability' => 'wp-codebox/open-browser-contained-site',
			'input'   => array_filter(
				array(
					'site_id'       => $site_id,
					'source_digest' => $source_digest,
				),
				static fn( string $value ): bool => '' !== $value
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

public function browser_contained_site_recovery_handle( string $site_id, string $source_digest ): string {
	return '' !== $site_id && preg_match( '/^[a-f0-9]{64}$/', $source_digest ) ? 'browser-contained-site:' . $site_id . ':' . $source_digest : '';
}

public function browser_contained_site_source_digest( array $input, array $playground, array $runtime, array $prepared_runtime ): string {
	$input_hash = strtolower( trim( (string) ( $prepared_runtime['input_hash'] ?? '' ) ) );
	if ( preg_match( '/^[a-f0-9]{64}$/', $input_hash ) ) {
		return $input_hash;
	}

	$hash_input = array(
		'runtime'    => is_array( $runtime['prepared_runtime'] ?? null ) ? array_diff_key( $runtime, array( 'prepared_runtime' => true ) ) : $runtime,
		'blueprint'  => is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(),
		'site_blueprint_artifact' => is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array(),
		'playground' => array(
			'wp'  => (string) ( $playground['wp'] ?? $input['playground']['wp'] ?? 'latest' ),
			'php' => (string) ( $playground['php'] ?? $input['playground']['php'] ?? 'latest' ),
		),
	);

	return hash( 'sha256', 'wp-codebox/browser-contained-site-source/v1' . "\n" . $this->stable_json( $hash_input ) );
}

public function browser_contained_site_caller_id( array $input ): string {
	$authorization = is_array( $input['authorization'] ?? null ) ? $input['authorization'] : array();
	$orchestrator  = is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array();
	$caller_id     = $this->safe_key( (string) ( $authorization['caller'] ?? $orchestrator['id'] ?? $orchestrator['type'] ?? '' ) );

	return '' !== $caller_id ? $caller_id : 'wp-codebox';
}
}
