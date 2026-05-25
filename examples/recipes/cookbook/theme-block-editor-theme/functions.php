<?php
/**
 * Minimal fixture theme setup for the theme block-editor cookbook recipe.
 */

add_action( 'after_setup_theme', function (): void {
	add_theme_support( 'title-tag' );
	add_theme_support( 'wp-block-styles' );
	add_theme_support( 'align-wide' );
	add_theme_support( 'editor-styles' );
	add_editor_style( 'style.css' );
} );

add_action( 'wp_enqueue_scripts', function (): void {
	wp_enqueue_style( 'theme-block-editor-cookbook', get_stylesheet_uri(), array(), '0.1.0' );
} );
