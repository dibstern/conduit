// Ways this can fail, each checked below:
// - re-creating M erases its removal, so the cached transcript keeps part B;
// - the checksum repairs that stale view with a base or replacement read;
// - returning opens a cold subscription instead of resuming the cached page;
// - catch-up omits remove M, or delivers it after the newer upsert M;
// - missing diagnostics make a fallback look like a read-free catch-up.
//
// CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//   --config test/e2e/playwright-harness.config.ts --project=desktop --workers=1 \
//   harness-recreated-message-resume.spec.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
} from "../../../src/lib/contracts/stored-event.js";
import {
	PartRemovalId,
	SessionDetailEnvelopeSchema,
	type SessionDetailItemSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { ReadModelRead } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

const SESSION = "recreated-message";
const OTHER = "recreated-other";
const MESSAGE = "recreated-M";
const PART_A = "recreated-A";
const PART_B = "recreated-B";
const TEXT_A = "Part A survives.";
const TEXT_B = "Part B disappears.";
const OTHER_TEXT = "The other session is open.";
const START = Date.UTC(2026, 9, 1);

const event =
	(sessionId: string, createdAt = START) =>
	<T extends CanonicalEventType>(type: T, data: EventPayloadMap[T]) =>
		canonicalEvent(type, sessionId, data, { provider: "claude", createdAt });

const seed = (filename: string, events: readonly CanonicalEvent[]) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* commit([...events], { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
		),
	);

/** Match nested RPC requests and chunks without depending on frame batching. */
const find = (value: unknown, match: (value: object) => boolean): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};
const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};
const rowIds = (item: typeof SessionDetailItemSchema.Type) => {
	if (item._tag === "message")
		return { kind: item._tag, messageId: item.message.id };
	if (item._tag === "part")
		return { kind: item._tag, messageId: item.messageId, partId: item.part.id };
	return { kind: item._tag };
};

test.describe.configure({ retries: 0 });

