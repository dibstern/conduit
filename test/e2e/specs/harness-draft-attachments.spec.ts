// conduit-test-mryl.2: images become refs before admission and are resolved only
// for provider delivery. Deliberately blocked outbox claims expose the durable
// checkpoint without a timing race or a second application send path.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { indexedAttachmentColumns } from "../../helpers/attachment-catalogue.js";
import { responseChunks } from "../../helpers/fake-claude-process-sdk.js";
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
				report["catalogue"] = check;
				report["logTail"] = harness.logTail.slice(-3000);
				report["passed"] =
					testInfo.status === "passed" && check?.unknownCarriers.length === 0;
				writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
				await testInfo.attach("draft-attachments", {
					path,
					contentType: "application/json",
				});
				expect(check?.unknownCarriers).toEqual([]);
			}
		},
		{ auto: true },
	],
});

test.use({ harnessOptions: { restartProof: true } });
test.describe.configure({ retries: 0 });

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
		expect(resent?.["images"]).toEqual([ref]);
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
