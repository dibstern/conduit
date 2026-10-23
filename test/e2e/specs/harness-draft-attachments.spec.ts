// conduit-test-mryl.2: images become refs before admission and are resolved only
// for provider delivery. Deliberately blocked outbox claims expose the durable
// checkpoint without a timing race or a second application send path.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/account-directory.js";
import {
	assertAttachmentCatalogue,
	indexedAttachmentColumns,
} from "../../helpers/attachment-catalogue.js";
import {
	projectStoreBackup,
	sourceChecksums,
} from "../../helpers/daemon-store-import-manifest.js";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
import {
	createLegacyInlineAttachmentStore,
	legacyImageRef,
} from "../../helpers/legacy-inline-attachment-store.js";
import type { ProcessHarness } from "../../helpers/process-harness.js";
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
const dataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const hash = createHash("sha256")
	.update("image/png\0")
	.update(imageBytes)
	.digest("hex");
const ref = { attachmentHash: hash, mime: "image/png" };

function withStore<A>(
	harness: ProcessHarness,
	read: (db: DatabaseSync) => A,
): A {
	const db = new DatabaseSync(harness.daemonStorePath());
	try {
		return read(db);
	} finally {
		db.close();
	}
}

function catalogue(harness: ProcessHarness) {
	return withStore(harness, (db) => {
		const columns = db
			.prepare(
				`SELECT m.name AS table_name, p.name AS column_name
				 FROM sqlite_master m JOIN pragma_table_info(m.name) p
				 WHERE m.type = 'table' AND upper(p.type) = 'TEXT'
				 ORDER BY m.name, p.cid`,
			)
			.all() as { table_name: string; column_name: string }[];
		const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
		const carriers = columns.flatMap(({ table_name, column_name }) => {
			const row = db
				.prepare(
					`SELECT COUNT(*) AS count FROM ${quote(table_name)}
					 WHERE instr(${quote(column_name)}, '"attachmentHash"') > 0`,
				)
				.get();
			return Number(row?.["count"]) > 0
				? [
						{
							column: `${table_name}.${column_name}`,
							rows: Number(row?.["count"]),
						},
					]
				: [];
		});
		return {
			textColumnsChecked: columns.length,
			carriers,
			unknownCarriers: carriers
				.map(({ column }) => column)
				.filter(
					(column) =>
						!indexedAttachmentColumns.some((known) => known === column),
				),
		};
	});
}

const test = harnessTest.extend<{ report: Record<string, unknown> }>({
	report: [
		async ({ harness }, use, testInfo) => {
			const report: Record<string, unknown> = {
				bead: "conduit-test-mryl.2",
				project: testInfo.project.name,
				test: testInfo.title,
				passed: false,
			};
			const directory = "test-results/draft-attachments";
			mkdirSync(directory, { recursive: true });
			const path = join(
				directory,
				`${testInfo.project.name}-${testInfo.testId}-retry-${testInfo.retry}.json`,
			);
			writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
			try {
				await use(report);
			} finally {
				const check = existsSync(harness.daemonStorePath())
					? catalogue(harness)
					: null;
				const inlineTranscriptRows = existsSync(harness.daemonStorePath())
					? withStore(harness, (db) =>
							db
								.prepare(
									`SELECT 'events.file.attached' AS owner, event_id AS id
									 FROM events WHERE type = 'file.attached' AND instr(data, 'data:') > 0
									 UNION ALL
									 SELECT 'events.message.snapshot', e.event_id
									 FROM events e, json_each(e.data, '$.message.parts') p
									 WHERE e.type = 'message.snapshot' AND json_extract(p.value, '$.type') = 'file'
									 AND instr(p.value, 'data:') > 0
									 UNION ALL
									 SELECT 'message_parts', id FROM message_parts
									 WHERE type IN ('file', 'attached-file')
									 AND instr(COALESCE(metadata, '') || COALESCE(rest_payload, ''), 'data:') > 0
									 UNION ALL
									 SELECT 'messages.rest_payload', m.id
									 FROM messages m, json_each(m.rest_payload, '$.parts') p
									 WHERE json_extract(p.value, '$.type') = 'file' AND instr(p.value, 'data:') > 0`,
								)
								.all(),
						)
					: null;
				report["catalogue"] = check;
				report["inlineTranscriptRows"] = inlineTranscriptRows;
				report["logTail"] = harness.logTail.slice(-3000);
				report["passed"] =
					testInfo.status === "passed" &&
					check?.unknownCarriers.length === 0 &&
					inlineTranscriptRows?.length === 0;
				writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
				await testInfo.attach("draft-attachments", {
					path,
					contentType: "application/json",
				});
				expect(check?.unknownCarriers).toEqual([]);
				expect(inlineTranscriptRows).toEqual([]);
			}
		},
		{ auto: true },
	],
});

test.use({ harnessOptions: { restartProof: true } });
test.describe.configure({ retries: 0 });

