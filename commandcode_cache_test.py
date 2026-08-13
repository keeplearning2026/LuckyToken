#!/usr/bin/env python3
"""Cache probe: send commandcode_request.json twice unchanged, then a third
time with 300 words appended to the system prompt IN MEMORY (no file is
written), and compare the three finish events."""

from __future__ import annotations

import copy
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import commandcode_send as sender


EXTRA_WORD_COUNT = 300


def send_and_get_finish(payload: dict) -> dict:
    envelope = sender.build_envelope(payload)
    body = json.dumps(envelope, ensure_ascii=False).encode("utf-8")
    request = Request(
        sender.ENDPOINT,
        data=body,
        method="POST",
        headers=sender.build_headers(),
    )
    try:
        with urlopen(request, timeout=sender.REQUEST_TIMEOUT_MS / 1000) as response:
            content = response.read().decode("utf-8")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code}: {detail}") from error
    for line in content.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "finish":
            return event
    raise RuntimeError("No finish event in response")


def system_holder(payload: dict) -> dict:
    if isinstance(payload.get("system"), str):
        return payload
    params = payload.get("params")
    if isinstance(params, dict) and isinstance(params.get("system"), str):
        return params
    raise RuntimeError(
        "No string system prompt found (top level or params.system)"
    )


def summarize(finish: dict) -> str:
    usage = finish.get("totalUsage", {})
    input_tokens = usage.get("inputTokens")
    cache_read = usage.get("cacheReadTokens", 0)
    no_cache = (usage.get("inputTokenDetails") or {}).get("noCacheTokens")
    cached = usage.get("cachedInputTokens", 0)
    rate = (100 * cached / input_tokens) if input_tokens else 0
    return (
        f"inputTokens={input_tokens} cacheReadTokens={cache_read} "
        f"noCacheTokens={no_cache} cachedInputTokens={cached} "
        f"cacheRate={rate:.2f}% outputTokens={usage.get('outputTokens')}"
    )


def main() -> None:
    payload = sender.load_request()
    base_words = len(system_holder(payload)["system"].split())
    print(f"base system words: {base_words}")

    results: list[dict] = []
    for index in (1, 2):
        finish = send_and_get_finish(payload)
        results.append(finish)
        print(f"\n=== finish #{index} (unchanged) ===")
        print(json.dumps(finish, indent=2, ensure_ascii=False))

    changed = copy.deepcopy(payload)
    extra = " ".join(f"sysword{index + 1}" for index in range(EXTRA_WORD_COUNT))
    system_holder(changed)["system"] = f"{system_holder(changed)['system']} {extra}"
    print(
        f"\nthird request: system words {base_words} + {EXTRA_WORD_COUNT} "
        "(in memory only, no file saved)"
    )

    finish3 = send_and_get_finish(changed)
    results.append(finish3)
    print("\n=== finish #3 (system +300 words) ===")
    print(json.dumps(finish3, indent=2, ensure_ascii=False))

    print("\n=== comparison ===")
    for index, finish in enumerate(results, start=1):
        print(f"#{index}: {summarize(finish)}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, URLError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
