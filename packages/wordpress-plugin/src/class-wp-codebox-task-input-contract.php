<?php
/**
 * Canonical WP Codebox task input contract.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Task_Input_Contract {

	public const SCHEMA  = 'wp-codebox/task-input/v1';
	public const VERSION = 1;
	public const ABILITY_ALIAS_FIELDS = array( 'goal', 'target', 'allowed_tools', 'tool_bridge', 'sandbox_tool_policy', 'expected_artifacts', 'structured_artifacts', 'policy', 'context' );

	/** @return array<string,mixed> */
	public static function schema(): array {
		return array(
			'$id'        => self::SCHEMA,
			'type'       => 'object',
			'required'   => array( 'schema', 'version', 'goal', 'target', 'allowed_tools', 'expected_artifacts', 'structured_artifacts', 'agent_bundles', 'tool_bridge', 'sandbox_tool_policy', 'policy', 'context' ),
			'properties' => array(
				'schema'             => array(
					'type'        => 'string',
					'const'       => self::SCHEMA,
					'description' => 'Task input contract schema id.',
				),
				'version'            => array(
					'type'        => 'integer',
					'const'       => self::VERSION,
					'description' => 'Task input contract version.',
				),
				'goal'               => array(
					'type'        => 'string',
					'description' => 'User-facing outcome the sandboxed coding agent should accomplish.',
				),
				'target'             => array(
					'type'        => 'object',
					'description' => 'Bounded target for the task, such as a repo, site, plugin, or theme.',
					'properties'  => array(
						'kind' => array( 'type' => 'string' ),
						'ref'  => array( 'type' => 'string' ),
						'path' => array( 'type' => 'string' ),
						'url'  => array( 'type' => 'string' ),
					),
				),
				'allowed_tools'      => array(
					'type'        => 'array',
					'description' => 'Tool names the product caller expects the sandboxed agent to stay within.',
					'items'       => array( 'type' => 'string' ),
				),
				'expected_artifacts' => array(
					'type'        => 'array',
					'description' => 'Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.',
					'items'       => array( 'type' => 'string' ),
				),
				'structured_artifacts' => array(
					'type'        => 'array',
					'description' => 'Named JSON artifacts supplied by the caller as typed task inputs.',
					'items'       => array(
						'type'       => 'object',
						'required'   => array( 'schema', 'name', 'type', 'payload', 'metadata', 'provenance' ),
						'properties' => array(
							'schema'         => array( 'const' => 'wp-codebox/structured-artifact/v1' ),
							'name'           => array( 'type' => 'string' ),
							'type'           => array( 'type' => 'string' ),
							'payload_schema' => array( 'anyOf' => array( array( 'type' => 'string' ), array( 'type' => 'object' ) ) ),
							'payload'        => (object) array(),
							'metadata'       => array( 'type' => 'object' ),
							'provenance'     => array( 'type' => 'object' ),
						),
					),
				),
				'agent_bundles'      => array(
					'type'        => 'array',
					'description' => 'Runtime agent bundles to import into the disposable sandbox before invoking the selected runtime agent.',
					'items'       => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'required' => array( 'source' ) ),
							array( 'required' => array( 'bundle' ) ),
						),
						'properties' => array(
							'source'      => array( 'type' => 'string' ),
							'bundle'      => array( 'type' => 'object' ),
							'slug'        => array( 'type' => 'string' ),
							'on_conflict' => array( 'enum' => array( 'error', 'skip', 'upgrade' ) ),
							'owner_id'    => array( 'type' => 'integer', 'minimum' => 1 ),
							'token_env'   => array( 'type' => 'string' ),
							'import_principal' => array(
								'type'       => 'object',
								'properties' => array(
									'agent_id'      => array( 'type' => 'integer', 'minimum' => 1 ),
									'owner_id'      => array( 'type' => 'integer', 'minimum' => 1 ),
									'token_id'      => array( 'type' => 'integer', 'minimum' => 1 ),
									'capabilities'  => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
									'scope'         => array( 'type' => 'object' ),
								),
							),
						),
					),
				),
				'sandbox_tool_policy' => array(
					'type'        => 'object',
					'description' => 'Resolved sandbox tool policy snapshot carried by the WP Codebox tool bridge.',
				),
				'tool_bridge'         => array(
					'type'        => 'object',
					'description' => 'WP Codebox-owned tool bridge envelope with allowlisted tools, dispatcher metadata, authorization notes, redaction notes, and sandbox_tool_policy.',
				),
				'policy'             => array(
					'type'        => 'object',
					'description' => 'Caller policy hints for approvals, apply-back, sandboxing, and risk controls.',
				),
				'context'            => array(
					'type'        => 'object',
					'description' => 'Additional non-secret caller context for the sandboxed task.',
				),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function normalize( array $input ): array|WP_Error {
		$goal = trim( (string) ( $input['goal'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_task_missing', 'goal is required.', array( 'status' => 400 ) );
		}

		return array(
			'schema'             => self::SCHEMA,
			'version'            => self::VERSION,
			'goal'               => $goal,
			'target'             => is_array( $input['target'] ?? null ) ? $input['target'] : array(),
			'allowed_tools'      => self::string_list( $input['allowed_tools'] ?? array() ),
			'expected_artifacts' => self::string_list( $input['expected_artifacts'] ?? array() ),
			'structured_artifacts' => self::structured_artifacts( $input['structured_artifacts'] ?? array() ),
			'agent_bundles'      => self::agent_bundles( $input['agent_bundles'] ?? array() ),
			'tool_bridge'        => is_array( $input['tool_bridge'] ?? null ) ? $input['tool_bridge'] : array(),
			'sandbox_tool_policy' => is_array( $input['sandbox_tool_policy'] ?? null ) ? $input['sandbox_tool_policy'] : array(),
			'policy'             => is_array( $input['policy'] ?? null ) ? $input['policy'] : array(),
			'context'            => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
		);
	}

	/** @return array<int,array<string,mixed>> */
	private static function structured_artifacts( mixed $value ): array {
		$artifacts = array();
		foreach ( is_array( $value ) ? $value : array() as $entry ) {
			if ( ! is_array( $entry ) ) {
				continue;
			}

			$name = isset( $entry['name'] ) ? trim( (string) $entry['name'] ) : '';
			$type = isset( $entry['type'] ) ? trim( (string) $entry['type'] ) : '';
			if ( '' === $name || '' === $type ) {
				continue;
			}

			$artifact = array(
				'schema'     => 'wp-codebox/structured-artifact/v1',
				'name'       => $name,
				'type'       => $type,
				'payload'    => $entry['payload'] ?? null,
				'metadata'   => is_array( $entry['metadata'] ?? null ) ? $entry['metadata'] : array(),
				'provenance' => array_merge(
					is_array( $entry['provenance'] ?? null ) ? $entry['provenance'] : array(),
					array( 'direction' => 'input' )
				),
			);

			$payload_schema = self::structured_payload_schema( $entry['payload_schema'] ?? $entry['payloadSchema'] ?? $entry['artifact_schema'] ?? $entry['artifactSchema'] ?? null );
			if ( null !== $payload_schema ) {
				$artifact['payload_schema'] = $payload_schema;
			}
			if ( isset( $artifact['provenance']['source'] ) ) {
				$source = trim( (string) $artifact['provenance']['source'] );
				if ( '' !== $source ) {
					$artifact['provenance']['source'] = $source;
				} else {
					unset( $artifact['provenance']['source'] );
				}
			}

			$artifacts[] = $artifact;
		}

		return $artifacts;
	}

	private static function structured_payload_schema( mixed $value ): mixed {
		if ( is_string( $value ) ) {
			$value = trim( $value );
			return '' !== $value ? $value : null;
		}

		return is_array( $value ) ? $value : null;
	}

	/** @return array<int,array<string,mixed>> */
	private static function agent_bundles( mixed $value ): array {
		$bundles = array();
		foreach ( is_array( $value ) ? $value : array() as $entry ) {
			if ( ! is_array( $entry ) ) {
				continue;
			}
			$source = isset( $entry['source'] ) ? trim( (string) $entry['source'] ) : '';
			$inline = is_array( $entry['bundle'] ?? null ) ? $entry['bundle'] : null;
			if ( '' === $source && null === $inline ) {
				continue;
			}
			$bundle = array();
			if ( '' !== $source ) {
				$bundle['source'] = $source;
			}
			if ( null !== $inline ) {
				$bundle['bundle'] = $inline;
			}
			foreach ( array( 'slug', 'token_env' ) as $field ) {
				$value = isset( $entry[ $field ] ) ? trim( (string) $entry[ $field ] ) : '';
				if ( '' !== $value ) {
					$bundle[ $field ] = $value;
				}
			}
			$on_conflict = (string) ( $entry['on_conflict'] ?? 'upgrade' );
			$bundle['on_conflict'] = in_array( $on_conflict, array( 'error', 'skip', 'upgrade' ), true ) ? $on_conflict : 'upgrade';
			if ( isset( $entry['owner_id'] ) && (int) $entry['owner_id'] > 0 ) {
				$bundle['owner_id'] = (int) $entry['owner_id'];
			}
			if ( is_array( $entry['import_principal'] ?? null ) ) {
				$bundle['import_principal'] = self::import_principal( $entry['import_principal'] );
			}
			$bundles[] = $bundle;
		}

		return $bundles;
	}

	/** @param array<string,mixed> $principal Raw import principal. @return array<string,mixed> */
	private static function import_principal( array $principal ): array {
		$normalized = array();
		foreach ( array( 'agent_id', 'owner_id', 'token_id' ) as $field ) {
			if ( isset( $principal[ $field ] ) && (int) $principal[ $field ] > 0 ) {
				$normalized[ $field ] = (int) $principal[ $field ];
			}
		}

		$capabilities = self::string_list( $principal['capabilities'] ?? array() );
		if ( ! empty( $capabilities ) ) {
			$normalized['capabilities'] = $capabilities;
		}
		if ( is_array( $principal['scope'] ?? null ) ) {
			$normalized['scope'] = $principal['scope'];
		}

		return $normalized;
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$items = array();
		foreach ( $value as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}
}
