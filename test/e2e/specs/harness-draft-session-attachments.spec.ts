// conduit-test-mryl.4: real RPC, browser and daemon checkpoints for session
// Draft attachment ownership. All runs retain their catalogue and DB evidence.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import type { Page, WebSocketRoute } from "@playwright/test";
import { Effect, Layer, Option, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import type { InputDraftKey } from "../../../src/lib/contracts/ws-rpc.js";
import { assertAttachmentCatalogue } from "../../helpers/attachment-catalogue.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import {
	expect,
	test as harnessTest,
} from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
	"base64",
);
const hash = createHash("sha256")
	.update("image/png\0")
	.update(imageBytes)
	.digest("hex");
const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const imageFile = {
	name: "draft-pixel.png",
	mimeType: "image/png",
	buffer: imageBytes,
};
const chips = (page: Page) =>
	page.locator(
		"#image-preview .paste-thumb, #image-preview [data-testid='file-attachment-chip']",
	);
const route = (sessionId: string) => `/s/${sessionId}?p=process-test`;

function withStore<A>(
	harness: ProcessHarness,
	read: (db: DatabaseSync) => A,
): A {
	// The live daemon writes too; wait out its locks instead of failing at once.
	const db = new DatabaseSync(harness.daemonStorePath(), { timeout: 5_000 });
	try {
		return read(db);
	} finally {
		db.close();
	}
}

function draftState(harness: ProcessHarness, key: string) {
	return withStore(harness, (db) => ({
		draft: db
			.prepare(
				"SELECT draft_key, text, promoted_session_id FROM input_drafts WHERE draft_key = ?",
			)
			.get(key),
		attachments: db
			.prepare(
				"SELECT id, draft_key, name, hash, state FROM draft_attachments WHERE draft_key = ? ORDER BY position, id",
			)
			.all(key),
	}));
}

function inputState(harness: ProcessHarness, inputId: string) {
	return withStore(harness, (db) => ({
		events: db
			.prepare(
				"SELECT type, data FROM events WHERE json_extract(data, '$.inputId') = ? ORDER BY sequence",
			)
			.all(inputId),
		pending: db
			.prepare(
				"SELECT state, request, images FROM pending_inputs WHERE input_id = ?",
			)
			.get(inputId),
	}));
}

function proofMarks(harness: ProcessHarness): Record<string, unknown>[] {
	const path = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): Record<string, unknown> => JSON.parse(line));
}

function providerImages(harness: ProcessHarness, inputId: string) {
	return proofMarks(harness)
		.filter(
			(mark) => mark["kind"] === "input-content" && mark["inputId"] === inputId,
		)
		.map((mark) =>
			Array.isArray(mark["content"]) ? (mark["content"] as unknown[]) : [],
		)
		.map((content) =>
			content.filter(
				(
					block,
				): block is {
					type: "image";
					source: { media_type: string; data: string };
				} =>
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "image",
			),
		);
}

async function expectDelivered(harness: ProcessHarness, inputId: string) {
	await expect
		.poll(() => providerImages(harness, inputId), { timeout: 30_000 })
		.toHaveLength(1);
	const deliveries = providerImages(harness, inputId);
	expect(deliveries[0]).toHaveLength(1);
	expect(deliveries[0]?.[0]?.source.media_type).toBe("image/png");
	expect(Buffer.from(deliveries[0]?.[0]?.source.data ?? "", "base64")).toEqual(
		imageBytes,
	);
	await expect
		.poll(() =>
			inputState(harness, inputId).events.filter(
				(event) => event["type"] === "input.sent",
			),
		)
		.toHaveLength(1);
	return deliveries;
}

async function snapshot(browser: ProcessBrowser, key: InputDraftKey) {
	return Option.getOrThrow(
		await Effect.runPromise(
			browser.rpc
				.SubscribeInputDraft({ key })
				.pipe(Stream.runHead, Effect.timeout("10 seconds")),
		),
	);
}

async function add(
	browser: ProcessBrowser,
	sessionId: string,
	id = randomUUID(),
) {
	const result = await Effect.runPromise(
		browser.rpc.AddDraftAttachment({
			key: { session: sessionId },
			id,
			name: imageFile.name,
			mime: "image/png",
			dataUrl,
		}),
	);
	expect(result).toMatchObject({
		attachment: { id, hash, mime: "image/png", size: imageBytes.length },
	});
	return id;
}

async function setText(
	browser: ProcessBrowser,
	sessionId: string,
	text: string,
) {
	await Effect.runPromise(
		browser.rpc.SyncInputDraft({
			key: { session: sessionId },
			text,
			originId: browser.originId,
		}),
	);
}

async function pick(page: Page) {
	await page.locator("input[type=file]").last().setInputFiles(imageFile);
}

function readCatalogue(harness: ProcessHarness) {
	return Effect.runPromise(
		assertAttachmentCatalogue.pipe(
			Effect.provide(
				SqliteNode.layer({
					filename: harness.daemonStorePath(),
					readonly: true,
				}).pipe(Layer.provide(Reactivity.layer)),
			),
			Effect.scoped,
		),
	);
}

