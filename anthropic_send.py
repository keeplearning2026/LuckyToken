#!/usr/bin/env python3
"""Read anthropic_request.json next to this script and POST it to the local
Anthropic-compatible endpoint at http://127.0.0.1:8082."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SCRIPT_DIR = Path(__file__).resolve().parent
REQUEST_FILE = SCRIPT_DIR / "anthropic_request.json"
ENDPOINT = "http://127.0.0.1:8082/v1/messages"
ANTHROPIC_TOKEN = "ccr_anthropic_283fdccc-febe-419e-98d9-07fceaccbad4"


def load_request() -> dict:
    if not REQUEST_FILE.is_file():
        sample = {
            "model": "commandcode-private/deepseek/deepseek-v4-flash",
            "max_tokens": 256,
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


def main() -> None:
    payload = load_request()
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ANTHROPIC_TOKEN}",
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with urlopen(request, timeout=180) as response:
            content = response.read().decode("utf-8")
            content_type = response.headers.get("Content-Type", "")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"HTTP {error.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    except URLError as error:
        print(f"Connection failed: {error.reason}", file=sys.stderr)
        sys.exit(1)

    if "text/event-stream" in content_type:
        for line in content.splitlines():
            if line.startswith("data:"):
                print(line.removeprefix("data:").strip())
    else:
        try:
            parsed = json.loads(content)
            print(json.dumps(parsed, indent=2, ensure_ascii=False))
        except json.JSONDecodeError:
            print(content)


if __name__ == "__main__":
    main()
