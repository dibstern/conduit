// Asks from every project reach every tab and every device, once (82tn.12, bead note), over the
// process harness with a managed fake OpenCode and the fake Claude SDK. How it could fail (the
// lane's catalogue, entry 15):
// a. an ask in project A reaches only tabs attached to A;
// b. a Claude ask sends no push;
// c. an ask is notified twice (two feeds, two tabs' worth of pushes, or a re-read pending set);
// d. an OpenCode ask and a Claude ask take different paths and one of them is lost.
import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/account.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const gitOverrides = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of gitOverrides) delete gitEnv[key];

function seedRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	execFileSync("git", ["init", "-b", "main", directory], {
		env: gitEnv,
		stdio: "pipe",
	});
	execFileSync(
		"git",
		[
			"-C",
			directory,
			"-c",
			"user.name=Ask alerts test",
			"-c",
			"user.email=asks@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		],
		{ env: gitEnv, stdio: "pipe" },
	);
}

/** A push service on loopback that counts what the daemon delivers. */
async function pushSink(root: string) {
	const key = join(root, "sink.key");
	const cert = join(root, "sink.crt");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
		],
		{ stdio: "pipe" },
	);
	const deliveries: { at: number; path: string }[] = [];
	const server: Server = createServer(
		{ key: readFileSync(key), cert: readFileSync(cert) },
		(request, response) => {
			request.resume();
			request.on("end", () => {
				deliveries.push({ at: Date.now(), path: request.url ?? "" });
				response.writeHead(201).end();
			});
		},
	);
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	const { port } = server.address() as AddressInfo;
	return { endpoint: `https://127.0.0.1:${port}/device`, deliveries, server };
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("asks from every project notify once (82tn.12)", () => {
	let harness: ProcessHarness | undefined;
	let sink: Server | undefined;
	let evidence: () => Record<string, unknown> = () => ({});

	afterEach(async ({ task }) => {
		sink?.close();
		sink = undefined;
		const fixture = harness;
		harness = undefined;
		const proof = evidence();
		try {
			await fixture?.dispose();
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-12-ask-alerts.json",
				JSON.stringify(
					{
						ticket: "conduit-test-82tn.12",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...proof,
					},
					null,
					2,
				),
			);
		}
	});

	it("an OpenCode ask and a Claude ask in A each alert a tab on B once and push once", async () => {
		for (const key of gitOverrides) vi.stubEnv(key, undefined);
		const fixture = ProcessHarness.create({
			managedOpenCode: true,
			managedOpenCodeId: MANAGED_OPENCODE_ACCOUNT_ID,
			autoStartOpenCode: true,
			runnerLifecycle: { idleTimeoutMs: null },
		});
		harness = fixture;
		const device = await pushSink(fixture.root);
		sink = device.server;
		const projectB = join(fixture.root, "project-b");
		seedRepository(fixture.projectDir);
		seedRepository(projectB);
		await fixture.restart({
			startupTimeoutMs: 120_000,
			runnerStartupTimeoutMs: 90_000,
			serviceEnvironment: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
		});
		const { savedSlug: slugB } = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [projectB],
		});
		const subscribed = await fetch(`${fixture.baseUrl}/api/push/subscribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: fixture.baseUrl },
			body: JSON.stringify({
				subscription: {
					endpoint: device.endpoint,
					keys: {
						p256dh: createECDH("prime256v1")
							.generateKeys()
							.toString("base64url"),
						auth: randomBytes(16).toString("base64url"),
					},
				},
			}),
		});
		expect(subscribed.status).toBe(200);

		// Two tabs on B: each gets one alert per ask; the device gets one push per ask.
		const tabs = await Promise.all([
			fixture.connect(undefined, undefined, slugB, false),
			fixture.connect(undefined, undefined, slugB, false),
		]);
		await Promise.all(tabs.map((tab) => tab.followAlerts()));

		const author = await fixture.connect(undefined, undefined, "process-test");
		const openCodeSession = await author.createSession(
			"OpenCode ask in A",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		const { sessionId: claudeSession } = await fixture.requestRpc({
			_tag: "CreateSession",
			projectSlug: "process-test",
			originId: "ask-alerts",
			providerId: "claude",
			model: { providerId: "claude", modelId: "sonnet" },
			permissionMode: "ask",
			title: "Claude ask in A",
		});
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(fixture.projectDir),
			payload: {
				id: "evt_ask_alerts",
				type: "permission.asked",
				properties: {
					id: "per_ask_alerts",
					sessionID: openCodeSession,
					permission: "bash",
					patterns: ["echo ask-alerts"],
					metadata: {},
					always: [],
				},
			},
		});
		void author
			.send(claudeSession, "question-fixed-ask-alerts", 120_000)
			.catch(() => undefined);
		await author.waitFor(
			(message) =>
				message["type"] === "question_pending" &&
				message["sessionId"] === claudeSession,
			0,
			60_000,
		);
		await author.close();

		const alertsOf = (tab: ProcessBrowser) =>
			tab.frames
				.map(({ message }) => message)
				.filter(
					(message) =>
						message["type"] === "alert" &&
						(message["kind"] === "permission" ||
							message["kind"] === "question"),
				)
				.map((message) => ({
					kind: message["kind"],
					sessionId: message["sessionId"],
					alertId: message["alertId"],
				}));
		evidence = () => ({
			openCodeSession,
			claudeSession,
			alertsByTab: tabs.map(alertsOf),
			pushes: device.deliveries,
		});
		await vi.waitFor(
			() => {
				for (const tab of tabs) expect(alertsOf(tab)).toHaveLength(2);
				expect(device.deliveries).toHaveLength(2);
			},
			{ timeout: 20_000 },
		);
		// Long enough for a second alert or push (a re-read pending set, a reconnect) to land.
		await pause(4_000);
		const expected = [
			{
				kind: "permission",
				sessionId: openCodeSession,
				alertId: expect.any(String),
			},
			{
				kind: "question",
				sessionId: claudeSession,
				alertId: expect.any(String),
			},
		];
		for (const tab of tabs)
			expect(
				[...alertsOf(tab)].sort((a, b) =>
					String(a.kind).localeCompare(String(b.kind)),
				),
			).toEqual(expected);
		expect(device.deliveries).toHaveLength(2);
	}, 180_000);
});
