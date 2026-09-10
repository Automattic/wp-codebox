// Run with the repository development dependencies: npx tsx scripts/verify-cloudflare-sqlite-delete-alias.ts
// Uses the generated pinned SQLite archive and PHP-WASM; no native php executable required.
import { readFile } from 'node:fs/promises';
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime } from '@php-wasm/node';
import { decodeZip } from '@php-wasm/stream-compression';
import { patchSqliteDeleteAlias } from '../packages/runtime-cloudflare/src/sqlite-delete-alias-compatibility.js';
import assert from 'node:assert/strict';
const zip=await readFile(new URL('../packages/runtime-cloudflare/artifacts/cloudflare-sqlite-database-integration.zip', import.meta.url));
const php = new PHP(await loadNodeRuntime('8.4', {emscriptenOptions:{processId:process.pid}}));
let driverPath='';let original='';
for await(const entry of decodeZip(new Blob([zip]).stream())){
 if(entry.name.endsWith('/'))continue;
 const p='/tmp/sqlite-alias-proof/'+entry.name;
 php.mkdir(p.slice(0,p.lastIndexOf('/')));
 const data=new Uint8Array(await entry.arrayBuffer());
 php.writeFile(p,data);
 if(p.endsWith('class-wp-pdo-mysql-on-sqlite.php')) {driverPath=p;original=new TextDecoder().decode(data);}
}
const code=String.raw`<?php
require '/tmp/sqlite-alias-proof/plugin-sqlite-database-integration/wp-includes/database/load.php';
set_error_handler(function($n,$s){throw new Exception($s);});
$db=new WP_PDO_MySQL_On_SQLite('mysql-on-sqlite:dbname=proof');
$db->exec('CREATE TABLE wp_options (option_id bigint unsigned NOT NULL AUTO_INCREMENT, option_name varchar(191) NOT NULL, option_value longtext NOT NULL, PRIMARY KEY(option_id), UNIQUE KEY option_name(option_name))');
$db->exec("INSERT INTO wp_options(option_name,option_value) VALUES ('target','before'),('design_version','v1'),('untouched','keep')");
$prefix="DELETE target FROM wp_options AS target LEFT JOIN wp_options AS design_version ON design_version.option_name='design_version' WHERE target.option_name='target' AND BINARY target.option_value=BINARY 'before' AND BINARY design_version.option_value=BINARY ";
try {
 $stale=$db->exec($prefix."'stale'");
 $before=$db->query("SELECT option_value FROM wp_options WHERE option_name='target'")->fetchColumn();
 $deleted=$db->exec($prefix."'v1'");
 $remaining=$db->query('SELECT option_name,option_value FROM wp_options ORDER BY option_name')->fetchAll(PDO::FETCH_ASSOC);
 echo json_encode(compact('stale','before','deleted','remaining'));
} catch(Throwable $e) {echo json_encode(['error'=>$e->getMessage()]);}
`;
try{
 const before=await php.run({code}); const observed=JSON.parse(before.text); assert.match(observed.error,/target/); console.log(JSON.stringify({unpatched:observed}));
 const patched=patchSqliteDeleteAlias(original);assert.equal(patchSqliteDeleteAlias(patched),patched);php.writeFile(driverPath,patched);
 const after=await php.run({code});const result=JSON.parse(after.text);
 assert.equal(result.stale,0);assert.equal(result.before,'before');assert.equal(result.deleted,1);assert.deepEqual(result.remaining,[{option_name:'design_version',option_value:'v1'},{option_name:'untouched',option_value:'keep'}]);
 console.log(JSON.stringify({patched:result,status:'actual-sqlite-compare-and-delete-passed'}));
}finally{php.exit();}