const test = harnessTest.extend<{ report: Record<string, unknown> }>({
	report: [
		async ({ harness }, use, testInfo) => {
			const report: Record<string, unknown> = {
				bead: "conduit-test-mryl.4",
				test: testInfo.title,
				project: testInfo.project.name,
				passed: false,
			};
			const directory = "test-results/draft-attachments";
			mkdirSync(directory, { recursive: true });
			const path = join(
				directory,
				`mryl-4-${testInfo.project.name}-${testInfo.testId}-retry-${testInfo.retry}.json`,
			);
			writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
			try {
				await use(report);
			} finally {
				const catalogue = existsSync(harness.daemonStorePath())
					? await readCatalogue(harness)
					: null;
				const invariants = existsSync(harness.daemonStorePath())
					? withStore(harness, (db) => ({
							missingBlobs: db
								.prepare(
									"SELECT hash FROM attachment_uses WHERE hash NOT IN (SELECT hash FROM attachment_blobs) UNION SELECT hash FROM draft_attachments WHERE state = 'live' AND hash NOT IN (SELECT hash FROM attachment_blobs)",
								)
								.all(),
							inlineRows: db
								.prepare(`SELECT 'events' AS owner, event_id AS id FROM events WHERE type IN ('input.admitted', 'file.attached') AND instr(data, 'data:') > 0
					UNION ALL SELECT 'pending_inputs', input_id FROM pending_inputs WHERE instr(request || COALESCE(images, ''), 'data:') > 0
					UNION ALL SELECT 'message_parts', id FROM message_parts WHERE type IN ('file', 'attached-file') AND instr(COALESCE(metadata, '') || COALESCE(rest_payload, ''), 'data:') > 0`)
								.all(),
						}))
					: null;
				report["catalogueViolations"] = catalogue;
				report["invariants"] = invariants;
				report["logTail"] = harness.logTail.slice(-3000);
				report["passed"] =
					testInfo.status === "passed" &&
					catalogue?.length === 0 &&
					invariants?.missingBlobs.length === 0 &&
					invariants?.inlineRows.length === 0;
				writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
				await testInfo.attach("draft-attachment-result", {
					path,
					contentType: "application/json",
				});
				expect(catalogue).toEqual([]);
				expect(invariants).toEqual({ missingBlobs: [], inlineRows: [] });
			}
		},
		{ auto: true },
	],
});

test.use({ harnessOptions: { restartProof: true } });
test.describe.configure({ retries: 0, timeout: 120_000 });

test("session images and files survive reload, sync to another browser and remove everywhere", async ({
	harness,
	page,
	browser,
	report,
}, testInfo) => {
	const control = await harness.connect();
	const sessionId = await control.createSession("Persistent Draft attachment");
	report["sessionId"] = sessionId;
	const other = await browser.newContext({
		viewport: page.viewportSize() ?? { width: 1440, height: 900 },
	});
	try {
		const tabB = await other.newPage();
		await new AppPage(page).goto(`${harness.baseUrl}${route(sessionId)}`);
		await new AppPage(tabB).goto(`${harness.baseUrl}${route(sessionId)}`);
		await page
			.locator("input[type=file]")
			.last()
			.setInputFiles([
				imageFile,
				{
					name: "draft-notes.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("saved Draft file bytes"),
				},
			]);
		await expect(chips(page)).toHaveCount(2);
		await expect(chips(tabB)).toHaveCount(2);
		await expect(page.locator("#image-preview img")).toHaveAttribute(
			"src",
			`/p/process-test/attachments/${hash}`,
		);
		const saved = await snapshot(control, { session: sessionId });
		expect(saved).toMatchObject({
			attachments: [
				{
					name: imageFile.name,
					hash,
					mime: "image/png",
					size: imageBytes.length,
				},
				{ name: "draft-notes.txt", mime: "text/plain" },
			],
		});
		expect(JSON.stringify(saved)).not.toContain("data:");
		report["savedSnapshot"] = saved;
		await page.reload();
		await expect(chips(page)).toHaveCount(2);
		await page
			.getByRole("button", {
				name: `Remove image ${imageFile.name}`,
				exact: true,
			})
			.click();
		await expect(chips(tabB)).toHaveCount(1);
		await tabB
			.getByRole("button", { name: "Remove file draft-notes.txt", exact: true })
			.click();
		await expect(chips(page)).toHaveCount(0);
		await expect(chips(tabB)).toHaveCount(0);
		report["removed"] = draftState(harness, sessionId);
		await page.screenshot({
			path: testInfo.outputPath("removed-on-both-devices.png"),
		});
	} finally {
		await other.close();
	}
});

