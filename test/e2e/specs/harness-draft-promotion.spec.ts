// conduit-test-mryl.5: Draft Session promotion, observed through the process
// harness, browser, provider bytes and durable attachment catalogue.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import type { Page } from "@playwright/test";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import type {
	InputDraftEnvelope,
	InputDraftKey,
} from "../../../src/lib/contracts/ws-rpc.js";
import { makeAttachmentStore } from "../../../src/lib/persistence/attachment-store.js";
import { inputDraftClaimMarker } from "../../../src/lib/persistence/input-drafts.js";
import { assertAttachmentCatalogue } from "../../helpers/attachment-catalogue.js";
import type {
	ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";
import { claudeModels, pickClaudeModel } from "../helpers/draft-model.js";
import {
	expect,
	test as harnessTest,
} from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const bytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
	"base64",
);
const hash = createHash("sha256")
	.update("image/png\0")
	.update(bytes)
	.digest("hex");
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
const image = { name: "promotion.png", mimeType: "image/png", buffer: bytes };
const chips = (page: Page) =>
	page.locator(
		"#image-preview .paste-thumb, #image-preview [data-testid='file-attachment-chip']",
	);
const draftRoute = (id: string) => `/draft/${id}?p=process-test`;

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

function storedDraft(harness: ProcessHarness, key: string) {
	return withStore(harness, (db) => ({
		draft: db
			.prepare(
				"SELECT text, promoted_session_id FROM input_drafts WHERE draft_key = ?",
			)
			.get(key),
		attachments: db
			.prepare(
				"SELECT id, hash, state FROM draft_attachments WHERE draft_key = ? ORDER BY id",
			)
			.all(key),
	}));
}

async function snapshot(browser: ProcessBrowser, key: InputDraftKey) {
	const envelope = Option.getOrThrow(
		await Effect.runPromise(
			browser.rpc
				.SubscribeInputDraft({ key })
				.pipe(Stream.runHead, Effect.timeout("10 seconds")),
		),
	);
	if (envelope._tag === "promoted")
		throw new Error("Expected a Draft snapshot");
	return envelope;
}

async function listed(browser: ProcessBrowser) {
	return Option.getOrThrow(
		await Effect.runPromise(
			browser.rpc
				.SubscribeDrafts({})
				.pipe(Stream.runHead, Effect.timeout("10 seconds")),
		),
	);
}

async function add(
	browser: ProcessBrowser,
	draftId: string,
	id = randomUUID(),
) {
	await Effect.runPromise(
		browser.rpc.AddDraftAttachment({
			key: { draft: draftId },
			id,
			name: image.name,
			mime: "image/png",
			dataUrl,
			projectSlug: "process-test",
		}),
	);
	return id;
}

async function sync(browser: ProcessBrowser, draftId: string, text: string) {
	await Effect.runPromise(
		browser.rpc.SyncInputDraft({
			key: { draft: draftId },
			text,
			projectSlug: "process-test",
			originId: browser.originId,
		}),
	);
}

function create(
	browser: ProcessBrowser,
	draftId: string,
	text: string,
	workspace: { worktreePath?: string; newWorktree?: boolean } = {},
) {
	return browser.rpc.CreateSession({
		projectSlug: "process-test",
		originId: browser.originId,
		draftId,
		draftText: text,
		providerId: "claude",
		permissionMode: "ask",
		...workspace,
		model: {
			providerId: "claude",
			modelId: "sonnet",
			variant: "",
			contextWindow: "200k",
		},
	});
}

function providerImages(harness: ProcessHarness, inputId: string) {
	const path = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): Record<string, unknown> => JSON.parse(line))
		.filter(
			(mark) => mark["kind"] === "input-content" && mark["inputId"] === inputId,
		)
		.flatMap((mark) =>
			Array.isArray(mark["content"]) ? (mark["content"] as unknown[]) : [],
		)
		.filter(
			(
				block,
			): block is {
				type: "image";
				source: { data: string; media_type: string };
			} =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "image",
		);
}

async function delivered(harness: ProcessHarness, inputId: string) {
	await expect
		.poll(() => providerImages(harness, inputId), { timeout: 30_000 })
		.toHaveLength(1);
	const images = providerImages(harness, inputId);
	expect(images[0]?.source.media_type).toBe("image/png");
	expect(Buffer.from(images[0]?.source.data ?? "", "base64")).toEqual(bytes);
	return images;
}