test("runtime registration imports a legacy inline image and renders it through the attachment route", async ({
	harness,
	page,
	report,
}, testInfo) => {
	test.setTimeout(120_000);
	report["bead"] = "conduit-test-mryl.11";
	const projectId = "legacy-inline-project";
	const folder = join(harness.root, projectId);
	const sourcePath = join(folder, ".conduit", "events.db");
	const source = await createLegacyInlineAttachmentStore(
		harness.root,
		projectId,
		{ sourcePath, unprojected: true },
	);
	const db = new DatabaseSync(sourcePath);
	try {
		// This history has no pending work. Registration only needs to import it.
		db.exec(
			"DELETE FROM provider_command_outbox; DELETE FROM pending_inputs; DELETE FROM events WHERE type = 'input.admitted'",
		);
	} finally {
		db.close();
	}
	const before = sourceChecksums(sourcePath);
	report["sourceBefore"] = before;
	const control = await harness.connect();
	const saved = await Effect.runPromise(
		control.rpc.SaveProject({ folders: [folder] }),
	);
	expect(saved.savedSlug).toBe(projectId);
	report["registeredProject"] = saved.savedSlug;
	// Registration rewrites .conduit/events.db into project storage, imports
	// that copy (leaving its backup there) and archives the untouched original.
	projectStoreBackup(harness.legacyProjectStorePath(projectId));
	const after = sourceChecksums(`${sourcePath}.migrated`);
	expect(after).toEqual(before);
	report["sourceArchiveAfter"] = after;
	await new AppPage(page).goto(`${harness.baseUrl}/s/${source.sessionId}`);
	const route = `/p/${saved.savedSlug}/attachments/${legacyImageRef.attachmentHash}`;
	const image = page.locator(`.msg-user img[src='${route}']`).first();
	await expect(image).toBeVisible();
	await expect
		.poll(() =>
			image.evaluate(
				(element: HTMLImageElement) =>
					element.complete && element.naturalWidth > 0,
			),
		)
		.toBe(true);
	const response = await page.request.get(`${harness.baseUrl}${route}`);
	expect(response.status()).toBe(200);
	expect(response.headers()["content-type"]).toBe("image/png");
	expect(await response.body()).toEqual(imageBytes);
	report["image"] = {
		route,
		status: response.status(),
		decoded: true,
		bytes: (await response.body()).length,
	};
	report["importedUses"] = withStore(harness, (store) =>
		store
			.prepare(
				"SELECT * FROM attachment_uses WHERE hash = ? ORDER BY source_table, source_column, source_row_key",
			)
			.all(legacyImageRef.attachmentHash),
	);
	expect(report["importedUses"]).not.toEqual([]);
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
	report["importCatalogueViolations"] = catalogue;
	expect(catalogue).toEqual([]);
	await page.screenshot({
		path: testInfo.outputPath("legacy-inline-import.png"),
		fullPage: true,
	});
});

function holdClaims(harness: ProcessHarness, sessionId: string): void {
	withStore(harness, (db) => {
		// This same SQL checkpoint is used by daemon-orchestration-engine tests.
		db.exec(`CREATE TRIGGER hold_attachment_send BEFORE UPDATE OF status ON provider_command_outbox
			WHEN NEW.session_id = '${sessionId.replaceAll("'", "''")}' AND NEW.status = 'running'
			BEGIN SELECT RAISE(IGNORE); END`);
	});
}

function releaseClaims(harness: ProcessHarness): void {
	withStore(harness, (db) =>
		db.exec("DROP TRIGGER IF EXISTS hold_attachment_send"),
	);
}

function storedInput(harness: ProcessHarness, inputId: string) {
	return withStore(harness, (db) => ({
		admitted: db
			.prepare(
				"SELECT event_id, data FROM events WHERE type = 'input.admitted' AND json_extract(data, '$.inputId') = ?",
			)
			.all(inputId),
		pending: db
			.prepare(
				"SELECT input_id, state, request, images FROM pending_inputs WHERE input_id = ?",
			)
			.get(inputId),
		outbox: db
			.prepare(
				"SELECT request_sequence, status, payload_json, command_id, run_id FROM provider_command_outbox WHERE effect_type = 'send_turn' AND json_extract(payload_json, '$.inputId') = ?",
			)
			.all(inputId),
		blobs: db.prepare("SELECT hash, mime, size FROM attachment_blobs").all(),
		uses: db
			.prepare(
				"SELECT source_table, source_column, source_row_key, hash FROM attachment_uses WHERE hash = ? ORDER BY source_table, source_column, source_row_key",
			)
			.all(hash),
	}));
}

function assertStoredRefs(
	harness: ProcessHarness,
	inputId: string,
	outbox: boolean,
) {
	const state = storedInput(harness, inputId);
	expect(state.admitted).toHaveLength(1);
	expect(JSON.stringify(state.admitted)).not.toContain("data:");
	expect(JSON.stringify(state.pending)).not.toContain("data:");
	expect(JSON.stringify(state.outbox)).not.toContain("data:");
	expect(state.blobs).toEqual([
		{ hash, mime: "image/png", size: imageBytes.length },
	]);
	expect(JSON.parse(String(state.pending?.["request"]))).toMatchObject({
		images: [ref],
	});
	expect(JSON.parse(String(state.pending?.["images"]))).toEqual([ref]);
	const eventId = state.admitted[0]?.["event_id"];
	for (const [source_table, source_column, source_row_key] of [
		["events", "data", String(eventId)],
		["pending_inputs", "request", inputId],
		["pending_inputs", "images", inputId],
	]) {
		expect(state.uses).toContainEqual({
			source_table,
			source_column,
			source_row_key,
			hash,
		});
	}
	if (outbox) {
		expect(state.outbox).toHaveLength(1);
		expect(state.outbox[0]?.["status"]).toBe("pending");
		expect(JSON.parse(String(state.outbox[0]?.["payload_json"]))).toMatchObject(
			{ images: [ref] },
		);
		expect(state.uses).toContainEqual({
			source_table: "provider_command_outbox",
			source_column: "payload_json",
			source_row_key: String(state.outbox[0]?.["request_sequence"]),
			hash,
		});
	}
	return state;
}

