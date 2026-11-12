#!/usr/bin/env python3
"""Resolve an exact, successful upstream-main CI commit before publication."""
import json
import os
import re
import subprocess


def validate_run(run, workflow_id, repository):
    if not isinstance(run, dict):
        raise ValueError('CI run is not an object')
    source = run.get('head_repository')
    sha = run.get('head_sha')
    if (run.get('workflow_id') != workflow_id or run.get('event') != 'push'
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('head_branch') != 'main' or not isinstance(source, dict)
            or source.get('full_name') != repository or not isinstance(sha, str)
            or not re.fullmatch(r'[a-f0-9]{40}', sha)):
        raise ValueError('publication requires successful upstream-main push CI')
    return sha


def main():
    repository = os.environ['GITHUB_REPOSITORY']
    if os.environ['GITHUB_REF'] != 'refs/heads/main':
        raise ValueError('publication recovery must run from main')
    run_id = os.environ.get('CI_RUN_ID', '')
    if not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise ValueError('a numeric CI run id is required')
    def api(path):
        return json.loads(subprocess.check_output(['gh', 'api', f'repos/{repository}/actions/{path}'], text=True))
    workflow = api('workflows/ci.yml')
    if not isinstance(workflow, dict) or type(workflow.get('id')) is not int:
        raise ValueError('cannot establish the CI workflow identity')
    sha = validate_run(api('runs/' + run_id), workflow['id'], repository)
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write('sha=' + sha + '\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit('::error::' + str(error))
