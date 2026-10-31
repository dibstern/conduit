"""T3 reader sweep (Run Ledger CONTRACT.md A.18 T3, A.21; bead 32.2.18). Read-only on the contract and bd.

Run from the repo root before every contract review round:
    python3 -I scripts/run-ledger/t3-reader-sweep.py [--contract PATH] [--allow PATH] [--hits OUT.tsv]
        [--pending DIR]
or `pnpm check:run-ledger-contract`, which runs T1 and this. Needs `bd` on PATH and its database
reachable: any bd failure, or a listed bead that `bd show` prints nothing for, fails the sweep. Exit 0
only when every hit is allowed and the recount agrees; 1 otherwise. Every subprocess is checked, so
no failure is masked (the role `bash -o pipefail` played for the shell prototype).

Terms: the backticked items of the last "Terms changed" paragraph in Appendix A, each a literal,
case-insensitive search. A term wrapped across two lines is found on its first line.
Swept: all of CONTRACT.md (A.11 to A.17 included) but src comments, the Terms paragraph and Rejected
clauses; `bd show <id> --long` of every bead the 12.2 table's first column names (a `32.7, 32.23`
cell is split on commas, a `32.16 (runner R1)` or `25scs (new, ...)` cell read by its id), plus 32.2
and its children that are not closed, with the same skips. A pending note (`<DIR>/<bead id>.txt`, a
note not yet written to the bead) is appended as if `bd update --append-notes` had run.
Newest note (A.21): each bead's newest note (the text its last notes change appended, from
`bd history`, or the pending note) is also swept on its own, unwrapped, as live text: a hit there is
allowed only by owner or pointer entries (32.2.18's REDESIGN-11 acceptance): any other entry
starting on that line fails it.
A hit is one line with one or more terms. It is allowed when an allow entry starts on the line (it
may run onto later lines); on a line with no non-blank line within the next 3, also by an entry that
starts on the line before and ends on it. Entries are matched with whitespace and backticks removed
on both sides, so one entry holds in bd's wrapped form and in the note's unwrapped text.
Allow list (t3-allow.txt beside this script): `substring<TAB>class`, class one of history,
rejected, unrelated, pointer, owner; the substring 40 or more characters; blank lines and lines
starting with # (with no tab) are ignored. Unused entries are printed, not failed.
Recount: the newest round's (the last Decided block, contract or build) header counts equal its
bullets, and its rule counts equal the last itemized "Rule count against HEAD" list (base plus one
per Deleted and Added bullet) and that list's Result line.
"""
import argparse, json, os, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(__file__)), "rev-parse", "--show-toplevel"],
                      capture_output=True, text=True, check=True).stdout.strip()
CLASSES = ("history", "rejected", "unrelated", "pointer", "owner")
LIVE_CLASSES = ("pointer", "owner")

ap = argparse.ArgumentParser(description="Run Ledger contract reader sweep (A.18 T3)")
ap.add_argument("--contract", default=os.path.join(ROOT, "docs/plans/2026-10-24-run-ledger-contract/CONTRACT.md"))
ap.add_argument("--allow", default=os.path.join(ROOT, "scripts/run-ledger/t3-allow.txt"))
ap.add_argument("--hits", help="write every hit line, with its class or UNALLOWED, to this TSV")
ap.add_argument("--pending", help="directory of pending notes, <bead id>.txt")
args = ap.parse_args()

if not shutil.which("bd"):
    sys.exit("T3: bd is not on PATH; the sweep must read the beads, so it cannot pass without bd")


def bd(*argv):
    r = subprocess.run(["bd", *argv], cwd=ROOT, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"T3: bd {' '.join(argv)} failed ({r.returncode}): {r.stderr.strip()[:300]}")
    return r.stdout


lines = open(args.contract, encoding="utf-8").read().split("\n")
a = next(i for i, l in enumerate(lines) if l.startswith("### 12.2 "))
b = next(i for i, l in enumerate(lines) if i > a and l.startswith("#"))
ids = {"conduit-test-82tn.32.2"}
for l in lines[a:b]:
    if not l.startswith("| ") or l.startswith(("| Ticket", "|---")):
        continue
    for part in l.split("|")[1].split(","):
        word = part.split()[0] if part.split() else ""
        if re.fullmatch(r"32(?:\.\d+)+", word):
            ids.add(f"conduit-test-82tn.{word}")
        elif re.fullmatch(r"[0-9a-z]{4,6}", word) and re.search(r"\d", word):
            ids.add(f"conduit-test-{word}")