function providerImages(harness: ProcessHarness, inputId: string) {
	const file = join(harness.root, "sdk-proof.ndjson");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): Record<string, unknown> => JSON.parse(line))
		.filter(
			(mark) => mark["kind"] === "input-content" && mark["inputId"] === inputId,
		)
		.flatMap((mark) => (Array.isArray(mark["content"]) ? mark["content"] : []))
		.filter(
			(
				block,
			): block is {
				type: "image";
				source: { type: "base64"; media_type: string; data: string };
			} =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "image",
		);
}

async function expectProviderImage(harness: ProcessHarness, inputId: string) {
	await expect
		.poll(() => providerImages(harness, inputId), { timeout: 30_000 })
		.toHaveLength(1);
	const images = providerImages(harness, inputId);
	expect(images[0]?.source.media_type).toBe("image/png");
	expect(Buffer.from(images[0]?.source.data ?? "", "base64")).toEqual(
		imageBytes,
	);
	return images;
}

async function expectTerminalScrub(harness: ProcessHarness, inputId: string) {
	await expect
		.poll(
			() => storedInput(harness, inputId).outbox.map((row) => row["status"]),
			{ timeout: 30_000 },
		)
		.toEqual(["completed"]);
	const state = storedInput(harness, inputId);
	expect(JSON.stringify(state.admitted)).not.toContain("data:");
	expect(JSON.stringify(state.pending)).not.toContain("data:");
	expect(
		JSON.parse(String(state.outbox[0]?.["payload_json"])),
	).not.toHaveProperty("images");
	expect(
		state.uses.filter(
			(row) => row["source_table"] === "provider_command_outbox",
		),
	).toEqual([]);
	return state;
}

test("send stores refs, deduplicates retries, and drops terminal outbox image uses", async ({
	harness,
	report,
}) => {
	test.setTimeout(120_000);
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Attachment send and retry");
	const inputId = randomUUID();
	report["sessionId"] = sessionId;
	report["inputId"] = inputId;
	holdClaims(harness, sessionId);
	try {
		const input = {
			sessionId,
			originId: browser.originId,
			inputId,
			text: "attachment-send-byte-proof",
			delivery: "queue" as const,
			images: [dataUrl],
		};
		expect(
			await Effect.runPromise(browser.rpc["input.submit"](input)),
		).toMatchObject({ ok: true });
		await expect
			.poll(() => storedInput(harness, inputId).outbox.length)
			.toBe(1);
		report["beforeDelivery"] = assertStoredRefs(harness, inputId, true);
		expect(providerImages(harness, inputId)).toEqual([]);
		const before = storedInput(harness, inputId);
		report["retries"] = await Promise.all([
			Effect.runPromise(browser.rpc["input.submit"](input)),
			Effect.runPromise(browser.rpc["input.submit"](input)),
		]);
		expect(report["retries"]).toMatchObject([{ ok: true }, { ok: true }]);
		expect(storedInput(harness, inputId)).toEqual(before);
	} finally {
		releaseClaims(harness);
	}
	report["providerImages"] = await expectProviderImage(harness, inputId);
	report["afterDelivery"] = await expectTerminalScrub(harness, inputId);
	expect(storedInput(harness, inputId).admitted).toHaveLength(1);
});

test("restart resolves an undelivered image from its durable outbox ref", async ({
	harness,
	report,
}) => {
	test.setTimeout(120_000);
	const browser = await harness.connect();
	const sessionId = await browser.createSession(
		"Undelivered attachment restart",
	);
	const inputId = randomUUID();
	report["sessionId"] = sessionId;
	report["inputId"] = inputId;
	holdClaims(harness, sessionId);
	try {
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					text: "attachment-restart-byte-proof",
					delivery: "queue",
					images: [dataUrl],
				}),
			),
		).toMatchObject({ ok: true });
		await expect
			.poll(() => storedInput(harness, inputId).outbox.length)
			.toBe(1);
		report["beforeRestart"] = assertStoredRefs(harness, inputId, true);
		expect(providerImages(harness, inputId)).toEqual([]);
		await harness.kill();
	} finally {
		releaseClaims(harness);
	}
	await harness.restart();
	report["providerImages"] = await expectProviderImage(harness, inputId);
	report["afterRestart"] = await expectTerminalScrub(harness, inputId);
});

