"""T1 citation check (Run Ledger CONTRACT.md A.18 T1, bead 32.2.18).

Run from the repo root before every contract review round:
    python3 -I scripts/run-ledger/t1-cite-check.py [--contract PATH] [--allow PATH] [--out ROWS.tsv]
or `pnpm check:run-ledger-contract`, which runs this and the T3 sweep. Exit 0 only when every row
is OK or allowed; 1 on any failure; 2 on a usage or setup error (a commit missing from the clone).

Every citation of main or R2 in the contract resolves to one file at its commit, is in range, and
its backticked anchor (a backticked term in the same parenthetical segment, before the citation)
occurs within the cited lines (2 lines of slack). A citation with no anchor (NO_ANCHOR) or a bare
range bound to no file (UNBOUND) fails like UNRESOLVED, OUT_OF_RANGE and ANCHOR_MISS (bead
32.2.18, REDESIGN-8 r1 decision) unless the allow list carries it.

Forms parsed: `file.ts 12-34, 56`, `file.ts:12-34`, `file.ts at <sha>: 12, 34-56`, a bare `:12-34`
after a `:`-form citation (it names that citation's file), and a bare range `(12-34)` or `, 12-34`
inside a parenthetical. A bare range names a file only when that file is cited in its own
parenthetical or clause (back from its `(` to the latest `; `, `. ` or table `|` outside
parentheses), so a preceding `<file> <range>` in the same citation list binds it; otherwise it is
UNBOUND. A section number (`S9.5`, `3.9`), a bare single digit or a `rows 203, 204` list is never
read as lines. Commit: an `at <sha>` right after the citation, else the latest sha mentioned before
it in the paragraph, else 1ba91324 (D56). A citation marked `in 3223`, `in 3224`, `in the split`,
`in this worktree` or led by `3223 ` / `3224 ` is a worktree citation, not main, and is skipped. A
`file.ts` citation inside a code span is a format example and is skipped. src comments are checked
for range only. It prints the 2.1 rows' citations.

Allow list (t1-allow.txt beside this script): `<key>\t<class>\t<reason>`, `#` comments. The key is
`<file> <ranges> at <sha>`, or `- <ranges>` for an UNBOUND range. Each class allows only its rows:
anchorless allows NO_ANCHOR, unbound allows UNBOUND, and stale, external, history and unchecked
allow UNRESOLVED, OUT_OF_RANGE and ANCHOR_MISS. Unused entries are printed, not failed.
"""
import argparse, collections, os, re, subprocess, sys

ROOT = subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(__file__)), "rev-parse", "--show-toplevel"],
                      capture_output=True, text=True, check=True).stdout.strip()
COMMITS = ["1ba91324", "6c9ff950", "3aa43c60"]
DEFAULT = "1ba91324"
FAILURES = ("UNRESOLVED", "OUT_OF_RANGE", "ANCHOR_MISS")
CLASSES = {"anchorless": ("NO_ANCHOR",), "unbound": ("UNBOUND",), "stale": FAILURES, "external": FAILURES,
           "history": FAILURES, "unchecked": FAILURES}

ap = argparse.ArgumentParser(description="Run Ledger contract citation check (A.18 T1)")
ap.add_argument("--contract", default=os.path.join(ROOT, "docs/plans/2026-10-24-run-ledger-contract/CONTRACT.md"))
ap.add_argument("--allow", default=os.path.join(ROOT, "scripts/run-ledger/t1-allow.txt"))
ap.add_argument("--out", help="write every row that is not OK to this TSV")
args = ap.parse_args()

for c in COMMITS:
    if subprocess.run(["git", "-C", ROOT, "cat-file", "-e", f"{c}^{{commit}}"], capture_output=True).returncode:
        print(f"T1: commit {c} is not in this clone; fetch it before running the check", file=sys.stderr)
        sys.exit(2)

allow = {}
for n, l in enumerate(open(args.allow, encoding="utf-8").read().split("\n"), 1):
    if not l.strip() or l.startswith("#"):
        continue
    parts = l.split("\t")
    if len(parts) != 3 or parts[1] not in CLASSES or not parts[2].strip():
        sys.exit(f"T1 allow line {n}: want <key>TAB<class>TAB<reason>, class one of {sorted(CLASSES)}: {l!r}")
    allow[parts[0]] = [parts[1], parts[2], 0]