test("a file read finishing after a route switch stays in its originating session Draft", async ({
	harness,
	page,
	report,
}) => {
	const control = await harness.connect();
	const first = await control.createSession("Attachment read origin");
	const second = await control.createSession("Attachment read destination");
	await page.addInitScript(() => {
		const state = window as Window & {
			draftAttachmentReads?: Array<() => void>;
		};
		state.draftAttachmentReads = [];
		const NativeReader = window.FileReader;
		window.FileReader = class extends NativeReader {
			override readAsDataURL(blob: Blob) {
				state.draftAttachmentReads?.push(() => super.readAsDataURL(blob));
			}
		};
	});
	await new AppPage(page).goto(`${harness.baseUrl}${route(first)}`);
	await pick(page);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & { draftAttachmentReads?: unknown[] })
						.draftAttachmentReads?.length,
			),
		)
		.toBe(1);
	// Keep the document and the outstanding FileReader alive while Svelte changes routes.
	await page.evaluate((path) => {
		history.pushState({}, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, route(second));
	await expect(page).toHaveURL(new RegExp(`/s/${second}\\?`));
	await expect(new AppPage(page).input).toBeVisible();
	await page.evaluate(() => {
		for (const release of (
			window as Window & { draftAttachmentReads?: Array<() => void> }
		).draftAttachmentReads ?? [])
			release();
	});
	await expect
		.poll(
			() =>
				draftState(harness, first).attachments.filter(
					(item) => item["state"] === "live",
				).length,
		)
		.toBe(1);
	expect(draftState(harness, second).attachments).toEqual([]);
	await expect(chips(page)).toHaveCount(0);
	await page.evaluate((path) => {
		history.pushState({}, "", path);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, route(first));
	await expect(chips(page)).toHaveCount(1);
	report["origin"] = draftState(harness, first);
	report["destination"] = draftState(harness, second);
});

test("composer sends saved ids with identical provider bytes, clears its Draft and quietly accepts retry", async ({
	harness,
	page,
	report,
}, testInfo) => {
	const control = await harness.connect();
	const sessionId = await control.createSession("Send Draft by reference");
	const requests: Record<string, unknown>[] = [];
	page.on("websocket", (socket) =>
		socket.on("framesent", ({ payload }) => {
			const frame = JSON.parse(payload.toString()) as {
				tag?: string;
				payload?: Record<string, unknown>;
			};
			if (frame.tag === "input.submit" && frame.payload)
				requests.push(frame.payload);
		}),
	);
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${route(sessionId)}`);
	await pick(page);
	await expect(page.locator("#image-preview img")).toHaveAttribute(
		"src",
		`/p/process-test/attachments/${hash}`,
	);
	const selected = draftState(harness, sessionId).attachments.map((item) =>
		String(item["id"]),
	);
	const text = "draft-reference-identical-bytes";
	const rawDraftText = `  \n${text} \n  `;
	await app.input.fill(rawDraftText);
	await expect
		.poll(() => draftState(harness, sessionId).draft?.["text"])
		.toBe(rawDraftText);
	await app.sendBtn.click();
	await expect.poll(() => requests.length).toBe(1);
	const request = requests[0];
	const inputId = String(request?.["inputId"]);
	expect(request).toMatchObject({
		text,
		draftText: rawDraftText,
		attachmentIds: selected,
	});
	expect(request?.["images"] ?? []).toEqual([]);
	expect(JSON.stringify(request)).not.toContain("data:");
	await expect(chips(page)).toHaveCount(0);
	await expect(app.input).toHaveValue("");
	await expect
		.poll(() =>
			draftState(harness, sessionId).attachments.every(
				(item) => item["state"] === "sent" && item["hash"] === null,
			),
		)
		.toBe(true);
	expect(draftState(harness, sessionId).draft?.["text"] ?? "").toBe("");
	report["providerDeliveries"] = await expectDelivered(harness, inputId);
	report["sentRequest"] = request;
	report["rawDraftText"] = rawDraftText;
	await setText(control, sessionId, "fresh Draft after accepted send");
	await add(control, sessionId);
	const fresh = draftState(harness, sessionId);
	const retry = await Effect.runPromise(
		control.rpc["input.submit"]({
			sessionId,
			inputId,
			text,
			delivery: "queue",
			draftKey: { session: sessionId },
			attachmentIds: selected,
		}),
	);
	expect(retry).toMatchObject({ ok: true });
	expect(draftState(harness, sessionId)).toEqual(fresh);
	expect(
		inputState(harness, inputId).events.filter(
			(event) => event["type"] === "input.admitted",
		),
	).toHaveLength(1);
	expect(providerImages(harness, inputId)).toHaveLength(1);
	report["retry"] = retry;
	report["freshDraftPreserved"] = fresh;
	await page.screenshot({
		path: testInfo.outputPath("sent-image-and-fresh-draft.png"),
	});
});

test("concurrent sends of one input id admit and deliver its attachment once", async ({
	harness,
	report,
}) => {
	const tabA = await harness.connect();
	const tabB = await harness.connect();
	const sessionId = await tabA.createSession("Concurrent Draft send");
	const attachmentId = await add(tabA, sessionId);
	const input = {
		sessionId,
		inputId: randomUUID(),
		text: "concurrent-draft-reference",
		delivery: "queue" as const,
		draftKey: { session: sessionId },
		attachmentIds: [attachmentId],
	};
	report["results"] = await Promise.all([
		Effect.runPromise(tabA.rpc["input.submit"](input)),
		Effect.runPromise(tabB.rpc["input.submit"](input)),
	]);
	expect(report["results"]).toMatchObject([{ ok: true }, { ok: true }]);
	report["providerDeliveries"] = await expectDelivered(harness, input.inputId);
	report["input"] = inputState(harness, input.inputId);
	expect(
		inputState(harness, input.inputId).events.filter(
			(event) => event["type"] === "input.admitted",
		),
	).toHaveLength(1);
	await expect
		.poll(async () =>
			(await tabA.history(sessionId)).filter(
				(message) => message.role === "user" && message.text === input.text,
			),
		)
		.toHaveLength(1);
});

test("a stale attachment id is refused without admission or changing the remaining Draft", async ({
	harness,
	report,
}) => {
	const tabA = await harness.connect();
	const tabB = await harness.connect();
	const sessionId = await tabA.createSession("Stale Draft attachment");
	const staleId = await add(tabA, sessionId);
	await add(tabA, sessionId);
	await setText(tabA, sessionId, "keep this Draft after refusal");
	const stale = await snapshot(tabB, { session: sessionId });
	await Effect.runPromise(
		tabA.rpc.RemoveDraftAttachment({
			key: { session: sessionId },
			id: staleId,
		}),
	);
	const before = draftState(harness, sessionId);
	const inputId = randomUUID();
	const result = await Effect.runPromise(
		tabB.rpc["input.submit"]({
			sessionId,
			inputId,
			text: "keep this Draft after refusal",
			delivery: "queue",
			draftKey: { session: sessionId },
			attachmentIds: [staleId],
		}).pipe(Effect.result),
	);
	expect(result).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "DraftAttachmentMissing" },
	});
	expect(inputState(harness, inputId).events).toEqual([]);
	expect(inputState(harness, inputId).pending).toBeUndefined();
	expect(draftState(harness, sessionId)).toEqual(before);
	report["staleSnapshot"] = stale;
	report["sendResult"] = result;
	report["unchangedDraft"] = before;
});

test("startup sweeps a removed Draft blob while keeping a sent image", async ({
	harness,
	report,
}) => {
	const control = await harness.connect();
	const sessionId = await control.createSession(
		"Draft attachment startup sweep",
	);
	const sentId = await add(control, sessionId);
	const inputId = randomUUID();
	await Effect.runPromise(
		control.rpc["input.submit"]({
			sessionId,
			inputId,
			text: "keep sent blob",
			delivery: "queue",
			draftKey: { session: sessionId },
			attachmentIds: [sentId],
		}),
	);
	await expectDelivered(harness, inputId);
	const removedId = randomUUID();
	const textBytes = Buffer.from("unshared removed Draft bytes");
	const removed = await Effect.runPromise(
		control.rpc.AddDraftAttachment({
			key: { session: sessionId },
			id: removedId,
			name: "removed.txt",
			mime: "text/plain",
			dataUrl: `data:text/plain;base64,${textBytes.toString("base64")}`,
		}),
	);
	if (!("attachment" in removed))
		throw new Error("Fresh attachment returned a tombstone");
	const removedHash = removed.attachment.hash;
	await Effect.runPromise(
		control.rpc.RemoveDraftAttachment({
			key: { session: sessionId },
			id: removedId,
		}),
	);
	expect(
		withStore(harness, (db) =>
			db
				.prepare("SELECT hash FROM attachment_blobs WHERE hash = ?")
				.get(removedHash),
		),
	).toBeDefined();
	await harness.kill();
	// B3 forbids time-based tombstone pruning, even for an otherwise empty
	// Draft. Moving the fixture clock back catches the withdrawn seven-day rule.
	// Write only while the daemon is down, so its own writes cannot lock us out.
	withStore(harness, (db) =>
		db
			.prepare(
				"UPDATE draft_attachments SET created_at = ? WHERE draft_key = ? AND state IN ('removed', 'sent')",
			)
			.run(Date.now() - 30 * 24 * 60 * 60 * 1000, sessionId),
	);
	await harness.restart();
	const retained = withStore(harness, (db) =>
		db.prepare("SELECT hash FROM attachment_blobs ORDER BY hash").all(),
	);
	expect(retained).toEqual([{ hash }]);
	const tombstones = draftState(harness, sessionId).attachments;
	expect(tombstones).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: sentId, state: "sent", hash: null }),
			expect.objectContaining({ id: removedId, state: "removed", hash: null }),
		]),
	);
	report["removedHash"] = removedHash;
	report["retainedBlobs"] = retained;
	report["retainedTombstones"] = tombstones;
});

test("Side Thread start consumes the source Draft attachment by reference", async ({
	harness,
	page,
	report,
}) => {
	// A Side Thread forks the source transcript, so the fake provider must
	// record one and the source needs a completed turn.
	writeFileSync(
		join(harness.root, "claude", "conduit-test-record-forks"),
		"record",
	);
	const control = await harness.connect();
	const sourceId = await control.createSession("Side Thread attachment source");
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${route(sourceId)}`);
	await app.sendMessage("side-thread-source-first");
	const chat = new ChatPage(page);
	await expect(chat.assistantMessages.last()).toContainText(
		"done(side-thread-source-first)",
		{ timeout: 30_000 },
	);
	await chat.waitForStreamingComplete();
	const attachmentId = await add(control, sourceId);
	const text = "side-thread-draft-attachment";
	const rawDraftText = `  ${text}  `;
	await setText(control, sourceId, rawDraftText);
	const inputId = randomUUID();
	const side = await Effect.runPromise(
		control.rpc.StartSideThread({
			sessionId: sourceId,
			title: "Attachment Side Thread",
			inputId,
			text,
			draftText: rawDraftText,
			draftKey: { session: sourceId },
			attachmentIds: [attachmentId],
			originId: control.originId,
		}),
	);
	expect(side.sessionId).not.toBe(sourceId);
	report["sideThread"] = side;
	report["providerDeliveries"] = await expectDelivered(harness, inputId);
	expect(draftState(harness, sourceId).attachments).toContainEqual(
		expect.objectContaining({ id: attachmentId, state: "sent", hash: null }),
	);
	expect(draftState(harness, sourceId).draft?.["text"] ?? "").toBe("");
	expect(JSON.stringify(inputState(harness, inputId))).not.toContain("data:");
});

