<?php
/**
 * Minimal fixture theme template for the theme block-editor cookbook recipe.
 */

?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<div class="wp-site-blocks">
	<header class="site-header">
		<div class="site-title"><?php bloginfo( 'name' ); ?></div>
	</header>
	<main>
		<?php
		while ( have_posts() ) {
			the_post();
			the_content();
		}
		?>
	</main>
	<footer class="site-footer">
		<?php bloginfo( 'description' ); ?>
	</footer>
</div>
<?php wp_footer(); ?>
</body>
</html>
