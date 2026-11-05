#!/usr/bin/env node
// 82tn.32.30: what a session is doing is one read-only view (CONTRACT.md 8.1, SessionActivity).
// Only the projectors, which write the row's status, and the view may read a busy or retry
// status. Everything else reads the session's activity. A reader listed below is either a
// provider-event reader (it reads what a provider reported, not the row), a view reader, or a
// row writer that reads the row only to correct it; an entry that no longer matches must be removed.
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const reader =
	/(?:[!=]==?\s*["'](?:busy|retry)["'])|(?:["'](?:busy|retry)["']\s*[!=]==?)|case\s+["'](?:busy|retry)["']|IN\s*\(\s*'(?:busy|retry)'|status\s*=\s*'(?:busy|retry)'|session-busy(?:\.js)?["']/;

const allowed = {
	// The projectors and the view.
	"src/lib/persistence/projectors/session-handlers.ts": "projector",
	"src/lib/persistence/effect/projectors-effect.ts": "projector",
	// Provider-event readers: the status a provider reported, before any row exists.
	"src/lib/provider/opencode/opencode-runtime-event-translator.ts": "event",
	"src/lib/provider/relay-event-sink.ts": "event",
	"src/lib/provider/provider-runtime-event-to-domain.ts": "event",
	"src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts":
		"event",
	"src/lib/session/session-retries.ts": "event",
	"src/lib/relay/sse-wiring.ts": "event",
	"src/lib/persistence/effect/inherit-fork-history.ts": "event",
	"src/lib/domain/daemon/Layers/opencode-instances-reconcile.ts": "event",
	// View readers: the status poller publishes each session's status from SessionActivity (busy
	// while the ledger holds its active Run), so these read the view's status, not a row's.
	"src/lib/session-busy.ts": "view",
	"src/lib/relay/monitoring-reducer.ts": "view",
	"src/lib/session/session-info-list.ts": "view",
	// Row writers (32.13) read the row only to correct it. The poller's stale-busy pass does so only
	// when the ledger says nothing may act (8.3).
	"src/lib/domain/relay/Services/session-status-poller.ts": "writer",
	// A dead runner's busy children with no run of their own are settled idle (82tn.32.40).
	"src/lib/provider/session-run-settlement.ts": "writer",
};

const matched = new Set();
let violations = 0;

function check(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (!["node_modules", "generated"].includes(entry.name)) check(path);
			continue;
		}
		// Stories are fixtures: they build rows, they never decide what a session is doing.
		if (
			!/\.(?:ts|svelte)$/.test(entry.name) ||
			/\.stories\.ts$/.test(entry.name)
		)
			continue;
		const file = relative(process.cwd(), path);
		const lines = readFileSync(path, "utf8").split("\n");
		lines.forEach((line, index) => {
			if (!reader.test(line)) return;
			if (file in allowed) {
				matched.add(file);
				return;
			}
			console.error(
				`${file}:${index + 1}: reads a row's busy or retry status; read the session's activity (SessionActivity) instead.`,
			);
			violations++;
		});
	}
}

check(resolve("src"));
for (const file of Object.keys(allowed))
	if (!matched.has(file)) {
		console.error(
			`${file}: no longer reads busy or retry; remove it from the allowed list.`,
		);
		violations++;
	}
console.log(`Row status readers: ${violations} violation(s).`);
process.exitCode = violations ? 1 : 0;
