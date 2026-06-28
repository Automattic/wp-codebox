<?php
/**
 * Shared WordPress runtime primitives for workload execution.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Reusable safety and result-collection primitives for in-process WordPress workloads.
 */
final class WP_Codebox_WordPress_Runtime_Primitives {

	/** @param array<string,mixed> $args Args. @return array<string,mixed> */
	public static function external_http_guardrail( array $args ): array {
		$state  = is_array( $GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null ) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : array();
		$action = (string) ( $args['action'] ?? 'collect' );

		if ( 'install' === $action ) {
			$state = array(
				'allowlist' => self::normalize_allowlist( $args['allowlistDomains'] ?? $args['allowlist'] ?? array() ),
				'block'     => filter_var( $args['blockNetwork'] ?? $args['block_network'] ?? true, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE ) ?? true,
				'requests'  => array(),
			);
			$GLOBALS['wp_codebox_external_http_guardrail_state'] = $state;
			if ( empty( $GLOBALS['wp_codebox_external_http_guardrail_filter_installed'] ) && function_exists( 'add_filter' ) ) {
				add_filter( 'pre_http_request', 'wp_codebox_external_http_guardrail_pre_http_request', 10, 3 );
				$GLOBALS['wp_codebox_external_http_guardrail_filter_installed'] = true;
			}
		}

		$state    = is_array( $GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null ) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : $state;
		$requests = is_array( $state['requests'] ?? null ) ? $state['requests'] : array();
		$blocked  = count( array_filter( $requests, static fn( array $request ): bool => 'blocked' === ( $request['classification'] ?? '' ) ) );
		$allowed  = count( array_filter( $requests, static fn( array $request ): bool => in_array( (string) ( $request['classification'] ?? '' ), array( 'allowlisted', 'internal' ), true ) ) );

		return array(
			'schema'   => 'wp-codebox/external-http-guardrail/v1',
			'status'   => 'passed',
			'summary'  => array( 'total' => count( $requests ), 'blocked' => $blocked, 'allowlisted' => $allowed ),
			'requests' => $requests,
			'metadata' => array(
				'runner'    => 'wp-codebox/wordpress-runtime-primitives/v1',
				'allowlist' => array_values( array_map( 'strval', $state['allowlist'] ?? array() ) ),
				'block'     => (bool) ( $state['block'] ?? true ),
			),
		);
	}

	/** @param false|array|WP_Error $preempt Preempt. @param array<string,mixed> $parsed_args Parsed args. */
	public static function external_http_guardrail_pre_http_request( mixed $preempt, array $parsed_args, string $url ): mixed {
		$state = is_array( $GLOBALS['wp_codebox_external_http_guardrail_state'] ?? null ) ? $GLOBALS['wp_codebox_external_http_guardrail_state'] : array();
		$host  = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		if ( '' === $host ) {
			return $preempt;
		}

		$allowlist      = array_map( 'strtolower', array_map( 'strval', is_array( $state['allowlist'] ?? null ) ? $state['allowlist'] : array() ) );
		$is_internal    = self::is_internal_host( $host );
		$is_allowlisted = ! $is_internal && self::host_matches_allowlist( $host, $allowlist );
		$classification = $is_internal ? 'internal' : ( $is_allowlisted ? 'allowlisted' : 'blocked' );

		$state['requests'][] = array_filter(
			array(
				'url'            => self::redact_url( $url ),
				'host'           => $host,
				'method'         => strtoupper( (string) ( $parsed_args['method'] ?? 'GET' ) ),
				'classification' => $classification,
				'headers'        => self::redact_headers( is_array( $parsed_args['headers'] ?? null ) ? $parsed_args['headers'] : array() ),
			),
			static fn( mixed $value ): bool => ! ( is_array( $value ) && empty( $value ) ) && '' !== $value
		);
		$GLOBALS['wp_codebox_external_http_guardrail_state'] = $state;

		if ( 'blocked' === $classification && ( $state['block'] ?? true ) ) {
			return new WP_Error( 'wp_codebox_external_http_guardrail_blocked', 'External HTTP request blocked by WP Codebox fuzz guardrail.', array( 'host' => $host, 'classification' => $classification ) );
		}

		return $preempt;
	}

