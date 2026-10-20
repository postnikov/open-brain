#!/usr/bin/env python3
"""Private stdio fallback: same DB/environment, no HTTP, cron or startup cleanup."""
import os
import pathlib
import plistlib
import sys

try:
    plist = plistlib.loads(pathlib.Path(sys.argv[1]).read_bytes())
    root = pathlib.Path(__file__).resolve().parents[1]
    args = list(plist['ProgramArguments'])
    if args[-1] == str(root / 'ops/launch-server.sh'):
        # Keychain wrapper entry: DATABASE_URL then comes from the repository .env.
        args = ['/opt/homebrew/bin/node', str(root / 'node_modules/.bin/tsx'), str(root / 'src/index.ts')]
    elif args[-1] in [str(root / 'src/server-hardened.ts'), str(root / 'src/server.ts')]:
        args[-1] = str(root / 'src/index.ts')
    else:
        raise ValueError('Unexpected server entry')
    env = dict(os.environ, **plist.get('EnvironmentVariables', {}))
    env['OPEN_BRAIN_MAINTENANCE'] = '1'
    os.chdir(root)
    os.execve(args[0], args, env)
except Exception:
    sys.exit('Open Brain stdio fallback failed; inspect private configuration')
