<?php
/**
 * WooCommerce store cookbook seed.
 *
 * Run after the recipe's blueprint has installed WooCommerce and the recipe has
 * mounted a plugin under test at /wordpress/wp-content/plugins/plugin-under-test.
 *
 * Creates fixture-only store data: standard store pages, three simple products,
 * one customer, and one processing order. Auto-logs in as admin so the preview
 * can jump between storefront and admin URLs.
 *
 * Output: JSON describing the seeded store and useful preview/admin URLs.
 */

require_once ABSPATH . 'wp-admin/includes/plugin.php';

// Activate the plugin under test if the recipe mounted one and it isn't
// already active via blueprint.
$plugin_under_test = null;
foreach ( get_plugins( '/plugin-under-test' ) as $plugin_file => $plugin_data ) {
	if ( ! empty( $plugin_data['Name'] ) ) {
		$plugin_under_test = 'plugin-under-test/' . $plugin_file;
		break;
	}
}

if ( $plugin_under_test && ! is_plugin_active( $plugin_under_test ) ) {
	$activation_result = activate_plugin( $plugin_under_test );
	if ( is_wp_error( $activation_result ) ) {
		throw new RuntimeException( $activation_result->get_error_message() );
	}
}

if ( ! class_exists( 'WooCommerce' ) || ! function_exists( 'wc_create_order' ) ) {
	throw new RuntimeException( 'WooCommerce is not active in the sandbox.' );
}

function wp_codebox_create_store_page( string $title, string $slug, string $content ): int {
	$existing = get_page_by_path( $slug, OBJECT, 'page' );
	if ( $existing instanceof WP_Post ) {
		return (int) $existing->ID;
	}

	$page_id = wp_insert_post( array(
		'post_title'   => $title,
		'post_name'    => $slug,
		'post_content' => $content,
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_author'  => 1,
	) );

	if ( is_wp_error( $page_id ) || ! $page_id ) {
		throw new RuntimeException( sprintf( 'Failed to create %s page', $title ) );
	}

	return (int) $page_id;
}

function wp_codebox_create_simple_product( array $product_data, int $category_id ): int {
	$existing_id = wc_get_product_id_by_sku( $product_data['sku'] );
	$product     = $existing_id ? wc_get_product( $existing_id ) : new WC_Product_Simple();

	if ( ! $product instanceof WC_Product_Simple ) {
		$product = new WC_Product_Simple();
	}

	$product->set_name( $product_data['name'] );
	$product->set_sku( $product_data['sku'] );
	$product->set_regular_price( $product_data['regular_price'] );
	$product->set_price( $product_data['price'] );
	$product->set_description( $product_data['description'] );
	$product->set_short_description( $product_data['short_description'] );
	$product->set_status( 'publish' );
	$product->set_catalog_visibility( 'visible' );
	$product->set_manage_stock( true );
	$product->set_stock_quantity( $product_data['stock_quantity'] );
	$product->set_stock_status( 'instock' );
	$product->set_category_ids( array( $category_id ) );

	if ( ! empty( $product_data['sale_price'] ) ) {
		$product->set_sale_price( $product_data['sale_price'] );
		$product->set_price( $product_data['sale_price'] );
	}

	$product_id = $product->save();

	if ( ! $product_id ) {
		throw new RuntimeException( sprintf( 'Failed to create product %s', $product_data['sku'] ) );
	}

	return (int) $product_id;
}

update_option( 'woocommerce_store_address', '123 Fixture Market Street' );
update_option( 'woocommerce_store_city', 'Testville' );
update_option( 'woocommerce_default_country', 'US:CA' );
update_option( 'woocommerce_currency', 'USD' );
update_option( 'woocommerce_product_type', 'both' );
update_option( 'woocommerce_allow_tracking', 'no' );
update_option( 'woocommerce_onboarding_profile', array( 'skipped' => true ) );
update_option( 'woocommerce_cod_settings', array( 'enabled' => 'yes' ) );

$shop_page_id     = wp_codebox_create_store_page( 'Cookbook Shop', 'cookbook-shop', '' );
$cart_page_id     = wp_codebox_create_store_page( 'Cookbook Cart', 'cookbook-cart', '[woocommerce_cart]' );
$checkout_page_id = wp_codebox_create_store_page( 'Cookbook Checkout', 'cookbook-checkout', '[woocommerce_checkout]' );
$account_page_id  = wp_codebox_create_store_page( 'Cookbook My Account', 'cookbook-my-account', '[woocommerce_my_account]' );

update_option( 'woocommerce_shop_page_id', $shop_page_id );
update_option( 'woocommerce_cart_page_id', $cart_page_id );
update_option( 'woocommerce_checkout_page_id', $checkout_page_id );
update_option( 'woocommerce_myaccount_page_id', $account_page_id );

$category = term_exists( 'Cookbook Fixtures', 'product_cat' );
if ( ! $category ) {
	$category = wp_insert_term( 'Cookbook Fixtures', 'product_cat', array(
		'slug'        => 'cookbook-fixtures',
		'description' => 'Fixture products for WP Codebox WooCommerce cookbook runs.',
	) );
}

