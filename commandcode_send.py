#!/usr/bin/env python3
"""Read commandcode_request.json next to this script and POST it to the
CommandCode upstream endpoint exactly like the LuckyToken provider does.

The JSON file contains the full request envelope (config/params/...). If the
envelope has no "params", one is synthesized from the top-level keys so you can
write a minimal {"model": ..., "system": ..., "messages": [...]} file.
"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


SCRIPT_DIR = Path(__file__).resolve().parent
REQUEST_FILE = SCRIPT_DIR / "commandcode_request_v1.json"
API_KEY_FILE = SCRIPT_DIR / "CommandcodeAPIKey.txt"
ENDPOINT = "https://api.commandcode.ai/alpha/generate"
REQUEST_TIMEOUT_MS = 180_000
DEFAULT_MODEL = "deepseek/deepseek-v4-flash"


def load_api_key() -> str:
    if not API_KEY_FILE.is_file():
        print(f"Missing API key file: {API_KEY_FILE}", file=sys.stderr)
        sys.exit(2)
    api_key = API_KEY_FILE.read_text(encoding="utf-8").strip()
    if not api_key:
        print(f"API key file is empty: {API_KEY_FILE}", file=sys.stderr)
        sys.exit(2)
    return api_key


def load_request() -> dict:
    if not REQUEST_FILE.is_file():
        sample = {
            "model": "commandcode-private/deepseek/deepseek-v4-flash",
            "system": "You are a helpful assistant.",
            "messages": [{"role": "user", "content": "Say hello"}],
        }
        REQUEST_FILE.write_text(
            json.dumps(sample, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(
            f"No request file found. Created a sample at {REQUEST_FILE}\n"
            "Edit it and run this script again.",
            file=sys.stderr,
        )
        sys.exit(2)

    with REQUEST_FILE.open(encoding="utf-8") as handle:
        try:
            payload = json.load(handle)
        except json.JSONDecodeError as error:
            print(f"Invalid JSON in {REQUEST_FILE}: {error}", file=sys.stderr)
            sys.exit(2)

    if not isinstance(payload, dict):
        print(f"{REQUEST_FILE} must contain a JSON object.", file=sys.stderr)
        sys.exit(2)
    return payload


def build_envelope(payload: dict) -> dict:
    """Fill envelope defaults, then let the file's explicit values win. The
    request content is sent unchanged (no model rewriting)."""

    if "params" in payload:
        params = dict(payload["params"])
        params.setdefault("model", DEFAULT_MODEL)
        params.setdefault("stream", True)
        return {**payload, "params": params}

    params: dict = {}
    for key in ("model", "system", "max_tokens", "stream", "temperature",
                "reasoning_effort", "messages", "tools"):
        if key in payload:
            params[key] = payload[key]
    params.setdefault("model", DEFAULT_MODEL)
    params.setdefault("stream", True)
    params.setdefault("max_tokens", 256)

    envelope = {
        "config": {
            "workingDir": "D:\\project\\LuckyToken",
            "date": "2026-08-13",
            "environment": "local",
            "structure": [],
            "isGitRepo": True,
            "currentBranch": "main",
            "mainBranch": "main",
            "gitStatus": "clean",
            "recentCommits": [],
        },
        "memory": None,
        "taste": None,
        "skills": None,
        "permissionMode": "standard",
        "threadId": str(uuid.uuid4()),
        "params": params,
    }
    for key in ("config", "memory", "taste", "skills", "permissionMode", "threadId"):
        if key in payload:
            envelope[key] = payload[key]
    return envelope


def build_headers() -> dict[str, str]:
    """Mirror buildCommandCodeHeaders in provider.ts."""
    return {
        "accept": "*/*",
        "content-type": "application/json",
        "user-agent": "cli",
        "x-command-code-version": "1.9.0",
        "x-taste-learning": "false",
        "x-co-flag": "false",
        "x-cmd-zdr": "1",
        "x-session-id": str(uuid.uuid4()),
        "x-cli-environment": "production",
        "authorization": f"Bearer {load_api_key()}",
    }


def main() -> None:
    payload = load_request()
    envelope = build_envelope(payload)
    body = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
    request = Request(ENDPOINT, data=body, method="POST", headers=build_headers())

    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_MS / 1000) as response:
            content = response.read().decode("utf-8")
            content_type = response.headers.get("Content-Type", "")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"HTTP {error.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except URLError as error:
        print(f"Connection failed: {error.reason}", file=sys.stderr)
        sys.exit(1)

    for line in content.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print(line)
            continue
        if event.get("type") == "finish":
            print(json.dumps(event, indent=2, ensure_ascii=False))
        else:
            print(json.dumps(event, ensure_ascii=False))


if __name__ == "__main__":
    main()
