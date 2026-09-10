#!/usr/bin/env python3
"""Upload only a prepared native-api/native-engine namespace to the existing disposable canary."""
import concurrent.futures, hashlib, json, sqlite3, sys, time, tomllib
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
ACCOUNT='c9a6d8fc0e01d908d3d399d12043b2fb'
BUCKET='bricks24-native-canary-20260910'
D1='fe4d6486-6cd6-4a2e-9542-4f2dd8af7d8a'
output=Path(sys.argv[1]).resolve()
prepared=json.loads((output/'prepared.json').read_text())
site=prepared.get('siteId')
if site not in {'native-api','native-engine'}: raise RuntimeError('This bounded uploader accepts only the two isolated native rehearsal namespaces.')
state=Path(prepared['stateDirectory'])/'v3'
oauth=tomllib.loads((Path.home()/'Library/Preferences/.wrangler/config/default.toml').read_text())['oauth_token']
base='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT

def api(path,method='GET',data=None,headers=None):
    for attempt in range(8):
        try:
            with urlopen(Request(base+path,data=data,method=method,headers={'Authorization':'Bearer '+oauth,**(headers or {})}),timeout=90) as response:
                return response.read()
        except HTTPError as error:
            if error.code in [429,500,502,503,504] and attempt<7:
                time.sleep(min(60,int(error.headers.get('retry-after','0')) or 2**attempt));continue
            raise RuntimeError('Cloudflare operation failed: HTTP '+str(error.code)+' '+error.read().decode()[:300]) from None

def query(sql,params=[]):
    response=json.loads(api('/d1/database/'+D1+'/query','POST',json.dumps({'sql':sql,'params':params}).encode(),{'Content-Type':'application/json'}))
    if not response.get('success'): raise RuntimeError('D1 query failed: '+str(response.get('errors')))
    return response['result']

prior=query("SELECT site_id,revision,manifest_key,persisted_at,version FROM wp_codebox_state WHERE site_id IN ('default',?)",[site])[0]['results']
if any(row['site_id']==site for row in prior): raise RuntimeError('native-api already has a canonical pointer; no upload or reset performed.')
(output/'remote-before.json').write_text(json.dumps(prior,indent=2))
db=sqlite3.connect(next(file for file in (state/'r2/miniflare-R2BucketObject').glob('*.sqlite') if file.name!='metadata.sqlite'))
objects=db.execute("SELECT key,blob_id,size,http_metadata FROM _mf_objects WHERE key LIKE ?",('sites/'+site+'/%',)).fetchall()
blobs=state/'r2/wp-codebox-runtime-chubes/blobs'
progress_file=output/'uploaded-objects.jsonl'
completed={json.loads(line)['key'] for line in progress_file.read_text().splitlines()} if progress_file.exists() else set()

def upload(row):
    key,blob,size,metadata=row
    content=(blobs/blob).read_bytes()
    if len(content)!=size: raise RuntimeError('Prepared object size mismatch')
    digest=hashlib.sha256(content).hexdigest()
    if '/objects/' in key and key.rsplit('/',1)[1]!=digest: raise RuntimeError('Prepared immutable object digest mismatch')
    if key not in completed:
        api('/r2/buckets/'+BUCKET+'/objects/'+key,'PUT',content,{'Content-Type':json.loads(metadata).get('contentType','application/octet-stream')})
    return {'key':key,'sha256':digest,'bytes':size}

with progress_file.open('a') as log, concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    for index,receipt in enumerate(pool.map(upload,objects),1):
        if receipt['key'] not in completed:log.write(json.dumps(receipt)+'\n');log.flush()
        if index%100==0 or index==len(objects):print(json.dumps({'uploaded':index,'total':len(objects)}),flush=True)
pointer=prepared['pointer']
query('INSERT INTO wp_codebox_state(site_id,revision,manifest_key,persisted_at,version) VALUES(?,?,?,?,1)', [site,pointer['revision'],pointer['manifestKey'],pointer['persistedAt']])
query('INSERT INTO wp_codebox_commits(site_id,version,revision,manifest_key,persisted_at) VALUES(?,1,?,?,?)',[site,pointer['revision'],pointer['manifestKey'],pointer['persistedAt']])
after=query("SELECT site_id,revision,manifest_key,persisted_at,version FROM wp_codebox_state WHERE site_id IN ('default',?)",[site])[0]['results']
if next(row for row in prior if row['site_id']=='default')!=next(row for row in after if row['site_id']=='default'):raise RuntimeError('Default canonical pointer changed during preparation')
receipt={'status':'isolated-remote-allocation-prepared','account':ACCOUNT,'bucket':BUCKET,'database':D1,'objects':len(objects),'bytes':sum(row[2] for row in objects),'before':prior,'after':after}
(output/'remote-prepared.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
