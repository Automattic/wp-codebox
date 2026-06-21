<?php
/**
 * Runtime dependency plan contract shared by sandbox builders.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runtime_Dependency_Plan {

	/** @var array<string,mixed> */
	private array $selection;

	/** @var string[] */
	private array $provider_plugin_paths;

	/** @var array<int,array<string,mixed>> */
	private array $provider_plugins;

	/** @var array<int,array<string,mixed>> */
	private array $component_plugins;

	/** @var array<int,array<string,mixed>> */
	private array $runtime_overlays;

	/** @var array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} */
	private array $inheritance;

	/** @var array{connectors:string[],settings:string[]} */
	private array $inheritance_request;

	/** @var array<int,array<string,mixed>> */
	private array $agent_bundles;

	/** @var string[] */
	private array $secret_env_names;

	/** @var array<string,string> */
	private array $runtime_env;

	/** @var array<string,mixed> */
	private array $provider_credentials;

	/**
	 * @param array<string,mixed> $selection Provider/model/runtime selection metadata.
	 * @param string[] $provider_plugin_paths Resolved provider plugin paths.
	 * @param array<int,array<string,mixed>> $provider_plugins Prepared provider plugin entries.
	 * @param array<int,array<string,mixed>> $component_plugins Prepared component plugin entries.
	 * @param array<int,array<string,mixed>> $runtime_overlays Runtime overlay descriptors.
	 * @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance Resolved inheritance metadata.
	 * @param array{connectors:string[],settings:string[]} $inheritance_request Requested inheritance metadata.
	 * @param array<int,array<string,mixed>> $agent_bundles Agent bundle import specs.
	 * @param string[] $secret_env_names Required secret env names.
	 * @param array<string,mixed> $runtime_env Non-secret runtime environment values.
	 * @param array<string,mixed> $provider_credentials Redacted provider credential resolution metadata.
	 */
	public function __construct( array $selection, array $provider_plugin_paths, array $provider_plugins, array $component_plugins, array $runtime_overlays, array $inheritance, array $inheritance_request, array $agent_bundles, array $secret_env_names, array $runtime_env = array(), array $provider_credentials = array() ) {
		$this->selection             = $selection;
		$this->provider_plugin_paths = self::string_list( $provider_plugin_paths );
		$this->provider_plugins      = array_values( array_filter( $provider_plugins, 'is_array' ) );
		$this->component_plugins     = array_values( array_filter( $component_plugins, 'is_array' ) );
		$this->runtime_overlays      = array_values( array_filter( $runtime_overlays, 'is_array' ) );
		$this->inheritance           = array(
			'connectors' => array_values( array_filter( is_array( $inheritance['connectors'] ?? null ) ? $inheritance['connectors'] : array(), 'is_array' ) ),
			'settings'   => array_values( array_filter( is_array( $inheritance['settings'] ?? null ) ? $inheritance['settings'] : array(), 'is_array' ) ),
		);
		$this->inheritance_request   = array(
			'connectors' => self::string_list( $inheritance_request['connectors'] ?? array() ),
			'settings'   => self::string_list( $inheritance_request['settings'] ?? array() ),
		);
		$this->agent_bundles         = array_values( array_filter( $agent_bundles, 'is_array' ) );
		$this->secret_env_names      = self::secret_env_list( $secret_env_names );
		$this->runtime_env           = self::runtime_env_map( $runtime_env );
		$this->provider_credentials  = self::normalize_provider_credentials( $provider_credentials );
	}

	/** @return array<string,mixed> */
	public function selection(): array {
		return $this->selection;
	}

	public function provider(): string {
		return trim( (string) ( $this->selection['provider'] ?? '' ) );
	}

	public function model(): string {
		return trim( (string) ( $this->selection['model'] ?? '' ) );
	}

	/** @return string[] */
	public function provider_plugin_paths(): array {
		return $this->provider_plugin_paths;
	}

	/** @return array<int,array<string,mixed>> */
	public function provider_plugins(): array {
		return $this->provider_plugins;
	}

	/** @return string[] */
	public function provider_plugin_slugs(): array {
		return array_values( array_filter( array_map( static fn( array $plugin ): string => (string) ( $plugin['slug'] ?? '' ), $this->provider_plugins ) ) );
	}

	/** @return array<int,array<string,mixed>> */
	public function component_plugins(): array {
		return $this->component_plugins;
	}

	/** @return array<int,array<string,mixed>> */
	public function runtime_overlays(): array {
		return $this->runtime_overlays;
	}

	/** @return array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} */
	public function inheritance(): array {
		return $this->inheritance;
	}

	/** @return array{connectors:string[],settings:string[]} */
	public function inheritance_request(): array {
		return $this->inheritance_request;
	}

	/** @return array<int,array<string,mixed>> */
	public function agent_bundles(): array {
		return $this->agent_bundles;
	}

	/** @return string[] */
	public function secret_env_names(): array {
		return $this->secret_env_names;
	}

	/** @return array<string,string> */
	public function runtime_env(): array {
		return $this->runtime_env;
	}

	/** @return array<string,mixed> */
	public function provider_credentials(): array {
		return $this->provider_credentials;
	}

	/** @param array<string,string> $defaults @return array<string,string> */
	public function runtime_env_with_defaults( array $defaults ): array {
		return array_merge( $this->runtime_env, self::runtime_env_map( $defaults ) );
	}

	/** @return array<int,array<string,mixed>> */
	public function browser_provider_plugin_specs(): array {
		return array_map(
			static fn( string $path ): array => array(
				'slug'       => self::safe_key( basename( $path ) ),
				'path'       => $path,
				'activate'   => true,
				'provenance' => array(
					'source' => 'provider-plugin-path',
				),
			),
			$this->provider_plugin_paths
		);
	}

	/** @return array<string,mixed> */
	public function to_contract(): array {
		return array_filter(
			array(
				'schema'                => 'wp-codebox/runtime-dependency-plan/v1',
				'selection'             => array_filter( $this->selection, static fn( mixed $value ): bool => '' !== $value && array() !== $value ),
				'provider_plugin_paths' => $this->provider_plugin_paths,
				'provider_plugins'      => $this->provider_plugins,
				'component_plugins'     => $this->component_plugins,
				'runtime_overlays'      => $this->runtime_overlays,
				'inheritance_request'   => $this->inheritance_request,
				'inheritance'           => $this->inheritance,
				'agent_bundles'         => $this->agent_bundles,
				'secret_env'            => $this->secret_env_names,
				'runtime_env'           => $this->runtime_env,
				'provider_credentials'  => $this->provider_credentials,
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	private static function safe_key( string $value ): string {
		return trim( strtolower( preg_replace( '/[^a-zA-Z0-9_\-]+/', '-', $value ) ?? '' ), '-' );
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		$items = array();
		foreach ( is_array( $value ) ? $value : array() as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}

	/** @return string[] */
	private static function secret_env_list( mixed $value ): array {
		return array_values( array_filter( self::string_list( $value ), static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) );
	}

	/** @return array<string,string> */
	private static function runtime_env_map( mixed $value ): array {
		$env = array();
		foreach ( is_array( $value ) ? $value : array() as $name => $env_value ) {
			$name = trim( (string) $name );
			if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) && is_scalar( $env_value ) ) {
				$env[ $name ] = (string) $env_value;
			}
		}

		return $env;
	}

	/** @return array<string,mixed> */
	private static function normalize_provider_credentials( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$requirements = is_array( $value['requirements'] ?? null ) ? $value['requirements'] : array();
		$preflight    = is_array( $value['preflight'] ?? null ) ? $value['preflight'] : array();
		$secret_env   = self::secret_env_list( $value['secret_env'] ?? $preflight['secret_env'] ?? array() );
		if ( empty( $requirements ) && empty( $preflight ) && empty( $secret_env ) ) {
			return array();
		}

		return array_filter(
			array(
				'schema'       => 'wp-codebox/provider-credential-resolution/v1',
				'requirements' => $requirements,
				'preflight'    => $preflight,
				'secret_env'   => $secret_env,
				'redacted'     => true,
			),
			static fn( mixed $entry ): bool => array() !== $entry && '' !== $entry
		);
	}
}