const test = harnessTest.extend<{ report: Record<string, unknown> }>({
	report: [
		async ({ harness }, use, testInfo) => {
			const report: Record<string, unknown> = {
				bead: "conduit-test-mryl.5",
				test: testInfo.title,
				project: testInfo.project.name,
				passed: false,
			};
			const directory = "test-results/draft-attachments";
			mkdirSync(directory, { recursive: true });
			const path = join(
				directory,
				`mryl-5-${testInfo.project.name}-${testInfo.testId}-retry-${testInfo.retry}.json`,
			);
			writeFileSync(path, JSON.stringify(report, null, 2));
			try {
				await use(report);
			} finally {
				const catalogue = await Effect.runPromise(
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
				const invariants = withStore(harness, (db) => ({
					missingBlobs: db
						.prepare(
							"SELECT hash FROM attachment_uses WHERE hash NOT IN (SELECT hash FROM attachment_blobs) UNION SELECT hash FROM draft_attachments WHERE state = 'live' AND hash NOT IN (SELECT hash FROM attachment_blobs)",
						)
						.all(),
					inlineRows: db
						.prepare(`SELECT 'events' AS owner, event_id AS id FROM events WHERE type IN ('input.admitted', 'file.attached') AND instr(data, 'data:') > 0
				UNION ALL SELECT 'pending_inputs', input_id FROM pending_inputs WHERE instr(request || COALESCE(images, ''), 'data:') > 0
				UNION ALL SELECT 'message_parts', id FROM message_parts WHERE type IN ('file', 'attached-file') AND instr(COALESCE(metadata, '') || COALESCE(rest_payload, ''), 'data:') > 0
				UNION ALL SELECT 'provider_command_outbox', command_id FROM provider_command_outbox WHERE instr(payload_json, 'data:') > 0`)
						.all(),
				}));
				report["catalogueViolations"] = catalogue;
				report["invariants"] = invariants;
				report["logTail"] = harness.logTail.slice(-3000);
				report["passed"] =
					testInfo.status === "passed" &&
					catalogue.length === 0 &&
					invariants.missingBlobs.length === 0 &&
					invariants.inlineRows.length === 0;
				writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
				await testInfo.attach("draft-promotion-result", {
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
test.use({
	harnessOptions: { restartProof: true, capabilityModels: claudeModels },
});

test.describe.configure({ retries: 0, timeout: 120_000 });

test("image-only Draft survives reload and sidebar counts include only live images and files", async ({
	harness,
	page,
	report,
}, testInfo) => {
	const browser = await harness.connect();
	const draftId = randomUUID();
	const id = await add(browser, draftId);
	await new AppPage(page).goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await expect(chips(page)).toHaveCount(1);
	await page.reload();
	await expect(chips(page)).toHaveCount(1);
	await new AppPage(page).goto(`${harness.baseUrl}/?p=process-test`);
	const row = page.locator(`[data-draft-id='${draftId}']`);
	await expect(row).toContainText("1 image");
	await expect(
		row.locator("[data-testid='draft-attachment-icon']"),
	).toBeVisible();
	expect(await listed(browser)).toContainEqual(
		expect.objectContaining({ draftId, imageCount: 1, fileCount: 0 }),
	);
	await add(browser, draftId);
	await expect(row).toContainText("2 images");
	await Effect.runPromise(
		browser.rpc.AddDraftAttachment({
			key: { draft: draftId },
			id: randomUUID(),
			name: "notes.txt",
			mime: "text/plain",
			dataUrl: "data:text/plain;base64,bm90ZXM=",
			projectSlug: "process-test",
		}),
	);
	await Effect.runPromise(
		browser.rpc.RemoveDraftAttachment({
			key: { draft: draftId },
			id,
			projectSlug: "process-test",
		}),
	);
	await expect(row).toContainText("1 image, 1 file");
	const textOnly = randomUUID();
	await sync(browser, textOnly, "  \nsecond line");
	const textRow = page.locator(`[data-draft-id='${textOnly}']`);
	await expect(textRow).toContainText("Untitled draft");
	await expect(textRow.getByTestId("draft-attachment-icon")).toHaveCount(0);
	report["list"] = await listed(browser);
	report["draft"] = storedDraft(harness, draftId);
	await page.screenshot({ path: testInfo.outputPath("mixed-draft-label.png") });
});

test("first browser send promotes every attachment state and delivers identical bytes by reference", async ({
	harness,
	page,
	report,
}) => {
	const browser = await harness.connect();
	const draftId = randomUUID();
	const id = await add(browser, draftId);
	const removed = await add(browser, draftId);
	await Effect.runPromise(
		browser.rpc.RemoveDraftAttachment({
			key: { draft: draftId },
			id: removed,
			projectSlug: "process-test",
		}),
	);
	const ended = randomUUID();
	withStore(harness, (db) =>
		db
			.prepare(
				"INSERT INTO draft_attachments (id, draft_key, position, name, hash, state, created_at) VALUES (?, ?, 99, 'already-sent.png', NULL, 'sent', ?)",
			)
			.run(ended, draftId, Date.now()),
	);
	const sends: Array<Record<string, unknown>> = [];
	await page.routeWebSocket("**/rpc", (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((data) => {
			const frame = JSON.parse(String(data)) as {
				_tag?: string;
				tag?: string;
				payload?: Record<string, unknown>;
			};
			if (
				frame._tag === "Request" &&
				frame.tag === "input.submit" &&
				frame.payload
			)
				sends.push(frame.payload);
			server.send(data);
		});
	});
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await expect(chips(page)).toHaveCount(1);
	await pickClaudeModel(page);
	await expect(app.sendBtn).toBeEnabled();
	await app.sendBtn.click();
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await expect.poll(() => sends.length).toBe(1);
	const sessionId = new URL(page.url()).pathname.split("/")[2] ?? "";
	expect(sends[0]).toMatchObject({
		attachmentIds: [id],
		draftKey: { session: sessionId },
	});
	expect(JSON.stringify(sends)).not.toContain("data:");
	report["deliveries"] = await delivered(
		harness,
		String(sends[0]?.["inputId"]),
	);
	await expect(chips(page)).toHaveCount(0);
	await expect(app.input).toHaveValue("");
	expect(await snapshot(browser, { session: sessionId })).toMatchObject({
		text: "",
		attachments: [],
	});
	expect(storedDraft(harness, draftId)).toMatchObject({
		draft: { text: "", promoted_session_id: sessionId },
		attachments: [],
	});
	expect(storedDraft(harness, sessionId).attachments).toEqual(
		expect.arrayContaining([
			{ id, state: "sent", hash: null },
			{ id: removed, state: "removed", hash: null },
			{ id: ended, state: "sent", hash: null },
		]),
	);
	expect(
		await Effect.runPromise(
			browser.rpc.AddDraftAttachment({
				key: { draft: draftId },
				id: removed,
				name: image.name,
				mime: "image/png",
				dataUrl,
				projectSlug: "process-test",
			}),
		),
	).toEqual({ ended: "removed" });
	expect(
		await Effect.runPromise(
			browser.rpc.AddDraftAttachment({
				key: { draft: draftId },
				id: ended,
				name: image.name,
				mime: "image/png",
				dataUrl,
				projectSlug: "process-test",
			}),
		),
	).toEqual({ ended: "sent" });
	expect(
		withStore(harness, (db) =>
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM attachment_blobs WHERE hash = ?",
				)
				.get(hash),
		),
	).toEqual({ count: 1 });
	report["session"] = storedDraft(harness, sessionId);
	report["send"] = sends[0];
});

test.describe(() => {
	test.use({ startHarness: false });
	test("a send failure after creation keeps the promoted Draft attachments for retry", async ({
		harness,
		report,
	}) => {
		await harness.restart({
			serviceEnvironment: { CONDUIT_TEST_RPC_DEFECT: "input.submit" },
		});
		const browser = await harness.connect();
		const draftId = randomUUID();
		const id = await add(browser, draftId);
		const text = "retry after creation";
		await sync(browser, draftId, text);
		const { sessionId } = await Effect.runPromise(
			create(browser, draftId, text),
		);
		const before = storedDraft(harness, sessionId);
		const inputId = randomUUID();
		const request = {
			sessionId,
			inputId,
			text,
			draftText: text,
			delivery: "queue" as const,
			draftKey: { session: sessionId },
			attachmentIds: [id],
		};
		const failure = await Effect.runPromise(
			browser.rpc["input.submit"](request).pipe(Effect.exit),
		);
		expect(failure._tag).toBe("Failure");
		expect(storedDraft(harness, sessionId)).toEqual(before);
		expect(before).toMatchObject({
			draft: { text },
			attachments: [{ id, hash, state: "live" }],
		});
		expect(
			withStore(harness, (db) =>
				db
					.prepare(
						"SELECT event_id FROM events WHERE type = 'input.admitted' AND json_extract(data, '$.inputId') = ?",
					)
					.all(inputId),
			),
		).toEqual([]);
		report["failure"] = failure;
		await harness.terminate();
		await harness.restart({
			serviceEnvironment: { CONDUIT_TEST_RPC_DEFECT: undefined },
		});
		const retry = await harness.connect();
		expect(await snapshot(retry, { session: sessionId })).toMatchObject({
			text,
			attachments: [{ id, hash }],
		});
		await Effect.runPromise(retry.rpc["input.submit"](request));
		report["deliveries"] = await delivered(harness, inputId);
	});
});

test("a file read finishing after its Draft Session was sent lands in the promoted session Draft", async ({
	harness,
	page,
	report,
}) => {
	const browser = await harness.connect();
	const draftId = randomUUID();
	await sync(browser, draftId, "send before image read");
	await page.addInitScript(() => {
		const state = window as Window & { releaseDraftReads?: Array<() => void> };
		state.releaseDraftReads = [];
		const NativeReader = window.FileReader;
		window.FileReader = class extends NativeReader {
			override readAsDataURL(blob: Blob) {
				state.releaseDraftReads?.push(() => super.readAsDataURL(blob));
			}
		};
	});
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}${draftRoute(draftId)}`);
	await page.locator("input[type=file]").last().setInputFiles(image);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as Window & { releaseDraftReads?: unknown[] })
						.releaseDraftReads?.length,
			),
		)
		.toBe(1);
	await expect(app.sendBtn).toBeDisabled();
	// Another device can send while this device's picker read is outstanding.
	const { sessionId } = await Effect.runPromise(
		create(browser, draftId, "send before image read"),
	);
	const inputId = randomUUID();
	await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			inputId,
			text: "send before image read",
			draftText: "send before image read",
			draftKey: { session: sessionId },
			attachmentIds: [],
			delivery: "queue",
		}),
	);
	await expect
		.poll(() =>
			withStore(
				harness,
				(db) =>
					db
						.prepare(
							"SELECT event_id FROM events WHERE type = 'input.sent' AND json_extract(data, '$.inputId') = ?",
						)
						.all(inputId).length,
			),
		)
		.toBe(1);
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await expect(app.input).toHaveValue("");
	await page.evaluate(() => {
		for (const release of (
			window as Window & { releaseDraftReads?: Array<() => void> }
		).releaseDraftReads ?? [])
			release();
	});
	await expect
		.poll(
			async () =>
				(await snapshot(browser, { session: sessionId })).attachments.length,
		)
		.toBe(1);
	expect(storedDraft(harness, draftId).attachments).toEqual([]);
	await page.reload();
	await expect(chips(page)).toHaveCount(1);
	report["session"] = storedDraft(harness, sessionId);
	expect(await snapshot(browser, { session: sessionId })).toMatchObject({
		attachments: [{ hash, name: image.name }],
	});
});

test("startup releases image-only claims and preserves tombstones while dropping empty Drafts", async ({
	harness,
	report,
}) => {
	const browser = await harness.connect();
	const draftId = randomUUID();
	const id = await add(browser, draftId);
	const tombstoneId = randomUUID();
	const removed = await add(browser, tombstoneId);
	await Effect.runPromise(
		browser.rpc.RemoveDraftAttachment({
			key: { draft: tombstoneId },
			id: removed,
			projectSlug: "process-test",
		}),
	);
	await harness.kill();
	withStore(harness, (db) =>
		db
			.prepare(
				"UPDATE input_drafts SET promoted_session_id = ? WHERE draft_key IN (?, ?)",
			)
			.run(inputDraftClaimMarker, draftId, tombstoneId),
	);
	await harness.restart();
	const after = await harness.connect();
	expect(storedDraft(harness, draftId)).toMatchObject({
		draft: { text: "", promoted_session_id: null },
		attachments: [{ id, hash, state: "live" }],
	});
	expect(await listed(after)).toContainEqual(
		expect.objectContaining({ draftId, imageCount: 1, fileCount: 0 }),
	);
	expect(
		(await listed(after)).some((draft) => draft.draftId === tombstoneId),
	).toBe(false);
	expect(storedDraft(harness, tombstoneId)).toMatchObject({
		draft: { promoted_session_id: null },
		attachments: [{ id: removed, state: "removed", hash: null }],
	});
	report["imageOnly"] = storedDraft(harness, draftId);
	report["tombstoneOnly"] = storedDraft(harness, tombstoneId);
});

test("new draft pressed twice gives independent empty ids which stay unlisted and disappear on restart", async ({
	harness,
	page,
	report,
}) => {
	const browser = await harness.connect();
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/?p=process-test`);
	const ids: string[] = [];
	for (let index = 0; index < 2; index++) {
		await page.locator("#new-session-btn:visible").click();
		await expect(page).toHaveURL(/\/draft\/[^/?]+/);
		await expect(app.input).toBeVisible();
		const id = new URL(page.url()).pathname.split("/")[2] ?? "";
		expect(ids).not.toContain(id);
		ids.push(id);
		// Normal empty syncs need no row. Seed one as a crash could leave it,
		// so the restart cleanup assertion also proves actual deletion.
		await sync(browser, id, "");
		withStore(harness, (db) =>
			db
				.prepare(
					"INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at) VALUES (?, 'process-test', 'draft', '', ?)",
				)
				.run(id, Date.now()),
		);
		expect(storedDraft(harness, id).draft).toBeDefined();
		expect(
			(await listed(browser)).some((draft) => ids.includes(draft.draftId)),
		).toBe(false);
		if (!(await page.locator("#new-session-btn:visible").count()))
			await app.sessionBarBack.click();
	}
	await harness.terminate();
	await harness.restart();
	for (const id of ids)
		expect(storedDraft(harness, id)).toEqual({
			draft: undefined,
			attachments: [],
		});
	report["freshIds"] = ids;
});

test.describe(() => {
	test.use({ startHarness: false });
	test("promotion write failure rolls back session creation, text and attachments, and retry succeeds", async ({
		harness,
		report,
	}) => {
		const draftId = randomUUID();
		await harness.restart({
			serviceEnvironment: {
				CONDUIT_TEST_DRAFT_PROMOTION_WRITE_FAILURE: draftId,
			},
		});
		const browser = await harness.connect();
		const id = await add(browser, draftId);
		const text = "retain all work on failed promotion";
		await sync(browser, draftId, text);
		const before = storedDraft(harness, draftId);
		const sessions = withStore(harness, (db) =>
			db.prepare("SELECT id FROM sessions ORDER BY id").all(),
		);
		const events = withStore(harness, (db) =>
			db
				.prepare(
					"SELECT event_id FROM events WHERE type = 'session.created' ORDER BY sequence",
				)
				.all(),
		);
		const failure = await Effect.runPromise(
			create(browser, draftId, text).pipe(Effect.exit),
		);
		expect(failure._tag).toBe("Failure");
		expect(harness.logTail).toContain("Test Draft promotion write failure");
		expect(storedDraft(harness, draftId)).toEqual(before);
		expect(
			withStore(harness, (db) =>
				db.prepare("SELECT id FROM sessions ORDER BY id").all(),
			),
		).toEqual(sessions);
		expect(
			withStore(harness, (db) =>
				db
					.prepare(
						"SELECT event_id FROM events WHERE type = 'session.created' ORDER BY sequence",
					)
					.all(),
			),
		).toEqual(events);
		expect(await snapshot(browser, { draft: draftId })).toMatchObject({
			text,
			attachments: [{ id, hash }],
		});
		const { sessionId } = await Effect.runPromise(
			create(browser, draftId, text),
		);
		expect(await snapshot(browser, { session: sessionId })).toMatchObject({
			text,
			attachments: [{ id, hash }],
		});
		expect(storedDraft(harness, draftId)).toMatchObject({
			draft: { promoted_session_id: sessionId },
			attachments: [],
		});
		const inputId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				inputId,
				text,
				draftText: text,
				draftKey: { session: sessionId },
				attachmentIds: [id],
				delivery: "queue",
			}),
		);
		report["failure"] = failure;
		report["deliveries"] = await delivered(harness, inputId);
		report["source"] = storedDraft(harness, draftId);
	});
});

test("workspace setup failure compensates promotion, deletes the session and worktree, and retries by reference", async ({
	harness,
	report,
}) => {
	const draftId = randomUUID();
	const gitEnv = { ...process.env };
	for (const name of [
		"GIT_DIR",
		"GIT_INDEX_FILE",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
	])
		delete gitEnv[name];
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", harness.projectDir, ...args], {
			env: gitEnv,
			encoding: "utf8",
		});
	git("init", "-b", "main");
	git(
		"-c",
		"user.name=Draft test",
		"-c",
		"user.email=draft@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--allow-empty",
		"-m",
		"Initial commit",
	);
	await harness.terminate();
	await harness.restart({
		serviceEnvironment: { CONDUIT_TEST_DRAFT_WORKSPACE_FAILURE: draftId },
	});
	const browser = await harness.connect();
	const id = await add(browser, draftId);
	const removed = await add(browser, draftId);
	await Effect.runPromise(
		browser.rpc.RemoveDraftAttachment({
			key: { draft: draftId },
			id: removed,
			projectSlug: "process-test",
		}),
	);
	const text = "restore Draft when workspace setup fails";
	await sync(browser, draftId, text);
	const before = storedDraft(harness, draftId);
	const sessionsBefore = withStore(harness, (db) =>
		db.prepare("SELECT id FROM sessions ORDER BY id").all(),
	);
	const worktreesBefore = git("worktree", "list", "--porcelain");
	const branchesBefore = git(
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads",
	);
	const envelopes: InputDraftEnvelope[] = [];
	const failure = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const queue = yield* Queue.unbounded<InputDraftEnvelope>();
				yield* browser.rpc
					.SubscribeInputDraft({ key: { draft: draftId } })
					.pipe(
						Stream.runForEach((envelope) => {
							envelopes.push(envelope);
							return Queue.offer(queue, envelope);
						}),
						Effect.forkScoped,
					);
				expect(yield* Queue.take(queue)).toMatchObject({
					_tag: "synchronized",
					text,
					attachments: [{ id, hash }],
				});
				const failure = yield* create(browser, draftId, text, {
					newWorktree: true,
				}).pipe(Effect.exit);
				// A later write on the same stream is a delivery barrier for earlier envelopes.
				yield* browser.rpc.SyncInputDraft({
					key: { draft: draftId },
					text,
					projectSlug: "process-test",
					originId: browser.originId,
				});
				let received = yield* Queue.take(queue);
				while (received._tag !== "draft") received = yield* Queue.take(queue);
				return failure;
			}),
		).pipe(Effect.timeout("30 seconds")),
	);
	expect(failure._tag).toBe("Failure");
	if (failure._tag === "Failure")
		expect(Cause.findErrorOption(failure.cause)).toMatchObject({
			_tag: "Some",
			value: { _tag: "WorkspaceMoveError" },
		});
	expect(harness.logTail).toContain("Test Draft workspace setup failure");
	expect(envelopes.filter((envelope) => envelope._tag === "promoted")).toEqual(
		[],
	);
	expect(storedDraft(harness, draftId)).toEqual(before);
	expect(
		withStore(harness, (db) =>
			db.prepare("SELECT id FROM sessions ORDER BY id").all(),
		),
	).toEqual(sessionsBefore);
	// Retention may reclaim the deleted session's history at any time; its
	// session.deleted event keeps the launch ownership as durable evidence.
	const deleted = withStore(harness, (db) =>
		db
			.prepare(
				"SELECT json_extract(data, '$.sessionId') AS sessionId, json_extract(data, '$.worktreeOwnership') AS ownership FROM events WHERE type = 'session.deleted' ORDER BY sequence DESC LIMIT 1",
			)
			.get(),
	);
	if (
		typeof deleted?.["sessionId"] !== "string" ||
		typeof deleted["ownership"] !== "string"
	)
		throw new Error("Missing deleted launch workspace");
	const failedSessionId = deleted["sessionId"];
	expect(storedDraft(harness, failedSessionId)).toEqual({
		draft: undefined,
		attachments: [],
	});
	const ownership = JSON.parse(deleted["ownership"]) as {
		readonly _tag: string;
		readonly ownership?: readonly { readonly path: string }[];
	};
	expect(ownership._tag).toBe("Owned");
	const paths = (ownership.ownership ?? []).map(({ path }) => path);
	expect(paths.length).toBeGreaterThan(0);
	for (const path of paths) expect(existsSync(path)).toBe(false);
	expect(git("worktree", "list", "--porcelain")).toBe(worktreesBefore);
	expect(git("for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
		branchesBefore,
	);
	expect(
		(await listed(browser)).find((draft) => draft.draftId === draftId),
	).toMatchObject({ firstLine: text, imageCount: 1 });
	expect(await snapshot(browser, { draft: draftId })).toMatchObject({
		text,
		attachments: [{ id, hash }],
	});
	const catalogue = await Effect.runPromise(
		Effect.all({
			violations: assertAttachmentCatalogue,
			blob: Effect.flatMap(makeAttachmentStore, (store) => store.get(hash)),
		}).pipe(
			Effect.provide(
				SqliteNode.layer({
					filename: harness.daemonStorePath(),
					readonly: true,
				}).pipe(Layer.provide(Reactivity.layer)),
			),
			Effect.scoped,
		),
	);
	expect(catalogue.violations).toEqual([]);
	expect(Buffer.from(catalogue.blob.bytes)).toEqual(bytes);
	const { sessionId } = await Effect.runPromise(
		create(browser, draftId, text, { newWorktree: true }),
	);
	expect(await snapshot(browser, { session: sessionId })).toMatchObject({
		text,
		attachments: [{ id, hash }],
	});
	const inputId = randomUUID();
	await Effect.runPromise(
		browser.rpc["input.submit"]({
			sessionId,
			inputId,
			text,
			draftText: text,
			draftKey: { session: sessionId },
			attachmentIds: [id],
			delivery: "queue",
		}),
	);
	report["failure"] = failure;
	report["failedSessionId"] = failedSessionId;
	report["removedWorktrees"] = paths;
	report["envelopesBeforeRetry"] = envelopes;
	report["restoredDraft"] = before;
	report["restoredBlobHash"] = hash;
	report["deliveries"] = await delivered(harness, inputId);
});

