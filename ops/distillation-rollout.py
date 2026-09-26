#!/usr/bin/env python3
"""Activate durable SQL + coordinated cleanup, or enter authenticated maintenance."""
import argparse, datetime, hashlib, importlib.util, json, os, pathlib, plistlib, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('http_rollout',ROOT/'ops/http-rollout.py')
http=importlib.util.module_from_spec(spec);spec.loader.exec_module(http)

def planned(raw, maintenance):
    value=plistlib.loads(raw)
    if value['ProgramArguments'][-1]!=str(ROOT/'src/server-hardened.ts'):
        raise ValueError('Hardened HTTP entry required')
    env=value.setdefault('EnvironmentVariables',{})
    if maintenance:
        env['OPEN_BRAIN_MAINTENANCE']='1';env['OPEN_BRAIN_DISABLE_CLEANUP']='1'
    else:
        env.pop('OPEN_BRAIN_MAINTENANCE',None);env.pop('OPEN_BRAIN_DISABLE_CLEANUP',None)
    return plistlib.dumps(value)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['activate','maintenance','check-rollback'])
    p.add_argument('--state',required=True,type=pathlib.Path)
    p.add_argument('--apply',action='store_true')
    a=p.parse_args()
    server=pathlib.Path.home()/'Library/LaunchAgents/com.open-brain.server.plist'
    raw=server.read_bytes();active=planned(raw,False);maintenance=planned(raw,True)
    if a.action=='check-rollback':
        state=json.loads(a.state.read_text())
        if hashlib.sha256(raw).hexdigest() not in state['allowed_hashes']:raise ValueError('Plist changed after rollout')
        print('Maintenance rollback available; no data/schema/client rewind');return
    if not a.apply:raise ValueError('Mutation requires --apply')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    if a.action=='activate' and a.state.exists():raise ValueError('State exists; inspect previous attempt')
    if a.action=='maintenance':
        state=json.loads(a.state.read_text())
        if hashlib.sha256(raw).hexdigest() not in state['allowed_hashes']:raise ValueError('Concurrent plist change')
    else:
        a.state.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        _,snapshot=http.backup(server,stamp)
        state={'created_at':stamp,'snapshot':snapshot,'allowed_hashes':[hashlib.sha256(x).hexdigest() for x in [raw,active,maintenance]],'phase':'prepared'}
        http.atomic(a.state,(json.dumps(state,indent=2)+'\n').encode())
    target=f'gui/{os.getuid()}/com.open-brain.server'
    node=plistlib.loads(raw)['ProgramArguments'][0]
    def run(args,name):
        result=subprocess.run([node,*args],cwd=ROOT,capture_output=True,timeout=600)
        if result.returncode:raise ValueError(f'{name} failed (private diagnostics suppressed)')
        # Counts/hashes only; full private proof remains beside manifest.
        proof=a.state.parent/(name+'.json');http.atomic(proof,result.stdout)
        return json.loads(result.stdout)
    http.stop_server(target)
    try:
        if a.action=='activate':
            run(['scripts/backup/cli.mjs','backup'],'backup-before-migration')
            run(['scripts/backup/cli.mjs','restore'],'restore-before-migration')
            run(['ops/distillation-db.mjs','migrate'],'migration')
        http.atomic(server,active if a.action=='activate' else maintenance,raw)
        http.launch('enable',target);http.launch('bootstrap',f'gui/{os.getuid()}',str(server))
        state['phase']='active' if a.action=='activate' else 'maintenance'
        http.atomic(a.state,(json.dumps(state,indent=2)+'\n').encode())
        print(json.dumps({'phase':state['phase'],'state':str(a.state)}))
    except Exception:
        # Fail to authenticated maintenance; never restart the legacy distiller.
        current=server.read_bytes()
        if hashlib.sha256(current).hexdigest() in state['allowed_hashes']:
            http.stop_server(target)
            http.atomic(server,maintenance,current)
            http.launch('bootstrap',f'gui/{os.getuid()}',str(server),required=False)
        raise

if __name__=='__main__':
    try:main()
    except Exception as e:sys.exit(str(e) if isinstance(e,ValueError) else 'Rollout failed; inspect private state')
