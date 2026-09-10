import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { D1OperationRepository } from '../src/d1-operation-repository.js'
import { isProtectedNativeSite, nativePreviewPathAllowed, nativePreviewReceipt, rewriteNativePreview, routeNativeBricksPreview, type NativePreviewBackend } from '../src/bricks-preview.js'
import type { NativeEnv } from '../src/native-bricks-api.js'
import type { RevisionState } from '../src/revision-coordinator.js'
function database() {
  const sqlite=new DatabaseSync(':memory:')
  const db={prepare(query:string){const statement=sqlite.prepare(query);let values:any[]=[];return{bind(...args:any[]){values=args;return this},async run(){return{meta:{changes:statement.run(...values).changes}}},async first(){return statement.get(...values)??null},async all(){return{results:statement.all(...values)}}}},async batch(statements:any[]){return Promise.all(statements.map(statement=>statement.run()))}} as unknown as D1Database
  return {db,sqlite}
}
const site={id:'native-engine',hostname:'native.example',origin:'https://native.example'}
const pointer={revision:'revision-a',manifestKey:'sites/native-engine/markdown/revisions/a.json',persistedAt:'2026-09-10T00:00:00Z'}
async function fixture(scope='sites:read',principal='owner',sites=['native-engine']) {
  const {db,sqlite}=database();await new D1OperationRepository(db).initialize()
  sqlite.exec('CREATE TABLE wp_codebox_native_operations(site_id TEXT,principal TEXT,state TEXT,receipt_json TEXT,generation INTEGER)')
  sqlite.prepare("INSERT INTO wp_codebox_sites(site_id,hostname,origin,state,created_at,activated_at,updated_at,generation) VALUES(?,?,?,'active',1,1,1,1)").run(site.id,site.hostname,site.origin)
  const receipt={site_id:site.id,revision_receipt:{receipt_id:'receipt_a',canonical_state_version:2,canonical_state_revision:pointer.revision,canonical_manifest_key:pointer.manifestKey,canonical_persisted_at:pointer.persistedAt}}
  sqlite.prepare("INSERT INTO wp_codebox_native_operations VALUES(?,'owner','succeeded',?,1)").run(site.id,JSON.stringify(receipt))
  const env:NativeEnv={WORDPRESS_STATE_DATABASE:db,WORDPRESS_STATE_BUCKET:{} as R2Bucket,WORDPRESS_SITE_CONTEXTS:JSON.stringify([site]),WORDPRESS_BRICKS_PREPARED_ALLOCATIONS:JSON.stringify({[site.id]:{}}),WORDPRESS_API_TOKENS:JSON.stringify([{id:'preview',principal,digest:createHash('sha256').update('credential').digest('hex'),scopes:[scope],sites,expiresAt:'2099-01-01T00:00:00.000Z',maxSites:1}])}
  let renders=0;let state:RevisionState={schema:'wp-codebox/cloudflare-wordpress-state/v2',store:'d1',version:2,pointer}
  const backend:NativePreviewBackend={state:async()=>state,render:async(request,_site,received)=>{renders++;assert.deepEqual(received,pointer);assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('cookie'),false);return new Response('<h1 class="brxe-heading">Native content</h1><img src="https://native.example/wp-content/uploads/a.jpg"><link href="/wp-content/themes/bricks/a.css">',{headers:{'content-type':'text/html','cache-control':'public,max-age=60','set-cookie':'logged_in=bad','etag':'old'}})}}
  const request=(path='/',headers:Record<string,string>={},method='GET')=>new Request(`https://control.example/v1/bricks/sites/${site.id}/previews/receipt_a${path}`,{method,headers:{authorization:'Bearer credential','x-wp-codebox-preview-base':'/preview/protected_view',...headers}})
  return {env,sqlite,backend,request,renders:()=>renders,setState:(value:RevisionState)=>{state=value},state}
}
test('native preview authenticates exact receipt and rewrites HTML assets under private customer mount',async()=>{
  const f=await fixture();const response=(await routeNativeBricksPreview(f.request('/',{cookie:'wordpress_logged_in=secret'}),f.env,f.backend))!
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('etag'),null)
  assert.equal(response.headers.get('x-wp-codebox-native-receipt'),'receipt_a');assert.equal(response.headers.get('x-wp-codebox-canonical-version'),'2')
  const html=await response.text();assert.match(html,/brxe-heading/);assert.match(html,/src="\/preview\/protected_view\/wp-content\/uploads\/a.jpg"/);assert.match(html,/href="\/preview\/protected_view\/wp-content\/themes\/bricks\/a.css"/)
  assert.equal(html.includes('native.example'),false);assert.equal(f.renders(),1)
})
test('native preview denies wrong credentials, scope, principal, site and uncommitted receipt before PHP',async()=>{
  for(const [scope,principal,sites,status] of [['sites:create','owner',[site.id],403],['sites:read','foreign',[site.id],404],['sites:read','owner',['elsewhere'],404]] as const){const f=await fixture(scope,principal,[...sites]);assert.equal((await routeNativeBricksPreview(f.request(),f.env,f.backend))!.status,status);assert.equal(f.renders(),0)}
  const f=await fixture();assert.equal((await routeNativeBricksPreview(f.request('/',{authorization:''}),f.env,f.backend))!.status,401)
  f.sqlite.exec("UPDATE wp_codebox_native_operations SET state='running'");assert.equal((await routeNativeBricksPreview(f.request(),f.env,f.backend))!.status,404);assert.equal(f.renders(),0)
})
test('native preview rejects stale or concurrently replaced canonical revision and inactive allocation',async()=>{
  for(const phase of ['before','during']) {const f=await fixture();if(phase==='before')f.setState({...f.state,version:3});else f.backend.render=async()=>{f.setState({...f.state,version:3});return new Response('stale body')};const response=(await routeNativeBricksPreview(f.request(),f.env,f.backend))!;assert.equal(response.status,409);assert.equal((await response.text()).includes('stale body'),false)}
  const f=await fixture();f.sqlite.exec("UPDATE wp_codebox_sites SET generation=2");assert.equal((await routeNativeBricksPreview(f.request(),f.env,f.backend))!.status,410);assert.equal(f.renders(),0)
})
test('native preview denies admin/PHP/actions/encoded paths and writes while permitting browser assets and frontend reads',async()=>{
  for(const path of ['/wp-admin/','/wp-login.php','/index.php','/wp-json/','/__internal','/wp-content/secret.json','/wp-content/a.php','/%77p-admin/','/?bricks=run','/?action=delete','/?rest_route=/wp/v2/users']) {const f=await fixture();assert.equal((await routeNativeBricksPreview(f.request(path),f.env,f.backend))!.status,403,path);assert.equal(f.renders(),0)}
  for(const path of ['/','/services/','/?p=13','/wp-content/themes/bricks/a.css?ver=2.4','/wp-content/uploads/a.webp','/wp-includes/js/jquery/jquery.min.js']){const url=new URL(path,'https://example.test');assert.equal(nativePreviewPathAllowed(url.pathname,url.searchParams),true,path)}
  const f=await fixture();assert.equal((await routeNativeBricksPreview(f.request('/',{},'POST'),f.env,f.backend))!.status,405)
})
test('native preview streams binary assets privately and rewrites only authorized frontend redirects',async()=>{
  const f=await fixture();f.backend.render=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}})
  const asset=(await routeNativeBricksPreview(f.request('/wp-content/uploads/a.jpg'),f.env,f.backend))!;assert.deepEqual(new Uint8Array(await asset.arrayBuffer()),new Uint8Array([1,2,3]));assert.equal(asset.headers.get('cache-control'),'private, no-store')
  f.backend.render=async()=>new Response(null,{status:301,headers:{location:'https://native.example/services/'}});assert.equal((await routeNativeBricksPreview(f.request(),f.env,f.backend))!.headers.get('location'),'/preview/protected_view/services/')
  f.backend.render=async()=>new Response(null,{status:302,headers:{location:'/wp-admin/'}});assert.equal((await routeNativeBricksPreview(f.request(),f.env,f.backend))!.status,409)
})
test('native protection includes prepared and previously owned allocations while public default is unchanged',async()=>{
  const f=await fixture();assert.equal(await isProtectedNativeSite(f.env,site),true)
  delete f.env.WORDPRESS_BRICKS_PREPARED_ALLOCATIONS;assert.equal(await isProtectedNativeSite(f.env,site),true)
  f.sqlite.exec('DELETE FROM wp_codebox_native_operations');assert.equal(await isProtectedNativeSite(f.env,site),false)
  f.env.WORDPRESS_BRICKS_PREPARED_ALLOCATIONS=JSON.stringify({[site.id]:{},default:{}});assert.equal(await isProtectedNativeSite(f.env,site),true);assert.equal(await isProtectedNativeSite(f.env,{...site,id:'default'}),false)
  assert.equal(nativePreviewReceipt(site,'receipt_a','https://runtime.example').url,'https://runtime.example/v1/bricks/sites/native-engine/previews/receipt_a/')
  assert.equal(nativePreviewReceipt({...site,id:'default'},'receipt_a','https://runtime.example').state,'requested')
})
test('native URL rewriting handles CSS/srcset/escaped JSON without adding mount twice',()=>{
  const value='<img srcset="/wp-content/a.jpg 1x, /wp-content/b.jpg 2x"><style>a{background:url(/wp-content/c.jpg)}</style><script>var u="https:\\/\\/native.example\\/wp-content\\/d.js";</script>'
  const output=rewriteNativePreview(value,site.origin,'/preview/token');assert.equal(output.includes('native.example'),false);assert.match(output,/url\(\/preview\/token\/wp-content\/c.jpg\)/);assert.match(output,/, \/preview\/token\/wp-content\/b.jpg/);assert.equal(output.includes('/preview/token/preview/token'),false)
})
