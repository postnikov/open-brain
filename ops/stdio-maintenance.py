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
    if args[-1] not in [str(root / 'src/server-hardened.ts'), str(root / 'src/server.ts')]:
        raise ValueError('Unexpected server entry')
    args[-1] = str(root / 'src/index.ts')
    env = dict(os.environ, **plist.get('EnvironmentVariables', {}))
    os.chdir(root)
    os.execve(args[0], args, env)
except Exception:
    sys.exit('Open Brain stdio fallback failed; inspect private configuration')
