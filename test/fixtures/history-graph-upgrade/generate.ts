// Generates the stores beside this file: daemon event stores written by the
// build before the History Graph (conduit-test-82tn.50), which
// test/integration/daemon/history-graph-upgrade.test.ts copies, opens with the
// current build and checks: every session's messages and parts read exactly as
// they did before the upgrade. One store per provider, each driven through the
// process harness and that provider's fake:
// - claude.db: a plain chat, a chat rewound to its second prompt and sent on
//   (the rewind's removals are committed), a fork, and a Run still running
//   when the daemon is killed;
// - codex.db: a Run with a steer (two turns, one Run);
// - cursor.db: a Run whose subagent writes its own session;
// - opencode.db: a plain chat.
//
// Regenerate only on purpose, from a build before migration 0094:
//
//   export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
//   pnpm build </dev/null
//   CONDUIT_TEST_DIST=dist pnpm exec tsx test/fixtures/history-graph-upgrade/generate.ts </dev/null

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/account.js";
import {
	codexModels,
	fixtureRows,
	signedInCodexDiscoveryTrace,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 30_000;
const dist = process.env["CONDUIT_TEST_DIST"] ?? "dist";
const output = (name: string) =>
	fileURLToPath(new URL(`./${name}.db`, import.meta.url));

const query = <T>(harness: ProcessHarness, sql: string, ...args: string[]) => {
	const db = new DatabaseSync(harness.daemonStorePath(), { readOnly: true });
	try {
		return db.prepare(sql).all(...args) as T[];
	} finally {
		db.close();
	}
};

const until = async (what: string, ready: () => boolean | Promise<boolean>) => {
	const deadline = Date.now() + TIMEOUT;
	while (!(await ready())) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
		// test-waits-allow real-wait: this generator drives real provider processes outside vitest, with no virtual clock.
		await sleep(100);
	}
};

const turnsSettled = (harness: ProcessHarness, sessionId: string, n: number) =>
	until(`${n} settled turns in ${sessionId}`, () => {
		const states = query<{ state: string }>(
			harness,
			"SELECT state FROM turns WHERE session_id = ?",
			sessionId,
		).map(({ state }) => state);
		return states.length === n && states.every((s) => s === "completed");
	});

const submit = async (
	browser: ProcessBrowser,
	sessionId: string,
	text: string,
	delivery: "queue" | "steer" = "queue",
) => {
	await browser.followSession(sessionId);
	const result = await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			originId: browser.originId,
			inputId: randomUUID(),
			delivery,
			text,
		}),
	);
	if (!result.ok) throw new Error(`Submit refused: ${text}`);
};

/** Folds the WAL in and copies the store to one file beside this script. */
const save = (harness: ProcessHarness, name: string) => {
	const store = harness.daemonStorePath();
	const db = new DatabaseSync(store);
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		db.exec("PRAGMA journal_mode = DELETE");
		db.exec("VACUUM");
	} finally {
		db.close();
	}
	if (existsSync(`${store}-wal`))
		throw new Error("The store still has a WAL after checkpointing");
	copyFileSync(store, output(name));
	console.log(`Wrote ${output(name)}`);
};

const generate = async (
	name: string,
	options: Parameters<typeof ProcessHarness.create>[0],
	drive: (harness: ProcessHarness) => Promise<void>,
) => {
	const harness = ProcessHarness.create({ dist, ...options });
	try {
		await drive(harness);
		save(harness, name);
	} finally {
		await harness.dispose();
	}
};

const userMessageId = async (
	browser: ProcessBrowser,
	sessionId: string,
	text: string,
) => {
	const found = (await browser.history(sessionId)).find(
		(message) =>
			message.role === "user" &&
			(message.parts ?? []).some((part) => part.text === text),
	);
	if (!found) throw new Error(`Missing user message ${text}`);
	return found.id;
};

await generate("claude", {}, async (harness) => {
	await harness.restart();
	const browser = await harness.connect();
	await browser.setAutoSettle(null);
	const plain = await browser.createSession("Upgrade plain");
	for (const prompt of ["upgrade-plain-first", "upgrade-plain-second"])
		await browser.send(plain, prompt);
	const rewound = await browser.createSession("Upgrade rewound");
	for (const prompt of ["rewind-one", "rewind-two", "rewind-three"])
		await browser.send(rewound, prompt);
	const target = await userMessageId(browser, rewound, "rewind-two");
	await Effect.runPromise(
		browser.rpc.RewindSession({ sessionId: rewound, messageId: target }),
	);
	// The next send commits the rewind: today's projector deletes the rows.
	await browser.send(rewound, "rewind-after");
	await Effect.runPromise(
		browser.rpc.ForkSession({ sessionId: plain, originId: browser.originId }),
	);
	const running = await browser.createSession("Upgrade running");
	await browser.send(running, "upgrade-running-first");
	void browser.send(running, "approval-upgrade-running").catch(() => undefined);
	await until(
		"the running Run's approval",
		() =>
			query(
				harness,
				"SELECT 1 FROM pending_approvals WHERE session_id = ? AND status = 'pending'",
				running,
			).length > 0,
	);
	// A kill leaves the Run active in the store, as a crash before an upgrade does.
	await harness.kill();
});

