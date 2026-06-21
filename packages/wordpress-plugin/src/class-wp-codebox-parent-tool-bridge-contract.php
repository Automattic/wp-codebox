<?php
/**
 * Parent tool bridge contract constants and schema helpers.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Parent_Tool_Bridge_Contract {

	public const BRIDGE_SCHEMA  = 'wp-codebox/parent-tool-bridge/v1';
	public const BRIDGE_VERSION = 1;
	public const REQUEST_SCHEMA = 'wp-codebox/parent-tool-request/v1';
	public const REQUEST_VERSION = 1;
	public const RESULT_SCHEMA  = 'wp-codebox/parent-tool-result/v1';
	public const RESULT_VERSION = 1;

	/** @return array<string,mixed> */
	public static function bridge_schema(): array {
		return array(
			'$id'        => self::BRIDGE_SCHEMA,
			'type'       => 'object',
			'required'   => array( 'schema', 'version', 'allowed_tools', 'dispatcher', 'sandbox_env', 'authorization', 'redaction', 'metadata' ),
			'properties' => array(
				'schema'        => array( 'type' => 'string', 'const' => self::BRIDGE_SCHEMA ),
				'version'       => array( 'type' => 'integer', 'const' => self::BRIDGE_VERSION ),
				'allowed_tools' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'dispatcher'    => array(
					'type'       => 'object',
					'required'   => array( 'owner', 'mode', 'request_schema', 'result_schema' ),
					'properties' => array(
						'owner'          => array( 'type' => 'string', 'const' => 'wp-codebox' ),
						'mode'           => array( 'type' => 'string', 'enum' => array( 'host_endpoint', 'host_command' ) ),
						'endpoint'       => array( 'type' => 'object' ),
						'command'        => array( 'type' => 'object' ),
						'request_schema' => array( 'type' => 'string', 'const' => self::REQUEST_SCHEMA ),
						'result_schema'  => array( 'type' => 'string', 'const' => self::RESULT_SCHEMA ),
						'timeout_ms'     => array( 'type' => 'integer', 'minimum' => 1 ),
					),
				),
				'sandbox_env'   => array( 'type' => 'object' ),
				'authorization' => array( 'type' => 'object' ),
				'redaction'     => array( 'type' => 'object' ),
				'metadata'      => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	public static function request_schema(): array {
		return array(
			'$id'        => self::REQUEST_SCHEMA,
			'type'       => 'object',
			'required'   => array( 'schema', 'version', 'request_id', 'tool', 'operation', 'input', 'sandbox_session', 'authorization', 'metadata' ),
			'properties' => array(
				'schema'          => array( 'type' => 'string', 'const' => self::REQUEST_SCHEMA ),
				'version'         => array( 'type' => 'integer', 'const' => self::REQUEST_VERSION ),
				'request_id'      => array( 'type' => 'string' ),
				'tool'            => array( 'type' => 'string' ),
				'operation'       => array( 'type' => 'string' ),
				'input'           => (object) array(),
				'sandbox_session' => array( 'type' => 'object' ),
				'authorization'   => array( 'type' => 'object' ),
				'metadata'        => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	public static function result_schema(): array {
		return array(
			'$id'        => self::RESULT_SCHEMA,
			'type'       => 'object',
			'required'   => array( 'schema', 'version', 'request_id', 'tool', 'operation', 'status', 'artifacts', 'diagnostics', 'metadata' ),
			'properties' => array(
				'schema'      => array( 'type' => 'string', 'const' => self::RESULT_SCHEMA ),
				'version'     => array( 'type' => 'integer', 'const' => self::RESULT_VERSION ),
				'request_id'  => array( 'type' => 'string' ),
				'tool'        => array( 'type' => 'string' ),
				'operation'   => array( 'type' => 'string' ),
				'status'      => array( 'type' => 'string', 'enum' => array( 'succeeded', 'failed', 'denied', 'unavailable', 'timeout' ) ),
				'output'      => (object) array(),
				'error'       => array( 'type' => 'object' ),
				'artifacts'   => array( 'type' => 'object' ),
				'diagnostics' => array( 'type' => 'object' ),
				'metadata'    => array( 'type' => 'object' ),
			),
		);
	}
}
