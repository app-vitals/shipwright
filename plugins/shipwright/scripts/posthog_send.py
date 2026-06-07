#!/usr/bin/env python3
"""
Shipwright PostHog event sender.

Usage:
    python3 posthog_send.py EVENT_NAME [--project P] [--task T] [--ts ISO] [key=value ...]

Arguments:
    EVENT_NAME   Required. e.g. shipwright_task_started
    --project P  Project folder name (used to build distinct_id and $insert_id)
    --task T     Task ID (used to build distinct_id and $insert_id)
    --ts ISO     Optional timestamp (ISO-8601). Defaults to now (UTC).
    key=value    Additional event properties. Values are parsed as JSON if
                 valid (so integers, booleans, arrays work naturally);
                 otherwise treated as strings.

Examples:
    python3 posthog_send.py shipwright_task_started \\
        --project my-app --task WS-1.1 \\
        --ts "$TASK_STARTED_AT" \\
        title="Add workspace model" estimated_h=2 complexity=3 model=sonnet

    python3 posthog_send.py shipwright_ci_result \\
        --project my-app --task WS-1.1 \\
        passed_first_try=true fix_attempts=0 failures=[]

    python3 posthog_send.py shipwright_review_complete \\
        --project my-app --task WS-1.1 \\
        verdict="SHIP IT" findings=0 fixes_applied=0 \\
        'agents=["code-reviewer","silent-failure-hunter"]'

The script builds distinct_id and $insert_id automatically from --project and --task,
so the caller never has to construct JSON.

Environment variables:
    POSTHOG_PROJECT_API_KEY  Required. If absent, exits 0 silently (no-op).
    POSTHOG_HOST             Optional. Defaults to https://us.i.posthog.com

Exit codes:
    0  Success or silently skipped (no API key)
    1  Network error, bad arguments, or JSON parse error
"""

import json
import os
import ssl
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Known system CA bundle locations — covers macOS python.org builds, Linux distros.
# python.org macOS installers ship without a populated CA bundle, causing
# CERTIFICATE_VERIFY_FAILED even though the system has a valid bundle.
_CA_CANDIDATES = [
    "/etc/ssl/cert.pem",                        # macOS system bundle
    "/etc/ssl/certs/ca-certificates.crt",       # Debian / Ubuntu
    "/etc/pki/tls/certs/ca-bundle.crt",         # RHEL / CentOS
]


def _ssl_context():
    for ca in _CA_CANDIDATES:
        if os.path.exists(ca):
            return ssl.create_default_context(cafile=ca)
    return ssl.create_default_context()


def _parse_value(v):
    """Parse a key=value string value as JSON if possible, else return as string."""
    try:
        return json.loads(v)
    except (json.JSONDecodeError, ValueError):
        return v


def main():
    api_key = os.environ.get("POSTHOG_PROJECT_API_KEY", "")
    if not api_key:
        sys.exit(0)

    args = sys.argv[1:]
    if not args:
        print("Usage: posthog_send.py EVENT_NAME [--project P] [--task T] [--ts ISO] [key=value ...]", file=sys.stderr)
        sys.exit(1)

    event_name = args[0]
    project = ""
    task_id = ""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    props = {}

    i = 1
    while i < len(args):
        a = args[i]
        if a == "--project" and i + 1 < len(args):
            project = args[i + 1]; i += 2
        elif a == "--task" and i + 1 < len(args):
            task_id = args[i + 1]; i += 2
        elif a == "--ts" and i + 1 < len(args):
            ts = args[i + 1]; i += 2
        elif "=" in a:
            k, _, v = a.partition("=")
            props[k] = _parse_value(v)
            i += 1
        else:
            print(f"⚠ PostHog: unrecognised argument: {a}", file=sys.stderr)
            i += 1

    distinct_id = f"shipwright/{project}/{task_id}" if project and task_id else "shipwright/unknown"
    props["$insert_id"] = f"{event_name}/{project}/{task_id}" if project and task_id else event_name
    if project:
        props.setdefault("project", project)
    if task_id:
        props.setdefault("task_id", task_id)

    event = {"event": event_name, "distinct_id": distinct_id, "timestamp": ts, "properties": props}
    host = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com").rstrip("/")
    payload = json.dumps({"api_key": api_key, "batch": [event]}).encode()

    req = urllib.request.Request(
        f"{host}/batch/",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        urllib.request.urlopen(req, context=_ssl_context(), timeout=10)
    except urllib.error.URLError as e:
        print(f"⚠ PostHog export failed: {e} — event not delivered", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
