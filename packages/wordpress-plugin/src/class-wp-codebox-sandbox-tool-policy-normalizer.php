<?php
/**
 * Sandbox tool policy normalization.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Sandbox_Tool_Policy_Normalizer {

	public const SCHEMA  = 'wp-codebox/sandbox-tool-policy/v1';
	public const VERSION = 1;
	public const TOOL_BRIDGE_SCHEMA  = 'wp-codebox/tool-bridge/v1';
	public const TOOL_BRIDGE_VERSION = 1;

	private const TOOL_DENIAL_SCHEMA = 'wp-codebox/tool-allowlist-denial/v1';
	private const AGENTS_API_RUNTIME_ENVIRONMENT = 'environment';
	private const AGENTS_API_RUNTIME_CAPABILITY_SCOPE = 'capability_scope';
	private const AGENTS_API_RUNTIME_LOCAL = 'runtime_local';

	private WP_Codebox_Runtime_Tool_Policy_Descriptor $descriptor_resolver;

	public function __construct() {
		$this->descriptor_resolver = new WP_Codebox_Runtime_Tool_Policy_Descriptor();
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function normalize_for_task_input( array $input ): array|WP_Error {
		$policy = is_array( $input['sandbox_tool_policy'] ?? null ) ? $input['sandbox_tool_policy'] : array();
		$bridge = is_array( $input['tool_bridge'] ?? null ) ? $input['tool_bridge'] : array();
		if ( empty( $policy ) && ! empty( $bridge ) ) {
			$policy = $this->policy_from_tool_bridge( $bridge );
		}
		if ( empty( $policy ) && function_exists( 'apply_filters' ) ) {
			$bridge = apply_filters( 'wp_codebox_tool_bridge', array(), WP_Codebox_Agent_Task::string_list( $input['allowed_tools'] ?? array() ), $input );
			if ( is_array( $bridge ) ) {
				$policy = $this->policy_from_tool_bridge( $bridge );
			}
		}
		if ( empty( $policy ) ) {
			$policy = $this->from_allowed_tools( WP_Codebox_Agent_Task::string_list( $input['allowed_tools'] ?? array() ), $input );
		}
		if ( empty( $policy ) && function_exists( 'apply_filters' ) ) {
			$policy = apply_filters( 'wp_codebox_resolved_sandbox_tool_policy', $policy, $input );
		}

		$issues = $this->policy_issues( is_array( $policy ) ? $policy : array() );
		if ( ! empty( $issues ) ) {
			return new WP_Error(
				'wp_codebox_sandbox_tool_policy_invalid',
				'Allowed tools require a valid resolved sandbox_tool_policy snapshot.',
				array(
					'status' => 400,
					'schema' => 'wp-codebox/sandbox-tool-policy-validation/v1',
					'issues' => $issues,
				)
			);
		}

		return $policy;
	}

	/** @param string[] $allowed_tools @param array<string,mixed> $context @return array<string,mixed> */
	public function tool_bridge_from_allowed_tools( array $allowed_tools, array $context = array() ): array {
		$policy = $this->from_allowed_tools( $allowed_tools, $context );
		if ( empty( $policy ) ) {
			return array();
		}

		return $this->tool_bridge_from_policy( $allowed_tools, $policy, $context );
	}

	/** @param string[] $allowed_tools @param array<string,mixed> $policy @param array<string,mixed> $context @return array<string,mixed> */
	public function tool_bridge_from_policy( array $allowed_tools, array $policy, array $context = array() ): array {
		if ( empty( $policy ) ) {
			return array();
		}

		$bridge = array(
			'schema'              => self::TOOL_BRIDGE_SCHEMA,
			'version'             => self::TOOL_BRIDGE_VERSION,
			'allowed_tools'       => WP_Codebox_Agent_Task::string_list( $allowed_tools ),
			'sandbox_tool_policy' => $policy,
			'dispatcher'          => array(
				'owner'    => 'wp-codebox',
				'callback' => 'wp_codebox_browser_runtime_tool_callback',
				'location' => 'sandbox',
			),
			'authorization'       => array(
				'mode'  => 'allowlist',
				'notes' => 'Only sandbox-visible tools in sandbox_tool_policy are exposed to the runtime agent. Parent control-plane actions remain outside the sandbox bridge.',
			),
			'redaction'           => array(
				'notes' => 'Secret values are passed through environment allowlists only and must not be embedded in tool bridge payloads, logs, or dispatcher metadata.',
			),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_resolved_tool_bridge', $bridge, $allowed_tools, $context );
			if ( is_array( $filtered ) ) {
				$bridge = $filtered;
			}
		}

		return $bridge;
	}

	/** @param string[] $tools @param array<string,mixed> $task_input */
	public function validate_task_tools( array $tools, array $task_input ): WP_Error|null {
		$policy = $this->normalize_for_task_input( $task_input );
		if ( is_wp_error( $policy ) ) {
			return $policy;
		}

		$denied = array();
		foreach ( WP_Codebox_Agent_Task::string_list( $tools ) as $tool ) {
			$descriptor = $this->descriptor_resolver->resolve_runtime_tool_alias( $policy, $tool );
			$reason     = $this->descriptor_resolver->denial_reason( $descriptor );
			if ( null !== $reason ) {
				$denied[] = array(
					'tool'   => $tool,
					'reason' => $reason,
				);
			}
		}

		if ( empty( $denied ) ) {
			return null;
		}

		return new WP_Error(
			'wp_codebox_tool_not_allowed',
			'One or more requested tools are not allowed by the resolved sandbox tool policy.',
			array(
				'status'        => 403,
				'schema'        => self::TOOL_DENIAL_SCHEMA,
				'denied_tools'  => $denied,
				'allowed_tools' => $this->allowed_tools( $policy ),
				'policy_schema' => $policy['schema'] ?? '',
			)
		);
	}

	/** @param string[] $allowed_tools @param array<string,mixed> $context @return array<string,mixed> */
	public function from_allowed_tools( array $allowed_tools, array $context = array() ): array {
		$policy_tools = array();
		foreach ( WP_Codebox_Agent_Task::string_list( $allowed_tools ) as $tool_id ) {
			$tool = $this->tool_policy_entry( $tool_id, $context );
			if ( ! empty( $tool ) ) {
				$policy_tools[] = $tool;
			}
		}

		if ( empty( $policy_tools ) ) {
			return array();
		}

		$policy = array(
			'schema'  => self::SCHEMA,
			'version' => self::VERSION,
			'tools'   => $policy_tools,
		);

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_sandbox_tool_policy', $policy, $allowed_tools, $context );
			if ( is_array( $filtered ) ) {
				$policy = $filtered;
			}
		}

		return $policy;
	}

	/** @return string[] */
	public function allowed_tools( array $policy ): array {
		$effective = $this->descriptor_resolver->resolve_effective_runtime_tool_policy( $policy );
		$allowed = array();
		foreach ( is_array( $effective['tools'] ?? null ) ? $effective['tools'] : array() as $tool ) {
			if ( is_array( $tool ) && null === $this->descriptor_resolver->denial_reason( $tool ) ) {
				$allowed[] = (string) $tool['id'];
			}
		}

		return array_values( array_unique( $allowed ) );
	}

	/** @param array<string,mixed> $policy @return array<int,array<string,string>> */
	public function policy_issues( array $policy ): array {
		$issues = array();
		if ( self::SCHEMA !== ( $policy['schema'] ?? '' ) ) {
			$issues[] = array( 'field' => 'schema', 'message' => 'sandbox_tool_policy.schema must be ' . self::SCHEMA . '.' );
		}
		if ( self::VERSION !== (int) ( $policy['version'] ?? 0 ) ) {
			$issues[] = array( 'field' => 'version', 'message' => 'sandbox_tool_policy.version must be ' . self::VERSION . '.' );
		}
		if ( empty( $policy['tools'] ) || ! is_array( $policy['tools'] ) ) {
			$issues[] = array( 'field' => 'tools', 'message' => 'sandbox_tool_policy.tools must be a non-empty array.' );
			return $issues;
		}

		$seen = array();
		foreach ( $policy['tools'] as $index => $tool ) {
			if ( ! is_array( $tool ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . ']', 'message' => 'Each sandbox tool policy tool must be an object.' );
				continue;
			}
			$id = trim( (string) ( $tool['id'] ?? '' ) );
			if ( '' === $id ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].id', 'message' => 'Tool id must be a non-empty string.' );
			} elseif ( isset( $seen[ $id ] ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].id', 'message' => 'Duplicate tool id: ' . $id . '.' );
			}
			$seen[ $id ] = true;
			if ( '' === trim( (string) ( $tool['runtime_tool_id'] ?? '' ) ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].runtime_tool_id', 'message' => 'Tool runtime_tool_id must be a non-empty string.' );
			}
			$runtime = is_array( $tool['runtime'] ?? null ) ? $tool['runtime'] : array();
			foreach ( array( self::AGENTS_API_RUNTIME_ENVIRONMENT, self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ) as $field ) {
				if ( '' === trim( (string) ( $runtime[ $field ] ?? '' ) ) ) {
					$issues[] = array( 'field' => 'tools[' . $index . '].runtime.' . $field, 'message' => 'Tool runtime.' . $field . ' must be a non-empty string.' );
				}
			}
			if ( ! is_bool( $tool['allowed'] ?? null ) ) {
				$issues[] = array( 'field' => 'tools[' . $index . '].allowed', 'message' => 'Tool allowed must be boolean.' );
			}
		}

		return $issues;
	}

	/** @param array<string,mixed> $context @return array<string,mixed> */
	private function tool_policy_entry( string $tool_id, array $context ): array {
		$tool_id = trim( $tool_id );
		if ( '' === $tool_id ) {
			return array();
		}

		$entry = array(
			'id'                   => $tool_id,
			'runtime_tool_id'      => $this->provider_safe_runtime_tool_id( $tool_id ),
			'execution_location'   => 'sandbox',
			'transport_visibility' => 'sandbox',
			'allowed'              => true,
			'runtime'              => array(
				self::AGENTS_API_RUNTIME_ENVIRONMENT      => self::AGENTS_API_RUNTIME_LOCAL,
				self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE => self::AGENTS_API_RUNTIME_LOCAL,
			),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_sandbox_tool_policy_tool', $entry, $tool_id, $context );
			if ( is_array( $filtered ) ) {
				$entry = $filtered;
			}
		}

		return $entry;
	}

	/** @param array<string,mixed> $bridge @return array<string,mixed> */
	private function policy_from_tool_bridge( array $bridge ): array {
		if ( self::TOOL_BRIDGE_SCHEMA !== ( $bridge['schema'] ?? '' ) || self::TOOL_BRIDGE_VERSION !== (int) ( $bridge['version'] ?? 0 ) ) {
			return array();
		}

		return is_array( $bridge['sandbox_tool_policy'] ?? null ) ? $bridge['sandbox_tool_policy'] : array();
	}

	private function provider_safe_runtime_tool_id( string $tool_id ): string {
		return trim( preg_replace( '/[^A-Za-z0-9_]+/', '_', $tool_id ) ?? '', '_' );
	}

}
