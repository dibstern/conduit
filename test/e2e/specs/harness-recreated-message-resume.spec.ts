// Ways this can fail, each checked below:
// - re-creating M erases its removal, so the cached transcript keeps part B;
// - the checksum repairs that stale view with a base or replacement read;
// - returning opens a cold subscription instead of resuming the cached page;
// - catch-up omits remove M, or delivers it after the newer upsert M;
// - missing diagnostics make a fallback look like a read-free catch-up.
// - the live burst never overflows the detail subscriber's advance buffer;
// - overflow replaces the detail view instead of applying its durable removals;
// - part B survives overflow catch-up or reappears after the view converges;
// - overflow catch-up waits for a later publication instead of the freed view.
//
// CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//   --config test/e2e/playwright-harness.config.ts --project=desktop --workers=1 \
//   harness-recreated-message-resume.spec.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type {
	CanonicalEvent,
	EventPayloadMap,
	LiveEventType,
} from "../../../src/lib/contracts/stored-event.js";
import {
	PartRemovalId,
	type SessionDetailEnvelopeSchema,
	type SessionDetailItemSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { find, observeDetail } from "../helpers/detail-wire.js";
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
	<T extends LiveEventType>(type: T, data: EventPayloadMap[T]) =>
		canonicalEvent(type, sessionId, data, { provider: "claude", createdAt });

const seed = (filename: string, events: readonly CanonicalEvent[]) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* commit([...events], { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);

const rowIds = (item: typeof SessionDetailItemSchema.Type) => {
	if (item._tag === "message")
		return { kind: item._tag, messageId: item.message.id };
	if (item._tag === "part")
		return { kind: item._tag, messageId: item.messageId, partId: item.part.id };
	return { kind: item._tag };
};
const envelopeIds = (envelope: typeof SessionDetailEnvelopeSchema.Type) => {
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
	const store = harness.daemonStorePath();
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

	const {
		sent,
		received,
		mismatches,
		pageErrors,
		requests,
		envelopes,
		detailReads,
	} = observeDetail(page, metricsFile, SESSION);
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
		envelopes: delivered.map(envelopeIds),
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

test("an open recreated message catches up through overflow without replacing its view", async ({
	harness,
	page,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"The cache and wire are the same on every device; desktop shows both sessions.",
	);
	test.setTimeout(120_000);
	const store = harness.daemonStorePath();
	const metricsFile = join(
		harness.root,
		"recreated-message-overflow-metrics.json",
	);
	const initial = event(SESSION);
	const advanceBusCapacity = 1;
	const unrelatedAdvances = 64;
	const heldMs = 8000;
	const heldDeliveries = 4;
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
	]);
	await harness.restart({
		keepPort: true,
		metricsFile,
		skipBrowserProbe: true,
		serviceEnvironment: {
			CONDUIT_TEST_ADVANCE_BUS_CAPACITY: String(advanceBusCapacity),
		},
	});
	const driver = await harness.connect(undefined, undefined, undefined, false);
	const {
		sent,
		received,
		mismatches,
		pageErrors,
		requests,
		envelopes,
		detailReads,
	} = observeDetail(page, metricsFile, SESSION);
	const messages = page.locator("#messages");
	await page.goto(`${harness.baseUrl}/s/${SESSION}?p=process-test`);
	await expect(messages.getByText(TEXT_A, { exact: true })).toBeVisible();
	await expect(messages.getByText(TEXT_B, { exact: true })).toBeVisible();
	await expect
		.poll(() => envelopes(SESSION).some((e) => e._tag === "synchronized"))
		.toBe(true);
	const before = await detailReads();
	expect(
		before.base ?? 0,
		"Diagnostics must include the initial detail base",
	).toBeGreaterThan(0);
	const sentFrom = sent.length;
	const receivedFrom = received.length;
	const mismatchesBefore = mismatches.length;
	const rename = (sessionId: string, title: string) =>
		Effect.runPromise(
			driver.rpc
				.RenameSession({
					sessionId,
					title,
					originId: driver.originId,
				})
				.pipe(Effect.timeout("15 seconds")),
		);
	const visibility = await page.evaluateHandle(
		({ textA, textB }) => {
			const messages = document.querySelector("#messages");
			if (!messages) throw new Error("Missing open session transcript");
			const state = { converged: false, reappeared: false };
			const observer = new MutationObserver(() => {
				const texts = Array.from(messages.querySelectorAll(".md-content p"))
					.filter((part) => part.getClientRects().length > 0)
					.map((part) => part.textContent?.trim());
				if (state.converged && texts.includes(textB)) state.reappeared = true;
				if (texts.length === 1 && texts[0] === textA) state.converged = true;
			});
			observer.observe(messages, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
			});
			return { state, observer };
		},
		{ textA: TEXT_A, textB: TEXT_B },
	);

	// The server sends a delivery only after the page acknowledged the last,
	// queueing at most two more, while unrelated advances deliver nothing and so
	// never back up. Hold the page's main thread and rename this session until a
	// delivery blocks the open view's stream: the burst then overflows its bus.
	// A task queued now runs before any delivery the renames below send.
	const heldUntil = await page.evaluate((ms) => {
		const until = Date.now() + ms;
		setTimeout(() => {
			while (Date.now() < until) {}
		}, 0);
		return until;
	}, heldMs);
	for (let index = 0; index < heldDeliveries; index++)
		await rename(SESSION, `Held delivery ${index}`);
	// Hide the removal signals, as a dropped bus publication would. Only an
	// overflow can route the unrelated advances below to this open detail view.
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
	await Promise.all(
		Array.from({ length: unrelatedAdvances }, (_, index) =>
			rename(OTHER, `Overflow advance ${index}`),
		),
	);
	expect(
		Date.now(),
		"The burst must land while the page still holds its acknowledgement",
	).toBeLessThan(heldUntil);
	// The burst left its newest advances, the gap among them, on the bus. The
	// freed view must catch up from them with no later publication.
	await page.evaluate(() => undefined);
	await expect
		.soft(messages.locator(".md-content p:visible"))
		.toHaveText([TEXT_A]);
	// Keep observing after convergence, including a delayed checksum repair.
	await page.waitForTimeout(1500);
	const after = await detailReads();
	const observed = await visibility.evaluate(({ state, observer }) => {
		observer.disconnect();
		return state;
	});
	await visibility.dispose();
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
	// This is the original subscription's request id, still live during the burst.
	const delivered = envelopes(SESSION, 0, receivedFrom);
	const visiblePartTexts = (
		await messages.locator(".md-content p:visible").allTextContents()
	).map((text) => text.trim());
	mkdirSync("test-results", { recursive: true });
	const output = join("test-results", "recreated-message-overflow.json");
	writeFileSync(
		output,
		`${JSON.stringify(
			{
				parameters: {
					advanceBusCapacity,
					unrelatedAdvances,
					heldMs,
					heldDeliveries,
				},
				detailReadCounts,
				envelopes: delivered.map(envelopeIds),
				visiblePartTexts,
			},
			null,
			2,
		)}\n`,
	);
	await testInfo.attach("recreated-message-overflow", {
		path: output,
		contentType: "application/json",
	});

	expect(
		detailReadCounts["overflow"],
		"Detail overflow catch-up must run",
	).toBeGreaterThan(0);
	expect(
		detailReadCounts["replacement"],
		"Detail must not replace its view",
	).toBe(0);
	expect(detailReadCounts["base"]).toBe(0);
	expect(detailReadCounts["resume"]).toBe(0);
	expect(requests(SESSION, sentFrom)).toEqual([]);
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
	expect(observed).toEqual({ converged: true, reappeared: false });
	expect(visiblePartTexts).toEqual([TEXT_A]);
	expect(mismatches.slice(mismatchesBefore)).toEqual([]);
	expect(pageErrors).toEqual([]);
});