test("Queue Edit keeps a saved ref in the composer and resends identical bytes", async ({
	harness,
	page,
	report,
}) => {
	test.setTimeout(120_000);
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Edit attachment queue");
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const submitted: Record<string, unknown>[] = [];
	page.on("websocket", (socket) =>
		socket.on("framesent", ({ payload }) => {
			const frame: unknown = JSON.parse(payload.toString());
			if (
				typeof frame === "object" &&
				frame !== null &&
				"tag" in frame &&
				frame.tag === "input.submit" &&
				"payload" in frame &&
				typeof frame.payload === "object" &&
				frame.payload !== null
			)
				submitted.push(frame.payload as Record<string, unknown>);
		}),
	);
	await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
	await app.sendMessage("task-stop-foreground-attachment-edit");
	await expect(chat.stopBtn).toBeVisible();
	const inputId = randomUUID();
	const text = "attachment-edit-byte-proof";
	report["sessionId"] = sessionId;
	report["originalInputId"] = inputId;
	try {
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					text,
					delivery: "queue",
					images: [dataUrl],
				}),
			),
		).toMatchObject({ ok: true });
		await expect(page.getByTestId("pending-input-text")).toHaveText(text);
		report["queued"] = assertStoredRefs(harness, inputId, false);
		await page.getByTestId("pending-input-edit").click();
		await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
		await expect(app.input).toHaveValue(text);
		await expect(
			page.locator(
				"#image-preview .paste-thumb, #image-preview [data-testid='file-attachment-chip']",
			),
		).toHaveCount(1);
		const savedThumbnail = page.locator("#image-preview .paste-thumb img");
		await expect(savedThumbnail).toHaveAttribute(
			"src",
			`/p/process-test/attachments/${hash}`,
		);
		await expect
			.poll(() =>
				savedThumbnail.evaluate(
					(image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
				),
			)
			.toBe(true);
		await page.screenshot({
			path: `test-results/draft-attachments/queue-edit-${sessionId}.png`,
			animations: "disabled",
		});
		report["savedThumbnail"] = await savedThumbnail.getAttribute("src");
		await expect
			.poll(() =>
				withStore(
					harness,
					(db) =>
						db
							.prepare("SELECT text FROM input_drafts WHERE draft_key = ?")
							.get(sessionId)?.["text"],
				),
			)
			.toBe(text);
		await page.reload();
		await expect(app.input).toHaveValue(text);
		await expect(savedThumbnail).toHaveAttribute(
			"src",
			`/p/process-test/attachments/${hash}`,
		);
		await app.sendBtn.click();
		await expect(page.getByTestId("pending-input-text")).toHaveText(text);
		const resentId = await page
			.getByTestId("pending-input-row")
			.getAttribute("data-input-id");
		if (!resentId) throw new Error("Resent queue row has no input id");
		expect(resentId).not.toBe(inputId);
		await expect
			.poll(() => submitted.some((input) => input["inputId"] === resentId))
			.toBe(true);
		const resent = submitted.find((input) => input["inputId"] === resentId);
		expect(resent?.["attachmentIds"]).toEqual([`${inputId}:0`]);
		expect(resent?.["images"] ?? []).toEqual([]);
		expect(JSON.stringify(resent)).not.toContain("data:");
		report["composerResend"] = resent;
		report["resentInputId"] = resentId;
		report["resentQueued"] = assertStoredRefs(harness, resentId, false);
		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		report["providerImages"] = await expectProviderImage(harness, resentId);
		await expect(app.messages).toContainText(responseChunks(text).join(""), {
			timeout: 30_000,
		});
		expect(providerImages(harness, inputId)).toEqual([]);
		report["afterEdit"] = await expectTerminalScrub(harness, resentId);
		expect(storedInput(harness, resentId).blobs).toHaveLength(1);
	} finally {
		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
	}
});

test("Claude stores the attached-file ref and renders its route or image unavailable", async ({
	harness,
	page,
	report,
}) => {
	test.setTimeout(120_000);
	report["bead"] = "mryl.10";
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Transcript attachment route");
	const inputId = randomUUID();
	const attached = () =>
		withStore(harness, (db) =>
			db
				.prepare(
					"SELECT data FROM events WHERE session_id = ? AND type = 'file.attached' ORDER BY sequence",
				)
				.all(sessionId),
		);
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				text: "transcript-attachment-ref-proof",
				delivery: "queue",
				images: [dataUrl],
			}),
		),
	).toMatchObject({ ok: true });
	await expect.poll(() => attached().length, { timeout: 30_000 }).toBe(1);
	const event = JSON.parse(String(attached()[0]?.["data"])) as {
		source?: unknown;
	};
	expect(event.source).toEqual(ref);
	expect(event).not.toHaveProperty("url");
	report["attachedFileEvent"] = event;
	const parts = withStore(harness, (db) =>
		db
			.prepare(
				`SELECT p.metadata, p.rest_payload FROM message_parts p
				 JOIN messages m ON m.id = p.message_id WHERE m.session_id = ?`,
			)
			.all(sessionId),
	);
	expect(JSON.stringify(parts)).toContain(hash);
	expect(JSON.stringify(parts)).not.toContain("data:");
	report["parts"] = parts;
	// Routing requests through Playwright disables the browser HTTP cache so a
	// reload after the deliberate corruption below really asks for the blob.
	await page.route("**/attachments/**", (route) => route.continue());
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
	const image = page.getByTestId("user-message-attachments").locator("img");
	await expect(image).toHaveAttribute(
		"src",
		`/p/process-test/attachments/${hash}`,
	);
	await expect
		.poll(() =>
			image.evaluate(
				(element: HTMLImageElement) =>
					element.complete && element.naturalWidth > 0,
			),
		)
		.toBe(true);
	await page.screenshot({
		path: `test-results/draft-attachments/transcript-${sessionId}.png`,
		animations: "disabled",
	});
	report["imageSource"] = await image.getAttribute("src");
	withStore(harness, (db) => {
		db.exec("PRAGMA foreign_keys = OFF");
		db.prepare("DELETE FROM attachment_blobs WHERE hash = ?").run(hash);
	});
	try {
		await page.reload();
		await expect(
			page
				.getByTestId("user-message-attachments")
				.getByText("image unavailable", {
					exact: true,
				}),
		).toBeVisible();
		await page.screenshot({
			path: `test-results/draft-attachments/unavailable-${sessionId}.png`,
			animations: "disabled",
		});
		report["missingBlobPlaceholder"] = "image unavailable";
	} finally {
		withStore(harness, (db) =>
			db
				.prepare(
					"INSERT OR IGNORE INTO attachment_blobs (hash, mime, size, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(hash, "image/png", imageBytes.length, imageBytes, Date.now()),
		);
	}
});

