#!/usr/bin/env python3
"""Diff two versions of a package's type declarations, grouped by declaration.

Usage: dts-diff.py OLD NEW [--contract FILE ...]
OLD and NEW are both .d.ts files or both directories (every **/*.d.ts inside,
paired by relative path). Headers carry [comment], [additive] (only optional
member additions), or [review]. Repeat --contract to add [contract] when a
declaration is named as a whole word in any contract. Leading doc comments
belong to the declaration they document, including newly added declarations.
"""

import argparse
import difflib
import re
import sys
from pathlib import Path

DECL = re.compile(r"^(export )?(declare )?(type|interface|function|const|class|namespace|enum) (\w+)")


def owners(lines: list[str]) -> list[str]:
    names = []
    name = "?"
    for line in lines:
        match = DECL.match(line.lstrip()) if len(line) - len(line.lstrip()) < 8 else None
        if match:
            name = match.group(4)
        names.append(name)
    index = 0
    while index < len(lines):
        if not is_comment(lines[index]):
            index += 1
            continue
        start = index
        while index < len(lines) and (not lines[index].strip() or is_comment(lines[index])):
            index += 1
        if index < len(lines) and DECL.match(lines[index].lstrip()):
            names[start:index] = [names[index]] * (index - start)
    return names


def is_comment(line: str) -> bool:
    return line.strip().startswith(("*", "/**", "*/", "//"))


def classify(lines: list[str]) -> str:
    code = [line for line in lines if not is_comment(line[2:])]
    if not code:
        return "comment"
    if all(line.startswith("+ ") and re.match(r"(?:readonly\s+)?[\w$]+\?\s*:", line[2:]) for line in code):
        return "additive"
    return "review"


def diff_file(label: str, old: list[str], new: list[str], contracts: str = "") -> None:
    groups: dict[str, list[str]] = {}
    old_owners, new_owners = owners(old), owners(new)
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        for prefix, lines, names, start, end in (
            ("-", old, old_owners, i1, i2),
            ("+", new, new_owners, j1, j2),
        ):
            for index in range(start, end):
                if lines[index].strip():
                    groups.setdefault(names[index], []).append(f"{prefix} {lines[index].strip()}")
    for name, lines in groups.items():
        contract = " [contract]" if name != "?" and re.search(rf"\b{re.escape(name)}\b", contracts) else ""
        print(f"## {label} :: {name} [{classify(lines)}]{contract}")
        for line in lines:
            print("   ", line[:220])


def read(path: Path) -> list[str]:
    return path.read_text().splitlines() if path.exists() else []


def main(old: Path, new: Path, contracts: str = "") -> None:
    if old.is_file():
        diff_file(new.name, read(old), read(new), contracts)
        return
    paths = sorted({p.relative_to(old) for p in old.rglob("*.d.ts")} | {p.relative_to(new) for p in new.rglob("*.d.ts")})
    for rel in paths:
        diff_file(str(rel), read(old / rel), read(new / rel), contracts)


if __name__ == "__main__":
    if len(sys.argv) == 1:
        sys.exit(__doc__)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("old", type=Path)
    parser.add_argument("new", type=Path)
    parser.add_argument("--contract", type=Path, action="append", default=[])
    args = parser.parse_args()
    main(args.old, args.new, "\n".join(path.read_text() for path in args.contract))
