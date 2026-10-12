// Failure modes: login kind is lost on the wire, invalid paths inherit the
// default, recovery duplicates a turn, or an old runner reads a tagged object.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Effect, Either } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
let evidence: Record<string, unknown> = {};
const proofs: Record<string, unknown>[] = [];
afterEach(async () => {
	mkdirSync("test-results", { recursive: true });
	proofs.push({ ...evidence, process: harness?.proof() });
	writeFileSync(
		"test-results/g4zp-4-legacy-folder-replay.json",
		JSON.stringify(proofs, null, 2),
	);
	await harness?.dispose();
	harness = undefined;
});

it.each([
	"missing-folder",
	"legacy-configured",
	"tagged-default",
	"empty-string",
	"empty-tagged-path",
	"empty-native-path",
	"missing-login-kind",
	"invalid-default-path",
] as const)("replays or rejects serialized %s after restart with its complete login", async (scenario) => {
	evidence = { scenario };
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		foregroundCli: true,
		restartProof: true,
		holdRunnerOutput: "send-turn",
	});
	const running = harness;
	const defaultFolder = join(running.root, "default-claude");
	const sdkDefault = scenario === "tagged-default";
	const expectedFolder = sdkDefault
		? join(running.root, "home", ".claude")
		: scenario === "legacy-configured"
			? join(running.root, "login-home", ".claude")
			: defaultFolder;
	mkdirSync(expectedFolder, { recursive: true });
	const invalid =
		scenario === "empty-string" ||
		scenario === "empty-tagged-path" ||
		scenario === "empty-native-path" ||
		scenario === "missing-login-kind" ||
		scenario === "invalid-default-path";
	const proofPath = join(running.root, "sdk-proof.ndjson");
	if (sdkDefault) {
		const hook = join(running.root, "implicit-sdk-login.mjs");
		writeFileSync(hook, 'delete process.env["CLAUDE_CONFIG_DIR"];\n');
		await running.restart({
			serviceEnvironment: {
				NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
			},
		});
	} else
		await running.restart({ cliArgs: ["--claude-config-dir", expectedFolder] });
	const browser = await running.connect();
	const sessionId = await browser.createSession("Legacy launch folder");
	const pending = browser
		.send(sessionId, "legacy-folder-replay")
		.catch(() => undefined);
	await vi.waitFor(
		() => {
			const marks = readFileSync(proofPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(
				marks.some(
					(mark) =>
						mark["kind"] === "held-output" && mark["type"] === "send-turn",
				),
			).toBe(true);
			expect(marks.filter((mark) => mark["kind"] === "query")).toEqual([]);
		},
		{ timeout: 15_000 },
	);
	await running.kill();
	await pending;
	const db = new Database(running.projectStorePath());
	try {
		const stored = db
			.prepare<[string], { payload_json: string }>(
				"SELECT payload_json FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' AND status = 'running'",
			)
			.get(sessionId);
		if (!stored) throw new Error("Missing admitted command");
		const payload: Record<string, unknown> = JSON.parse(stored.payload_json);
		delete payload["configDir"];
		if (scenario === "missing-folder" || scenario === "legacy-configured")
			delete payload["folderSource"];
		if (scenario === "legacy-configured") payload["configDir"] = expectedFolder;
		if (scenario === "tagged-default")
			payload["configDir"] = { _tag: "SdkDefault", path: expectedFolder };
		if (scenario === "empty-string") payload["configDir"] = "";
		if (scenario === "empty-tagged-path")
			payload["configDir"] = { _tag: "Configured", path: "" };
		if (scenario === "missing-login-kind")
			payload["configDir"] = { path: expectedFolder };
		if (scenario === "invalid-default-path")
			payload["configDir"] = { _tag: "SdkDefault", path: defaultFolder };
		payload["nativeThread"] = {
			configDir:
				scenario === "empty-native-path" ? "" : "/wrong/legacy/account",
		};
		const updated = db
			.prepare(`UPDATE provider_command_outbox
			SET payload_json = ?
			WHERE session_id = ? AND effect_type = 'send_turn' AND status = 'running'`)
			.run(JSON.stringify(payload), sessionId);
		expect(updated.changes).toBe(1);
		evidence = {
			scenario,
			sessionId,
			defaultFolder,
			expectedFolder,
			serialized: db
				.prepare(
					"SELECT payload_json FROM provider_command_outbox WHERE session_id = ?",
				)
				.get(sessionId),
		};
	} finally {
		db.close();
	}
	if (invalid) {
		const failure =
			scenario === "missing-login-kind"
				? '["_tag"]'
				: scenario === "invalid-default-path"
					? "Claude SDK default folder must be a .claude directory"
					: "Claude config directory must be non-empty";
		await expect(running.restart()).rejects.toThrow(failure);
		evidence["rejection"] = failure;
		const queries = readFileSync(proofPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as ProcessMark)
			.filter((mark) => mark.kind === "query");
		evidence["queries"] = queries;
		expect(queries).toEqual([]);
		return;
	}
	await running.restart();
	const after = await running.connect(sessionId);
	await after.view(sessionId);
	await vi.waitFor(
		() => {
			const store = new Database(running.projectStorePath(), {
				readonly: true,
			});
			try {
				const command = store
					.prepare<[string], { status: string; error_code: string | null }>(
						"SELECT status, error_code FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
					)
					.get(sessionId);
				evidence["command"] = command;
				expect(command?.status).toBe("completed");
				expect(command?.error_code).toBeNull();
			} finally {
				store.close();
			}
		},
		{ timeout: 15_000 },
	);
	const queries = readFileSync(proofPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ProcessMark)
		.filter(
			(mark) =>
				mark.kind === "query" &&
				JSON.parse(mark.optionsJson).persistSession !== false,
		);
	evidence["queries"] = queries;
	expect(queries).toHaveLength(1);
	for (const query of queries) {
		if (query.kind !== "query") throw new Error("Expected SDK launch proof");
		if (sdkDefault) {
			expect(query.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
			expect(JSON.parse(query.optionsJson).env["HOME"]).toBe(
				join(running.root, "home"),
			);
		} else expect(query.env["CLAUDE_CONFIG_DIR"]).toBe(expectedFolder);
	}
	if (!invalid) {
		const store = new Database(running.projectStorePath(), { readonly: true });
		try {
			const receipt = store
				.prepare<[string], { value: string }>(
					"SELECT value FROM provider_state WHERE session_id = ? AND key = 'nativeThread:claude'",
				)
				.get(sessionId);
			if (!receipt) throw new Error("Missing completed native receipt");
			evidence["receipt"] = JSON.parse(receipt.value);
			expect(JSON.parse(receipt.value)).toMatchObject({
				configDir: {
					_tag: sdkDefault ? "SdkDefault" : "Configured",
					path: expectedFolder,
				},
			});
		} finally {
			store.close();
		}
	}
}, 45_000);

