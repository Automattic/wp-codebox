<?php
/**
 * Host-side validation for sandbox tool policy snapshots.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Host_Tool_Policy_Validator {

	private const TOOL_DENIAL_SCHEMA = 'wp-codebox/tool-allowlist-denial/v1';
	private const SANDBOX_TOOL_POLICY_SCHEMA = 'wp-codebox/sandbox-tool-policy/v1';
	private const AGENTS_API_RUNTIME_ENVIRONMENT = 'environment';
	private const AGENTS_API_RUNTIME_CAPABILITY_SCOPE = 'capability_scope';
	private const AGENTS_API_RUNTIME_LOCAL = 'runtime_local';

	/** @param string[] $tools @param array<string,mixed>|null $task_input Normalized task input. */
	public function validate_allowed_tools( array $tools, ?array $task_input = null ): WP_Error|null {
		return $this->validate_task_tools( is_array( $task_input ) ? $task_input : array( 'allowed_tools' => $tools ) );
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	public function validate_task_tools( array $task_input ): WP_Error|null {
		$tools  = $this->string_list( $task_input['allowed_tools'] ?? array() );
		$policy = $this->resolved_sandbox_tool_policy( $task_input );
		if ( is_wp_error( $policy ) ) {
			return $policy;
		}

		$allowed = $this->allowed_sandbox_tools( $policy );
		$denied  = array();

		foreach ( $tools as $tool ) {
			$policy_tool = $this->sandbox_policy_tool( $policy, $tool );
			$reason      = null === $policy_tool ? 'not-in-policy' : $this->sandbox_policy_denial_reason( $policy_tool );
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
				'allowed_tools' => $allowed,
				'policy_schema' => $policy['schema'] ?? '',
			)
		);
	}

	/** @return string[] */
	private function string_list( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $value ): string => trim( (string) $value ),
						$values
					),
					static fn( string $value ): bool => '' !== $value
				)
			)
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function resolved_sandbox_tool_policy( array $input ): array|WP_Error {
		$policy = is_array( $input['sandbox_tool_policy'] ?? null ) ? $input['sandbox_tool_policy'] : array();
		if ( empty( $policy ) && function_exists( 'apply_filters' ) ) {
			$policy = apply_filters( 'wp_codebox_resolved_sandbox_tool_policy', $policy, $input );
		}

		$issues = $this->sandbox_tool_policy_issues( is_array( $policy ) ? $policy : array() );
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

	/** @param array<string,mixed> $policy @return array<int,array<string,string>> */
	private function sandbox_tool_policy_issues( array $policy ): array {
		$issues = array();
		if ( self::SANDBOX_TOOL_POLICY_SCHEMA !== ( $policy['schema'] ?? '' ) ) {
			$issues[] = array( 'field' => 'schema', 'message' => 'sandbox_tool_policy.schema must be ' . self::SANDBOX_TOOL_POLICY_SCHEMA . '.' );
		}
		if ( 1 !== (int) ( $policy['version'] ?? 0 ) ) {
			$issues[] = array( 'field' => 'version', 'message' => 'sandbox_tool_policy.version must be 1.' );
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
			foreach ( array( 'runtime_tool_id' ) as $field ) {
				if ( '' === trim( (string) ( $tool[ $field ] ?? '' ) ) ) {
					$issues[] = array( 'field' => 'tools[' . $index . '].' . $field, 'message' => 'Tool ' . $field . ' must be a non-empty string.' );
				}
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

	/** @param array<string,mixed> $policy @return string[] */
	private function allowed_sandbox_tools( array $policy ): array {
		$allowed = array();
		foreach ( is_array( $policy['tools'] ?? null ) ? $policy['tools'] : array() as $tool ) {
			if ( is_array( $tool ) && null === $this->sandbox_policy_denial_reason( $tool ) ) {
				$allowed[] = (string) $tool['id'];
			}
		}

		return array_values( array_unique( $allowed ) );
	}

	/** @param array<string,mixed> $policy @return array<string,mixed>|null */
	private function sandbox_policy_tool( array $policy, string $tool_id ): array|null {
		foreach ( is_array( $policy['tools'] ?? null ) ? $policy['tools'] : array() as $tool ) {
			if ( is_array( $tool ) && $tool_id === (string) ( $tool['id'] ?? '' ) ) {
				return $tool;
			}
		}

		return null;
	}

	/** @param array<string,mixed> $tool */
	private function sandbox_policy_denial_reason( array $tool ): string|null {
		$runtime = $this->sandbox_tool_runtime_metadata( $tool );

		if ( self::AGENTS_API_RUNTIME_LOCAL !== $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] ) {
			return 'parent-only';
		}
		if ( self::AGENTS_API_RUNTIME_LOCAL !== $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] ) {
			return 'not-visible-in-sandbox';
		}
		if ( true !== ( $tool['allowed'] ?? false ) ) {
			return 'not-allowed';
		}

		return null;
	}

	/** @param array<string,mixed> $tool @return array{environment:string,capability_scope:string} */
	private function sandbox_tool_runtime_metadata( array $tool ): array {
		$runtime = is_array( $tool['runtime'] ?? null ) ? $tool['runtime'] : array();

		return array(
			self::AGENTS_API_RUNTIME_ENVIRONMENT => isset( $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] ) && '' !== trim( (string) $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] )
				? trim( (string) $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] )
				: '',
			self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE => isset( $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] ) && '' !== trim( (string) $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] )
				? trim( (string) $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ] )
				: '',
		);
	}
}