test("attachment HTTP route enforces auth, hash validation and immutable safe headers", async ({
	harness,
	page,
	report,
}) => {
	test.setTimeout(120_000);
	report["bead"] = "mryl.10";
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Attachment HTTP headers");
	const textBytes = Buffer.from("attachment route text file\n");
	const textHash = createHash("sha256")
		.update("text/plain\0")
		.update(textBytes)
		.digest("hex");
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				text: "attachment-http-proof",
				delivery: "queue",
				images: [
					dataUrl,
					`data:text/plain;base64,${textBytes.toString("base64")}`,
				],
			}),
		),
	).toMatchObject({ ok: true });
	await expect
		.poll(() =>
			withStore(harness, (db) =>
				Number(
					db.prepare("SELECT COUNT(*) AS count FROM attachment_blobs").get()?.[
						"count"
					],
				),
			),
		)
		.toBe(2);
	await harness.requestRpc({ _tag: "SetPin", pin: "4826" });
	const url = `${harness.baseUrl}/p/process-test/attachments/${hash}`;
	const unauthenticated = await fetch(url, { redirect: "manual" });
	expect(unauthenticated.status).toBe(401);
	report["unauthenticatedStatus"] = unauthenticated.status;
	await page.goto(harness.baseUrl);
	const pin = page.getByPlaceholder("PIN (4-8 digits)", { exact: true });
	await expect(pin).toBeVisible();
	await pin.fill("4826");
	await pin.press("Enter");
	await expect(pin).toHaveCount(0);
	const responses: Record<string, unknown>[] = [];
	for (const [attachmentHash, mime, disposition, bytes] of [
		[hash, "image/png", "inline", imageBytes],
		[textHash, "text/plain", "attachment", textBytes],
	] as const) {
		const response = await page.request.get(
			`${harness.baseUrl}/p/process-test/attachments/${attachmentHash}`,
			{ maxRedirects: 0 },
		);
		expect(response.status()).toBe(200);
		const headers = response.headers();
		expect(headers["content-type"]).toBe(mime);
		expect(headers["cache-control"]).toBe(
			"private, max-age=31536000, immutable",
		);
		expect(headers["x-content-type-options"]).toBe("nosniff");
		expect(headers["content-security-policy"]).toBe("sandbox");
		expect(headers["content-disposition"]).toBe(disposition);
		expect(await response.body()).toEqual(bytes);
		responses.push({ attachmentHash, status: response.status(), headers });
	}
	report["responses"] = responses;
	const missing: Record<string, unknown>[] = [];
	for (const candidate of ["a".repeat(64), hash.toUpperCase(), "invalid", ""]) {
		const response = await page.request.get(
			`${harness.baseUrl}/p/process-test/attachments/${candidate}`,
			{ maxRedirects: 0 },
		);
		expect(response.status()).toBe(404);
		missing.push({ candidate, status: response.status() });
	}
	report["missingAndMalformed"] = missing;
});