text = open(args.contract, encoding="utf-8").read().split("\n")
sec21 = next(i for i, l in enumerate(text, 1) if l.startswith("### 2.1 "))
sec21_end = next(i for i, l in enumerate(text, 1) if i > sec21 and l.startswith("#"))
trees, bodies = {}, {}


def git(*argv):
    return subprocess.run(["git", "-C", ROOT, *argv], capture_output=True, text=True, check=True).stdout


def tree(c):
    if c not in trees:
        trees[c] = git("ls-tree", "-r", "--name-only", c).split()
    return trees[c]


def body(c, p):
    if (c, p) not in bodies:
        bodies[(c, p)] = git("show", f"{c}:{p}").split("\n")
    return bodies[(c, p)]


# paragraphs: a bullet, header, table row or blank line starts one; keep the start line
paras, cur, start, in_code = [], [], 0, False
for i, l in enumerate(text, 1):
    if l.startswith("```"):
        in_code = not in_code
        if cur:
            paras.append((start, " ".join(cur)))
        cur = []
        continue
    if in_code:
        continue
    if (not l.strip()) or l.startswith(("- ", "#", "|", "<!--")):
        if cur:
            paras.append((start, " ".join(cur)))
        cur, start = ([], i) if not l.strip() else ([l], i)
        if l.startswith("|"):
            paras.append((i, l))
            cur = []
        continue
    if not cur:
        start = i
    cur.append(l.strip())
if cur:
    paras.append((start, " ".join(cur)))

RANGE = r"\d{1,5}(?:-\d{1,5})?"
NUMS = rf"((?:(?:,| and|,? and)? {RANGE}(?![\w.%]| s\b| ms\b| min\b| of\b))+)"
FNAME = r"((?:[\w.-]+/)*[A-Za-z][\w.-]*\.(?:ts|tsx|js|sql|svelte))"
CITE = re.compile(rf"\b{FNAME}(?:{NUMS}|:({RANGE})| at (\w{{8}}):{NUMS})")
COLON = re.compile(rf"(?<=[ ,(]):({RANGE})(?![\w.])")
BARE = re.compile(rf"(?<=[(,;] )({RANGE})(?![\w.%:-]| s\b| ms\b| min\b| of\b)|(?<=\()({RANGE})(?=[),;])")
SHA = re.compile(r"\b(" + "|".join(COMMITS) + r")\b")
WORKTREE = re.compile(r"^[^;)]{0,40}?\b(in 3223|in 3224|in the split|in this worktree)\b")

stats = collections.Counter()
rows, table21 = [], []


def ranges_of(nums):
    rs = []
    for part in re.findall(RANGE, nums):
        a, _, b = part.partition("-")
        rs.append((int(a), int(b or a)))
    return rs


def anchor_segment(p, pos):
    lo = max(p.rfind("(", 0, pos), p.rfind(";", 0, pos))
    return re.findall(r"`([^`]{2,60})`", p[lo + 1:pos])


def worktree(p, pos, end):
    return bool(WORKTREE.search(p[end:end + 60]) or re.search(r"\b322[34] $", p[max(0, pos - 5):pos]))


def record(start, key, verdict, detail, is_21):
    entry = allow.get(key)
    if verdict != "OK" and entry and verdict in CLASSES[entry[0]]:
        entry[2] += 1
        verdict, detail = f"ALLOWED_{entry[0]}", entry[1]
    stats[verdict] += 1
    row = f"{verdict}\t{start}\t{key}\t{detail}"
    if verdict != "OK":
        rows.append(row)
    if is_21:
        table21.append(row)


def check(start, p, fname, nums, pos, sha, is_21):
    rs = ranges_of(nums)
    key = f"{fname} {nums.strip().lstrip(',').strip()} at {sha}"
    cands = [x for x in tree(sha) if x == fname or x.endswith("/" + fname)]
    verdict, detail = "OK", ""
    if not cands:
        verdict = "UNRESOLVED"
    else:
        ok = [c for c in cands if all(a <= b <= len(body(sha, c)) for a, b in rs)]
        if not ok:
            verdict, detail = "OUT_OF_RANGE", str([len(body(sha, c)) for c in cands])
        elif not p.startswith("<!--"):
            anchors = anchor_segment(p, pos)
            if not anchors:
                verdict = "NO_ANCHOR"
            for tok in anchors:
                if not any(tok in "\n".join(body(sha, c)[max(0, a - 3):b + 2]) for c in ok for a, b in rs):
                    verdict, detail = "ANCHOR_MISS", f"`{tok}`"
                    break
    record(start, key, verdict, detail, is_21)


