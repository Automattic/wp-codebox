export interface WordPressFixtureUserSpec {
  userId?: number
  username?: string
  email?: string
  role?: string
  displayName?: string
  password?: string
}

export interface BrowserStorageStateCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: "Strict" | "Lax" | "None"
}

export interface BrowserAuthStorageState {
  cookies: BrowserStorageStateCookie[]
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
}

export interface WordPressFixtureUserStorageStateEnvelope {
  schema: "wp-codebox/browser-auth-storage-state/v1"
  kind: "wordpress-fixture-user-admin-auth"
  user: {
    id: number
    username: string
    email: string
    role: string
    created: boolean
  }
  storageState: BrowserAuthStorageState
}

export function browserStorageStateFromWordPressAuthCookies(cookies: Array<Partial<BrowserStorageStateCookie>>): BrowserAuthStorageState {
  return {
    cookies: cookies.map((cookie) => ({
      name: String(cookie.name ?? ""),
      value: String(cookie.value ?? ""),
      domain: String(cookie.domain ?? ""),
      path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
      expires: typeof cookie.expires === "number" ? cookie.expires : Math.floor(Date.now() / 1000) + 3600,
      httpOnly: cookie.httpOnly !== false,
      secure: cookie.secure === true,
      sameSite: cookie.sameSite ?? "Lax",
    })),
    origins: [],
  }
}

export function wordpressFixtureUserStorageStatePhpCode({
  browserUrls,
  user = {},
}: {
  browserUrls: string[]
  user?: WordPressFixtureUserSpec
}): string {
  return `
$fixture_user = json_decode( ${JSON.stringify(JSON.stringify(user))}, true );
$browser_urls = json_decode( ${JSON.stringify(JSON.stringify(browserUrls))}, true );
if ( ! is_array( $fixture_user ) ) {
    $fixture_user = array();
}
if ( ! is_array( $browser_urls ) ) {
    $browser_urls = array();
}
$requested_user_id = isset( $fixture_user['userId'] ) ? (int) $fixture_user['userId'] : 0;
$username = isset( $fixture_user['username'] ) && is_string( $fixture_user['username'] ) && '' !== trim( $fixture_user['username'] ) ? sanitize_user( $fixture_user['username'], true ) : 'wp-codebox-fixture-admin';
if ( '' === $username ) {
    throw new RuntimeException( 'Fixture user username is invalid.' );
}
$role = isset( $fixture_user['role'] ) && is_string( $fixture_user['role'] ) && '' !== trim( $fixture_user['role'] ) ? sanitize_key( $fixture_user['role'] ) : 'administrator';
if ( ! get_role( $role ) ) {
    throw new RuntimeException( 'Fixture user role does not exist: ' . $role );
}
$email = isset( $fixture_user['email'] ) && is_string( $fixture_user['email'] ) && is_email( $fixture_user['email'] ) ? $fixture_user['email'] : $username . '@example.test';
$display_name = isset( $fixture_user['displayName'] ) && is_string( $fixture_user['displayName'] ) && '' !== trim( $fixture_user['displayName'] ) ? $fixture_user['displayName'] : 'WP Codebox Fixture User';
$password = isset( $fixture_user['password'] ) && is_string( $fixture_user['password'] ) && '' !== $fixture_user['password'] ? $fixture_user['password'] : wp_generate_password( 32, true, true );
$created = false;
$user = $requested_user_id > 0 ? get_user_by( 'id', $requested_user_id ) : get_user_by( 'login', $username );
if ( ! $user && $requested_user_id <= 0 ) {
    $user_id = wp_insert_user(
        array(
            'user_login'   => $username,
            'user_email'   => $email,
            'user_pass'    => $password,
            'display_name' => $display_name,
            'role'         => $role,
        )
    );
    if ( is_wp_error( $user_id ) ) {
        throw new RuntimeException( 'Fixture user creation failed: ' . $user_id->get_error_message() );
    }
    $created = true;
    $user = get_user_by( 'id', (int) $user_id );
}
if ( ! $user ) {
    throw new RuntimeException( 'Fixture user could not be resolved.' );
}
$user_id = (int) $user->ID;
$wp_user = new WP_User( $user_id );
if ( ! in_array( $role, (array) $wp_user->roles, true ) ) {
    $wp_user->add_role( $role );
}
wp_set_current_user( $user_id );
$expiration = time() + HOUR_IN_SECONDS;
$token = '';
if ( class_exists( 'WP_Session_Tokens' ) ) {
    $token = WP_Session_Tokens::get_instance( $user_id )->create( $expiration );
}
$cookies = array();
foreach ( $browser_urls as $browser_url ) {
    $browser_host = wp_parse_url( $browser_url, PHP_URL_HOST );
    if ( ! $browser_host ) {
        continue;
    }
    $secure = 'https' === wp_parse_url( $browser_url, PHP_URL_SCHEME );
    foreach ( array( array( AUTH_COOKIE, 'auth', false ), array( SECURE_AUTH_COOKIE, 'secure_auth', true ) ) as $admin_cookie ) {
        $cookies[] = array(
            'name'     => $admin_cookie[0],
            'value'    => wp_generate_auth_cookie( $user_id, $expiration, $admin_cookie[1], $token ),
            'domain'   => $browser_host,
            'path'     => defined( 'ADMIN_COOKIE_PATH' ) && ADMIN_COOKIE_PATH ? ADMIN_COOKIE_PATH : '/wp-admin',
            'expires'  => $expiration,
            'httpOnly' => true,
            'secure'   => $admin_cookie[2],
            'sameSite' => 'Lax',
        );
    }
    $logged_in_cookie = array(
        'name'     => LOGGED_IN_COOKIE,
        'value'    => wp_generate_auth_cookie( $user_id, $expiration, 'logged_in', $token ),
        'domain'   => $browser_host,
        'path'     => defined( 'COOKIEPATH' ) && COOKIEPATH ? COOKIEPATH : '/',
        'expires'  => $expiration,
        'httpOnly' => true,
        'secure'   => $secure,
        'sameSite' => 'Lax',
    );
    $cookies[] = $logged_in_cookie;
    if ( defined( 'SITECOOKIEPATH' ) && SITECOOKIEPATH && SITECOOKIEPATH !== COOKIEPATH ) {
        $logged_in_cookie['path'] = SITECOOKIEPATH;
        $cookies[] = $logged_in_cookie;
    }
}
echo wp_json_encode(
    array(
        'schema'       => 'wp-codebox/browser-auth-storage-state/v1',
        'kind'         => 'wordpress-fixture-user-admin-auth',
        'user'         => array(
            'id'       => $user_id,
            'username' => $user->user_login,
            'email'    => $user->user_email,
            'role'     => $role,
            'created'  => $created,
        ),
        'storageState' => array(
            'cookies' => $cookies,
            'origins' => array(),
        ),
    )
);
`
}
