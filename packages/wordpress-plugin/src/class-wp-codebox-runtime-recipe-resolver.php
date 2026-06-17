<?php
/**
 * Generic runtime recipe/package resolution for WordPress sandboxes.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runtime_Recipe_Resolver {

	/** @param array<string,mixed> $input Caller task input. @param array<string,mixed> $inheritance Resolved inheritance metadata. @return array<string,mixed>|WP_Error */
	public static function apply_to_input( array $input, array $inheritance = array() ): array|WP_Error {
		$request = self::request_from_input( $input );
		if ( empty( $request['packages'] ) && empty( $request['capabilities'] ) ) {
			return $input;
		}

		$resolved = self::resolve( $request, $input, $inheritance );
		if ( is_wp_error( $resolved ) ) {
			return $resolved;
		}

		$runtime = is_array( $input['runtime'] ?? null ) ? $input['runtime'] : array();
		$input['runtime'] = self::merge_runtime( $runtime, $resolved['runtime'] );
		$input['runtime']['resolved_recipe'] = $resolved['contract'];

		foreach ( array( 'provider_plugin_paths', 'secret_env', 'agent_bundles' ) as $field ) {
			if ( ! empty( $resolved[ $field ] ) ) {
				$input[ $field ] = self::merge_lists( is_array( $input[ $field ] ?? null ) ? $input[ $field ] : array(), $resolved[ $field ] );
			}
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

	/** @param array<string,mixed> $request Runtime recipe request. @param array<string,mixed> $input Caller task input. @param array<string,mixed> $inheritance Resolved inheritance metadata. @return array<string,mixed>|WP_Error */
	public static function resolve( array $request, array $input = array(), array $inheritance = array() ): array|WP_Error {
		$registry = self::package_registry( $input, $inheritance );
		$package_ids = self::requested_package_ids( $request, $registry );
		$selected = array();
		$errors = array();

		foreach ( $package_ids as $package_id ) {
			self::select_package( $package_id, $registry, $selected, $errors );
		}

		if ( ! empty( $errors ) ) {
			return new WP_Error( 'wp_codebox_runtime_recipe_unresolved', 'Runtime recipe packages could not be resolved.', array( 'status' => 400, 'errors' => $errors ) );
		}

		$resolved = array(
			'schema'                 => 'wp-codebox/runtime-recipe-resolution/v1',
			'packages'               => array(),
			'capabilities'           => array(),
			'runtime'                => array(),
			'inherit'                => array(),
			'provider_plugin_paths'  => array(),
			'secret_env'             => array(),
			'agent_bundles'          => array(),
			'placement_capabilities' => array(),
		);

		foreach ( $selected as $package ) {
			$resolved['packages'][] = self::package_public_entry( $package );
			$resolved['capabilities'] = self::merge_string_lists( $resolved['capabilities'], self::package_capabilities( $package ) );
			$resolved['runtime'] = self::merge_runtime( $resolved['runtime'], is_array( $package['runtime'] ?? null ) ? $package['runtime'] : array() );
			$resolved['inherit'] = self::merge_inherit( $resolved['inherit'], is_array( $package['inherit'] ?? null ) ? $package['inherit'] : array() );
			$resolved['provider_plugin_paths'] = self::merge_string_lists( $resolved['provider_plugin_paths'], $package['provider_plugin_paths'] ?? array() );
			$resolved['secret_env'] = self::merge_secret_env( $resolved['secret_env'], $package['secret_env'] ?? array() );
			$resolved['agent_bundles'] = self::merge_lists( $resolved['agent_bundles'], is_array( $package['agent_bundles'] ?? null ) ? $package['agent_bundles'] : array() );
			$resolved['placement_capabilities'] = self::merge_string_lists( $resolved['placement_capabilities'], $package['placement_capabilities'] ?? array() );
		}

		$resolved['contract'] = self::contract( $request, $resolved );
		return $resolved;
	}

	/** @param array<string,mixed> $input Caller task input. @return array{packages:array<int,mixed>,capabilities:string[]} */
	private static function request_from_input( array $input ): array {
		$runtime = is_array( $input['runtime'] ?? null ) ? $input['runtime'] : array();
		$recipe = is_array( $input['runtime_recipe'] ?? null ) ? $input['runtime_recipe'] : ( is_array( $runtime['recipe'] ?? null ) ? $runtime['recipe'] : array() );

		return array(
			'packages'     => self::merge_lists( is_array( $recipe['packages'] ?? null ) ? $recipe['packages'] : array(), is_array( $runtime['packages'] ?? null ) ? $runtime['packages'] : array(), is_array( $input['runtime_packages'] ?? null ) ? $input['runtime_packages'] : array() ),
			'capabilities' => self::merge_string_lists( is_array( $recipe['capabilities'] ?? null ) ? $recipe['capabilities'] : array(), is_array( $runtime['capabilities'] ?? null ) ? $runtime['capabilities'] : array(), is_array( $input['runtime_capabilities'] ?? null ) ? $input['runtime_capabilities'] : array() ),
		);
	}

	/** @param array<string,mixed> $input Caller task input. @param array<string,mixed> $inheritance Resolved inheritance metadata. @return array<string,array<string,mixed>> */
	private static function package_registry( array $input, array $inheritance ): array {
		$registry = array(
			'wordpress-playground' => array(
				'id'                     => 'wordpress-playground',
				'label'                  => 'WordPress Playground sandbox',
				'provides'               => array( 'wordpress.playground', 'browser.preview' ),
				'placement_capabilities' => array( 'wordpress.playground', 'browser.preview' ),
			),
		);

		if ( function_exists( 'apply_filters' ) ) {
			$registry = apply_filters( 'wp_codebox_runtime_package_registry', $registry, $input, $inheritance );
		}

		$normalized = array();
		foreach ( is_array( $registry ) ? $registry : array() as $key => $package ) {
			if ( ! is_array( $package ) ) {
				continue;
			}

			$id = self::safe_key( (string) ( $package['id'] ?? $package['package'] ?? $key ) );
			if ( '' === $id ) {
				continue;
			}

			$package['id'] = $id;
			$normalized[ $id ] = $package;
		}

		return $normalized;
	}

	/** @param array<string,mixed> $request Runtime recipe request. @param array<string,array<string,mixed>> $registry Package registry. @return string[] */
	private static function requested_package_ids( array $request, array $registry ): array {
		$ids = array();
		foreach ( is_array( $request['packages'] ?? null ) ? $request['packages'] : array() as $package ) {
			$id = is_array( $package ) ? (string) ( $package['id'] ?? $package['package'] ?? $package['name'] ?? '' ) : (string) $package;
			$id = self::safe_key( $id );
			if ( '' !== $id ) {
				$ids[] = $id;
			}
		}

		foreach ( self::string_list_lower( $request['capabilities'] ?? array() ) as $capability ) {
			foreach ( $registry as $id => $package ) {
				if ( in_array( $capability, self::package_capabilities( $package ), true ) ) {
					$ids[] = $id;
				}
			}
		}

		return array_values( array_unique( $ids ) );
	}

	/** @param array<string,array<string,mixed>> $registry Package registry. @param array<string,array<string,mixed>> $selected Selected packages keyed by id. @param array<int,array<string,string>> $errors Resolution errors. */
	private static function select_package( string $package_id, array $registry, array &$selected, array &$errors ): void {
		$package_id = self::safe_key( $package_id );
		if ( '' === $package_id || isset( $selected[ $package_id ] ) ) {
			return;
		}

		if ( ! isset( $registry[ $package_id ] ) ) {
			$errors[] = array( 'code' => 'package_not_registered', 'package' => $package_id );
			return;
		}

		$package = $registry[ $package_id ];
		foreach ( self::string_list_lower( $package['requires'] ?? array() ) as $required ) {
			$required_id = isset( $registry[ $required ] ) ? $required : self::package_id_for_capability( $required, $registry );
			if ( '' === $required_id ) {
				$errors[] = array( 'code' => 'requirement_not_registered', 'package' => $package_id, 'requirement' => $required );
				continue;
			}

			self::select_package( $required_id, $registry, $selected, $errors );
		}

		$selected[ $package_id ] = $package;
	}

	/** @param array<string,array<string,mixed>> $registry Package registry. */
	private static function package_id_for_capability( string $capability, array $registry ): string {
		foreach ( $registry as $id => $package ) {
			if ( in_array( $capability, self::package_capabilities( $package ), true ) ) {
				return $id;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $package Package descriptor. @return string[] */
	private static function package_capabilities( array $package ): array {
		return self::merge_string_lists( $package['provides'] ?? array(), $package['capabilities'] ?? array() );
	}

	/** @param array<string,mixed> $request Runtime recipe request. @param array<string,mixed> $resolved Resolution payload. @return array<string,mixed> */
	private static function contract( array $request, array $resolved ): array {
		return array_filter(
			array(
				'schema'                 => 'wp-codebox/runtime-recipe-resolution/v1',
				'request'                => array(
					'packages'     => is_array( $request['packages'] ?? null ) ? $request['packages'] : array(),
					'capabilities' => self::string_list_lower( $request['capabilities'] ?? array() ),
				),
				'packages'               => $resolved['packages'],
				'capabilities'           => $resolved['capabilities'],
				'placement_capabilities' => $resolved['placement_capabilities'],
				'summary'                => array(
					'packages'    => count( $resolved['packages'] ),
					'plugins'     => count( is_array( $resolved['runtime']['plugins'] ?? null ) ? $resolved['runtime']['plugins'] : array() ),
					'mu_plugins'  => count( is_array( $resolved['runtime']['mu_plugins'] ?? null ) ? $resolved['runtime']['mu_plugins'] : array() ),
					'themes'      => count( is_array( $resolved['runtime']['themes'] ?? null ) ? $resolved['runtime']['themes'] : array() ),
					'components'  => count( is_array( $resolved['runtime']['components'] ?? null ) ? $resolved['runtime']['components'] : array() ),
					'bootstrap'   => count( is_array( $resolved['runtime']['bootstrap'] ?? null ) ? $resolved['runtime']['bootstrap'] : array() ),
				),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $package Package descriptor. @return array<string,mixed> */
	private static function package_public_entry( array $package ): array {
		return array_filter(
			array(
				'id'           => (string) ( $package['id'] ?? '' ),
				'label'        => (string) ( $package['label'] ?? '' ),
				'provides'     => self::package_capabilities( $package ),
				'requires'     => self::string_list_lower( $package['requires'] ?? array() ),
				'provenance'   => is_array( $package['provenance'] ?? null ) ? $package['provenance'] : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	/** @param array<string,mixed> $base Base runtime. @param array<string,mixed> $extra Extra runtime. @return array<string,mixed> */
	private static function merge_runtime( array $base, array $extra ): array {
		foreach ( array( 'components', 'plugins', 'mu_plugins', 'themes', 'bootstrap' ) as $field ) {
			$base[ $field ] = self::merge_lists( is_array( $base[ $field ] ?? null ) ? $base[ $field ] : array(), is_array( $extra[ $field ] ?? null ) ? $extra[ $field ] : array() );
		}

		foreach ( array( 'prepared', 'prepared_runtime' ) as $field ) {
			if ( isset( $extra[ $field ] ) && ! isset( $base[ $field ] ) ) {
				$base[ $field ] = $extra[ $field ];
			}
		}

		return $base;
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
			foreach ( self::string_list_lower( $list ) as $item ) {
				if ( ! in_array( $item, $merged, true ) ) {
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
			foreach ( self::string_list( $list ) as $item ) {
				if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $item ) && ! in_array( $item, $merged, true ) ) {
					$merged[] = $item;
				}
			}
		}

		return $merged;
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		$items = array();
		foreach ( is_array( $value ) ? $value : array() as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item ) {
				$items[] = $item;
			}
		}

		return $items;
	}

	/** @return string[] */
	private static function string_list_lower( mixed $value ): array {
		return array_values( array_unique( array_map( 'strtolower', self::string_list( $value ) ) ) );
	}

	private static function safe_key( string $value ): string {
		if ( function_exists( 'sanitize_key' ) ) {
			return sanitize_key( $value );
		}

		return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $value ) ?? '' );
	}
}
