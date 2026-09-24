#!/usr/bin/env python3
"""Install only Open Brain backup jobs. No application restart or credentials copied."""
import json, os, pathlib, plistlib, shutil, subprocess
home = pathlib.Path.home()
repo = pathlib.Path(__file__).resolve().parents[1]
node = shutil.which('node')
if not node:
    raise SystemExit('node missing')
config_path = pathlib.Path(os.environ.get('OPEN_BRAIN_BACKUP_CONFIG', home / '.open-brain/backup.json'))
config = json.loads(config_path.read_text())
logdir = pathlib.Path(config['directory']) / 'logs'
logdir.mkdir(mode=0o700, exist_ok=True)
launch = home / 'Library/LaunchAgents'
for suffix, action, schedule in [
    ('backup', 'backup', {'StartCalendarInterval': {'Hour': 4, 'Minute': 0}}),
    ('backup-check', 'check', {'StartInterval': 3600}),
    ('restore-check', 'restore', {'StartCalendarInterval': {'Weekday': 0, 'Hour': 5, 'Minute': 0}}),
]:
    label = f'com.open-brain.{suffix}'
    path = launch / f'{label}.plist'
    if path.exists():
        raise SystemExit(f'Refusing overwrite: {path}; inspect/unload/back up first')
    args = [node, str(repo / 'scripts/backup/cli.mjs'), action]
    if action != 'check': args.append('--if-due')
    log = logdir / f'{suffix}.log'
    log.touch(mode=0o600, exist_ok=True)
    body = {'Label': label, 'ProgramArguments': args, 'WorkingDirectory': str(repo),
            'EnvironmentVariables': {'OPEN_BRAIN_BACKUP_CONFIG': str(config_path)},
            'RunAtLoad': True, 'ProcessType': 'Background', 'Umask': 0o077,
            'StandardOutPath': str(log), 'StandardErrorPath': str(log), **schedule}
    path.write_bytes(plistlib.dumps(body)); path.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(path)], check=True)
    print(f'Loaded {label}')
