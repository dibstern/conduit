// OpenCode's process reporter (CONTRACT.md 2.1 row 215, section 9 "OpenCode adapter"). Failure
// modes: no process_started for a bound session; a repeat per event; a new process id never
// reported, so the old runner keeps authority; a daemon restart reusing the server reports a new
// launch instead of a reattach; process_lost written for a process this session never ran on, for
// a stop with no process id, twice for one stop, or outside the settlement's write.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type EffectOpenCodeRuntimeIngress,
	makeEffectOpenCodeRuntimeIngress,
} from "../../../../src/lib/domain/project-services/Services/opencode-runtime-ingress-service.js";
import { ProviderRuntimeIngestionLive } from "../../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

const SESSION_ID = "sess-opencode-ledger-evidence";

const makeRuntime = (filename: string) => {
	const persistence = makePersistenceEffectLayer(filename, "test-project");
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		),
	);
};

const makeIngress = (runtime: ReturnType<typeof makeRuntime>) =>
	runtime.runPromise(
		makeEffectOpenCodeRuntimeIngress({
			warn: vi.fn(),
			debug: vi.fn(),
			info: vi.fn(),
			verbose: vi.fn(),
		}),
	);

const busy = makeSSEEvent("session.status", {
	sessionID: SESSION_ID,
	status: { type: "busy" },
});

describe("OpenCode process evidence", () => {
	let dir: string;
	let runtime: ReturnType<typeof makeRuntime>;
	let ingress: EffectOpenCodeRuntimeIngress;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-opencode-ledger-evidence-"));
		runtime = makeRuntime(join(dir, "events.db"));
		ingress = await makeIngress(runtime);
	});

	afterEach(async () => {
		ingress.stopStatsLogging();
		await runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	const send = (
		target: EffectOpenCodeRuntimeIngress,
		providerProcessId?: string,
	) =>
		Effect.runPromise(
			target.onSSEEventEffect(
				busy,
				SESSION_ID,
				"opencode",
				providerProcessId ? { providerProcessId } : undefined,
			),
		);

	/** Evidence rows with the type of the event committed just after each. */
	const evidence = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ type: string; data: string; next: string }>`
					SELECT e.type, e.data, (SELECT n.type FROM events n
						WHERE n.session_id = e.session_id AND n.sequence > e.sequence
						ORDER BY n.sequence LIMIT 1) AS next
					FROM events e WHERE e.session_id = ${SESSION_ID}
						AND e.type LIKE 'evidence.%' ORDER BY e.sequence`;
				return rows.map((row) => ({
					type: row.type,
					data: JSON.parse(row.data) as unknown,
					next: row.next,
				}));
			}),
		);

	it("reports each process once, a new one fresh and a restart's reused one reattached", async () => {
		await send(ingress, "opencode:p1");
		await send(ingress, "opencode:p1");
		await send(ingress);
		await send(ingress, "opencode:p2");
		ingress.stopStatsLogging();
		const restarted = await makeIngress(runtime);
		await send(restarted, "opencode:p2");
		await send(restarted, "opencode:p2");
		restarted.stopStatsLogging();

		expect(await evidence()).toEqual([
			{
				type: "evidence.process_started",
				data: {
					runnerId: "opencode:p1",
					label: "opencode:p1:0",
					reattached: false,
				},
				next: "session.status",
			},
			{
				type: "evidence.process_started",
				data: {
					runnerId: "opencode:p2",
					label: "opencode:p2:0",
					reattached: false,
				},
				next: "session.status",
			},
			{
				type: "evidence.process_started",
				data: {
					runnerId: "opencode:p2",
					label: "opencode:p2:0",
					reattached: true,
				},
				next: "session.status",
			},
		]);
		// The arm folded them: the ledger's entries name the new process's label.
		const folded = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{ entry_json: string }>`
					SELECT entry_json FROM run_ledger_entries WHERE session_id = ${SESSION_ID}`;
			}),
		);
		expect(folded.some((row) => row.entry_json.includes("opencode:p2:0"))).toBe(
			true,
		);
	});

	it("loses the stopped process once, in the stop settlement's write", async () => {
		await send(ingress, "opencode:p1");
		// A stop naming no process, or one this session never ran on, loses nothing.
		await Effect.runPromise(ingress.onInstanceStopped("opencode", () => true));
		await Effect.runPromise(
			ingress.onInstanceStopped("opencode", () => true, "opencode:other"),
		);
		await Effect.runPromise(
			ingress.onInstanceStopped("opencode", () => true, "opencode:p1"),
		);
		await Effect.runPromise(
			ingress.onInstanceStopped("opencode", () => true, "opencode:p1"),
		);

		const lost = (await evidence()).filter(
			(row) => row.type === "evidence.process_lost",
		);
		expect(lost).toEqual([
			{
				type: "evidence.process_lost",
				data: { runnerId: "opencode:p1", retiredAt: expect.any(Number) },
				next: "session.status",
			},
		]);
	});
});