await generate("codex", {}, async (harness) => {
	const tracePath = join(harness.root, "codex-replay.jsonl");
	const gatePath = join(harness.root, "codex-replay-gate");
	const capturePath = join(harness.root, "codex-capture.jsonl");
	const writeTrace = (trace: TraceRow[]) =>
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	writeTrace(signedInCodexDiscoveryTrace());
	const discoveryPath = join(harness.root, "codex-discovery.jsonl");
	const traceMap = join(harness.root, "codex-trace-map.json");
	writeFileSync(discoveryPath, readFileSync(tracePath, "utf8"));
	writeFileSync(
		traceMap,
		JSON.stringify({ "*": { "codex-discovery": { trace: discoveryPath } } }),
	);
	writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
	await harness.restart({
		startupTimeoutMs: TIMEOUT,
		runnerStartupTimeoutMs: TIMEOUT,
		serviceEnvironment: {
			CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
			CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
			CONDUIT_CODEX_APP_SERVER_TRACE_GATE: gatePath,
			CONDUIT_TEST_CODEX_TRACE_MAP: traceMap,
		},
	});
	const browser = await harness.connect();
	await browser.setAutoSettle(null);
	let account: { id: string } | undefined;
	await until("Codex account", async () => {
		account = (await browser.instances()).instances.find(
			({ driver }) => driver === "codex",
		);
		return account !== undefined;
	});
	if (!account) throw new Error("Missing Codex account");
	await codexModels(browser, account.id);
	const sessionId = await browser.createSession(
		"Upgrade steer",
		account.id,
		"codex",
		{ modelId: "gpt-6.1-sol", contextWindow: "", permissionMode: "ask" },
	);
	writeTrace(fixtureRows("steer"));
	// Hold the replay after the steer's acknowledgement, as codex-run-ledger's steer case does.
	writeFileSync(gatePath, "591");
	await submit(browser, sessionId, "Say hello");
	const captured = (method: string) =>
		existsSync(capturePath) &&
		readFileSync(capturePath, "utf8")
			.split("\n")
			.filter(Boolean)
			.some(
				(line) => (JSON.parse(line) as TraceRow).message?.method === method,
			);
	await until("the Codex reply's first delta", () =>
		captured("item/agentMessage/delta"),
	);
	await submit(browser, sessionId, "Use the steered instruction", "steer");
	await until("the Codex steer", () => captured("turn/steer"));
	writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
	await turnsSettled(harness, sessionId, 2);
	await harness.terminate();
});

await generate("cursor", {}, async (harness) => {
	const tracePath = join(harness.root, "cursor-replay.jsonl");
	const read = (source: string) =>
		readFileSync(
			resolve(`test/fixtures/cursor-sdk-traces/${source}.jsonl`),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind?: string });
	const rows = read("subagent-foreground-default-fixed");
	const catalog = read("basic").find(({ kind }) => kind === "models.list");
	if (!catalog) throw new Error("Basic capture has no model catalog");
	rows.splice(
		1,
		0,
		{
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		} as { kind: string },
		...(rows.some(({ kind }) => kind === "models.list") ? [] : [catalog]),
	);
	writeFileSync(
		tracePath,
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	await harness.restart({
		startupTimeoutMs: TIMEOUT,
		runnerStartupTimeoutMs: TIMEOUT,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: tracePath,
			CONDUIT_CURSOR_SDK_CAPTURE: join(harness.root, "cursor-capture.jsonl"),
			CONDUIT_TEST_CURSOR_DELTA_DELAY_MS: "2",
		},
	});
	const added = await harness.requestRpc({
		_tag: "AddInstance",
		name: "Cursor upgrade",
		driver: "cursor",
	});
	if (!added.addedInstanceId) throw new Error("Missing Cursor account");
	const browser = await harness.connect();
	await browser.setAutoSettle(null);
	const sessionId = await browser.createSession(
		"Upgrade subagent",
		added.addedInstanceId,
		"cursor",
		{ modelId: "composer-2.5", contextWindow: "", permissionMode: "ask" },
	);
	await submit(browser, sessionId, "Replay the captured subagent turn.");
	await turnsSettled(harness, sessionId, 1);
	await until(
		"the Cursor subagent's session",
		() =>
			query(harness, "SELECT 1 FROM sessions WHERE parent_id = ?", sessionId)
				.length > 0,
	);
	await harness.terminate();
});

await generate(
	"opencode",
	{
		managedOpenCode: true,
		managedOpenCodeId: MANAGED_OPENCODE_ACCOUNT_ID,
		autoStartOpenCode: true,
		managedOpenCodeStopGraceMs: 100,
	},
	async (harness) => {
		await harness.restart();
		const browser = await harness.connect();
		await browser.setAutoSettle(null);
		const sessionId = await browser.createSession(
			"Upgrade OpenCode",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		for (const prompt of ["upgrade-opencode-first", "upgrade-opencode-second"])
			await browser.send(sessionId, prompt);
		await harness.terminate();
	},
);