for start, p in paras:
    is_21 = p.startswith("| ") and sec21 < start < sec21_end and not p.startswith("| Ledger rule")
    shas = [(m.start(), m.group(1)) for m in SHA.finditer(p)]
    cites = []
    for m in CITE.finditer(p):
        fname, s, e = m.group(1), m.start(), m.end()
        nums, form = (m.group(2), "lines") if m.group(2) else (m.group(3), "colon") if m.group(3) else (m.group(5), "at")
        group = re.split(r"[;()]", p[e:])[0]
        tail = re.search(r" at (\w{8})\b", group)
        sha = m.group(4) or (tail.group(1) if tail and tail.group(1) in COMMITS else None)
        if not sha:
            before = [c for q, c in shas if q < s]
            sha = before[-1] if before else DEFAULT
        cites.append((s, e, fname, nums, sha, form, worktree(p, s, e)))
    # a bare range names a file only from its own parenthetical or clause; a bare colon form, the latest colon citation's
    taken = [(c[0], c[1]) for c in cites]
    extra = []
    for rx, kind in ((COLON, "colon"), (BARE, "bare")):
        for m in rx.finditer(p):
            pos = m.start()
            if any(s <= pos < e for s, e in taken):
                continue
            nums = m.group(1) or (m.group(2) if m.lastindex and m.lastindex >= 2 else None)
            if not nums:
                continue
            # a bare range must sit in an open parenthetical
            if kind == "bare" and p.rfind("(", 0, pos) < p.rfind(")", 0, pos):
                continue
            if not any(c[1] <= pos for c in cites):
                continue  # no file cited before it in the paragraph: not a citation
            # never a section number (S9.5, 3.9), a bare single digit, or a row list
            if p[pos - 1:pos] in ("S", "§") or re.match(r"\.\d", p[m.end():]) \
                    or re.fullmatch(r"\d", nums) or re.search(r"\brows? [\d, and]*$", p[max(0, pos - 40):pos]):
                stats["skipped: section, row or single digit"] += 1
                continue
            if kind == "colon":
                # `file.ts:12-34 ..., :56-78`: the latest `:`-form citation's file
                prior = [c for c in cites if c[1] <= pos and c[5] == "colon"]
            else:
                # its clause: back from its own `(` to the latest `; `, `. ` or `|` outside parentheses
                i, depth = p.rfind("(", 0, pos) - 1, 0
                while i >= 0:
                    ch = p[i]
                    depth += (ch == ")") - (ch == "(")
                    if depth <= 0 and (p[i:i + 2] in ("; ", ". ") or ch == "|"):
                        break
                    depth = max(depth, 0)
                    i -= 1
                prior = [c for c in cites if i < c[0] and c[1] <= pos]
            taken.append((pos, m.end()))
            if not prior:
                record(start, f"- {nums}", "UNBOUND", kind, is_21)
                continue
            before = [c for q, c in shas if q < pos]
            sha = before[-1] if before else DEFAULT
            extra.append((pos, m.end(), prior[-1][2], nums, sha, kind, prior[-1][6]))
    for s, e, fname, nums, sha, form, wt in cites + extra:
        if fname == "file.ts" and p.count("`", 0, s) % 2:
            stats["skipped: example in a code span"] += 1
        elif wt:
            stats["skipped: worktree citation"] += 1
        else:
            stats[f"form {form}"] += 1
            check(start, p, fname, nums, s, sha, is_21)

if args.out:
    open(args.out, "w", encoding="utf-8").write("\n".join(rows) + "\n")
print("T1", dict(sorted(stats.items())))
print("2.1 rows:")
for r in table21:
    print(" ", r)
for key, (cls, _, used) in allow.items():
    if not used:
        print(f"unused allow entry ({cls}): {key}")
bad = [r for r in rows if not r.startswith("ALLOWED_")]
print(f"T1 failures: {len(bad)}")
for r in bad:
    print(" ", r)
sys.exit(1 if bad else 0)
