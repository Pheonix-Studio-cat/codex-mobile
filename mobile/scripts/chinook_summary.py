#!/usr/bin/env python3
"""Writes the Chinook Security reports of a directory as a Markdown table.

    python3 chinook_summary.py DIR >> "$GITHUB_STEP_SUMMARY"

A bot without a report is listed as such — a missing report is not a clean
run. Findings are listed by rule and place; Chinook Security never puts the
found value into a report, and neither does this summary.
"""

from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

BOTS = ("secret-bot", "code-bot", "dependency-bot", "license-bot")


def main(directory: str) -> int:
    root = Path(directory)
    print("## Chinook Security — whole repository (report only)\n")
    print("| Bot | Findings | critical | high | medium | low | info |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    details = []
    for bot in BOTS:
        path = root / f"{bot}.json"
        if not path.is_file():
            print(f"| {bot} | **no report** — the run proves nothing | | | | | |")
            continue
        report = json.loads(path.read_text(encoding="utf-8"))
        summary = report.get("summary") or {}
        levels = summary.get("by_severity") or {}
        counts = [str(levels.get(level, 0)) for level in ("critical", "high", "medium", "low", "info")]
        print(f"| {bot} | {summary.get('total', 0)} | " + " | ".join(counts) + " |")
        rules = collections.Counter(finding.get("rule") for finding in report.get("findings") or [])
        if rules:
            details.append(f"**{bot}:** " + ", ".join(f"`{rule}` × {count}" for rule, count in rules.most_common()))
    if details:
        print()
        print("\n\n".join(details))
    print(
        "\nThe gate for this fork's own code is the **Mobile (gate)** job. "
        "This table includes upstream Codex, whose test fixtures look like credentials."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
