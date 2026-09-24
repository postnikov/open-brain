#!/usr/bin/env python3
"""Approved local HTTP cutover; rollback keeps HTTP off and clients on stdio.

Backups are dated, adjacent and 0600. Only the open-brain sections are edited.
No token values are read or stored by this script. Run --help before use.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shlex
import subprocess
import sys
import tempfile
import time
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]


def replace_toml(raw, entry):
    # Only the existing flat section is supported; fail rather than eat subtables.
    parsed = tomllib.loads(raw)
    old = parsed['mcp_servers']['open-brain']
    if any(isinstance(v, dict) for v in old.values()):
        raise ValueError('Nested open-brain tables need an explicit migration')
    pattern = r'(?m)^\[mcp_servers\.open-brain\][^\n]*\n(?:(?!\[).*(?:\n|$))*'
    replacement = '[mcp_servers.open-brain]\n' + ''.join(
        f'{k} = {json.dumps(v)}\n' for k, v in entry.items()) + '\n'
    updated, count = re.subn(pattern, lambda _: replacement, raw)
    if count != 1:
        raise ValueError('Expected exactly one open-brain section')
    expected = copy.deepcopy(parsed)
    expected['mcp_servers']['open-brain'] = entry
    if tomllib.loads(updated) != expected:
        raise ValueError('Unrelated TOML settings would change')
    return updated


def atomic(path, data, expected=None):
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if expected is not None and path.read_bytes() != expected:
            raise ValueError('Concurrent config change; retry from a fresh snapshot')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def backup(path, stamp):
    data = path.read_bytes()
    target = path.with_name(path.name + '.pre-open-brain-' + stamp + '.bak')
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    return data, {'path': str(path), 'backup': str(target), 'sha256': hashlib.sha256(data).hexdigest()}


def launch(*args, required=True):
    result = subprocess.run(['/bin/launchctl', *args], capture_output=True)
    if required and result.returncode:
        raise ValueError(f'launchctl {args[0]} failed, exit {result.returncode} (private details suppressed)')
    return result.returncode


def stop_server(target):
    # launchd can return nonzero from bootout while successfully removing a job.
    # Verify the resulting state before deciding whether cutover failed.
    launch('bootout', target, required=False)
    for _ in range(25):
        if launch('print', target, required=False) == 113:
            return
        time.sleep(0.2)
    raise ValueError('Server job did not unload; refusing to start another listener')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['activate', 'rollback', 'check-rollback'])
    p.add_argument('--state', type=pathlib.Path, required=True, help='Private manifest path, outside git')
    p.add_argument('--service', default='vibe/open-brain/OPEN_BRAIN_HTTP_TOKEN')
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    home = pathlib.Path.home()
    claude = home / '.claude.json'
    codex = home / '.codex/config.toml'
    server = home / 'Library/LaunchAgents/com.open-brain.server.plist'
    target = f'gui/{os.getuid()}/com.open-brain.server'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    if a.action == 'activate':
        if not a.apply:
            raise ValueError('Activation requires --apply')
        if a.state.exists():
            raise ValueError('Manifest exists; use a new path')
        c_raw, c_copy = backup(claude, stamp)
        x_raw, x_copy = backup(codex, stamp)
        s_raw, s_copy = backup(server, stamp)
        c = json.loads(c_raw)
        x = tomllib.loads(x_raw.decode())
        s = plistlib.loads(s_raw)
        if s['ProgramArguments'][-1] != str(ROOT / 'src/server.ts'):
            raise ValueError('Server is not at the expected legacy baseline')
        expected_c = {'type': 'http', 'url': 'http://localhost:3100/mcp'}
        expected_x = {'url': 'http://localhost:3100/mcp'}
        if c['mcpServers']['open-brain'] != expected_c or x['mcp_servers']['open-brain'] != expected_x:
            raise ValueError('Client baseline changed; inspect before migration')
        node, tsx = s['ProgramArguments'][:2]
        helper = shlex.join([node, tsx, str(ROOT / 'src/security/headers.ts'), a.service])
        new_c = {'type': 'http', 'url': 'http://127.0.0.1:3100/mcp', 'headersHelper': helper}
        new_x = {'url': 'http://127.0.0.1:3100/mcp', 'http_headers_helper': helper}
        c['mcpServers']['open-brain'] = new_c
        new_toml = replace_toml(x_raw.decode(), new_x)
        s['ProgramArguments'][-1] = str(ROOT / 'src/server-hardened.ts')
        s.setdefault('EnvironmentVariables', {})['OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE'] = a.service
        s['EnvironmentVariables']['OPEN_BRAIN_BIND_HOST'] = '127.0.0.1'
        # A restart must not delete pending input via the legacy TTL policy.
        s['EnvironmentVariables']['OPEN_BRAIN_DISABLE_CLEANUP'] = '1'
        if 'OPEN_BRAIN_HTTP_TOKEN_FILE' in s['EnvironmentVariables']:
            raise ValueError('Ambiguous token source')
        a.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        manifest = {'created_at': stamp, 'files': [c_copy, x_copy, s_copy], 'claude_entry': new_c, 'codex_entry': new_x,
                    'old_claude_entry': expected_c, 'old_codex_entry': expected_x,
                    'server_sha256': hashlib.sha256(plistlib.dumps(s)).hexdigest()}
        atomic(a.state, (json.dumps(manifest, indent=2) + '\n').encode())
        # Manifest and every original exist before the first mutation.
        atomic(claude, (json.dumps(c, indent=2) + '\n').encode(), c_raw)
        atomic(codex, new_toml.encode(), x_raw)
        atomic(server, plistlib.dumps(s), s_raw)
        stop_server(target)
        launch('enable', target)
        launch('bootstrap', f'gui/{os.getuid()}', str(server))
        print('Activated secured HTTP; verify live client calls and negative probes now')
    else:
        manifest = json.loads(a.state.read_bytes())
        c_raw, x_raw, s_raw = claude.read_bytes(), codex.read_bytes(), server.read_bytes()
        c = json.loads(c_raw)
        x = tomllib.loads(x_raw.decode())
        if c['mcpServers']['open-brain'] not in [manifest['claude_entry'], manifest['old_claude_entry']] or x['mcp_servers']['open-brain'] not in [manifest['codex_entry'], manifest['old_codex_entry']]:
            raise ValueError('Client entry changed since activation; do not overwrite it')
        if hashlib.sha256(s_raw).hexdigest() not in [manifest['server_sha256'], manifest['files'][2]['sha256']]:
            raise ValueError('Server plist changed since activation')
        for f in manifest['files']:
            if hashlib.sha256(pathlib.Path(f['backup']).read_bytes()).hexdigest() != f['sha256']:
                raise ValueError('Backup verification failed')
        entry = {'command': sys.executable, 'args': [str(ROOT / 'ops/stdio-maintenance.py'), str(server)]}
        c['mcpServers']['open-brain'] = {'type': 'stdio', **entry}
        new_toml = replace_toml(x_raw.decode(), entry)
        if a.action == 'check-rollback' or not a.apply:
            print('Rollback preflight passed: HTTP off, clients -> stdio, no DB writes or legacy HTTP restart')
            return
        backup(claude, 'rollback-' + stamp)
        backup(codex, 'rollback-' + stamp)
        launch('disable', target)
        stop_server(target)
        atomic(claude, (json.dumps(c, indent=2) + '\n').encode(), c_raw)
        atomic(codex, new_toml.encode(), x_raw)
        print('Rollback applied: HTTP disabled; reconnect both clients to stdio. Keychain and all data retained.')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        # Config/OS errors can contain secrets; only static operator errors escape.
        sys.exit(str(e) if type(e) is ValueError else 'Rollout failed; inspect private state, details suppressed')
