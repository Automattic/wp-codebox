<?php
/**
 * Runtime profile descriptor resolution for WordPress sandboxes.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runtime_Profile_Resolver {

	/** @param array<string,mixed> $input Caller task input. @param array<string,mixed> $inheritance Resolved inheritance metadata. @return array<string,mixed>|WP_Error */
	public static function apply_to_input( array $input, array $inheritance = array() ): array|WP_Error {
		$request = self::request_from_input( $input );
		if ( empty( $request['profiles'] ) && empty( $request['components'] ) && empty( $request['capabilities'] ) ) {
			return $input;
		}

		$resolved = self::resolve( $request, $input, $inheritance );
		if ( is_wp_error( $resolved ) ) {
			return $resolved;
		}

		$profile = is_array( $input['runtime_profile'] ?? null ) ? $input['runtime_profile'] : array();
		foreach ( array( 'id', 'profile', 'profiles', 'components', 'capabilities' ) as $selector_field ) {
			unset( $profile[ $selector_field ] );
		}
		$materialization_profile = self::merge_profile( $resolved['profile'], $profile );
		$profile                 = self::merge_profile( self::public_profile( $resolved ), $profile );
		$profile['resolved_profile'] = $resolved['contract'];

		$input['runtime_profile'] = $profile;
		$runtime = is_array( $input['runtime'] ?? null ) ? $input['runtime'] : array();
		$runtime['plugins'] = self::merge_lists(
			is_array( $materialization_profile['plugins'] ?? null ) ? $materialization_profile['plugins'] : array(),
			is_array( $materialization_profile['provider_plugins'] ?? null ) ? $materialization_profile['provider_plugins'] : array(),
			is_array( $runtime['plugins'] ?? null ) ? $runtime['plugins'] : array()
		);
		foreach ( array( 'components', 'mu_plugins', 'themes', 'bootstrap', 'runtime_overlays', 'runtime_state_mounts', 'runtime_config_mounts' ) as $field ) {
			$items = is_array( $materialization_profile[ $field ] ?? null ) ? $materialization_profile[ $field ] : array();
			if ( ! empty( $items ) ) {
				$runtime[ $field ] = self::merge_lists( $items, is_array( $runtime[ $field ] ?? null ) ? $runtime[ $field ] : array() );
			}
		}
		$runtime['resolved_profile'] = $resolved['contract'];
		$input['runtime'] = $runtime;

		foreach ( array( 'provider_plugin_paths', 'secret_env', 'agent_bundles' ) as $field ) {
			if ( ! empty( $resolved[ $field ] ) ) {
				$input[ $field ] = self::merge_lists( is_array( $input[ $field ] ?? null ) ? $input[ $field ] : array(), $resolved[ $field ] );
			}
		}

		if ( ! empty( $resolved['model_defaults'] ) ) {
			foreach ( array( 'agent', 'mode', 'provider', 'model', 'max_turns', 'task_timeout_seconds' ) as $field ) {
				if ( empty( $input[ $field ] ) && ! empty( $resolved['model_defaults'][ $field ] ) ) {
					$input[ $field ] = $resolved['model_defaults'][ $field ];
				}
			}
		}
		if ( ! empty( $resolved['profile']['env'] ) && is_array( $resolved['profile']['env'] ) ) {
			$input['runtime_env'] = array_merge( $resolved['profile']['env'], is_array( $input['runtime_env'] ?? null ) ? $input['runtime_env'] : array() );
		}

		if ( ! empty( $resolved['inherit'] ) ) {
			$input['inherit'] = self::merge_inherit( is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array(), $resolved['inherit'] );
		}

		if ( ! empty( $resolved['placement_capabilities'] ) ) {
			$placement = is_array( $input['placement'] ?? null ) ? $input['placement'] : array();
			$placement['required_capabilities'] = self::merge_string_lists( is_array( $placement['required_capabilities'] ?? null ) ? $placement['required_capabilities'] : array(), $resolved['placement_capabilities'] );
			$input['placement'] = $placement;
		}

		return $input;
	}

	/** @param array<string,mixed> $request Runtime profile request. @param array<string,mixed> $input Caller task input. @param array<string,mixed> $inheritance Resolved inheritance metadata. @return array<string,mixed>|WP_Error */
	public static function resolve( array $request, array $input = array(), array $inheritance = array() ): array|WP_Error {
		$registry = self::profile_registry( $input, $inheritance );
		$errors = array();
		$profile_ids = self::requested_profile_ids( $request, $registry, $errors );
		$selected = array();

		foreach ( $profile_ids as $profile_id ) {
			self::select_profile( $profile_id, $registry, $selected, $errors );
		}

		if ( ! empty( $errors ) ) {
			return new WP_Error( 'wp_codebox_runtime_profile_unresolved', 'Runtime profiles could not be resolved.', array( 'status' => 400, 'errors' => $errors ) );
		}

		$resolved = array(
			'schema'                 => 'wp-codebox/runtime-profile-resolution/v1',
			'profiles'               => array(),
			'capabilities'           => array(),
			'profile'                => array(),
			'inherit'                => array(),
			'provider_plugin_paths'  => array(),
			'secret_env'             => array(),
			'agent_bundles'          => array(),
			'placement_capabilities' => array(),
			'model_defaults'         => array(),
		);

		foreach ( $selected as $profile ) {
			$resolved['profiles'][] = self::profile_public_entry( $profile );
			$resolved['capabilities'] = self::merge_string_lists( $resolved['capabilities'], self::profile_capabilities( $profile ) );
			$resolved['profile'] = self::merge_profile( $resolved['profile'], $profile );
			$resolved['inherit'] = self::merge_inherit( $resolved['inherit'], is_array( $profile['inherit'] ?? null ) ? $profile['inherit'] : array() );
			$resolved['provider_plugin_paths'] = self::merge_string_lists( $resolved['provider_plugin_paths'], $profile['provider_plugin_paths'] ?? array() );
			$resolved['secret_env'] = self::merge_secret_env( $resolved['secret_env'], $profile['secret_env'] ?? array() );
			$resolved['agent_bundles'] = self::merge_lists( $resolved['agent_bundles'], is_array( $profile['agent_bundles'] ?? null ) ? $profile['agent_bundles'] : array() );
			$resolved['placement_capabilities'] = self::merge_string_lists( $resolved['placement_capabilities'], $profile['placement_capabilities'] ?? array() );
			$resolved['model_defaults'] = array_merge( $resolved['model_defaults'], is_array( $profile['model_defaults'] ?? null ) ? $profile['model_defaults'] : ( is_array( $profile['modelDefaults'] ?? null ) ? $profile['modelDefaults'] : array() ) );
		}

		$resolved['profile']['id'] = implode( '+', array_map( static fn( array $profile ): string => (string) ( $profile['id'] ?? '' ), $resolved['profiles'] ) );
		foreach ( self::unresolved_component_entries( $request, $registry ) as $component ) {
			$resolved['profile']['components'] = self::merge_lists( is_array( $resolved['profile']['components'] ?? null ) ? $resolved['profile']['components'] : array(), array( $component ) );
			$resolved['unresolved_components'] = self::merge_lists( is_array( $resolved['unresolved_components'] ?? null ) ? $resolved['unresolved_components'] : array(), array( $component ) );
		}
		$resolved['profile']['schema']       = 'wp-codebox/runtime-profile/v1';
		$resolved['profile']['capabilities'] = $resolved['capabilities'];
		$resolved['profile']['readiness']    = is_array( $resolved['profile']['readiness'] ?? null ) && ! empty( $resolved['profile']['readiness'] ) ? $resolved['profile']['readiness'] : self::readiness( $resolved['profile'] );
		$resolved['profile']['diagnostics']  = self::diagnostics( $request, $resolved );
		$resolved['profile']['provenance']   = array_merge(
			array(
				'owner'    => 'wp-codebox',
				'resolver' => __CLASS__,
			),
			is_array( $resolved['profile']['provenance'] ?? null ) ? $resolved['profile']['provenance'] : array()
		);

		$resolved['contract'] = self::contract( $request, $resolved );
		return $resolved;
	}

	/** @param array<string,mixed> $input Caller task input. @return array{profiles:string[],components:string[],capabilities:string[]} */
	private static function request_from_input( array $input ): array {
		$runtime = is_array( $input['runtime'] ?? null ) ? $input['runtime'] : array();
		$profile = $input['runtime_profile'] ?? ( $runtime['profile'] ?? array() );
		if ( ! is_array( $profile ) && is_array( $input['runtimeProfile'] ?? null ) ) {
			$profile = $input['runtimeProfile'];
		}
		$profile_array = is_array( $profile ) ? $profile : array();

		$profiles = self::merge_string_lists(
			is_string( $profile ) ? array( $profile ) : array(),
			$input['runtimePresetId'] ?? array(),
			$input['runtime_preset_id'] ?? array(),
			$runtime['runtimePresetId'] ?? array(),
			$runtime['runtime_preset_id'] ?? array(),
			$profile_array['profiles'] ?? array(),
			$profile_array['profile'] ?? array(),
			$profile_array['runtimePresetId'] ?? array(),
			$profile_array['runtime_preset_id'] ?? array(),
			$runtime['profiles'] ?? array(),
			$input['runtime_profiles'] ?? array()
		);
		$id = trim( (string) ( $profile_array['id'] ?? '' ) );
		if ( '' !== $id && ! in_array( $id, $profiles, true ) ) {
			$profiles[] = $id;
		}

		return array(
			'profiles'     => $profiles,
			'components'   => self::merge_string_lists( $profile_array['components'] ?? array(), $runtime['components'] ?? array(), $input['runtime_components'] ?? array() ),
			'capabilities' => self::merge_string_lists( $profile_array['capabilities'] ?? array(), $runtime['capabilities'] ?? array(), $input['runtime_capabilities'] ?? array() ),
		);
	}

	/** @param array<string,mixed> $input Caller task input. @param array<string,mixed> $inheritance Resolved inheritance metadata. @return array<string,array<string,mixed>> */
	private static function profile_registry( array $input, array $inheritance ): array {
		$registry = array(
			'wordpress-playground' => array(
				'id'                     => 'wordpress-playground',
				'label'                  => 'WordPress Playground sandbox',
				'capabilities'           => array( 'wordpress.playground', 'browser.preview' ),
				'public_capabilities'    => array( 'wordpress.sandbox', 'browser.preview' ),
				'placement_capabilities' => array( 'wordpress.playground', 'browser.preview' ),
			),
			'codebox-agent-runtime' => array(
				'id'                     => 'codebox-agent-runtime',
				'label'                  => 'WP Codebox agent runtime',
				'aliases'                => array( 'agent-runtime', 'wordpress-agent-runtime' ),
				'capabilities'           => array( 'codebox.agent-runtime' ),
				'public_capabilities'    => array( 'codebox.agent-runtime' ),
				'requires'                => array( 'wordpress-playground' ),
				'placement_capabilities' => array( 'codebox.agent-runtime' ),
			),
			'provider-openai' => array(
				'id'               => 'provider-openai',
				'label'            => 'OpenAI provider plugin',
				'aliases'          => array( 'openai', 'openai-provider' ),
				'capabilities'     => array( 'provider.openai' ),
				'provider_plugins' => array( array( 'slug' => 'ai-provider-for-openai', 'activate' => true ) ),
			),
			'provider-claude-code' => array(
				'id'               => 'provider-claude-code',
				'label'            => 'Claude Code provider plugin',
				'aliases'          => array( 'claude-code', 'claude-code-provider' ),
				'capabilities'     => array( 'provider.claude-code' ),
				'provider_plugins' => array( array( 'slug' => 'ai-provider-for-claude-code', 'activate' => true ) ),
			),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$registry = apply_filters( 'wp_codebox_runtime_profile_registry', $registry, $input, $inheritance );
		}

		$normalized = array();
		foreach ( is_array( $registry ) ? $registry : array() as $key => $profile ) {
			if ( ! is_array( $profile ) ) {
				continue;
			}
			$id = self::safe_key( (string) ( $profile['id'] ?? $profile['profile'] ?? $key ) );
			if ( '' === $id ) {
				continue;
			}
			$profile['id'] = $id;
			$normalized[ $id ] = $profile;
		}

		return $normalized;
	}

	/** @param array<string,mixed> $request Runtime profile request. @param array<string,array<string,mixed>> $registry Profile registry. @param array<int,array<string,string>> $errors Resolution errors. @return string[] */
	private static function requested_profile_ids( array $request, array $registry, array &$errors ): array {
		$ids = array();
		foreach ( self::merge_string_lists( $request['profiles'] ?? array() ) as $profile_id ) {
			$resolved_id = self::profile_id_for_selector( $profile_id, $registry );
			if ( '' === $resolved_id ) {
				$errors[] = array( 'code' => 'profile_not_registered', 'profile' => $profile_id );
				continue;
			}

			$ids[] = $resolved_id;
		}

		foreach ( self::merge_string_lists( $request['components'] ?? array() ) as $component ) {
			$resolved_id = self::profile_id_for_selector( $component, $registry );
			if ( '' !== $resolved_id ) {
				$ids[] = $resolved_id;
			}
		}

		foreach ( self::merge_string_lists( $request['capabilities'] ?? array() ) as $capability ) {
			foreach ( $registry as $id => $profile ) {
				if ( in_array( $capability, self::profile_capabilities( $profile ), true ) ) {
					$ids[] = $id;
				}
			}
		}

		return array_values( array_unique( $ids ) );
	}

	/** @param array<string,array<string,mixed>> $registry. @param array<string,array<string,mixed>> $selected. @param array<int,array<string,string>> $errors. */
	private static function select_profile( string $profile_id, array $registry, array &$selected, array &$errors ): void {
		$profile_id = self::safe_key( $profile_id );
		if ( '' === $profile_id || isset( $selected[ $profile_id ] ) ) {
			return;
		}
		if ( ! isset( $registry[ $profile_id ] ) ) {
			$errors[] = array( 'code' => 'profile_not_registered', 'profile' => $profile_id );
			return;
		}

		$profile = $registry[ $profile_id ];
		foreach ( self::merge_string_lists( $profile['requires'] ?? array() ) as $required ) {
			$required_id = self::profile_id_for_selector( $required, $registry );
			$required_id = '' !== $required_id ? $required_id : self::profile_id_for_capability( $required, $registry );
			if ( '' === $required_id ) {
				$errors[] = array( 'code' => 'requirement_not_registered', 'profile' => $profile_id, 'requirement' => $required );
				continue;
			}
			self::select_profile( $required_id, $registry, $selected, $errors );
		}

		$selected[ $profile_id ] = $profile;
	}

	/** @param array<string,array<string,mixed>> $registry. */
	private static function profile_id_for_capability( string $capability, array $registry ): string {
		foreach ( $registry as $id => $profile ) {
			if ( in_array( $capability, self::profile_capabilities( $profile ), true ) ) {
				return $id;
			}
		}

		return '';
	}

	/** @param array<string,array<string,mixed>> $registry. */
	private static function profile_id_for_selector( string $selector, array $registry ): string {
		$selector = self::safe_key( $selector );
		if ( '' === $selector ) {
			return '';
		}

		if ( isset( $registry[ $selector ] ) ) {
			return $selector;
		}

		foreach ( $registry as $id => $profile ) {
			if ( in_array( $selector, self::merge_string_lists( $profile['aliases'] ?? array() ), true ) ) {
				return $id;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $profile Profile descriptor. @return string[] */
	private static function profile_capabilities( array $profile ): array {
		return self::merge_string_lists( $profile['provides'] ?? array(), $profile['capabilities'] ?? array() );
	}

	/** @param array<string,mixed> $profile Profile descriptor. @return string[] */
	private static function profile_public_capabilities( array $profile ): array {
		$public = self::merge_string_lists( $profile['public_capabilities'] ?? array(), $profile['public_provides'] ?? array() );
		return ! empty( $public ) ? $public : self::profile_capabilities( $profile );
	}

	/** @param array<string,mixed> $resolved Resolution payload. @return array<string,mixed> */
	private static function public_profile( array $resolved ): array {
		$components = array();
		foreach ( is_array( $resolved['unresolved_components'] ?? null ) ? $resolved['unresolved_components'] : array() as $component ) {
			if ( is_array( $component ) ) {
				$components[] = $component;
			}
		}

		return array_filter(
			array(
				'schema'       => 'wp-codebox/runtime-profile/v1',
				'id'           => (string) ( $resolved['profile']['id'] ?? '' ),
				'capabilities' => self::public_capabilities( $resolved ),
				'components'   => $components,
				'readiness'    => is_array( $resolved['profile']['readiness'] ?? null ) ? $resolved['profile']['readiness'] : array(),
				'runtime_requirements' => is_array( $resolved['profile']['runtime_requirements'] ?? null ) ? $resolved['profile']['runtime_requirements'] : array(),
				'diagnostics'  => is_array( $resolved['profile']['diagnostics'] ?? null ) ? $resolved['profile']['diagnostics'] : array(),
				'provenance'   => is_array( $resolved['profile']['provenance'] ?? null ) ? $resolved['profile']['provenance'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $resolved Resolution payload. @return string[] */
	private static function public_capabilities( array $resolved ): array {
		$capabilities = array();
		foreach ( is_array( $resolved['profiles'] ?? null ) ? $resolved['profiles'] : array() as $profile ) {
			if ( is_array( $profile ) ) {
				$capabilities = self::merge_string_lists( $capabilities, $profile['public_provides'] ?? array(), $profile['provides'] ?? array() );
			}
		}

		return $capabilities;
	}

	/** @param array<string,mixed> $request Runtime profile request. @param array<string,array<string,mixed>> $registry Profile registry. @return array<int,array<string,string>> */
	private static function unresolved_component_entries( array $request, array $registry ): array {
		$entries = array();
		foreach ( self::merge_string_lists( $request['components'] ?? array() ) as $component ) {
			if ( ! isset( $registry[ $component ] ) ) {
				$entries[] = array( 'kind' => 'component', 'slug' => $component );
			}
		}

		return $entries;
	}

	/** @param array<string,mixed> $request Runtime profile request. @param array<string,mixed> $resolved Resolution payload. @return array<string,mixed> */
	private static function contract( array $request, array $resolved ): array {
		return array_filter(
			array(
				'schema'       => 'wp-codebox/runtime-profile-resolution/v1',
				'request'      => array(
					'profiles'     => self::merge_string_lists( $request['profiles'] ?? array() ),
					'components'   => self::merge_string_lists( $request['components'] ?? array() ),
					'capabilities' => self::merge_string_lists( $request['capabilities'] ?? array() ),
				),
				'profiles'     => $resolved['profiles'],
				'capabilities' => $resolved['capabilities'],
				'summary'      => array(
					'profiles'         => count( $resolved['profiles'] ),
					'components'       => count( is_array( $resolved['profile']['components'] ?? null ) ? $resolved['profile']['components'] : array() ),
					'provider_plugins' => count( is_array( $resolved['profile']['provider_plugins'] ?? null ) ? $resolved['profile']['provider_plugins'] : array() ),
					'overlays'         => count( is_array( $resolved['profile']['runtime_overlays'] ?? null ) ? $resolved['profile']['runtime_overlays'] : array() ),
				),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $profile Resolved runtime profile. @return array<string,mixed> */
	private static function readiness( array $profile ): array {
		$missing = array();
		foreach ( array( 'components', 'plugins', 'mu_plugins', 'themes', 'overlays' ) as $field ) {
			foreach ( is_array( $profile[ $field ] ?? null ) ? $profile[ $field ] : array() as $entry ) {
				if ( ! is_array( $entry ) ) {
					continue;
				}
				$required  = false !== ( $entry['required'] ?? true );
				$readiness = (string) ( $entry['readiness'] ?? '' );
				$slug      = (string) ( $entry['slug'] ?? $entry['id'] ?? '' );
				if ( $required && 'missing' === $readiness && '' !== $slug ) {
					$missing[] = $field . ':' . $slug;
				}
			}
		}

		return array(
			'status' => empty( $missing ) ? 'ready' : 'missing',
			'checks' => array(
				'dependencies' => empty( $missing ),
			),
			'missing' => $missing,
		);
	}

	/** @param array<string,mixed> $request Runtime profile request. @param array<string,mixed> $resolved Resolution payload. @return array<int,array<string,mixed>> */
	private static function diagnostics( array $request, array $resolved ): array {
		$diagnostics = array(
			array(
				'code'     => 'runtime_profile.resolved',
				'status'   => (string) ( $resolved['profile']['readiness']['status'] ?? 'ready' ),
				'severity' => 'info',
				'message'  => 'Runtime profile resolved by WP Codebox.',
				'evidence' => array(
					'profiles'         => count( $resolved['profiles'] ),
					'components'       => count( is_array( $resolved['profile']['components'] ?? null ) ? $resolved['profile']['components'] : array() ),
					'provider_plugins' => count( is_array( $resolved['profile']['provider_plugins'] ?? null ) ? $resolved['profile']['provider_plugins'] : array() ),
					'overlays'         => count( is_array( $resolved['profile']['runtime_overlays'] ?? null ) ? $resolved['profile']['runtime_overlays'] : array() ),
				),
			),
		);

		$unresolved = is_array( $resolved['unresolved_components'] ?? null ) ? $resolved['unresolved_components'] : array();
		if ( ! empty( $unresolved ) ) {
			$diagnostics[] = array(
				'code'     => 'runtime_profile.unregistered_components',
				'status'   => 'unknown',
				'severity' => 'warning',
				'message'  => 'Runtime profile includes caller-provided components that WP Codebox did not resolve from its registry.',
				'evidence' => array( 'components' => $unresolved ),
			);
		}

		return $diagnostics;
	}

	/** @param array<string,mixed> $profile Profile descriptor. @return array<string,mixed> */
	private static function profile_public_entry( array $profile ): array {
		return array_filter(
			array(
				'id'         => (string) ( $profile['id'] ?? '' ),
				'label'      => (string) ( $profile['label'] ?? '' ),
				'aliases'    => array_values( array_diff( self::merge_string_lists( $profile['aliases'] ?? array() ), array( 'agents-api' ) ) ),
				'provides'   => self::profile_public_capabilities( $profile ),
				'internal'   => array_filter(
					array(
						'provides' => self::profile_capabilities( $profile ),
					),
					static fn( mixed $value ): bool => array() !== $value && '' !== $value
				),
				'requires'   => self::merge_string_lists( $profile['requires'] ?? array() ),
				'provenance' => is_array( $profile['provenance'] ?? null ) ? $profile['provenance'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $base Base profile. @param array<string,mixed> $extra Extra profile. @return array<string,mixed> */
	private static function merge_profile( array $base, array $extra ): array {
		foreach ( array( 'components', 'plugins', 'mu_plugins', 'themes', 'overlays', 'runtime_overlays', 'runtime_state_mounts', 'runtime_config_mounts', 'provider_plugins', 'extra_plugins', 'component_contracts', 'bootstrap', 'diagnostics' ) as $field ) {
			$base[ $field ] = self::merge_lists( is_array( $base[ $field ] ?? null ) ? $base[ $field ] : array(), is_array( $extra[ $field ] ?? null ) ? $extra[ $field ] : array() );
		}
		$base['capabilities'] = self::merge_string_lists( $base['capabilities'] ?? array(), $extra['capabilities'] ?? array() );

		foreach ( array( 'env', 'metadata', 'readiness', 'provenance', 'runtime_requirements' ) as $field ) {
			$base[ $field ] = array_merge( is_array( $base[ $field ] ?? null ) ? $base[ $field ] : array(), is_array( $extra[ $field ] ?? null ) ? $extra[ $field ] : array() );
		}

		return array_filter( $base, static fn( mixed $value ): bool => array() !== $value && '' !== $value );
	}

	/** @param array<string,mixed> $base Base inherit. @param array<string,mixed> $extra Extra inherit. @return array<string,mixed> */
	private static function merge_inherit( array $base, array $extra ): array {
		foreach ( array( 'connectors', 'settings' ) as $field ) {
			$base[ $field ] = self::merge_string_lists( is_array( $base[ $field ] ?? null ) ? $base[ $field ] : array(), is_array( $extra[ $field ] ?? null ) ? $extra[ $field ] : array() );
		}

		return array_filter( $base, static fn( mixed $value ): bool => array() !== $value );
	}

	/** @return array<int,mixed> */
	private static function merge_lists( mixed ...$lists ): array {
		$merged = array();
		$seen = array();
		foreach ( $lists as $list ) {
			foreach ( is_array( $list ) ? $list : array() as $item ) {
				$key = is_array( $item ) ? md5( wp_json_encode( $item ) ?: serialize( $item ) ) : 'scalar:' . (string) $item;
				if ( isset( $seen[ $key ] ) ) {
					continue;
				}
				$seen[ $key ] = true;
				$merged[] = $item;
			}
		}

		return $merged;
	}

	/** @return string[] */
	private static function merge_string_lists( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			if ( is_string( $list ) ) {
				$list = array( $list );
			}
			foreach ( is_array( $list ) ? $list : array() as $item ) {
				$item = self::safe_key( (string) $item );
				if ( '' !== $item && ! in_array( $item, $merged, true ) ) {
					$merged[] = $item;
				}
			}
		}

		return $merged;
	}

	/** @return string[] */
	private static function merge_secret_env( mixed ...$lists ): array {
		$merged = array();
		foreach ( $lists as $list ) {
			foreach ( is_array( $list ) ? $list : array() as $item ) {
				$item = trim( (string) $item );
				if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $item ) && ! in_array( $item, $merged, true ) ) {
					$merged[] = $item;
				}
			}
		}

		return $merged;
	}

	private static function safe_key( string $value ): string {
		return trim( strtolower( preg_replace( '/[^a-zA-Z0-9_\-\.]+/', '-', $value ) ?? '' ), '-' );
	}
}