test("an admitted queued input drains once after a crash before sent and its Draft stays cleared", async ({
	harness,
	page,
	report,
}) => {
	const control = await harness.connect();
	const sessionId = await control.createSession(
		"Draft admission crash checkpoint",
	);
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${route(sessionId)}`);
	await app.sendMessage("task-stop-foreground-draft-admission-crash");
	await expect(new ChatPage(page).stopBtn).toBeVisible();
	// Crash only once the runner holds the turn. A crash before the runner
	// starts it fails the turn, which rightly pauses the queue instead.
	await expect
		.poll(() =>
			proofMarks(harness).some(
				(mark) =>
					mark["kind"] === "task-stop-turn" && mark["phase"] === "streaming",
			),
		)
		.toBe(true);
	const attachmentId = await add(control, sessionId);
	const text = "draft-admitted-before-crash";
	await setText(control, sessionId, text);
	const inputId = randomUUID();
	await Effect.runPromise(
		control.rpc["input.submit"]({
			sessionId,
			inputId,
			text,
			delivery: "queue",
			draftKey: { session: sessionId },
			attachmentIds: [attachmentId],
		}),
	);
	const admitted = inputState(harness, inputId);
	expect(
		admitted.events.filter((event) => event["type"] === "input.admitted"),
	).toHaveLength(1);
	expect(
		admitted.events.filter((event) => event["type"] === "input.sent"),
	).toHaveLength(0);
	expect(providerImages(harness, inputId)).toEqual([]);
	expect(draftState(harness, sessionId).draft?.["text"] ?? "").toBe("");
	expect(draftState(harness, sessionId).attachments).toContainEqual(
		expect.objectContaining({ id: attachmentId, state: "sent" }),
	);
	report["crashCheckpoint"] = admitted;
	await harness.kill();
	writeFileSync(join(harness.root, "task-stop-release-result"), "release");
	await harness.restart({ keepPort: true });
	report["providerDeliveries"] = await expectDelivered(harness, inputId);
	const after = draftState(harness, sessionId);
	expect(after.draft?.["text"] ?? "").toBe("");
	expect(after.attachments.filter((item) => item["state"] === "live")).toEqual(
		[],
	);
	report["afterRestart"] = {
		draft: after,
		input: inputState(harness, inputId),
	};
});

test("Remove arriving ahead of a delayed Add leaves a tombstone and no visible item", async ({
	harness,
	page,
	report,
}) => {
	const control = await harness.connect();
	const sessionId = await control.createSession("Delayed attachment Add");
	let held: { id: string; send: () => void } | undefined;
	let addResponse: unknown;
	await page.routeWebSocket(/\/rpc$/, (client) => {
		const server = client.connectToServer();
		let requestId: string | number | undefined;
		client.onMessage((message) => {
			const frame = JSON.parse(message.toString()) as {
				id?: string | number;
				tag?: string;
				payload?: { id: string };
			};
			if (frame.tag === "AddDraftAttachment" && frame.payload) {
				requestId = frame.id;
				held = { id: frame.payload.id, send: () => server.send(message) };
			} else server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(message.toString()) as {
				requestId?: string | number;
				_tag?: string;
			};
			if (frame._tag === "Exit" && frame.requestId === requestId)
				addResponse = frame;
			client.send(message);
		});
	});
	await new AppPage(page).goto(`${harness.baseUrl}${route(sessionId)}`);
	await pick(page);
	await expect.poll(() => held?.id).toBeTruthy();
	await expect(chips(page)).toHaveCount(1);
	await expect(new AppPage(page).sendBtn).toBeDisabled();
	if (!held) throw new Error("Add frame was not held");
	await Effect.runPromise(
		control.rpc.RemoveDraftAttachment({
			key: { session: sessionId },
			id: held.id,
		}),
	);
	held.send();
	await expect.poll(() => addResponse).toBeDefined();
	expect(JSON.stringify(addResponse)).toContain('"ended":"removed"');
	await expect(chips(page)).toHaveCount(0);
	expect(draftState(harness, sessionId).attachments).toContainEqual(
		expect.objectContaining({ id: held.id, state: "removed", hash: null }),
	);
	report["addResponse"] = addResponse;
	report["draft"] = draftState(harness, sessionId);
});

for (const end of ["removed", "sent"] as const) {
	test(`a lost Add acknowledgment retried after another browser ${end} it never resurrects`, async ({
		harness,
		page,
		browser,
		report,
	}) => {
		const control = await harness.connect();
		const sessionId = await control.createSession(
			`Lost Add acknowledgment ${end}`,
		);
		const connections: WebSocketRoute[] = [];
		const addIds: string[] = [];
		let suppress = true;
		let offline = false;
		let synchronized = false;
		const ended: unknown[] = [];
		await page.routeWebSocket(/\/rpc$/, async (client) => {
			if (offline) {
				await client.close({
					code: 1012,
					reason: "Draft Add acknowledgment outage",
				});
				return;
			}
			const server = client.connectToServer();
			const requests = new Map<string, string>();
			connections.push(client);
			client.onMessage((message) => {
				const frame = JSON.parse(message.toString()) as {
					id?: string | number;
					tag?: string;
					payload?: { id?: string };
				};
				if (frame.tag && frame.id !== undefined)
					requests.set(String(frame.id), frame.tag);
				if (frame.tag === "AddDraftAttachment" && frame.payload?.id)
					addIds.push(frame.payload.id);
				server.send(message);
			});
			server.onMessage((message) => {
				const frame = JSON.parse(message.toString()) as {
					requestId?: string | number;
					_tag?: string;
				};
				const tag = requests.get(String(frame.requestId));
				if (tag === "SubscribeInputDraft" && frame._tag === "Chunk")
					synchronized = true;
				// Suppress both the acknowledgment and its own snapshot echo. Otherwise
				// the echo saves the local item before the deliberate connection loss.
				if (
					suppress &&
					(tag === "AddDraftAttachment" || tag === "SubscribeInputDraft")
				)
					return;
				if (tag === "AddDraftAttachment" && frame._tag === "Exit")
					ended.push(frame);
				client.send(message);
			});
		});
		// Deliver the initial Draft snapshot before withholding later echoes.
		suppress = false;
		await new AppPage(page).goto(`${harness.baseUrl}${route(sessionId)}`);
		await expect.poll(() => synchronized).toBe(true);
		const other = await browser.newContext({
			viewport: page.viewportSize() ?? { width: 1440, height: 900 },
		});
		try {
			const tabB = await other.newPage();
			await new AppPage(tabB).goto(`${harness.baseUrl}${route(sessionId)}`);
			suppress = true;
			await pick(page);
			await expect(chips(tabB)).toHaveCount(1);
			await expect.poll(() => addIds.length).toBe(1);
			await expect(new AppPage(page).sendBtn).toBeDisabled();
			if (end === "removed") {
				await tabB
					.getByRole("button", {
						name: `Remove image ${imageFile.name}`,
						exact: true,
					})
					.click();
			} else {
				await new AppPage(tabB).sendMessage(
					"send while other Add reply is lost",
				);
			}
			await expect(chips(tabB)).toHaveCount(0);
			await expect
				.poll(() => draftState(harness, sessionId).attachments[0]?.["state"])
				.toBe(end);
			offline = true;
			await Promise.all(
				connections
					.splice(0)
					.map((client) =>
						client.close({ code: 1012, reason: "Lost Add acknowledgment" }),
					),
			);
			await expect(page.locator("#connect-overlay")).toBeVisible();
			suppress = false;
			offline = false;
			await expect
				.poll(() => addIds.length, { timeout: 30_000 })
				.toBeGreaterThanOrEqual(2);
			expect(new Set(addIds).size).toBe(1);
			await expect(chips(page)).toHaveCount(0);
			await expect
				.poll(() => JSON.stringify(ended))
				.toContain(`"ended":"${end}"`);
			expect(draftState(harness, sessionId).attachments).toContainEqual(
				expect.objectContaining({ id: addIds[0], state: end, hash: null }),
			);
			report["addIds"] = addIds;
			report["retryResponses"] = ended;
			report["draft"] = draftState(harness, sessionId);
		} finally {
			offline = false;
			suppress = false;
			await other.close();
		}
	});
}

test("session deletion removes every Draft state and promoted alias durably before a crash", async ({
	harness,
	report,
}) => {
	const control = await harness.connect();
	const sessionId = await control.createSession("Deleted Draft attachment");
	const liveId = await add(control, sessionId);
	const removedId = await add(control, sessionId);
	await Effect.runPromise(
		control.rpc.RemoveDraftAttachment({
			key: { session: sessionId },
			id: removedId,
		}),
	);
	const alias = randomUUID();
	// Ticket .5 owns promotion. Seed its retired alias shape to prove the delete
	// trigger's promoted_session_id predicate now, without implementing .5 here.
	withStore(harness, (db) => {
		db.prepare(
			"INSERT INTO input_drafts(draft_key, project_id, kind, text, updated_at, promoted_session_id) VALUES (?, 'process-test', 'draft', '', ?, ?)",
		).run(alias, Date.now(), sessionId);
		db.prepare(
			"INSERT INTO draft_attachments(id, draft_key, position, name, hash, state, created_at) VALUES (?, ?, 0, 'alias.png', ?, 'live', ?)",
		).run(`${alias}:live`, alias, hash, Date.now());
		db.prepare(
			"INSERT INTO draft_attachments(id, draft_key, position, hash, state, created_at) VALUES (?, ?, 1, NULL, 'sent', ?)",
		).run(`${alias}:sent`, alias, Date.now());
	});
	report["beforeDelete"] = {
		session: draftState(harness, sessionId),
		alias: draftState(harness, alias),
		liveId,
	};
	await control.deleteSession(sessionId);
	const deleted = {
		session: draftState(harness, sessionId),
		alias: draftState(harness, alias),
	};
	expect(deleted).toEqual({
		session: { draft: undefined, attachments: [] },
		alias: { draft: undefined, attachments: [] },
	});
	// Cleanup is part of the DELETE transaction. Kill immediately, with no
	// graceful-shutdown cleanup or sweep, and inspect the committed result again.
	await harness.kill();
	report["afterKill"] = {
		session: draftState(harness, sessionId),
		alias: draftState(harness, alias),
	};
	expect(report["afterKill"]).toEqual(deleted);
	expect(
		withStore(harness, (db) =>
			db.prepare("SELECT hash FROM attachment_blobs WHERE hash = ?").get(hash),
		),
	).toEqual({ hash });
	await harness.restart();
	expect(
		withStore(harness, (db) =>
			db.prepare("SELECT hash FROM attachment_blobs WHERE hash = ?").get(hash),
		),
	).toBeUndefined();
	expect(draftState(harness, sessionId)).toEqual({
		draft: undefined,
		attachments: [],
	});
	expect(draftState(harness, alias)).toEqual({
		draft: undefined,
		attachments: [],
	});
	report["afterRestart"] = {
		session: draftState(harness, sessionId),
		alias: draftState(harness, alias),
		blobSwept: true,
	};
});

test("startup replay of an old admission never clears a fresh Draft with the same text", async ({
	harness,
	report,
}) => {
	const control = await harness.connect();
	const sessionId = await control.createSession("Replay preserves fresh Draft");
	const text = "identical text typed again after an old send";
	const oldId = await add(control, sessionId);
	const inputId = randomUUID();
	await setText(control, sessionId, text);
	await Effect.runPromise(
		control.rpc["input.submit"]({
			sessionId,
			inputId,
			text,
			delivery: "queue",
			draftKey: { session: sessionId },
			attachmentIds: [oldId],
		}),
	);
	await expectDelivered(harness, inputId);
	await setText(control, sessionId, text);
	const freshId = await add(control, sessionId);
	const fresh = draftState(harness, sessionId);
	await harness.kill();
	// A missing enrollment forces the input projector to replay the old
	// admission into the live store, rather than merely doing a no-op restart.
	withStore(harness, (db) =>
		db
			.prepare("DELETE FROM projector_cursors WHERE projector_name = 'input'")
			.run(),
	);
	await harness.restart();
	expect(draftState(harness, sessionId)).toEqual(fresh);
	expect(draftState(harness, sessionId).attachments).toContainEqual(
		expect.objectContaining({ id: freshId, state: "live", hash }),
	);
	expect(providerImages(harness, inputId)).toHaveLength(1);
	const events = inputState(harness, inputId).events;
	for (const event of events) {
		const payload = JSON.parse(String(event["data"])) as Record<
			string,
			unknown
		>;
		expect(payload).not.toHaveProperty("draft");
		expect(payload).not.toHaveProperty("restoreTo");
	}
	report["oldInput"] = inputState(harness, inputId);
	report["freshDraft"] = fresh;
	report["afterReplay"] = draftState(harness, sessionId);
	report["inputProjectorCursor"] = withStore(harness, (db) =>
		db
			.prepare(
				"SELECT projector_name, last_applied_seq FROM projector_cursors WHERE projector_name = 'input'",
			)
			.get(),
	);
	expect(report["inputProjectorCursor"]).toBeDefined();
});

test.describe("Draft row re-check at the live commit", () => {
	test.use({
		startHarness: false,
		harnessOptions: { restartProof: true, logLevel: "info" },
	});
	test("a remote Draft text edit received during a composer send remains visible after acceptance", async ({
		harness,
		page,
		report,
	}) => {
		await harness.restart({
			serviceEnvironment: { CONDUIT_TEST_DRAFT_SEND_BEFORE_COMMIT_MS: "10000" },
		});
		const control = await harness.connect();
		const tabB = await harness.connect();
		const sessionId = await control.createSession(
			"Remote text during pending Draft send",
		);
		const attachmentId = await add(control, sessionId);
		const textA = "original text accepted with the attachment";
		const textB = "newer text typed by the other browser while Send waits";
		await setText(control, sessionId, textA);
		let inputId: string | undefined;
		let submitted: unknown;
		let response: unknown;
		page.on("websocket", (socket) => {
			let requestId: string | number | undefined;
			socket.on("framesent", ({ payload }) => {
				const frame = JSON.parse(payload.toString()) as {
					id?: string | number;
					tag?: string;
					payload?: { text?: string; inputId: string };
				};
				if (frame.tag === "input.submit" && frame.payload?.text === textA) {
					requestId = frame.id;
					inputId = frame.payload.inputId;
					submitted = frame.payload;
				}
			});
			socket.on("framereceived", ({ payload }) => {
				const frame = JSON.parse(payload.toString()) as {
					_tag?: string;
					requestId?: string | number;
				};
				if (
					frame._tag === "Exit" &&
					requestId !== undefined &&
					String(frame.requestId) === String(requestId)
				)
					response = frame;
			});
		});
		const app = new AppPage(page);
		await app.goto(`${harness.baseUrl}${route(sessionId)}`);
		await expect(app.input).toHaveValue(textA);
		await expect(chips(page)).toHaveCount(1);
		await app.sendBtn.click();
		await expect.poll(() => inputId).toBeDefined();
		if (!inputId) throw new Error("Composer submit has no input id");
		const sentInputId = inputId;
		await expect
			.poll(() =>
				harness.logTail.includes(`draft-send-before-commit:${sentInputId}`),
			)
			.toBe(true);
		expect(draftState(harness, sessionId).draft?.["text"]).toBe(textA);
		report["beforeCommit"] = draftState(harness, sessionId);
		await setText(tabB, sessionId, textB);
		await expect(app.input).toHaveValue(textB);
		await expect(app.input).toBeEditable();
		// An in-flight send shows Stop in place of Send; either way nothing sends.
		await expect(page.locator("#send:enabled")).toHaveCount(0);
		expect(draftState(harness, sessionId).draft?.["text"]).toBe(textB);
		report["remoteEditBeforeAcceptance"] = draftState(harness, sessionId);
		await expect
			.poll(() => response, { timeout: 30_000 })
			.toMatchObject({ exit: { _tag: "Success", value: { ok: true } } });
		await expect(app.input).toHaveValue(textB);
		await expect(app.sendBtn).toBeEnabled();
		await expect(chips(page)).toHaveCount(0);
		expect(draftState(harness, sessionId).draft?.["text"]).toBe(textB);
		expect(draftState(harness, sessionId).attachments).toContainEqual(
			expect.objectContaining({ id: attachmentId, state: "sent", hash: null }),
		);
		report["providerDeliveries"] = await expectDelivered(harness, sentInputId);
		expect(
			inputState(harness, sentInputId).events.filter(
				(event) => event["type"] === "input.admitted",
			),
		).toHaveLength(1);
		report["submitted"] = submitted;
		report["acceptedResponse"] = response;
		report["retainedDraft"] = draftState(harness, sessionId);
	});
	for (const phase of ["idle", "busy"] as const) {
		test(`${phase} session removal before commit rolls the entire admission back`, async ({
			harness,
			page,
			report,
		}) => {
			await harness.restart({
				serviceEnvironment: {
					CONDUIT_TEST_DRAFT_SEND_BEFORE_COMMIT_MS: "10000",
				},
			});
			const tabA = await harness.connect();
			const tabB = await harness.connect();
			const sessionId = await tabA.createSession("Draft commit removal race");
			const text = "Draft must remain after commit refusal";
			let inputId: string = randomUUID();
			let requestId: string | number | undefined;
			let uiResponse: unknown;
			page.on("websocket", (socket) => {
				let submitRequestId: string | number | undefined;
				socket.on("framesent", ({ payload }) => {
					const frame = JSON.parse(payload.toString()) as {
						id?: string | number;
						tag?: string;
						payload?: { text?: string; inputId: string };
					};
					if (frame.tag === "input.submit" && frame.payload?.text === text) {
						inputId = frame.payload.inputId;
						requestId = frame.id;
						submitRequestId = frame.id;
					}
				});
				socket.on("framereceived", ({ payload }) => {
					const frame = JSON.parse(payload.toString()) as {
						_tag?: string;
						requestId?: string | number;
					};
					if (
						frame._tag === "Exit" &&
						submitRequestId !== undefined &&
						String(frame.requestId) === String(submitRequestId)
					)
						uiResponse = frame;
				});
			});
			const app = new AppPage(page);
			if (phase === "busy") {
				await app.goto(`${harness.baseUrl}${route(sessionId)}`);
				await app.sendMessage("task-stop-foreground-draft-commit-race");
				await expect(new ChatPage(page).stopBtn).toBeVisible({
					timeout: 30_000,
				});
			}
			const id = await add(tabA, sessionId);
			await setText(tabA, sessionId, text);
			let sending: Promise<unknown> | undefined;
			if (phase === "idle") {
				await app.goto(`${harness.baseUrl}${route(sessionId)}`);
				await expect(app.input).toHaveValue(text);
				await expect(chips(page)).toHaveCount(1);
				await app.sendBtn.click();
				await expect.poll(() => requestId).toBeDefined();
			} else {
				sending = Effect.runPromise(
					tabA.rpc["input.submit"]({
						sessionId,
						inputId,
						text,
						delivery: "queue",
						draftKey: { session: sessionId },
						attachmentIds: [id],
					}).pipe(Effect.result),
				);
			}
			// In the busy phase the setup send is itself held by the hook, and
			// this submit waits behind it in the session's serialised block.
			await expect
				.poll(
					() => harness.logTail.includes(`draft-send-before-commit:${inputId}`),
					{ timeout: 30_000 },
				)
				.toBe(true);
			// The composer may clear locally, but only admission may clear the
			// durable Draft. This catches a premature SyncInputDraft{text:""}.
			expect(draftState(harness, sessionId).draft?.["text"]).toBe(text);
			report["beforeCommit"] = draftState(harness, sessionId);
			const newerText = `${text}; a newer edit typed while admission waits`;
			if (phase === "idle") await app.input.fill(newerText);
			await Effect.runPromise(
				tabB.rpc.RemoveDraftAttachment({ key: { session: sessionId }, id }),
			);
			const removed = draftState(harness, sessionId);
			let result: unknown;
			if (phase === "idle") {
				await expect
					.poll(() => JSON.stringify(uiResponse), { timeout: 30_000 })
					.toContain("DraftAttachmentMissing");
				result = uiResponse;
				await expect(app.input).toHaveValue(newerText);
				// No further edit, navigation or visibility event may be needed to
				// resume autosave after the failed send releases its in-flight guard.
				await expect
					.poll(() => draftState(harness, sessionId).draft?.["text"])
					.toBe(newerText);
				expect(draftState(harness, sessionId).attachments).toEqual(
					removed.attachments,
				);
				report["newerPendingEdit"] = newerText;
			} else {
				result = await sending;
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "DraftAttachmentMissing" },
				});
				expect(draftState(harness, sessionId)).toEqual(removed);
				expect(draftState(harness, sessionId).draft?.["text"]).toBe(text);
			}
			expect(inputState(harness, inputId)).toEqual({
				events: [],
				pending: undefined,
			});
			expect(providerImages(harness, inputId)).toEqual([]);
			report["sendResult"] = result;
			report["commitPath"] =
				phase === "idle" ? "orchestration durable.write" : "persistEvents";
			report["rolledBackInput"] = inputState(harness, inputId);
			report["preservedDraft"] = draftState(harness, sessionId);
			writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		});
	}
});