ids |= {x["id"] for x in json.loads(bd("children", "conduit-test-82tn.32.2", "--json")) if x["status"] != "closed"}
pending = {}
if args.pending:
    pending = {f[:-4]: open(os.path.join(args.pending, f), encoding="utf-8").read()
               for f in os.listdir(args.pending) if f.endswith(".txt")}
    ids |= set(pending)


def newest_note(bead_id):
    """The text the bead's last notes change appended (the whole field if it was rewritten)."""
    current = json.loads(bd("show", bead_id, "--json"))
    notes = (current[0] if isinstance(current, list) else current).get("notes") or ""
    for snap in json.loads(bd("history", bead_id, "--json")):
        older = (snap.get("Issue") or {}).get("notes") or ""
        if older != notes:
            return notes[len(older):].strip() if notes.startswith(older) else notes
    return notes


def read_bead(bead_id):
    text = bd("show", bead_id, "--long")
    if not text.strip():
        sys.exit(f"T3: bd show {bead_id} printed nothing")
    note = pending.get(bead_id)
    if note is not None:
        return text + f"\nPENDING NOTE ({bead_id}.txt)\n" + note, note
    return text, newest_note(bead_id)


with ThreadPoolExecutor(6) as pool:
    beads = dict(zip(sorted(ids), pool.map(read_bead, sorted(ids))))

starts = [i for i, l in enumerate(lines) if l.startswith("Terms changed")]
if not starts:
    sys.exit("T3: no Terms changed line")
t0 = t1 = starts[-1]
while t1 < len(lines) and lines[t1].strip():
    t1 += 1
body = " ".join(lines[t0:t1]).split("):", 1)[1]
terms = [m.group(1) or m.group(2) for m in re.finditer(r"``\s(.+?)\s``|`([^`]+)`", body)]
pats = [(t, re.compile(re.escape(t), re.IGNORECASE)) for t in terms]
NOTE = re.compile(r"\d{4}-\d\d-\d\d |(REDESIGN|R\d+)[^:]{0,40}:")


def searchable(text_lines, skipped, bead):
    """Blank src comments, skipped lines and Rejected clauses (to the end of the bullet,
    paragraph or table cell). Yields (line index, searchable text)."""
    in_rejected = in_src = False
    for i, raw in enumerate(text_lines):
        s = raw.strip()
        if s.startswith("<!-- src:") or in_src:
            in_src = "-->" not in s
            continue
        if i in skipped:
            in_rejected = False
            continue
        if not s or s.startswith(("- ", "|", "#", "•", "[")) or (bead and NOTE.match(s)):
            in_rejected = False
        if s.startswith("|"):
            yield i, "|".join(c for c in raw.split("|") if not c.strip().lower().startswith("rejected"))
            continue
        text = "" if in_rejected else raw
        if not in_rejected and "Rejected:" in raw:
            text = raw[: raw.index("Rejected:")]
            in_rejected = True
        yield i, text


def squash(s):
    return re.sub(r"[\s`]+", "", s)


allow = []
for n, l in enumerate(open(args.allow, encoding="utf-8").read().split("\n"), 1):
    if not l.strip() or (l.startswith("#") and "\t" not in l):
        continue
    sub, _, cls = l.rpartition("\t")
    if cls not in CLASSES or not sub:
        sys.exit(f"T3 allow line {n}: bad entry {l!r}")
    if len(sub) < 40:
        sys.exit(f"T3 allow line {n}: entry under 40 characters {sub!r}")
    allow.append([squash(sub), cls, 0, sub])
longest = max((len(e[0]) for e in allow), default=0)

sources = [("CONTRACT.md", lines, set(range(t0, t1)), False)]
for bead_id, (text, note) in beads.items():
    short = bead_id.removeprefix("conduit-test-").removeprefix("82tn.")
    sources.append((f"bead {short}", text.split("\n"), set(), False))
    if note.strip():
        sources.append((f"bead {short} newest note", note.split("\n"), set(), True))

