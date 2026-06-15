import { cleanWpCliOutput } from "./commands.js"

export interface WordPressAdminAuthCookie {
  name?: string
  value?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Lax"
}

export function parseWordPressAdminAuthCookies(output: string): WordPressAdminAuthCookie[] {
  return JSON.parse(cleanWpCliOutput(output)) as WordPressAdminAuthCookie[]
}

export function wordpressAdminAuthCookiePhpCode(browserUrls: string[], userId: number): string {
  return `
$user_id = ${JSON.stringify(userId)};
$user = get_user_by( 'id', $user_id );
if ( ! $user ) {
    throw new RuntimeException( 'Browser auth requires the requested WordPress user to exist.' );
}
wp_set_current_user( $user_id );
$expiration = time() + HOUR_IN_SECONDS;
$token = '';
if ( class_exists( 'WP_Session_Tokens' ) ) {
    $token = WP_Session_Tokens::get_instance( $user_id )->create( $expiration );
}
$browser_urls = ${JSON.stringify(browserUrls)};
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
echo wp_json_encode( $cookies );
`
}

export function browserAuthCookieHostSummary(cookies: Array<{ domain?: string }>): Array<{ host: string; cookieCount: number }> {
  const counts = new Map<string, number>()
  for (const cookie of cookies) {
    const host = normalizeBrowserCookieHost(String(cookie.domain ?? ""))
    if (!host) continue
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([host, cookieCount]) => ({ host, cookieCount }))
}

function normalizeBrowserCookieHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "")
}