test("a recreated message resumes without its old parts or a checksum repair", async ({
	harness,
	page,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"The cache and wire are the same on every device; desktop shows both sessions.",
	);
	test.setTimeout(120_000);
	const store = harness.projectStorePath();
	const metricsFile = join(harness.root, "recreated-message-metrics.json");
	const initial = event(SESSION);
	const other = event(OTHER);
	await harness.terminate();
	await seed(store, [
		...[SESSION, OTHER].map((sessionId) =>
			event(sessionId)("session.created", {
				sessionId,
				title: sessionId,
				provider: "claude",
				providerSessionId: sessionId,
			}),
		),
		initial("message.created", {
			sessionId: SESSION,
			messageId: MESSAGE,
			role: "assistant",
		}),
		initial("text.delta", {
			messageId: MESSAGE,
			partId: PART_A,
			text: `${TEXT_A}\n\n`,
		}),
		initial("text.delta", {
			messageId: MESSAGE,
			partId: PART_B,
			text: `${TEXT_B}\n\n`,
		}),
		initial("turn.completed", { messageId: MESSAGE }),
		other("message.created", {
			sessionId: OTHER,
			messageId: "other-M",
			role: "assistant",
		}),
		other("text.delta", {
			messageId: "other-M",
			partId: "other-A",
			text: OTHER_TEXT,
		}),
		other("turn.completed", { messageId: "other-M" }),
	]);
	await harness.restart({
		keepPort: true,
		metricsFile,
		skipBrowserProbe: true,
	});

	const sent: unknown[] = [];
	const received: unknown[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => sent.push(parse(String(payload))));
		socket.on("framereceived", ({ payload }) =>
			received.push(parse(String(payload))),
		);
	});
	const mismatches: string[] = [];
	page.on("console", (message) => {
		if (message.text().includes("[resume] checksum mismatch"))
			mismatches.push(message.text());
	});
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	const requests = (sessionId: string, from = 0) =>
		sent
			.slice(from)
			.flatMap((value) =>
				find(
					value,
					(found) =>
						"_tag" in found &&
						found._tag === "Request" &&
						"tag" in found &&
						found.tag === "SubscribeSessionDetail" &&
						"payload" in found &&
						typeof found.payload === "object" &&
						found.payload !== null &&
						"sessionId" in found.payload &&
						found.payload.sessionId === sessionId,
				),
			);
	const envelopes = (sessionId: string, sentFrom = 0, receivedFrom = 0) => {
		const ids = new Set(
			requests(sessionId, sentFrom).map((request) =>
				"id" in request ? String(request.id) : "",
			),
		);
		return received
			.slice(receivedFrom)
			.flatMap((value) =>
				find(
					value,
					(found) =>
						"_tag" in found &&
						found._tag === "Chunk" &&
						"requestId" in found &&
						ids.has(String(found.requestId)),
				),
			)
			.flatMap((chunk) => {
				const values: readonly unknown[] =
					"values" in chunk && Array.isArray(chunk.values) ? chunk.values : [];
				return values.filter(Schema.is(SessionDetailEnvelopeSchema));
			});
	};
	// The process harness subscribes to conduit:read-model-read and flushes
	// source counts atomically every 250ms. Wait for a flush beyond each phase.
	const detailReads = async () => {
		const asked = Date.now();
		await expect.poll(() => existsSync(metricsFile)).toBe(true);
		const metrics = () =>
			JSON.parse(readFileSync(metricsFile, "utf8")) as {
				flushedAt: number;
				sources: Record<
					string,
					{ reads: Partial<Record<ReadModelRead["kind"], number>> }
				>;
			};
		await expect.poll(() => metrics().flushedAt).toBeGreaterThan(asked);
		return metrics().sources[`session-detail/${SESSION}`]?.reads ?? {};
	};
	const messages = page.locator("#messages");
	const open = async (sessionId: string, shown: string) => {
		await page
			.locator(
				`#session-list .session-item[data-session-id="${sessionId}"] .session-item-title`,
			)
			.click();
		await expect(page).toHaveURL(new RegExp(`/s/${sessionId}(\\?|$)`));
		await expect(messages).toContainText(shown);
	};

	await page.goto(`${harness.baseUrl}/s/${SESSION}?p=process-test`);
	await expect(messages.getByText(TEXT_A, { exact: true })).toBeVisible();
	await expect(messages.getByText(TEXT_B, { exact: true })).toBeVisible();
	await expect
		.poll(() => envelopes(SESSION).some((e) => e._tag === "synchronized"))
		.toBe(true);
	await open(OTHER, OTHER_TEXT);
	await expect
		.poll(() => envelopes(OTHER).some((e) => e._tag === "synchronized"))
		.toBe(true);

	// Publish nothing to the daemon's bus while the page is away. Separate
	// commits give the removal and the re-created rows distinct versions.
	await seed(store, [
		event(SESSION, START + 1000)("message.removed", { messageId: MESSAGE }),
	]);
	const recreated = event(SESSION, START + 2000);
	await seed(store, [
		recreated("message.created", {
			sessionId: SESSION,
			messageId: MESSAGE,
			role: "assistant",
		}),
		recreated("text.delta", {
			messageId: MESSAGE,
			partId: PART_A,
			text: `${TEXT_A}\n\n`,
		}),
		recreated("turn.completed", { messageId: MESSAGE }),
	]);
	const before = await detailReads();
	expect(
		before.base ?? 0,
		"Diagnostics must include the initial detail base",
	).toBeGreaterThan(0);
	const sentFrom = sent.length;
	const receivedFrom = received.length;
	const mismatchesBefore = mismatches.length;
	await open(SESSION, TEXT_A);
	await expect
		.poll(() =>
			envelopes(SESSION, sentFrom, receivedFrom).some(
				(e) => e._tag === "synchronized" && e.checksum !== undefined,
			),
		)
		.toBe(true);
	// Let a checksum-triggered re-subscription and its read finish too.
	await page.waitForTimeout(1500);
	const after = await detailReads();
	const kinds = [
		"base",
		"resume",
		"replacement",
		"window",
		"overflow",
	] as const;
	const detailReadCounts = Object.fromEntries(
		kinds.map((kind) => [kind, (after[kind] ?? 0) - (before[kind] ?? 0)]),
	);
	const delivered = envelopes(SESSION, sentFrom, receivedFrom);
	const visiblePartTexts = (
		await messages.locator(".md-content p:visible").allTextContents()
	).map((text) => text.trim());
	const report = {
		envelopes: delivered.map((envelope) => {
			if (envelope._tag === "upsert")
				return { kind: envelope._tag, row: rowIds(envelope.item) };
			if (envelope._tag === "snapshot")
				return { kind: envelope._tag, rows: envelope.rows.map(rowIds) };
			if (envelope._tag === "remove") {
				const part = Schema.decodeUnknownOption(PartRemovalId)(envelope.id);
				return {
					kind: envelope._tag,
					...(part._tag === "Some"
						? { messageId: part.value[0], partId: part.value[1] }
						: { messageId: envelope.id }),
				};
			}
			return { kind: envelope._tag };
		}),
		detailReadCounts,
		visiblePartTexts,
	};
	mkdirSync("test-results", { recursive: true });
	const output = join("test-results", "recreated-message-resume.json");
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("recreated-message-resume", { path: output });

	const returnedRequests = requests(SESSION, sentFrom);
	expect(returnedRequests).toHaveLength(1);
	expect(
		find(returnedRequests[0], (found) => "resumeBase" in found),
	).not.toHaveLength(0);
	expect(delivered.some((e) => e._tag === "snapshot")).toBe(false);
	const removedAt = delivered.findIndex(
		(e) => e._tag === "remove" && e.id === MESSAGE,
	);
	const upsertedAt = delivered.findIndex(
		(e) =>
			e._tag === "upsert" &&
			e.item._tag === "message" &&
			e.item.message.id === MESSAGE,
	);
	expect(removedAt).toBeGreaterThanOrEqual(0);
	expect(upsertedAt).toBeGreaterThan(removedAt);
	expect(detailReadCounts).toEqual({
		base: 0,
		resume: 1,
		replacement: 0,
		window: 0,
		overflow: 0,
	});
	expect(mismatches.slice(mismatchesBefore)).toEqual([]);
	await expect(messages.getByText(TEXT_A, { exact: true })).toBeVisible();
	await expect(messages).not.toContainText(TEXT_B);
	expect(visiblePartTexts).toEqual([TEXT_A]);
	expect(pageErrors).toEqual([]);
});