it.skipIf(!process.env["CONDUIT_LEGACY_DIST"]).each([
	{ kind: "Configured", phase: "background" },
	{ kind: "SdkDefault", phase: "background" },
	{ kind: "Configured", phase: "replay" },
	{ kind: "SdkDefault", phase: "replay" },
] as const)(
	"preserves a $kind login on an actual legacy runner during $phase",
	async ({ kind, phase }) => {
		evidence = { kind, phase };
		const legacyDist = process.env["CONDUIT_LEGACY_DIST"];
		if (!legacyDist)
			throw new Error("A committed legacy runner bundle is required");
		harness = ProcessHarness.create({
			dist: legacyDist,
			foregroundCli: true,
			restartProof: true,
			...(phase === "replay" ? { holdRunnerOutput: "send-turn" as const } : {}),
		});
		const running = harness;
		const hook = join(running.root, "implicit-sdk-login.mjs");
		writeFileSync(hook, 'delete process.env["CLAUDE_CONFIG_DIR"];\n');
		await running.restart({
			buildId: "g4zp-legacy-string-folders",
			...(kind === "SdkDefault"
				? {
						serviceEnvironment: {
							NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
						},
					}
				: {}),
		});
		const before = await running.connect();
		let providerId = "claude";
		const folder =
			kind === "SdkDefault"
				? join(running.root, "home", ".claude")
				: join(running.root, "named-account");
		mkdirSync(folder, { recursive: true });
		if (kind === "Configured") {
			const added = await Effect.runPromise(
				before.rpc.AddInstance({
					projectSlug: "process-test",
					name: "legacy-named",
					driver: "claude",
					managed: false,
					configDir: folder,
				}),
			);
			if (!added.addedInstanceId) throw new Error("Missing named account");
			providerId = added.addedInstanceId;
			writeFileSync(
				join(running.root, "config", "daemon.json"),
				JSON.stringify({
					...Either.getOrThrowWith(
						loadDaemonConfigResult(join(running.root, "config")),
						(error) => error,
					),
					instances: added.instances,
				}),
			);
		}
		const sessionId = await before.createSession(
			"Legacy live folder",
			providerId,
		);
		const first = before
			.send(
				sessionId,
				phase === "replay" ? "legacy-folder-replay" : "upgrade-background-work",
			)
			.catch(() => undefined);
		if (phase === "background") {
			await first;
			await vi.waitFor(() =>
				expect(
					running.marks.some(
						(mark) =>
							mark.kind === "background-work" && mark.phase === "started",
					),
				).toBe(true),
			);
		} else {
			await vi.waitFor(
				() => {
					const marks = readFileSync(
						join(running.root, "sdk-proof.ndjson"),
						"utf8",
					)
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as Record<string, unknown>);
					expect(
						marks.some(
							(mark) =>
								mark["kind"] === "held-output" && mark["type"] === "send-turn",
						),
					).toBe(true);
				},
				{ timeout: 15_000 },
			);
		}
		const original = running.marks.find(
			(mark) => mark.kind === "runner-started",
		);
		if (original?.kind !== "runner-started")
			throw new Error("Missing legacy runner");
		await running.kill();
		await first;
		if (phase === "replay") {
			const store = new Database(running.projectStorePath());
			try {
				const row = store
					.prepare<[string], { payload_json: string }>(
						"SELECT payload_json FROM provider_command_outbox WHERE session_id = ? AND status = 'running'",
					)
					.get(sessionId);
				if (!row) throw new Error("Missing held legacy command");
				const payload: Record<string, unknown> = JSON.parse(row.payload_json);
				payload["configDir"] = { _tag: kind, path: folder };
				payload["folderSource"] = "legacyDefault";
				payload["nativeThread"] = {
					configDir: { _tag: "Configured", path: "/wrong/legacy/fallback" },
				};
				store
					.prepare(
						"UPDATE provider_command_outbox SET payload_json = ? WHERE session_id = ? AND status = 'running'",
					)
					.run(JSON.stringify(payload), sessionId);
				evidence["serialized"] = payload;
			} finally {
				store.close();
			}
		}
		await running.restart({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			buildId: "g4zp-tagged-folders",
		});
		const after = await running.connect(sessionId);
		const continued =
			phase === "background"
				? after.send(sessionId, "continue-legacy-folder")
				: undefined;
		await vi.waitFor(() => {
			const store = new Database(running.projectStorePath(), {
				readonly: true,
			});
			try {
				if (phase === "background") {
					expect(
						store
							.prepare<[string], { count: number }>(
								"SELECT COUNT(*) AS count FROM provider_command_outbox WHERE session_id = ? AND status = 'running'",
							)
							.get(sessionId)?.count,
					).toBe(1);
				} else {
					const command = store
						.prepare<[string], { status: string; error_code: string | null }>(
							"SELECT status, error_code FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
						)
						.get(sessionId);
					evidence["command"] = command;
					expect(command).toMatchObject({
						status: "completed",
						error_code: null,
					});
				}
			} finally {
				store.close();
			}
		});
		if (phase === "background")
			writeFileSync(
				join(running.root, "release-upgrade-background"),
				"release",
			);
		await continued;
		const queries = readFileSync(join(running.root, "sdk-proof.ndjson"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as ProcessMark)
			.filter(
				(mark) =>
					mark.kind === "query" &&
					JSON.parse(mark.optionsJson).persistSession !== false,
			);
		evidence = {
			...evidence,
			kind,
			phase,
			sessionId,
			folder,
			original,
			queries,
		};
		expect(queries).toHaveLength(1);
		const query = queries[0];
		if (query?.kind !== "query") throw new Error("Missing query proof");
		expect(query.pid).toBe(original.pid);
		if (kind === "SdkDefault") {
			expect(query.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
			expect(JSON.parse(query.optionsJson).env["HOME"]).toBe(
				join(running.root, "home"),
			);
		} else expect(query.env["CLAUDE_CONFIG_DIR"]).toBe(folder);
	},
	45_000,
);