hits = []
for src, text_lines, skipped, live in sources:
    offs = [0]
    for raw in text_lines:
        offs.append(offs[-1] + len(squash(raw)))
    flat = "".join(squash(raw) for raw in text_lines)
    rows = list(searchable(text_lines, skipped, src.startswith("bead")))
    for k, (i, text) in enumerate(rows):
        # A term may wrap onto the next line: search this line joined to the next, counting only
        # matches that start on this line.
        head = text.rstrip()
        nxt = rows[k + 1][1].strip() if k + 1 < len(rows) and rows[k + 1][0] == i + 1 else ""
        found = [t for t, p in pats if any(m.start() < len(head) for m in p.finditer(head + " " + nxt))]
        if not found:
            continue
        # A short last line of a block has no next line: an entry may then start on the line before it.
        last = i > 0 and not any(x.strip() for x in text_lines[i + 1:i + 4])
        lo = offs[i - 1] if last else offs[i]
        window = flat[lo:offs[i + 1] + longest]
        matched = []
        for e in allow:
            at = window.find(e[0])
            while at >= 0:
                pos = lo + at
                if offs[i] <= pos < offs[i + 1] or (last and pos < offs[i] < pos + len(e[0])):
                    matched.append(e)
                    break
                at = window.find(e[0], at + 1)
        for e in matched:
            e[2] += 1
        # A newest note is live text: every entry on its line must be owner or pointer.
        usable = matched if not live or all(e[1] in LIVE_CLASSES for e in matched) else []
        hits.append((src, i + 1, found, text_lines[i].strip(), usable[0][1] if usable else None))

rounds = [(m.group(1), m.group(2), i) for i, l in enumerate(lines)
          for m in [re.match(r"\*\*Decided \((contract|build) round (\d+[a-z]?)", l)] if m]
kind, rnd, blk = rounds[-1]
blk_end = next(i for i, l in enumerate(lines) if i > blk and l.startswith("#"))
block = " ".join(lines[blk:blk_end])
label = "Round" if kind == "contract" else "Build round"
hdr = re.search(rf"{label} {rnd} \(contract,\s+after\s+redesign\s+\d+\):\s+(\d+)\s+new\s+decisions?,\s+(\d+)\s+amend",
                block)
nd = sum(1 for l in lines[blk:blk_end] if re.match(r"- D\d+ ", l))
na = sum(1 for l in lines[blk:blk_end] if l.startswith("- Amends "))
count_ok = bool(hdr) and (int(hdr.group(1)), int(hdr.group(2))) == (nd, na)
print(f"recount {kind} round {rnd} header {hdr.groups() if hdr else None}; bullets: {nd} decisions, {na} amendments; "
      + ("agree" if count_ok else "DISAGREE"))
rules = re.search(r"deletes\s+(\d+)\s+rules\s+and\s+adds\s+(\d+):\s+(\d+)\s+more", block)
r0 = [i for i, l in enumerate(lines) if l.startswith("Rule count against HEAD, by")][-1]
r1 = next(i for i in range(r0 + 1, len(lines)) if not lines[i].strip())
items = [l for l in lines[r0:r1] if l.startswith("- ")]
base = re.match(r"- Base, A\.\d+: (\d+) deleted, (\d+) added\.", items[0]) if items else None
from_add = sum(1 for l in items if re.match(r"- Deleted from A\.\d+'s additions:", l))
head_del = sum(1 for l in items if l.startswith("- Deleted HEAD rule:"))
added = sum(1 for l in items if l.startswith("- Added:"))
res = next((re.match(r"- Result: (\d+) deleted and (\d+) added, (\d+) net", l) for l in items
            if l.startswith("- Result:")), None)
want = got_hdr = got_res = None
if base and res and rules:
    d, a = int(base.group(1)) + head_del, int(base.group(2)) - from_add + added
    want, got_hdr, got_res = (d, a, a - d), tuple(int(x) for x in rules.groups()), tuple(int(x) for x in res.groups())
rules_ok = want is not None and want == got_hdr == got_res
print(f"rule recount: itemized {want}; header {got_hdr}; Result line {got_res}; "
      + ("agree" if rules_ok else "DISAGREE"))

if args.hits:
    with open(args.hits, "w", encoding="utf-8") as f:
        for src, n, found, raw, cls in hits:
            f.write(f"{cls or 'UNALLOWED'}\t{src}:{n}\t{'; '.join(found)}\t{raw}\n")
by_class = {}
for h in hits:
    by_class[h[4] or "UNALLOWED"] = by_class.get(h[4] or "UNALLOWED", 0) + 1
print(f"terms {len(terms)}; sources {len(sources)} (CONTRACT.md, {len(beads)} beads, newest notes); "
      f"hit lines {len(hits)}; " + ", ".join(f"{k} {v}" for k, v in sorted(by_class.items())))
unallowed = [h for h in hits if h[4] is None]
for src, n, found, raw, _ in unallowed:
    print(f"UNALLOWED {src}:{n} [{'; '.join(found)}] {raw[:160]}")
for _, cls, used, sub in allow:
    if not used:
        print(f"unused allow entry ({cls}): {sub[:120]}")
sys.exit(1 if unallowed or not (count_ok and rules_ok) else 0)
