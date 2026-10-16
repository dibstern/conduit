#!/usr/bin/env python3
"""Diff two versions of a package's type declarations, grouped by declaration.

Usage: dts-diff.py OLD NEW
OLD and NEW are both .d.ts files or both directories (every **/*.d.ts inside,
paired by relative path). Prints changed lines under "## file :: Declaration",
so a reviewer can map each change onto conduit's contract files.
"""

import difflib
import re
import sys
from pathlib import Path

DECL = re.compile(r"^(export )?(declare )?(type|interface|function|const|class|namespace|enum) (\w+)")


def owner(lines: list[str], index: int) -> str:
    for line in reversed(lines[: index + 1]):
        match = DECL.match(line.lstrip()) if len(line) - len(line.lstrip()) < 8 else None
        if match:
            return match.group(4)
    return "?"


def diff_file(label: str, old: list[str], new: list[str]) -> None:
    groups: dict[str, list[str]] = {}
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        removed = [f"- {line.strip()}" for line in old[i1:i2] if line.strip()]
        added = [f"+ {line.strip()}" for line in new[j1:j2] if line.strip()]
        if removed or added:
            name = owner(new, j1) if j1 < len(new) else owner(old, i1)
            groups.setdefault(name, []).extend(removed + added)
    for name, lines in groups.items():
        print(f"## {label} :: {name}")
        for line in lines:
            print("   ", line[:220])


def read(path: Path) -> list[str]:
    return path.read_text().splitlines() if path.exists() else []


def main(old: Path, new: Path) -> None:
    if old.is_file():
        diff_file(new.name, read(old), read(new))
        return
    paths = sorted({p.relative_to(old) for p in old.rglob("*.d.ts")} | {p.relative_to(new) for p in new.rglob("*.d.ts")})
    for rel in paths:
        diff_file(str(rel), read(old / rel), read(new / rel))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
