<?php
/**
 * Composable agent-context section describing WP Codebox.
 *
 * Registers a `WP Codebox` section for the `agents-md` context on the
 * Agents API context section registry so host composers (any consumer of
 * `WP_Agent_Context_Section_Registry`) surface Codebox routing, safety, and
 * discovery guidance to coding agents. The plugin owns the surface, so it owns
 * the guidance; no host-specific composer is referenced here.
 *
 * @package WP_Codebox
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WP_Codebox_Agents_Md_Section {

	public const CONTEXT_SLUG = 'agents-md';
	public const SECTION_SLUG = 'wp-codebox';
	public const PRIORITY     = 40;

	/**
	 * Hook the registration onto the Agents API context extension point.
	 */
	public static function register(): void {
		add_action( 'agents_api_context_sections', array( self::class, 'register_section' ) );
	}

	/**
	 * Register the section when the substrate registry is loaded.
	 */
	public static function register_section(): void {
		if ( ! class_exists( 'WP_Agent_Context_Section_Registry' ) ) {
			return;
		}

		WP_Agent_Context_Section_Registry::register(
			self::CONTEXT_SLUG,
			self::SECTION_SLUG,
			self::PRIORITY,
			static function (): string {
				return self::render();
			},
			array(
				'label'       => 'WP Codebox',
				'description' => 'Disposable WordPress sandbox CLI and abilities.',
				'meta'        => array(
					'owner'      => 'wp-codebox',
					'freshness'  => 'generated',
					'conditions' => 'Registered when wp-codebox is active and the Agents API context section registry is loaded.',
				),
			)
		);
	}

	/**
	 * WP-CLI invocation prefix used in rendered guidance.
	 *
	 * Defaults to a path-pinned invocation. Hosts that need a different
	 * prefix (flags, wrapper binaries, remote routing) adjust it through the
	 * `wp_codebox_agents_md_wp_cli_cmd` filter.
	 */
	public static function wp_cli_cmd(): string {
		$default = 'wp --path=' . rtrim( (string) ABSPATH, '/\\' );

		$cmd = apply_filters( 'wp_codebox_agents_md_wp_cli_cmd', $default );

		return is_string( $cmd ) && '' !== trim( $cmd ) ? trim( $cmd ) : $default;
	}

	/**
	 * Render the section body.
	 */
	public static function render(): string {
		$wp = self::wp_cli_cmd();

		$lines = array(
			'## WP Codebox',
			'',
			'Disposable, isolated WordPress sites backed by WordPress Playground. Blow them up freely: CLI workloads, tests, fuzz, and browser/headless Playground sessions run here so the host install stays intact. Results return as artifact bundles. Abilities: `wp-codebox/*`. CLI mirrors the same service layer.',
			'',
			'**Default routing**',
			'- WordPress workload: `' . $wp . ' codebox run-wordpress-workload --input-file=<workload.json>`',
			'- Runtime task: `codebox run-runtime-task`',
			'- Fuzz suite: `codebox run-fuzz-suite`',
			'- Browser Playground session: `codebox browser-session create`',
			'- Readiness: `codebox resolve-runtime-requirements`',
			'- Evidence: `codebox artifacts list` → `codebox artifacts inspect`',
			'',
			'**Discovery**',
			'`' . $wp . ' codebox --help`. Live help is authoritative.',
		);

		return implode( "\n", $lines ) . "\n";
	}
}