if ( is_wp_error( $category ) ) {
	throw new RuntimeException( $category->get_error_message() );
}

$category_id = (int) ( is_array( $category ) ? $category['term_id'] : $category );
$product_ids = array();

foreach ( array(
	array(
		'name'              => 'Cookbook Logo Tee',
		'sku'               => 'CODEBOX-TEE',
		'regular_price'     => '24.00',
		'price'             => '24.00',
		'stock_quantity'    => 18,
		'short_description' => 'A simple product for cart and checkout smoke tests.',
		'description'       => 'Fixture apparel product used by the WooCommerce store cookbook recipe.',
	),
	array(
		'name'              => 'Cookbook Coffee Beans',
		'sku'               => 'CODEBOX-BEANS',
		'regular_price'     => '18.00',
		'price'             => '18.00',
		'sale_price'        => '15.00',
		'stock_quantity'    => 42,
		'short_description' => 'A sale product for price-display smoke tests.',
		'description'       => 'Fixture grocery product with a sale price for WooCommerce integration testing.',
	),
	array(
		'name'              => 'Cookbook Sticker Pack',
		'sku'               => 'CODEBOX-STICKERS',
		'regular_price'     => '6.00',
		'price'             => '6.00',
		'stock_quantity'    => 100,
		'short_description' => 'Low-price fixture product for catalog grids.',
		'description'       => 'Fixture accessory product for WooCommerce catalog and order smoke tests.',
	),
) as $product_data ) {
	$product_ids[] = wp_codebox_create_simple_product( $product_data, $category_id );
}

$customer_email = 'codebox-customer@example.test';
$customer_id    = email_exists( $customer_email );

if ( ! $customer_id ) {
	$customer_id = wp_insert_user( array(
		'user_login' => 'codebox_customer',
		'user_pass'  => 'password',
		'user_email' => $customer_email,
		'first_name' => 'Codebox',
		'last_name'  => 'Customer',
		'role'       => 'customer',
	) );
}

if ( is_wp_error( $customer_id ) || ! $customer_id ) {
	throw new RuntimeException( 'Failed to create WooCommerce customer fixture' );
}

$customer_id = (int) $customer_id;
$address     = array(
	'first_name' => 'Codebox',
	'last_name'  => 'Customer',
	'company'    => 'WP Codebox Fixtures',
	'email'      => $customer_email,
	'phone'      => '555-0100',
	'address_1'  => '456 Fixture Lane',
	'address_2'  => '',
	'city'       => 'Testville',
	'state'      => 'CA',
	'postcode'   => '94105',
	'country'    => 'US',
);

foreach ( $address as $key => $value ) {
	update_user_meta( $customer_id, 'billing_' . $key, $value );
	update_user_meta( $customer_id, 'shipping_' . $key, $value );
}

$order = wc_create_order( array( 'customer_id' => $customer_id ) );
if ( is_wp_error( $order ) || ! $order instanceof WC_Order ) {
	throw new RuntimeException( 'Failed to create WooCommerce order fixture' );
}

foreach ( array_slice( $product_ids, 0, 2 ) as $index => $product_id ) {
	$product = wc_get_product( $product_id );
	if ( $product ) {
		$order->add_product( $product, $index + 1 );
	}
}

$order->set_address( $address, 'billing' );
$order->set_address( $address, 'shipping' );
$order->set_payment_method( 'cod' );
$order->set_payment_method_title( 'Cash on delivery' );
$order->calculate_totals();
$order->update_status( 'processing', 'Created by WP Codebox WooCommerce cookbook seed.' );
$order_id = $order->save();

// Set pretty permalinks so storefront URLs resolve cleanly in the preview.
update_option( 'permalink_structure', '/%postname%/' );

global $wp_rewrite;
$wp_rewrite->init();
$wp_rewrite->flush_rules( false );

wp_set_auth_cookie( 1, true );

echo wp_json_encode( array(
	'product_ids'        => array_map( 'intval', $product_ids ),
	'category_id'        => $category_id,
	'customer_id'        => $customer_id,
	'order_id'           => (int) $order_id,
	'shop_page_id'       => $shop_page_id,
	'cart_page_id'       => $cart_page_id,
	'checkout_page_id'   => $checkout_page_id,
	'account_page_id'    => $account_page_id,
	'shop_url'           => get_permalink( $shop_page_id ),
	'cart_url'           => get_permalink( $cart_page_id ),
	'checkout_url'       => get_permalink( $checkout_page_id ),
	'account_url'        => get_permalink( $account_page_id ),
	'first_product_url'  => get_permalink( $product_ids[0] ),
	'orders_admin_url'   => admin_url( 'admin.php?page=wc-orders' ),
	'order_edit_url'     => admin_url( 'post.php?post=' . (int) $order_id . '&action=edit' ),
	'home_url'           => home_url( '/' ),
	'woocommerce_active' => is_plugin_active( 'woocommerce/woocommerce.php' ),
	'plugin_under_test'  => $plugin_under_test ? is_plugin_active( $plugin_under_test ) : false,
	'plugin_file'        => $plugin_under_test,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
echo "\n";