test("fork images survive parent retention and restart and are swept after the fork is deleted", async ({
	harness,
	page,
	report,
}) => {
	test.setTimeout(180_000);
	report["bead"] = "mryl.10";
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Attachment fork parent");
	const inputId = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				text: "attachment-fork-proof",
				delivery: "queue",
				images: [dataUrl],
			}),
		),
	).toMatchObject({ ok: true });
	await expectTerminalScrub(harness, inputId);
	const fork = await Effect.runPromise(
		browser.rpc.ForkSession({ sessionId, originId: browser.originId }),
	);
	expect(fork.forkedFrom).toBe(sessionId);
	report["parentSessionId"] = sessionId;
	report["forkSessionId"] = fork.sessionId;
	const bound = withStore(harness, (db) =>
		Number(
			db
				.prepare(
					"SELECT MAX(sequence) AS bound FROM events WHERE session_id = ? AND type IN ('session.created', 'session.forked')",
				)
				.get(fork.sessionId)?.["bound"],
		),
	);
	expect(bound).toBeGreaterThan(0);
	// This turn is newer than the fork. Retention must actually remove it,
	// while the inherited event prefix remains held by the live fork.
	const tailInput = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: tailInput,
				text: "attachment-parent-retention-tail",
				delivery: "queue",
			}),
		),
	).toMatchObject({ ok: true });
	await expectTerminalScrub(harness, tailInput);
	const tailEvents = () =>
		withStore(harness, (db) =>
			db
				.prepare(
					"SELECT type FROM events WHERE session_id = ? AND sequence > ? AND type NOT IN ('session.deleted', 'session.provider_cleanup_failed')",
				)
				.all(sessionId, bound),
		);
	expect(tailEvents().length).toBeGreaterThan(0);
	await browser.deleteSession(sessionId);
	await expect.poll(tailEvents, { timeout: 30_000 }).toEqual([]);
	report["parentTailRetainedAfterDrain"] = tailEvents();
	await harness.kill();
	await harness.restart({ keepPort: true });
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${fork.sessionId}?p=process-test`);
	// The inherited prefix renders collapsed under "Prior conversation".
	await page.getByRole("button", { name: "Prior conversation" }).click();
	const image = page.getByTestId("user-message-attachments").locator("img");
	await expect(image).toHaveAttribute(
		"src",
		`/p/process-test/attachments/${hash}`,
	);
	await expect
		.poll(() =>
			image.evaluate(
				(element: HTMLImageElement) =>
					element.complete && element.naturalWidth > 0,
			),
		)
		.toBe(true);
	await page.screenshot({
		path: `test-results/draft-attachments/fork-after-parent-retention-${fork.sessionId}.png`,
		animations: "disabled",
	});
	report["forkImageSourceAfterRestart"] = await image.getAttribute("src");
	const restarted = await harness.connect();
	await restarted.deleteSession(fork.sessionId);
	const remainingHistory = () =>
		withStore(harness, (db) =>
			db
				.prepare(
					"SELECT session_id, type FROM events WHERE session_id IN (?, ?) AND type NOT IN ('session.deleted', 'session.provider_cleanup_failed')",
				)
				.all(sessionId, fork.sessionId),
		);
	await expect.poll(remainingHistory, { timeout: 30_000 }).toEqual([]);
	report["historyAfterBothRetentionDrains"] = remainingHistory();
	expect(
		withStore(harness, (db) =>
			db.prepare("SELECT hash FROM attachment_blobs WHERE hash = ?").all(hash),
		),
	).toHaveLength(1);
	await harness.kill();
	await harness.restart({ keepPort: true });
	const remainingBlobs = withStore(harness, (db) =>
		db.prepare("SELECT hash FROM attachment_blobs WHERE hash = ?").all(hash),
	);
	expect(remainingBlobs).toEqual([]);
	report["blobsAfterFinalRestart"] = remainingBlobs;
});

test.describe("OpenCode attachment ingress", () => {
	test.use({
		harnessOptions: {
			restartProof: true,
			managedOpenCode: true,
			managedOpenCodeId: MANAGED_OPENCODE_ACCOUNT_ID,
		},
	});

	test("echoed images reuse identical content and keep changed bytes as another ref", async ({
		harness,
		report,
	}) => {
		test.setTimeout(120_000);
		report["bead"] = "mryl.10";
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"OpenCode image echo",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		writeFileSync(join(harness.configDir, "fake-opencode-hold-turn"), "hold");
		const inputId = randomUUID();
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					text: "opencode-attachment-echo-proof",
					delivery: "queue",
					images: [dataUrl],
				}),
			),
		).toMatchObject({ ok: true });
		const sentPrompt = () =>
			harness
				.opencodeRequestBodies()
				.find(({ path }) => path === `/session/${sessionId}/prompt_async`);
		await expect.poll(sentPrompt, { timeout: 30_000 }).toBeDefined();
		const prompt = JSON.parse(sentPrompt()?.body ?? "{}") as {
			messageID?: string;
			parts?: { type: string; url?: string }[];
		};
		if (!prompt.messageID) throw new Error("OpenCode send has no messageID");
		expect(prompt.parts?.find((part) => part.type === "file")?.url).toBe(
			dataUrl,
		);
		const messageId = prompt.messageID;
		await harness.emitOpenCodeEvent({
			directory: harness.projectDir,
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: {
					info: {
						id: messageId,
						sessionID: sessionId,
						role: "user",
						time: { created: Date.now() },
					},
				},
			},
		});
		// The stand-in echoes another PNG encoding. Its hash must follow those
		// actual bytes, rather than assuming that a provider preserves the upload.
		const changedBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
			"base64",
		);
		const changedDataUrl = `data:image/png;base64,${changedBytes.toString("base64")}`;
		const changedHash = createHash("sha256")
			.update("image/png\0")
			.update(changedBytes)
			.digest("hex");
		const echoes: Record<string, unknown>[] = [];
		for (const [partId, echoUrl, expectedHash, expectedBlobCount] of [
			["echo-original", dataUrl, hash, 1],
			["echo-reencoded", changedDataUrl, changedHash, 2],
		] as const) {
			await harness.emitOpenCodeEvent({
				directory: harness.projectDir,
				payload: {
					id: randomUUID(),
					type: "message.part.updated",
					properties: {
						part: {
							id: partId,
							messageID: messageId,
							sessionID: sessionId,
							type: "file",
							mime: "image/png",
							url: echoUrl,
							filename: `${partId}.png`,
						},
					},
				},
			});
			const eventRow = () =>
				withStore(harness, (db) =>
					db
						.prepare(
							"SELECT data FROM events WHERE session_id = ? AND type = 'file.attached' AND json_extract(data, '$.partId') = ?",
						)
						.get(sessionId, partId),
				);
			await expect.poll(eventRow, { timeout: 30_000 }).toBeDefined();
			const event = JSON.parse(String(eventRow()?.["data"])) as Record<
				string,
				unknown
			>;
			expect(event["source"]).toMatchObject({
				attachmentHash: expectedHash,
				mime: "image/png",
			});
			expect(event).not.toHaveProperty("url");
			expect(JSON.stringify(event)).not.toContain("data:");
			const blobs = withStore(harness, (db) =>
				db
					.prepare(
						"SELECT hash, mime, size FROM attachment_blobs ORDER BY hash",
					)
					.all(),
			);
			expect(blobs).toHaveLength(expectedBlobCount);
			expect(blobs).toContainEqual({
				hash: expectedHash,
				mime: "image/png",
				size: expectedHash === hash ? imageBytes.length : changedBytes.length,
			});
			echoes.push({ event, blobs });
		}
		report["echoes"] = echoes;
		report["realOpenCodeObservation"] =
			"Stand-in only; real OpenCode mime and bytes were not observed.";
		await harness.setOpenCodeStatus(harness.projectDir, sessionId, {
			type: "idle",
		});
	});

	test("REST snapshots and reconnect backfill replace data file parts in every saved copy", async ({
		harness,
		page,
		report,
	}) => {
		test.setTimeout(120_000);
		report["bead"] = "mryl.10";
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"OpenCode snapshot attachments",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		const created = Date.now();
		const messageId = "snapshot-image-user";
		const history = (name: string) => [
			{
				info: {
					id: messageId,
					sessionID: sessionId,
					role: "user",
					time: { created },
					agent: "build",
					model: { providerID: "fake", modelID: "fake-model" },
				},
				parts: [
					{
						id: "snapshot-image-file",
						messageID: messageId,
						sessionID: sessionId,
						type: "file",
						mime: "image/png",
						filename: name,
						url: dataUrl,
					},
				],
			},
		];
		const snapshots = () =>
			withStore(harness, (db) =>
				db
					.prepare(
						"SELECT data FROM events WHERE session_id = ? AND type = 'message.snapshot' AND json_extract(data, '$.messageId') = ? ORDER BY sequence",
					)
					.all(sessionId, messageId),
			);
		const copies: Record<string, unknown>[] = [];
		for (const [index, name] of ["first.png", "reconciled.png"].entries()) {
			writeFileSync(
				join(harness.configDir, "fake-opencode-history.json"),
				JSON.stringify({ [sessionId]: history(name) }),
			);
			// Reconnect requests complete REST history, including messages that
			// were never announced through SSE and later changed snapshots.
			await harness.closeOpenCodeStreams();
			await expect
				.poll(() => snapshots().length, { timeout: 30_000 })
				.toBe(index + 1);
			const state = withStore(harness, (db) => ({
				snapshots: snapshots(),
				message: db
					.prepare("SELECT rest_payload FROM messages WHERE id = ?")
					.get(messageId),
				parts: db
					.prepare(
						"SELECT type, metadata, rest_payload FROM message_parts WHERE message_id = ?",
					)
					.all(messageId),
				blobs: db
					.prepare("SELECT hash, mime, size FROM attachment_blobs")
					.all(),
			}));
			expect(JSON.stringify(state)).not.toContain("data:");
			const event = JSON.parse(String(state.snapshots.at(-1)?.["data"])) as {
				message: { parts: { source?: unknown; url?: unknown }[] };
			};
			expect(event.message.parts[0]?.source).toMatchObject(ref);
			expect(event.message.parts[0]).not.toHaveProperty("url");
			const saved = JSON.parse(String(state.message?.["rest_payload"])) as {
				parts: { source?: unknown; filename?: string }[];
			};
			expect(saved.parts[0]?.source).toMatchObject(ref);
			expect(saved.parts[0]?.filename).toBe(name);
			expect(state.parts).toHaveLength(1);
			const part = JSON.parse(String(state.parts[0]?.["rest_payload"])) as {
				source?: unknown;
			};
			expect(part.source).toMatchObject(ref);
			expect(state.blobs).toEqual([
				{ hash, mime: "image/png", size: imageBytes.length },
			]);
			copies.push(state);
		}
		report["savedCopies"] = copies;
		const app = new AppPage(page);
		await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
		const image = page.getByTestId("user-message-attachments").locator("img");
		await expect(image).toHaveAttribute(
			"src",
			`/p/process-test/attachments/${hash}`,
		);
		await expect
			.poll(() =>
				image.evaluate(
					(element: HTMLImageElement) =>
						element.complete && element.naturalWidth > 0,
				),
			)
			.toBe(true);
		await page.screenshot({
			path: `test-results/draft-attachments/opencode-snapshot-${sessionId}.png`,
			animations: "disabled",
		});
		expect(
			JSON.stringify(browser.frames, (_key, value: unknown) =>
				typeof value === "bigint" ? value.toString() : value,
			),
		).not.toContain("data:image/");
		report["browserSnapshotsContainInlineImages"] = false;
	});
});

test("provider preparation refusal preserves a Draft and admits nothing until retry", async ({
	harness,
	report,
}) => {
	report["bead"] = "conduit-test-mryl.4";
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Draft preparation refusal");
	const inputId = randomUUID();
	const id = randomUUID();
	const key = { session: sessionId };
	const text = "Keep my Draft after a preparation failure";
	await Effect.runPromise(
		browser.rpc.AddDraftAttachment({
			key,
			id,
			name: "draft.png",
			mime: "image/png",
			dataUrl,
		}),
	);
	await Effect.runPromise(browser.rpc.SyncInputDraft({ key, text }));
	const draft = () =>
		withStore(harness, (db) => ({
			text: db
				.prepare("SELECT text FROM input_drafts WHERE draft_key = ?")
				.get(sessionId),
			attachments: db
				.prepare(
					"SELECT id, state, hash FROM draft_attachments WHERE draft_key = ? ORDER BY id",
				)
				.all(sessionId),
		}));
	const before = draft();
	const pick = withStore(harness, (db) => {
		const row = db
			.prepare("SELECT model_provider, model_id FROM sessions WHERE id = ?")
			.get(sessionId);
		db.prepare(
			"UPDATE sessions SET model_provider = NULL, model_id = NULL WHERE id = ?",
		).run(sessionId);
		return row;
	});
	const input = {
		sessionId,
		inputId,
		text,
		delivery: "queue" as const,
		draftKey: key,
		attachmentIds: [id],
	};
	const result = await Effect.runPromise(
		browser.rpc["input.submit"](input).pipe(Effect.result),
	);
	expect(result).toMatchObject({ _tag: "Failure" });
	expect(JSON.stringify(result)).toContain("model pick is required");
	expect(draft()).toEqual(before);
	const refused = storedInput(harness, inputId);
	expect(refused.admitted).toEqual([]);
	expect(refused.pending).toBeUndefined();
	expect(refused.outbox).toEqual([]);
	expect(
		withStore(harness, (db) =>
			db
				.prepare(
					"SELECT id FROM messages WHERE session_id = ? AND input_id = ?",
				)
				.all(sessionId, inputId),
		),
	).toEqual([]);
	expect(providerImages(harness, inputId)).toEqual([]);
	report["refusal"] = result;
	report["unchangedDraft"] = before;
	report["refusedInput"] = refused;
	withStore(harness, (db) =>
		db
			.prepare(
				"UPDATE sessions SET model_provider = ?, model_id = ? WHERE id = ?",
			)
			.run(
				pick?.["model_provider"] ?? null,
				pick?.["model_id"] ?? null,
				sessionId,
			),
	);
	expect(
		await Effect.runPromise(browser.rpc["input.submit"](input)),
	).toMatchObject({ ok: true });
	await expect
		.poll(() => storedInput(harness, inputId).admitted.length)
		.toBe(1);
	expect(draft()).toMatchObject({
		text: { text: "" },
		attachments: [{ id, state: "sent", hash: null }],
	});
	report["acceptedRetry"] = storedInput(harness, inputId);
	const violations = await Effect.runPromise(
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
	expect(violations).toEqual([]);
	report["catalogueViolations"] = violations;
});

test("a missing blob fails dispatch visibly with AttachmentMissing", async ({
	harness,
	page,
	report,
}) => {
	test.setTimeout(120_000);
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Missing attachment dispatch");
	const inputId = randomUUID();
	const app = new AppPage(page);
	await app.goto(`${harness.baseUrl}/s/${sessionId}?p=process-test`);
	report["sessionId"] = sessionId;
	report["inputId"] = inputId;
	holdClaims(harness, sessionId);
	try {
		expect(
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					text: "attachment-missing-proof",
					delivery: "queue",
					images: [dataUrl],
				}),
			),
		).toMatchObject({ ok: true });
		await expect
			.poll(() => storedInput(harness, inputId).outbox.length)
			.toBe(1);
		report["beforeCorruption"] = assertStoredRefs(harness, inputId, true);
		// Simulate disk corruption after admission. Production never deletes a
		// blob while serving. Disable this connection's FK checks deliberately.
		withStore(harness, (db) => {
			db.exec("PRAGMA foreign_keys = OFF");
			db.prepare("DELETE FROM attachment_blobs WHERE hash = ?").run(hash);
		});
		releaseClaims(harness);
		await expect(page.getByText(/AttachmentMissing/).first()).toBeVisible({
			timeout: 30_000,
		});
		await expect
			.poll(
				() => storedInput(harness, inputId).outbox.map((row) => row["status"]),
				{ timeout: 30_000 },
			)
			.toEqual(["failed"]);
		report["visibleError"] = await page
			.getByText(/AttachmentMissing/)
			.first()
			.textContent();
		expect(providerImages(harness, inputId)).toEqual([]);
		const failed = storedInput(harness, inputId);
		expect(
			JSON.parse(String(failed.outbox[0]?.["payload_json"])),
		).not.toHaveProperty("images");
		expect(
			failed.uses.filter(
				(row) => row["source_table"] === "provider_command_outbox",
			),
		).toEqual([]);
		report["afterFailure"] = failed;
	} finally {
		releaseClaims(harness);
		withStore(harness, (db) =>
			db
				.prepare(
					"INSERT OR IGNORE INTO attachment_blobs (hash, mime, size, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(hash, "image/png", imageBytes.length, imageBytes, Date.now()),
		);
	}
});
