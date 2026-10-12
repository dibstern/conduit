import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure cases: external deletion never reaches the sidebar; an upstream
// failure lets late status/content or a restart recreate a locally deleted row.
describe("OpenCode session deletion", () => {
	const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
	let harness: ProcessHarness | undefined;
	let browser: ProcessBrowser | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		scenario = name;
		evidence = {
			tickets: ["conduit-test-21ge", "conduit-test-axen"],
			at: new Date().toISOString(),
		};
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		await fixture.restart({ opencodeIdleTimeoutMs: 120_000 });
		const viewer = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		browser = viewer;
		await viewer.startInstance(instanceId);
		await vi.waitFor(() =>
			expect(fixture.opencodeStreamConnections()).toContainEqual(
				expect.objectContaining({ action: "open", path: "/global/event" }),
			),
		);
		return { fixture, viewer };
	}

	async function opencode(
		fixture: ProcessHarness,
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	) {
		const instance = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === instanceId);
		if (!instance?.port) throw new Error("Fake OpenCode has no port");
		const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
			method,
			headers: {
				Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
				"Content-Type": "application/json",
				"x-opencode-directory": fixture.projectDir,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(2000),
		});
		expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
		return response;
	}

	const isRow = (id: string) => (message: Record<string, unknown>) =>
		message["type"] === "session_row" && message["id"] === id;
	const isRemoval = (id: string) => (message: Record<string, unknown>) =>
		message["type"] === "shell" &&
		message["_tag"] === "remove" &&
		message["id"] === id;

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["shell"] = browser?.frames
				.map(({ message }) => message)
				.filter((message) => message["type"] === "shell");
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			evidence["requests"] = fixture.opencodeRequests();
			evidence["daemonLog"] = fixture.logTail;
			await fixture.terminate();
			evidence["streams"] = fixture.opencodeStreamConnections();
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/rqbc-21ge-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
				browser = undefined;
			}
		}
	});

	it("removes an externally deleted session from the shell and a fresh browser", async () => {
		const { fixture, viewer } = await start("external-delete");
		const response = await opencode(fixture, "POST", "/session", {
			title: "Deleted outside Conduit",
		});
		const { id } = (await response.json()) as { id: string };
		evidence["sessionId"] = id;
		evidence["before"] = await viewer.waitFor(isRow(id));
		const cursor = viewer.frames.length;
		expect(
			await (await opencode(fixture, "DELETE", `/session/${id}`)).json(),
		).toBe(true);
		const removal = await viewer.waitFor(isRemoval(id), cursor);
		evidence["removal"] = removal;
		expect(removal).toMatchObject({ _tag: "remove", id, deleted: true });

		const fresh = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		evidence["freshShell"] = fresh.frames.map(({ message }) => message);
		expect(fresh.frames.some(({ message }) => isRow(id)(message))).toBe(false);
		expect(await (await opencode(fixture, "GET", "/session")).json()).toEqual(
			[],
		);
	});

	it("keeps a local deletion after upstream failure, late events and daemon restart", async () => {
		const { fixture, viewer } = await start("failed-delete-late-restart");
		const id = await viewer.createSession(
			"Delete fails upstream",
			instanceId,
			"opencode",
		);
		const controlId = await viewer.createSession(
			"Still live",
			instanceId,
			"opencode",
		);
		await viewer.waitFor(isRow(id));
		await opencode(fixture, "POST", "/test/fail-delete", { sessionID: id });
		const cursor = viewer.frames.length;
		await viewer.deleteSession(id);
		const removal = await viewer.waitFor(isRemoval(id), cursor);
		evidence["removal"] = removal;
		expect(removal).toMatchObject({ deleted: true });
		expect(fixture.opencodeRequests()).toContainEqual(
			expect.objectContaining({
				method: "DELETE",
				url: expect.stringContaining(`/session/${id}`),
			}),
		);
		const upstream = (await (
			await opencode(fixture, "GET", "/session")
		).json()) as { id: string }[];
		evidence["upstreamIdsAfterDelete"] = upstream.map((session) => session.id);
		expect(upstream.map((session) => session.id)).toContain(id);
		const childResponse = await opencode(fixture, "POST", "/session", {
			title: "Late child of a deleted session",
			parentID: id,
		});
		const { id: childId } = (await childResponse.json()) as { id: string };
		evidence["lateChildId"] = childId;
		await fixture.setOpenCodeStatus(fixture.projectDir, childId, {
			type: "busy",
		});
		const delayedResponse = await opencode(fixture, "POST", "/session", {
			title: "Child whose parent announcement arrives late",
		});
		const delayedChild = (await delayedResponse.json()) as { id: string };
		evidence["delayedParentChildId"] = delayedChild.id;
		await viewer.waitFor(isRow(delayedChild.id), cursor);
		const childCursor = viewer.frames.length;
		await fixture.emitOpenCodeEvent({
			directory: fixture.projectDir,
			payload: {
				id: "evt_late_parent_announcement",
				type: "session.created",
				properties: { info: { ...delayedChild, parentID: id } },
			},
		});
		const childRemoval = await viewer.waitFor(
			isRemoval(delayedChild.id),
			childCursor,
		);
		evidence["delayedParentRemoval"] = childRemoval;
		expect(childRemoval).toMatchObject({ deleted: true });

		await fixture.setOpenCodeStatus(fixture.projectDir, id, { type: "idle" });
		await fixture.emitOpenCodeEvent({
			directory: fixture.projectDir,
			payload: {
				id: "evt_late_deleted_session_message",
				type: "message.updated",
				properties: {
					info: {
						id: "msg-late-deleted-session",
						sessionID: id,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
		});
		await fixture.setOpenCodeStatus(fixture.projectDir, controlId, {
			type: "busy",
		});
		await viewer.waitFor(
			(message) => isRow(controlId)(message) && message["status"] === "busy",
			cursor,
		);
		expect(
			viewer.frames.slice(cursor).some(({ message }) => isRow(id)(message)),
		).toBe(false);
		expect(
			viewer.frames
				.slice(cursor)
				.some(({ message }) => isRow(childId)(message)),
		).toBe(false);
		const fresh = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		evidence["afterLateEvents"] = fresh.frames.map(({ message }) => message);
		expect(fresh.frames.some(({ message }) => isRow(id)(message))).toBe(false);
		expect(fresh.frames.some(({ message }) => isRow(childId)(message))).toBe(
			false,
		);
		expect(
			fresh.frames.some(({ message }) => isRow(delayedChild.id)(message)),
		).toBe(false);

		await fixture.terminate();
		await fixture.restart();
		const replacement = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		browser = replacement;
		const restartCursor = replacement.frames.length;
		await fixture.setOpenCodeStatus(fixture.projectDir, id, { type: "busy" });
		await fixture.setOpenCodeStatus(fixture.projectDir, id, { type: "idle" });
		await fixture.setOpenCodeStatus(fixture.projectDir, childId, {
			type: "busy",
		});
		await fixture.setOpenCodeStatus(fixture.projectDir, delayedChild.id, {
			type: "busy",
		});
		await fixture.setOpenCodeStatus(fixture.projectDir, controlId, {
			type: "idle",
		});
		await replacement.waitFor(
			(message) => isRow(controlId)(message) && message["status"] === "idle",
			restartCursor,
		);
		evidence["afterRestart"] = replacement.frames.map(({ message }) => message);
		expect(replacement.frames.some(({ message }) => isRow(id)(message))).toBe(
			false,
		);
		expect(
			replacement.frames.some(({ message }) => isRow(childId)(message)),
		).toBe(false);
		expect(
			replacement.frames.some(({ message }) => isRow(delayedChild.id)(message)),
		).toBe(false);
		const reloaded = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		evidence["reloadedAfterRestart"] = reloaded.frames.map(
			({ message }) => message,
		);
		expect(reloaded.frames.some(({ message }) => isRow(id)(message))).toBe(
			false,
		);
		expect(reloaded.frames.some(({ message }) => isRow(childId)(message))).toBe(
			false,
		);
		expect(
			reloaded.frames.some(({ message }) => isRow(delayedChild.id)(message)),
		).toBe(false);
	});
});
