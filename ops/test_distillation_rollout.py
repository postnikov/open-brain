import importlib.util, pathlib, plistlib, unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory
spec=importlib.util.spec_from_file_location('rollout',pathlib.Path(__file__).with_name('distillation-rollout.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RolloutTests(unittest.TestCase):
    def raw(self):
        return plistlib.dumps({'ProgramArguments':['node','tsx',str(m.ROOT/'src/server-hardened.ts')], 'EnvironmentVariables':{'OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE':'fixture','OPEN_BRAIN_DISABLE_CLEANUP':'1','UNRELATED':'same'}})
    def test_activation_removes_only_pause_flags(self):
        value=plistlib.loads(m.planned(self.raw(),False))
        self.assertEqual(value['EnvironmentVariables'],{'OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE':'fixture','UNRELATED':'same'})
    def test_maintenance_preserves_security_and_disables_all_jobs(self):
        value=plistlib.loads(m.planned(m.planned(self.raw(),False),True))
        self.assertEqual(value['EnvironmentVariables']['OPEN_BRAIN_MAINTENANCE'],'1')
        self.assertEqual(value['EnvironmentVariables']['OPEN_BRAIN_DISABLE_CLEANUP'],'1')
        self.assertEqual(value['EnvironmentVariables']['OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE'],'fixture')
    def test_legacy_entry_refused(self):
        value=plistlib.loads(self.raw());value['ProgramArguments'][-1]=str(m.ROOT/'src/server.ts')
        with self.assertRaises(ValueError):m.planned(plistlib.dumps(value),False)
    def test_migration_failure_enters_maintenance_without_rewind(self):
        with TemporaryDirectory() as tmp:
            home=pathlib.Path(tmp);server=home/'Library/LaunchAgents/com.open-brain.server.plist';server.parent.mkdir(parents=True);server.write_bytes(self.raw())
            state=home/'state/activation.json'
            good=type('R',(),{'returncode':0,'stdout':b'{}'})()
            bad=type('R',(),{'returncode':1,'stdout':b''})()
            with patch.object(m.pathlib.Path,'home',return_value=home),patch.object(m.sys,'argv',['rollout','activate','--state',str(state),'--apply']),patch.object(m.http,'stop_server'),patch.object(m.http,'launch'),patch.object(m.subprocess,'run',side_effect=[good,good,bad]):
                with self.assertRaisesRegex(ValueError,'migration failed'):m.main()
            self.assertEqual(plistlib.loads(server.read_bytes())['EnvironmentVariables']['OPEN_BRAIN_MAINTENANCE'],'1')
            self.assertTrue(state.exists())
if __name__=='__main__':unittest.main()