test.describe(() => {
	test.use({ startHarness: false });
	test("promotion keeps a text-only first send disabled until submission settles", async ({
		harness,
		page,
		report,
	}) => {
		await harness.restart({
			serviceEnvironment: { CONDUIT_TEST_DRAFT_SEND_BEFORE_COMMIT_MS: "10000" },
		});
		const browser = await harness.connect();
		const draftId = randomUUID();
		const text = "one first send while promotion is pending";
		await sync(browser, draftId, text);
		const sends: Array<Record<string, unknown>> = [];
		await page.routeWebSocket("**/rpc", (socket) => {
			const server = socket.connectToServer();
			socket.onMessage((data) => {
				const frame = JSON.parse(String(data)) as {
					_tag?: string;
					tag?: string;
					payload?: Record<string, unknown>;
				};
				if (
					frame._tag === "Request" &&
					frame.tag === "input.submit" &&
					frame.payload
				)
					sends.push(frame.payload);
				server.send(data);
			});
		});
		const app = new AppPage(page);
		await app.goto(`${harness.baseUrl}${draftRoute(draftId)}`);
		await expect(app.input).toHaveValue(text);
		await pickClaudeModel(page);
		await app.sendBtn.click();
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		await expect.poll(() => sends.length).toBe(1);
		await expect(app.input).toHaveValue(text);
		// Working composers may hide Send; neither a click nor the send shortcut
		// may submit again. Ctrl+Enter sends on every viewport; phone Enter is a newline.
		await expect(page.locator("#send:enabled")).toHaveCount(0);
		await app.input.press("Control+Enter");
		expect(sends).toHaveLength(1);
		const inputId = String(sends[0]?.["inputId"]);
		await expect
			.poll(
				() =>
					withStore(
						harness,
						(db) =>
							db
								.prepare(
									"SELECT event_id FROM events WHERE type = 'input.admitted' AND json_extract(data, '$.inputId') = ?",
								)
								.all(inputId).length,
					),
				{ timeout: 30_000 },
			)
			.toBe(1);
		await expect(app.input).toHaveValue("");
		expect(sends).toHaveLength(1);
		report["send"] = sends[0];
	});
});
