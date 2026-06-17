<?php
/**
 * Runtime tool policy descriptor resolution.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runtime_Tool_Policy_Descriptor {

	private const AGENTS_API_RUNTIME_ENVIRONMENT = 'environment';
	private const AGENTS_API_RUNTIME_CAPABILITY_SCOPE = 'capability_scope';
	private const AGENTS_API_RUNTIME_LOCAL = 'runtime_local';

	/** @param array<string,mixed> $policy @return array<string,mixed> */
	public function resolve_effective_runtime_tool_policy( array $policy ): array {
		$tools = array_map(
			fn( array $tool ): array => $this->runtime_tool_descriptor( $tool ),
			array_values( array_filter( is_array( $policy['tools'] ?? null ) ? $policy['tools'] : array(), 'is_array' ) )
		);

		return array(
			'schema'                   => (string) ( $policy['schema'] ?? '' ),
			'version'                  => (int) ( $policy['version'] ?? 0 ),
			'tools'                    => $tools,
			'allowedRuntimeToolIds'    => $this->string_list( array_map( static fn( array $tool ): string => $tool['allowed'] && $tool['visible'] ? $tool['runtimeToolId'] : '', $tools ) ),
			'visibleRuntimeToolIds'    => $this->string_list( array_map( static fn( array $tool ): string => $tool['visible'] ? $tool['runtimeToolId'] : '', $tools ) ),
			'parentOnlyRuntimeToolIds' => $this->string_list( array_map( static fn( array $tool ): string => $tool['parentOnly'] ? $tool['runtimeToolId'] : '', $tools ) ),
			'hiddenRuntimeToolIds'     => $this->string_list( array_map( static fn( array $tool ): string => $tool['hidden'] ? $tool['runtimeToolId'] : '', $tools ) ),
			'metadata'                 => is_array( $policy['metadata'] ?? null ) ? $policy['metadata'] : array(),
		);
	}

	/** @param array<string,mixed> $policy_or_effective */
	public function resolve_runtime_tool_alias( array $policy_or_effective, string $value ): array|null {
		$value = trim( $value );
		if ( '' === $value ) {
			return null;
		}

		$effective = array_key_exists( 'allowedRuntimeToolIds', $policy_or_effective )
			? $policy_or_effective
			: $this->resolve_effective_runtime_tool_policy( $policy_or_effective );

		foreach ( is_array( $effective['tools'] ?? null ) ? $effective['tools'] : array() as $tool ) {
			if ( ! is_array( $tool ) ) {
				continue;
			}
			if ( $value === (string) ( $tool['id'] ?? '' ) || $value === (string) ( $tool['runtimeToolId'] ?? '' ) || in_array( $value, $this->string_list( $tool['aliases'] ?? array() ), true ) ) {
				return $tool;
			}
		}

		return null;
	}

	/** @param array<string,mixed>|null $descriptor */
	public function denial_reason( array|null $descriptor ): string|null {
		if ( null === $descriptor ) {
			return 'not-in-policy';
		}
		if ( ! empty( $descriptor['parentOnly'] ) ) {
			return 'parent-only';
		}
		if ( ! empty( $descriptor['hidden'] ) ) {
			return 'hidden';
		}
		if ( empty( $descriptor['visible'] ) ) {
			return 'not-visible-in-sandbox';
		}
		if ( true !== ( $descriptor['allowed'] ?? false ) ) {
			return 'not-allowed';
		}

		return null;
	}

	/** @param array<string,mixed> $tool @return array<string,mixed> */
	private function runtime_tool_descriptor( array $tool ): array {
		$runtime          = $this->runtime_metadata( $tool );
		$metadata         = is_array( $tool['metadata'] ?? null ) ? $tool['metadata'] : array();
		$transport        = (string) ( $tool['transport_visibility'] ?? '' );
		$parent_only      = self::AGENTS_API_RUNTIME_LOCAL !== $runtime[ self::AGENTS_API_RUNTIME_ENVIRONMENT ] || self::AGENTS_API_RUNTIME_LOCAL !== $runtime[ self::AGENTS_API_RUNTIME_CAPABILITY_SCOPE ];
		$hidden           = 'hidden' === $transport;
		$visible          = ! $parent_only && ! $hidden && in_array( $transport, array( 'sandbox', 'both' ), true );
		$runtime_tool_id  = (string) ( $tool['runtime_tool_id'] ?? '' );
		$metadata_aliases = is_array( $metadata['aliases'] ?? null ) ? $metadata['aliases'] : array();

		$descriptor = array(
			'id'                  => (string) ( $tool['id'] ?? '' ),
			'runtimeToolId'       => $runtime_tool_id,
			'aliases'             => $this->string_list( array_merge( array( (string) ( $tool['id'] ?? '' ), $runtime_tool_id ), is_array( $tool['aliases'] ?? null ) ? $tool['aliases'] : array(), $metadata_aliases ) ),
			'allowed'             => true === ( $tool['allowed'] ?? false ),
			'executionLocation'   => (string) ( $tool['execution_location'] ?? '' ),
			'transportVisibility' => $transport,
			'visible'             => $visible,
			'parentOnly'          => $parent_only,
			'hidden'              => $hidden,
			'runtime'             => $runtime,
		);

		if ( isset( $metadata['schema'] ) && is_string( $metadata['schema'] ) ) {
			$descriptor['schema'] = $metadata['schema'];
		}
		if ( isset( $metadata['policy'] ) && is_array( $metadata['policy'] ) ) {
			$descriptor['policy'] = $metadata['policy'];
		}
		if ( ! empty( $metadata ) ) {
			$descriptor['metadata'] = $metadata;
		}

		return $descriptor;
	}

	/** @param array<string,mixed> $tool @return array{environment:string,capability_scope:string} */
	public function runtime_metadata( array $tool ): array {
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
}
