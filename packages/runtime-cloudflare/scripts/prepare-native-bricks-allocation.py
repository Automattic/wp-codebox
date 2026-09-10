#!/usr/bin/env python3
"""Prepare an empty, isolated local D1/R2 Bricks allocation; never writes its source.

The source is a retained Miniflare fixture containing the agency-authorized runtime
package. WordPress baseline data comes from the checked-in canonical seed. Customer
pages, media, design resources, histories, and credentials are not copied.
"""
import argparse, base64, datetime, hashlib, io, json, re, secrets, sqlite3, uuid, zipfile
from urllib.parse import urlparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-state', type=Path, required=True)
    parser.add_argument('--destination-state', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runtime-zip', type=Path, required=True)
    parser.add_argument('--runtime-version', default='2.4-rc')
    parser.add_argument('--port', type=int, default=8809)
    parser.add_argument('--site-id', default='default')
    parser.add_argument('--origin')
    args = parser.parse_args()
    if not re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*',args.site_id) or len(args.site_id)>63: raise RuntimeError('Invalid site ID.')
    site=args.site_id; origin=args.origin or 'http://127.0.0.1:'+str(args.port)
    parsed_origin=urlparse(origin)
    if parsed_origin.path or parsed_origin.query or parsed_origin.fragment or parsed_origin.username or not parsed_origin.hostname: raise RuntimeError('Origin must be canonical.')
    package = Path(__file__).resolve().parents[1]
    source, dest, output = args.source_state.resolve(), args.destination_state.resolve(), args.output.resolve()
    if dest.exists() or output.exists() or dest == source or source in dest.parents:
        raise RuntimeError('Destination state and output must be new directories outside the source.')
    dest.mkdir(parents=True); output.mkdir(parents=True)
    source_d1 = next(path for path in (source/'v3/d1/miniflare-D1DatabaseObject').glob('*.sqlite') if path.name != 'metadata.sqlite')
    source_r2 = next(path for path in (source/'v3/r2/miniflare-R2BucketObject').glob('*.sqlite') if path.name != 'metadata.sqlite')
    source_blobs = next(path/'blobs' for path in (source/'v3/r2').iterdir() if path.is_dir() and path.name != 'miniflare-R2BucketObject')
    source_database, source_objects = sqlite3.connect(source_d1), sqlite3.connect(source_r2)
    current = source_database.execute("SELECT revision,manifest_key,persisted_at FROM wp_codebox_state WHERE site_id='default'").fetchone()
    if not current or not current[0]: raise RuntimeError('Source fixture has no canonical pointer.')
    def body(key):
        row = source_objects.execute('SELECT blob_id,size FROM _mf_objects WHERE key=?',(key,)).fetchone()
        if not row: raise RuntimeError('Source object unavailable: '+key)
        data = (source_blobs/row[0]).read_bytes()
        if len(data) != row[1]: raise RuntimeError('Source object size mismatch.')
        return data
    manifest = json.loads(body(current[1]))
    if not any(file['path']=='themes/bricks/style.css' for file in manifest['wpContent']): raise RuntimeError('Source fixture has no Bricks runtime.')
    object_db = dest/source_r2.relative_to(source); object_db.parent.mkdir(parents=True)
    objects = sqlite3.connect(object_db); source_objects.backup(objects)
    objects.execute('DELETE FROM _mf_objects')
    blobs = dest/source_blobs.relative_to(source); blobs.mkdir(parents=True)
    def put(key,data,content_type='application/octet-stream'):
        blob = uuid.uuid4().hex
        (blobs/blob).write_bytes(data)
        objects.execute('INSERT OR REPLACE INTO _mf_objects(key,blob_id,version,size,etag,uploaded,checksums,http_metadata,custom_metadata) VALUES(?,?,?,?,?,?,?,?,?)',(key,blob,uuid.uuid4().hex,len(data),hashlib.md5(data).hexdigest(),int(datetime.datetime.now().timestamp()*1000),'{}',json.dumps({'contentType':content_type}),'{}'))
    # Runtime archives/manifests are global; omit every previous site's state.
    for (key,) in source_objects.execute("SELECT key FROM _mf_objects WHERE key NOT LIKE 'sites/%'"):
        put(key,body(key))
    # Vendor files come directly from the pinned ZIP, never from a patched proof fixture.
    wp_content = [file for file in manifest['wpContent'] if not file['path'].startswith('themes/bricks/')]
    for file in wp_content:
        data = body(file['objectKey'])
        if hashlib.sha256(data).hexdigest() != file['sha256']: raise RuntimeError('Runtime file digest mismatch.')
        file['objectKey']='sites/'+site+'/wp-content/objects/'+file['sha256']
        put(file['objectKey'],data)
    with zipfile.ZipFile(args.runtime_zip) as vendor_zip:
        for entry in vendor_zip.infolist():
            if entry.is_dir(): continue
            if not entry.filename.startswith('bricks/') or '..' in Path(entry.filename).parts: raise RuntimeError('Unexpected Bricks ZIP path.')
            data=vendor_zip.read(entry); digest=hashlib.sha256(data).hexdigest()
            record={'path':'themes/'+entry.filename,'objectKey':'sites/'+site+'/wp-content/objects/'+digest,'sha256':digest,'size':len(data)}
            put(record['objectKey'],data); wp_content.append(record)
    wp_content.sort(key=lambda file:file['path'])
    with zipfile.ZipFile(package/'assets/markdown-database-integration-canonical-seed.zip') as seed:
        files = {name:seed.read(name) for name in seed.namelist() if not name.endswith('.md')}
    for file in manifest['files']:
        if file['path'] in {'_options/template.json','_options/stylesheet.json','_options/bricks_mcp_settings.json','_options/bricks_global_settings.json'}:
            files[file['path']] = body(file['objectKey'])
    def option(name,value):
        path = '_options/'+name+'.json'; row=json.loads(files[path]); row['option_value']=value
        files[path]=json.dumps(row,indent=4).encode()
    option('home',origin); option('siteurl',origin)
    option('blogname','Native Bricks API rehearsal'); option('blogdescription','Isolated native runtime API proof')
    option('page_on_front','0'); option('show_on_front','posts'); option('blog_public','0')
    password,token,claim = secrets.token_urlsafe(32),secrets.token_urlsafe(32),secrets.token_urlsafe(32)
    users=json.loads(files['_tables/users.json']); users[0]['user_pass']=hashlib.md5(password.encode()).hexdigest(); users[0]['user_email']='operator@native-rehearsal.invalid'; users[0]['user_url']=''
    files['_tables/users.json']=json.dumps(users,indent=4).encode()
    canonical=[]
    for path,data in sorted(files.items()):
        sha=hashlib.sha256(data).hexdigest(); key='sites/'+site+'/markdown/objects/'+sha
        put(key,data); canonical.append({'path':path,'objectKey':key,'sha256':sha,'size':len(data)})
    revision=str(uuid.uuid4()); stamp=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    pointer={'revision':revision,'manifestKey':'sites/'+site+'/markdown/revisions/'+revision+'.json','persistedAt':stamp}
    clean={**pointer,'files':canonical,'uploads':[],'wpContent':wp_content,'wpContentDeleted':[]}
    # Prepare the one-read PHP reconstruction pack outside Worker request limits.
    runtime_files=[file for file in wp_content if not file['path'].startswith(('themes/bricks/assets/','themes/bricks/languages/'))]
    packed=[('markdown/'+file['path'],file) for file in canonical]+[('wp-content/'+file['path'],file) for file in runtime_files]
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as pack:
        for name,file in sorted(packed):
            blob=objects.execute('SELECT blob_id FROM _mf_objects WHERE key=?',(file['objectKey'],)).fetchone()[0]
            pack.writestr(name,(blobs/blob).read_bytes())
        pack.writestr('metadata/wp-content-deleted.json','{"wpContentDeleted":[]}')
    packed_bytes=buffer.getvalue(); digest=hashlib.sha256(packed_bytes).hexdigest()
    metadata={'schema':'wp-codebox/cloudflare-canonical-restore-pack/v1','objectKey':'sites/'+site+'/restore-packs/'+digest+'.zip','sha256':digest,'size':len(packed_bytes),'fileCount':len(packed),'decodedBytes':sum(file['size'] for _,file in packed)}
    put(metadata['objectKey'],packed_bytes,'application/zip'); clean['restorePack']=metadata
    put(pointer['manifestKey'],json.dumps(clean,separators=(',',':')).encode(),'application/json'); objects.commit()
    target_d1=dest/source_d1.relative_to(source); target_d1.parent.mkdir(parents=True)
    database=sqlite3.connect(target_d1); source_database.backup(database); database.execute('PRAGMA foreign_keys=OFF')
    for (name,) in database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").fetchall():
        database.execute('DELETE FROM "'+name.replace('"','""')+'"')
    database.execute('INSERT INTO wp_codebox_state(site_id,revision,manifest_key,persisted_at,version) VALUES(?,?,?,?,1)',(site,revision,pointer['manifestKey'],stamp))
    database.execute('INSERT INTO wp_codebox_commits(site_id,version,revision,manifest_key,persisted_at) VALUES(?,1,?,?,?)',(site,revision,pointer['manifestKey'],stamp)); database.commit()
    runtime={'version':args.runtime_version,'sha256':hashlib.sha256(args.runtime_zip.read_bytes()).hexdigest()}
    config={'name':'native-bricks-api-local-rehearsal','main':str(package/'src/worker-d1.ts'),'compatibility_date':'2026-07-18','compatibility_flags':['nodejs_compat'],'limits':{'cpu_ms':300000},'r2_buckets':[{'binding':'WORDPRESS_STATE_BUCKET','bucket_name':source_blobs.parent.name}],'d1_databases':[{'binding':'WORDPRESS_STATE_DATABASE','database_name':'wp-codebox-runtime-state','database_id':'00000000-0000-0000-0000-000000000000'}],'rules':[{'type':'CompiledWasm','globs':['**/*.wasm'],'fallthrough':False},{'type':'Data','globs':['**/*.sqlite','**/*-runtime.zip','**/*-canonical-seed.zip'],'fallthrough':False}],'vars':{'WORDPRESS_SITE_CONTEXTS':json.dumps([{'id':site,'hostname':parsed_origin.hostname,'origin':origin}]),'WORDPRESS_BRICKS_PREPARED_ALLOCATIONS':json.dumps({site:{**pointer,'runtime':runtime}}),'WORDPRESS_NATIVE_DEPLOYMENT_VERSION':'local-native-api-rehearsal'}}
    (output/'wrangler.jsonc').write_text(json.dumps(config,indent=2)+'\n')
    expires=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1)).isoformat(timespec='milliseconds').replace('+00:00','Z')
    credentials=[{'id':'native-rehearsal','principal':'native-rehearsal','digest':hashlib.sha256(token.encode()).hexdigest(),'scopes':['sites:create','sites:read','sites:import'],'expiresAt':expires,'maxSites':1,'sites':[site]}]
    secret_values={'WORDPRESS_API_TOKENS':json.dumps(credentials),'WORDPRESS_ADMIN_PASSWORD':password,'WORDPRESS_ADMIN_CLAIM_SECRET':claim,'WORDPRESS_AUTH_SECRET':secrets.token_urlsafe(48)}
    (output/'secrets.json').write_text(json.dumps(secret_values)); (output/'secrets.json').chmod(0o600)
    (output/'.dev.vars').write_text('\n'.join(k+"='"+v+"'" for k,v in secret_values.items())+'\n'); (output/'.dev.vars').chmod(0o600)
    (output/'credentials.json').write_text(json.dumps({'apiToken':token,'adminPassword':password})); (output/'credentials.json').chmod(0o600)
    receipt={'schema':'wp-codebox/native-bricks-prepared-allocation/v1','environment':'local-only','siteId':site,'origin':origin,'sourceRevision':current[0],'pointer':pointer,'runtime':runtime,'emptyNativeDocuments':True,'uploadCount':0,'canonicalFileCount':len(canonical),'runtimeFileCount':len(wp_content),'stateDirectory':str(dest),'config':str(output/'wrangler.jsonc')}
    (output/'prepared.json').write_text(json.dumps(receipt,indent=2)+'\n'); print(json.dumps(receipt))

if __name__=='__main__':main()