	/** @param array<string,mixed> $args Args. @param array<int,array<string,mixed>> $prior_steps Steps. @param array<int,array<string,mixed>> $artifact_refs Artifact refs. @return array<string,mixed> */
	public static function collect_workload_result( array $args, array $prior_steps, array $artifact_refs = array() ): array {
		$name    = (string) ( $args['artifact'] ?? $args['name'] ?? '' );
		$command = (string) ( $args['command'] ?? '' );
		$status  = (string) ( $args['status'] ?? '' );

		$matched_steps = array_values(
			array_filter(
				$prior_steps,
				static function ( mixed $step ) use ( $name, $command, $status ): bool {
					if ( ! is_array( $step ) ) {
						return false;
					}
					if ( '' !== $command && (string) ( $step['command'] ?? '' ) !== $command ) {
						return false;
					}
					if ( '' !== $status && (string) ( $step['status'] ?? '' ) !== $status ) {
						return false;
					}
					if ( '' === $name ) {
						return true;
					}
					foreach ( is_array( $step['artifactRefs'] ?? null ) ? $step['artifactRefs'] : array() as $ref ) {
						if ( is_array( $ref ) && self::artifact_matches_name( $ref, $name ) ) {
							return true;
						}
					}
					$observation = is_array( $step['observation'] ?? null ) ? $step['observation'] : array();
					return $name === (string) ( $observation['artifact'] ?? $observation['name'] ?? '' );
				}
			)
		);

		$matched_refs = array();
		foreach ( $matched_steps as $step ) {
			foreach ( is_array( $step['artifactRefs'] ?? null ) ? $step['artifactRefs'] : array() as $ref ) {
				if ( is_array( $ref ) && ( '' === $name || self::artifact_matches_name( $ref, $name ) ) ) {
					$matched_refs[] = $ref;
				}
			}
		}
		$matched_refs = array_merge( $matched_refs, array_values( array_filter( $artifact_refs, static fn( mixed $ref ): bool => is_array( $ref ) && ( '' === $name || self::artifact_matches_name( $ref, $name ) ) ) ) );
		$matched_refs = self::dedupe_artifact_refs( $matched_refs );
		$payload      = array(
			'schema'      => 'wp-codebox/wordpress-workload-result-collection/v1',
			'generatedAt' => gmdate( 'Y-m-d\TH:i:s\Z' ),
			'query'       => array_filter( array( 'artifact' => $name, 'command' => $command, 'status' => $status ), static fn( mixed $value ): bool => '' !== $value ),
			'summary'     => array( 'steps' => count( $matched_steps ), 'artifactRefs' => count( $matched_refs ) ),
			'steps'       => $matched_steps,
			'artifactRefs'=> $matched_refs,
		);

		$collection_name = '' === $name ? 'workload-result' : $name;
		$collection_ref  = array(
			'name'        => $collection_name,
			'kind'        => 'wordpress-workload-result-collection',
			'path'        => 'files/workload-results/' . self::safe_key( $collection_name ) . '.json',
			'contentType' => 'application/json',
			'payload'     => $payload,
		);

		return array( 'payload' => $payload, 'artifactRefs' => array_values( array_merge( $matched_refs, array( $collection_ref ) ) ) );
	}

	/** @param mixed $value Value. @return string[] */
	private static function normalize_allowlist( mixed $value ): array {
		$items = is_array( $value ) ? $value : explode( ',', (string) $value );
		return array_values( array_unique( array_filter( array_map( static fn( mixed $item ): string => strtolower( trim( (string) $item ) ), $items ), static fn( string $item ): bool => '' !== $item ) ) );
	}

	/** @param string[] $allowlist Allowlist. */
	private static function host_matches_allowlist( string $host, array $allowlist ): bool {
		foreach ( $allowlist as $allowed ) {
			if ( $host === $allowed || str_ends_with( $host, '.' . ltrim( $allowed, '.' ) ) ) {
				return true;
			}
		}
		return false;
	}

	private static function is_internal_host( string $host ): bool {
		$internal = array( 'localhost', '127.0.0.1', '::1' );
		if ( function_exists( 'home_url' ) ) {
			$home_host = strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) );
			if ( '' !== $home_host ) {
				$internal[] = $home_host;
			}
		}
		return in_array( $host, array_unique( $internal ), true );
	}

	private static function redact_url( string $url ): string {
		return preg_replace( '/([?&][^=]*(?:token|secret|nonce|_wpnonce|authorization|password|passwd|pwd|key|signature|sig)[^=]*=)[^&#]+/i', '$1[redacted]', $url ) ?? $url;
	}

	private static function safe_key( string $value ): string {
		if ( function_exists( 'sanitize_key' ) ) {
			$key = sanitize_key( $value );
			return '' === $key ? 'result' : $key;
		}
		$key = strtolower( preg_replace( '/[^a-zA-Z0-9_-]+/', '-', $value ) ?? '' );
		$key = trim( $key, '-' );
		return '' === $key ? 'result' : $key;
	}

	/** @param array<string,mixed> $headers Headers. @return array<string,string> */
	private static function redact_headers( array $headers ): array {
		$out = array();
		foreach ( $headers as $name => $value ) {
			$header = (string) $name;
			$out[ $header ] = preg_match( '/authorization|cookie|token|secret|nonce|api[-_]?key|x-wp-nonce/i', $header ) ? '[redacted]' : (string) ( is_array( $value ) ? implode( ', ', array_map( 'strval', $value ) ) : $value );
		}
		return $out;
	}

	/** @param array<string,mixed> $artifact Artifact ref. */
	private static function artifact_matches_name( array $artifact, string $name ): bool {
		return $name === (string) ( $artifact['name'] ?? $artifact['artifact'] ?? $artifact['id'] ?? '' );
	}

	/** @param array<int,array<string,mixed>> $refs Refs. @return array<int,array<string,mixed>> */
	private static function dedupe_artifact_refs( array $refs ): array {
		$seen = array();
		$out  = array();
		foreach ( $refs as $ref ) {
			$key = (string) ( $ref['name'] ?? $ref['artifact'] ?? '' ) . '|' . (string) ( $ref['path'] ?? '' );
			if ( isset( $seen[ $key ] ) ) {
				continue;
			}
			$seen[ $key ] = true;
			$out[]        = $ref;
		}
		return $out;
	}
}

if ( ! function_exists( 'wp_codebox_bench_run_external_http_guardrail_step' ) ) {
	/** @param array<string,mixed> $args Args. @return array<string,mixed> */
	function wp_codebox_bench_run_external_http_guardrail_step( array $args ): array {
		return WP_Codebox_WordPress_Runtime_Primitives::external_http_guardrail( $args );
	}
}

if ( ! function_exists( 'wp_codebox_external_http_guardrail_pre_http_request' ) ) {
	/** @param false|array|WP_Error $preempt Preempt. @param array<string,mixed> $parsed_args Parsed args. */
	function wp_codebox_external_http_guardrail_pre_http_request( mixed $preempt, array $parsed_args, string $url ): mixed {
		return WP_Codebox_WordPress_Runtime_Primitives::external_http_guardrail_pre_http_request( $preempt, $parsed_args, $url );
	}
}
