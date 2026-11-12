"""Publication recovery must not turn fork or failed runs into trusted inputs."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('resolve_ci', Path(__file__).with_name('resolve-ci-run.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class CiRun(unittest.TestCase):
    def setUp(self):
        self.run = dict(workflow_id=123, event='push', status='completed', conclusion='success',
                        head_branch='main', head_repository={'full_name': 'app-vitals/shipwright'},
                        head_sha='a' * 40)

    def test_successful_main_ci_resolves_its_exact_commit(self):
        self.assertEqual(M.validate_run(self.run, 123, 'app-vitals/shipwright'), 'a' * 40)

    def test_other_workflow_fork_pr_branch_failure_and_bad_sha_are_rejected(self):
        for fields in ({'workflow_id': 124}, {'event': 'pull_request'}, {'status': 'in_progress'},
                       {'conclusion': 'failure'}, {'conclusion': None}, {'head_branch': 'feature'},
                       {'head_repository': {'full_name': 'contributor/fork'}}, {'head_repository': None},
                       {'head_sha': 'main'}, {'head_sha': None}):
            with self.subTest(fields=fields):
                run = copy.deepcopy(self.run)
                run.update(fields)
                with self.assertRaises(ValueError):
                    M.validate_run(run, 123, 'app-vitals/shipwright')

    def test_malformed_run_is_rejected(self):
        for value in (None, [], {}, 'invalid'):
            with self.assertRaises(ValueError):
                M.validate_run(value, 123, 'app-vitals/shipwright')


if __name__ == '__main__':
    unittest.main()
