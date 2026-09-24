"""Config/rollback fault tests. All files and launchctl calls are synthetic."""
import importlib.util
import json
import pathlib
import plistlib
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollout', pathlib.Path(__file__).with_name('http-rollout.py'))
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class RolloutTest(unittest.TestCase):
    def test_toml_preserves_other_servers_and_roundtrips(self):
        raw = 'model="test"\n[mcp_servers.open-brain]\nurl="old"\n\n[mcp_servers.other]\nurl="keep"\n'
        new = rollout.replace_toml(raw, {'url': 'new', 'http_headers_helper': '/helper with spaces'})
        self.assertEqual(tomllib.loads(rollout.replace_toml(new, {'url': 'old'})), tomllib.loads(raw))
        with self.assertRaises(ValueError):
            rollout.replace_toml(raw + '[mcp_servers.open-brain.env]\nX="nested"\n', {'url': 'new'})

    def test_partial_cutover_can_roll_back_without_reopening_http(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / '.codex').mkdir()
            (home / 'Library/LaunchAgents').mkdir(parents=True)
            claude = home / '.claude.json'
            codex = home / '.codex/config.toml'
            server = home / 'Library/LaunchAgents/com.open-brain.server.plist'
            claude.write_text(json.dumps({'unrelated': 7, 'mcpServers': {'open-brain': {'type': 'http', 'url': 'http://localhost:3100/mcp'}}}))
            codex.write_text('model="keep"\n[mcp_servers.open-brain]\nurl="http://localhost:3100/mcp"\n')
            server.write_bytes(plistlib.dumps({'ProgramArguments': ['/node', '/tsx', str(rollout.ROOT / 'src/server.ts')]}))
            state = home / 'state/manifest.json'
            atomic = rollout.atomic

            def fail_second_config(path, data, expected=None):
                if path == codex:
                    raise ValueError('Simulated interruption')
                atomic(path, data, expected)

            with patch.object(pathlib.Path, 'home', return_value=home), patch.object(rollout, 'launch') as launch, patch.object(rollout, 'stop_server') as stop:
                with patch('sys.argv', ['rollout', 'activate', '--state', str(state), '--apply']), patch.object(rollout, 'atomic', side_effect=fail_second_config):
                    with self.assertRaisesRegex(ValueError, 'Simulated'):
                        rollout.main()
                # Concurrent unrelated user updates survive rollback.
                current = json.loads(claude.read_text()); current['unrelated'] = 8
                claude.write_text(json.dumps(current))
                with patch('sys.argv', ['rollout', 'rollback', '--state', str(state), '--apply']):
                    rollout.main()
                self.assertEqual(json.loads(claude.read_text())['unrelated'], 8)
                self.assertEqual(json.loads(claude.read_text())['mcpServers']['open-brain']['type'], 'stdio')
                self.assertEqual(tomllib.loads(codex.read_text())['model'], 'keep')
                self.assertIn('command', tomllib.loads(codex.read_text())['mcp_servers']['open-brain'])
                self.assertTrue(stop.called)
                self.assertFalse(any(call.args[0] in ['enable', 'bootstrap'] for call in launch.call_args_list))
                for item in json.loads(state.read_text())['files']:
                    self.assertEqual(pathlib.Path(item['backup']).stat().st_mode & 0o777, 0o600)

    def test_bootout_uses_observed_state_when_command_returns_error(self):
        with patch.object(rollout, 'launch', side_effect=[5, 113]):
            rollout.stop_server('synthetic')


if __name__ == '__main__':
    unittest.main()
