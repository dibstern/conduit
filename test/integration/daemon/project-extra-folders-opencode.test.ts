// Re-record the real OpenCode marker read with:
// SCENARIO=multi-folder-project pnpm test:record-snapshots
// Assertions use the fixed marker and replay-time paths, never recorded paths.

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveProject } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const MARKER = "CONDUIT-EXTRA-FOLDER-MARKER-7f3a";
const PROMPT =
	"Use the Read tool to read marker.txt in the additional project folder, then reply with its contents.";

function requestBodies(fixture: ProcessHarness, method: string, path: string) {
	return fixture
		.opencodeRequestBodies()
		.filter((request) => request.method === method && request.path === path)
		.map(({ body }) => JSON.parse(body) as Record<string, unknown>);
}

function permissionUpdates(fixture: ProcessHarness, sessionId: string) {
	return requestBodies(fixture, "PATCH", `/session/${sessionId}`).filter(
		(body) => "permission" in body,
	);
}

describe("OpenCode project extra folders through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string, recording = "multi-folder-project") {
		scenario = name;
		evidence = {
			ticket: "conduit-test-usg5.7",
			at: new Date().toISOString(),
			recording,
		};
		harness = ProcessHarness.create({
			rootPrefix: join(realpathSync(tmpdir()), "conduit-usg5-7-"),
			opencodeRecording: recording,
		});
		evidence["main"] = harness.projectDir;
		await harness.restart();
		return harness;
	}

	async function save(fixture: ProcessHarness, folders: readonly string[]) {
		const input = { slug: "process-test", folders };
		const result = await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new SaveProject(input),
		);
		evidence["save"] = { input, result };
		expect(result.savedSlug).toBe("process-test");
		expect(result.warnings).toEqual([]);
		expect(
			result.projects.find(({ slug }) => slug === result.savedSlug)?.folders,
		).toEqual(folders);
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["failures"] =
				task.result?.errors?.map(({ message, stack }) => ({
					message,
					stack,
				})) ?? [];
			evidence["requestBodies"] = fixture.opencodeRequestBodies();
			const rules = fixture
				.opencodeRequestBodies()
				.filter(({ method }) => method === "PATCH")
				.flatMap(({ body }) => {
					const parsed = JSON.parse(body) as { permission?: unknown[] };
					return parsed.permission ?? [];
				});
			expect(rules).not.toContainEqual(
				expect.objectContaining({ pattern: "*" }),
			);
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/usg5-7-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("reads the extra-folder marker and sends its current permission and note", async () => {
		const fixture = await start("extra-folder");
		const extra = join(fixture.root, "extra-folder");
		const missing = join(fixture.root, "deleted-extra-folder");
		mkdirSync(extra);
		mkdirSync(missing);
		writeFileSync(join(extra, "marker.txt"), MARKER);
		evidence["extra"] = extra;
		evidence["missing"] = missing;
		await save(fixture, [fixture.projectDir, extra, missing]);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Extra folder marker",
			undefined,
			"opencode",
		);
		evidence["sessionId"] = sessionId;
		rmSync(missing, { recursive: true });
		const reply = await browser.send(sessionId, PROMPT);
		evidence["reply"] = reply;
		expect(reply.done["code"]).toBe(0);
		expect(reply.chunks.join("")).toContain(MARKER);
		expect(
			browser.frames.filter(
				({ message }) => message["type"] === "permission_request",
			),
		).toEqual([]);
		await vi.waitFor(async () => {
			const history = await browser.history(sessionId);
			evidence["history"] = history;
			expect(
				history
					.filter(({ role }) => role === "assistant")
					.flatMap(({ parts }) => parts ?? [])
					.map(({ text }) => text ?? "")
					.join(""),
			).toContain(MARKER);
		});
		expect(permissionUpdates(fixture, sessionId)).toEqual([
			{
				permission: [
					{
						permission: "external_directory",
						pattern: `${extra}/*`,
						action: "allow",
					},
				],
			},
		]);
		const prompt = requestBodies(
			fixture,
			"POST",
			`/session/${sessionId}/prompt_async`,
		).at(-1);
		expect(prompt?.["system"]).toContain(extra);
		expect(prompt?.["system"]).not.toContain(missing);
		const warning = await browser.waitFor(
			(message) =>
				message["type"] === "error" &&
				message["code"] === "RETRY" &&
				String(message["message"]).includes(missing),
		);
		evidence["warning"] = warning;
	}, 60_000);

	it("never patches permissions for a single-folder session", async () => {
		const fixture = await start("single-folder", "chat-multi-turn");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Single folder",
			undefined,
			"opencode",
		);
		evidence["sessionId"] = sessionId;
		const first = await browser.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		const second = await browser.send(
			sessionId,
			"What word did I ask you to remember? Reply with just the word.",
		);
		evidence["replies"] = [first, second];
		expect(first.done["code"]).toBe(0);
		expect(second.done["code"]).toBe(0);
		expect(second.chunks.join("")).toContain("banana");
		expect(permissionUpdates(fixture, sessionId)).toEqual([]);
		for (const prompt of requestBodies(
			fixture,
			"POST",
			`/session/${sessionId}/prompt_async`,
		)) {
			expect(prompt).not.toHaveProperty("system");
		}
	}, 60_000);

	it("does not append rules on repeated turns with unchanged extras", async () => {
		const fixture = await start("unchanged-folder", "chat-multi-turn");
		const extra = join(fixture.root, "unchanged-extra-folder");
		mkdirSync(extra);
		evidence["extra"] = extra;
		await save(fixture, [fixture.projectDir, extra]);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Unchanged folder",
			undefined,
			"opencode",
		);
		evidence["sessionId"] = sessionId;
		const first = await browser.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		const second = await browser.send(
			sessionId,
			"What word did I ask you to remember? Reply with just the word.",
		);
		evidence["replies"] = [first, second];
		expect(first.done["code"]).toBe(0);
		expect(second.done["code"]).toBe(0);
		expect(second.chunks.join("")).toContain("banana");
		expect(permissionUpdates(fixture, sessionId)).toEqual([
			{
				permission: [
					{
						permission: "external_directory",
						pattern: `${extra}/*`,
						action: "allow",
					},
				],
			},
		]);
		for (const prompt of requestBodies(
			fixture,
			"POST",
			`/session/${sessionId}/prompt_async`,
		)) {
			expect(prompt["system"]).toContain(extra);
		}
	}, 60_000);

	it.each([
		false,
		true,
	])("asks only for the removed folder with restart=%s", async (restart) => {
		const fixture = await start(
			restart ? "removed-folder-restart" : "removed-folder",
			"chat-multi-turn",
		);
		const extra = join(fixture.root, "removed-extra-folder");
		mkdirSync(extra);
		evidence["extra"] = extra;
		await save(fixture, [fixture.projectDir, extra]);
		const before = await fixture.connect();
		const sessionId = await before.createSession(
			"Folder removal",
			undefined,
			"opencode",
		);
		evidence["sessionId"] = sessionId;
		const first = await before.send(
			sessionId,
			"Remember the word 'banana'. Reply with only: ok, remembered.",
		);
		expect(first.done["code"]).toBe(0);
		expect(permissionUpdates(fixture, sessionId)).toEqual([
			{
				permission: [
					{
						permission: "external_directory",
						pattern: `${extra}/*`,
						action: "allow",
					},
				],
			},
		]);
		await save(fixture, [fixture.projectDir]);
		if (restart) {
			await fixture.kill();
			await fixture.restart();
		}
		const after = await fixture.connect(sessionId);
		const second = await after.send(
			sessionId,
			"What word did I ask you to remember? Reply with just the word.",
		);
		evidence["replies"] = [first, second];
		expect(second.done["code"]).toBe(0);
		expect(second.chunks.join("")).toContain("banana");
		const updates = permissionUpdates(fixture, sessionId);
		expect(updates).toHaveLength(2);
		expect(updates.at(-1)).toEqual({
			permission: [
				{
					permission: "external_directory",
					pattern: `${extra}/*`,
					action: "ask",
				},
			],
		});
		expect(
			requestBodies(fixture, "POST", `/session/${sessionId}/prompt_async`).at(
				-1,
			),
		).not.toHaveProperty("system");
	}, 60_000);

	it("rejects a missing main folder before any OpenCode prompt", async () => {
		const fixture = await start("missing-main", "chat-simple");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Missing main folder",
			undefined,
			"opencode",
		);
		evidence["sessionId"] = sessionId;
		rmSync(fixture.projectDir, { recursive: true });
		const reply = await browser.send(sessionId, "Reply with pong.");
		evidence["reply"] = reply;
		expect(reply.done["code"]).toBe(1);
		expect(reply.chunks).toEqual([]);
		expect(
			requestBodies(fixture, "POST", `/session/${sessionId}/prompt_async`),
		).toEqual([]);
		const error = await browser.waitFor(
			(message) =>
				message["type"] === "error" &&
				message["sessionId"] === sessionId &&
				String(message["message"]).includes(fixture.projectDir),
		);
		evidence["error"] = error;
	}, 60_000);
});
