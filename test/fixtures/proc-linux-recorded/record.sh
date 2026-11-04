#!/bin/sh
# Records the /proc tree port-watcher.test.ts "recorded on Linux" reads: in a Linux container, a shell
# marked CONDUIT_SESSION_ID=s1 runs a node server on port 0 in /work/app with stdout on a Claude task
# output file; then every process's stat, cmdline, environ, /proc/stat and /proc/net/tcp{,6} are
# copied as they are, and each cwd and fd link's target goes to links.json (the test makes the links).
# Run from anywhere with Docker: sh record.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
rm -rf "$here/proc" "$here/meta.json" "$here/links.json"
docker run --rm --network none --user "$(id -u)" -v "$here:/out" node:24-bookworm-slim sh -c '
mkdir -p /tmp/work/app /tmp/claude/tasks && cd /tmp/work/app
cat > server.cjs <<JS
const server = require("node:http").createServer((_, res) => res.end("ok"));
const startedMs = Date.now();
server.listen(0, () => require("node:fs").writeFileSync("/tmp/started", JSON.stringify({ port: server.address().port, pid: process.pid, startedMs })));
JS
CONDUIT_SESSION_ID=s1 sh -c "cd /tmp/work/app && node server.cjs > /tmp/claude/tasks/brec1.output; true" &
while [ ! -s /tmp/started ]; do sleep 0.1; done
node -e "
const fs = require(\"node:fs\"), { join } = require(\"node:path\");
const out = \"/out/proc\";
const copy = (from, to) => { try { fs.writeFileSync(to, fs.readFileSync(from)); } catch {} };
const links = {};
const link = (from, to) => { try { links[to.slice(out.length + 1)] = fs.readlinkSync(from); } catch {} };
fs.mkdirSync(join(out, \"net\"), { recursive: true });
copy(\"/proc/stat\", join(out, \"stat\"));
for (const t of [\"tcp\", \"tcp6\"]) copy(\"/proc/net/\" + t, join(out, \"net\", t));
for (const pid of fs.readdirSync(\"/proc\").filter((n) => /^\\d+$/.test(n))) {
  const at = join(out, pid);
  fs.mkdirSync(join(at, \"fd\"), { recursive: true });
  for (const f of [\"stat\", \"cmdline\", \"environ\"]) copy(join(\"/proc\", pid, f), join(at, f));
  link(join(\"/proc\", pid, \"cwd\"), join(at, \"cwd\"));
  for (const fd of fs.readdirSync(join(\"/proc\", pid, \"fd\"))) link(join(\"/proc\", pid, \"fd\", fd), join(at, \"fd\", fd));
}
fs.writeFileSync(\"/out/links.json\", JSON.stringify(links, null, \"\\t\") + \"\n\");
const started = JSON.parse(fs.readFileSync(\"/tmp/started\", \"utf8\"));
fs.writeFileSync(\"/out/meta.json\", JSON.stringify({ uid: process.getuid(), ...started, kernel: fs.readFileSync(\"/proc/version\", \"utf8\").trim() }, null, \"\\t\") + \"\n\");
"
'
