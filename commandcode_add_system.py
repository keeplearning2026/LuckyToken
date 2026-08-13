#!/usr/bin/env python3
"""Read commandcode_request.json and write commandcode_request_v1.json with
200 extra words appended to the system prompt. The original file is untouched.

The system prompt lives either at the top level (converted into params by
commandcode_send.py) or inside params.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SOURCE_FILE = SCRIPT_DIR / "commandcode_request.json"
TARGET_FILE = SCRIPT_DIR / "commandcode_request_v1.json"
EXTRA_WORD_COUNT = 200


def system_holder(payload: dict) -> dict | None:
    """Return the dict whose 'system' key holds the prompt, or None."""
    if isinstance(payload.get("system"), str):
        return payload
    params = payload.get("params")
    if isinstance(params, dict) and isinstance(params.get("system"), str):
        return params
    return None


def main() -> None:
    if not SOURCE_FILE.is_file():
        print(f"Missing request file: {SOURCE_FILE}", file=sys.stderr)
        sys.exit(2)

    with SOURCE_FILE.open(encoding="utf-8") as handle:
        try:
            payload = json.load(handle)
        except json.JSONDecodeError as error:
            print(f"Invalid JSON in {SOURCE_FILE}: {error}", file=sys.stderr)
            sys.exit(2)

    holder = system_holder(payload)
    if holder is None:
        print(
            "No string system prompt found (top level or params.system).",
            file=sys.stderr,
        )
        sys.exit(2)

    extra = " ".join(f"sysword{index + 1}" for index in range(EXTRA_WORD_COUNT))
    holder["system"] = f"{holder['system']} {extra}"

    TARGET_FILE.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    word_count = len(holder["system"].split())
    print(
        f"Wrote {TARGET_FILE}\n"
        f"System prompt words: before={word_count - EXTRA_WORD_COUNT} "
        f"after={word_count} (added {EXTRA_WORD_COUNT})"
    )


if __name__ == "__main__":
    main()
