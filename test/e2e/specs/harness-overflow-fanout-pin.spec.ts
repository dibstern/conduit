// Behaviour pin conduit-test-16c8.2: two devices watch one session while its
// advance bus runs at capacity 1, the smallest PubSub. Ways this can fail,
// each checked below:
// - the burst never overflows the devices' advance buffers, so nothing is
//   pinned (overflow read count, and the burst landing inside the hold);
// - a freed view waits for a later publication that never comes, so a device
//   never renders the final text or every completed tool call (convergence
//   waits, bounded only to turn a hang into a failure);
// - overflow catch-up replaces a view instead of patching it (replacement
//   reads, snapshot envelopes, or a re-subscription after the hold);
// - fan-out drops a row update for one device that the other received (each
//   device's received row sequences against the other's latest per row);
// - catch-up leaves the two views different (rendered tool markers and text);
// - a checksum repair or page error papers over a broken catch-up.
//
// CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//   --config test/e2e/playwright-harness.config.ts --project=desktop --workers=1 \
//   harness-overflow-fanout-pin.spec.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { Schema } from "effect";
import {
	PartRemovalId,
	type SessionDetailEnvelope,
} from "../../../src/lib/contracts/ws-rpc.js";
import { observeDetail } from "../helpers/detail-wire.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

const advanceBusCapacity = 1;
const burstToolCalls = 16;
const burstPrompt = `load-tools-${burstToolCalls}`;
const warmupPrompt = "overflow-fanout-warmup";
const heldMs = 20_000;
const finalText = `done(${burstPrompt}).`;

/** The detail row an upsert or remove moves, keyed the same for both. */
const rowKey = (envelope: SessionDetailEnvelope): string | undefined => {
	if (envelope._tag === "upsert") {
		const { item } = envelope;
		if (item._tag === "message") return `message:${item.message.id}`;
		if (item._tag === "part") return `part:${item.messageId}/${item.part.id}`;
		if (item._tag === "pendingInput") return `input:${item.input.inputId}`;
		return item._tag;
	}
	if (envelope._tag === "remove") {
		const part = Schema.decodeUnknownOption(PartRemovalId)(envelope.id);
		if (part._tag === "Some") return `part:${part.value[0]}/${part.value[1]}`;
		return envelope.id.startsWith("input:")
			? envelope.id
			: `message:${envelope.id}`;
	}
	return undefined;
};

test.describe.configure({ retries: 0 });
// The test starts its own server with the capacity override.
test.use({ startHarness: false });

test("two devices catch up one overflowed session without a later publication", async ({
	browser,
	harness,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"Both devices are browser contexts of their own; the wire is the same on mobile.",
	);
	test.setTimeout(150_000);
	const metricsFile = join(harness.root, "overflow-fanout-metrics.json");
	await harness.restart({
		// Other harness suites may share the machine; startup alone is not pinned.
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
		metricsFile,
		skipBrowserProbe: true,
		serviceEnvironment: {
			CONDUIT_TEST_ADVANCE_BUS_CAPACITY: String(advanceBusCapacity),
		},
	});
	const driver = await harness.connect(undefined, undefined, undefined, false);
	await expect.poll(() => harness.generations.at(-1)?.fakeSdkActive).toBe(true);
	const session = await driver.createSession("Overflow fan-out");
	// Start the runner before the burst, so the held window covers the turn.
	const warmup = await driver.send(session, warmupPrompt, 120_000);
	expect(warmup.chunks.join("")).toContain(`done(${warmupPrompt}).`);

	const contexts: BrowserContext[] = [];
	const open = async (device: number) => {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			isMobile: false,
		});
		contexts.push(context);
		const page = await context.newPage();
		const wire = observeDetail(page, metricsFile, session);
		await page.goto(`${harness.baseUrl}/s/${session}?p=process-test`);
		const messages = page.locator("#messages");
		await expect(messages).toContainText(`done(${warmupPrompt}).`);
		await expect
			.poll(() =>
				wire.envelopes(session).some((e) => e._tag === "synchronized"),
			)
			.toBe(true);
		return { device, page, messages, wire };
	};
	try {
		const devices = await Promise.all([open(0), open(1)]);
		const before = await devices[0].wire.detailReads();

		// The server sends a detail delivery only after the page acknowledged the
		// last. Holding each page's main thread stalls both views' streams, so the
		// turn's advances overflow each view's two-slot buffer. The turn ends, and
		// nothing publishes again, while both pages are still held.
		const held = await Promise.all(
			devices.map(async (device) => ({
				...device,
				from: {
					sent: device.wire.sent.length,
					received: device.wire.received.length,
					mismatches: device.wire.mismatches.length,
				},
				// Fault injection: holding the browser thread must stall RPC acknowledgements until the bus overflows.
				until: await device.page.evaluate((ms) => {
					const until = Date.now() + ms;
					setTimeout(() => {
						while (Date.now() < until) {}
					}, 0);
					return until;
				}, heldMs),
			})),
		);
		const heldUntil = Math.min(...held.map(({ until }) => until));
		const burstStart = Date.now();
		await driver.send(session, burstPrompt, heldMs);
		const burstEnd = Date.now();
		expect(
			burstEnd,
			"The burst must end while both pages still hold their acknowledgements",
		).toBeLessThan(heldUntil);

		const converged = await Promise.all(
			held.map(async (device) => {
				// The turn's reply text precedes its calls, so it folds into the
				// collapsed step log; the summary counts every completed call.
				const toggle = device.page.locator(".turn-activity-toggle").last();
				await expect(toggle).toContainText(
					new RegExp(`Worked.*${burstToolCalls} commands`),
					{ timeout: 30_000 },
				);
				const convergedAfterReleaseMs = Date.now() - device.until;
				if ((await toggle.getAttribute("aria-expanded")) !== "true")
					await toggle.click();
				await expect(device.messages).toContainText(finalText);
				const tools = device.page
					.locator(".turn-activity")
					.last()
					.locator('.tool-item[data-tool-status="completed"]');
				await expect(tools).toHaveCount(burstToolCalls);
				const toolMarkers = (await tools.allTextContents())
					.map((text) => /load-tool-\d+-\d+/.exec(text)?.[0])
					.filter((marker) => marker !== undefined)
					.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
				return { ...device, convergedAfterReleaseMs, toolMarkers };
			}),
		);
		// Completed tools prove catch-up ran; the next metrics flush covers its reads.
		const after = await devices[0].wire.detailReads();
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

		const received = converged.map((device) => {
			const { wire, from } = device;
			// The original subscription's request id, still live through the burst.
			const delivered = wire.envelopes(session, 0, from.received);
			const rows = delivered.flatMap((envelope) => {
				const key = rowKey(envelope);
				return key !== undefined &&
					(envelope._tag === "upsert" || envelope._tag === "remove")
					? [{ key, sequence: envelope.sequence, kind: envelope._tag }]
					: [];
			});
			const latest = new Map<string, number>();
			for (const { key, sequence } of rows)
				latest.set(key, Math.max(sequence, latest.get(key) ?? -Infinity));
			return {
				...device,
				delivered,
				rows,
				latest,
				resubscriptions: wire.requests(session, from.sent).length,
				mismatches: wire.mismatches.slice(from.mismatches),
			};
		});
		// A device missed an update when another received a row sequence newer
		// than any it received for that row.
		const results = received.map((device) => ({
			...device,
			missedFromOther: received
				.filter((other) => other !== device)
				.flatMap((other) =>
					other.rows.filter(
						({ key, sequence }) =>
							(device.latest.get(key) ?? -Infinity) < sequence,
					),
				),
		}));
		const report = {
			parameters: {
				devices: devices.length,
				advanceBusCapacity,
				burstPrompt,
				burstToolCalls,
				heldMs,
			},
			burst: {
				ms: burstEnd - burstStart,
				endedBeforeReleaseMs: heldUntil - burstEnd,
			},
			detailReadCounts,
			devices: results.map((device) => ({
				device: device.device,
				convergedAfterReleaseMs: device.convergedAfterReleaseMs,
				receivedSequences: [
					...new Set(device.rows.map(({ sequence }) => sequence)),
				].sort((a, b) => a - b),
				maxSequence: Math.max(...device.latest.values()),
				rowsMoved: device.latest.size,
				envelopeKinds: Object.fromEntries(
					["snapshot", "upsert", "remove", "synchronized"].map((kind) => [
						kind,
						device.delivered.filter((e) => e._tag === kind).length,
					]),
				),
				// Observable replacement on this device: a snapshot or a new subscription.
				replacements: {
					snapshots: device.delivered.filter((e) => e._tag === "snapshot")
						.length,
					resubscriptions: device.resubscriptions,
				},
				missedFromOther: device.missedFromOther,
				toolMarkers: device.toolMarkers,
			})),
		};
		mkdirSync("test-results", { recursive: true });
		const output = join("test-results", "16c8-2-overflow-fanout.json");
		writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
		await testInfo.attach("16c8-2-overflow-fanout", {
			path: output,
			contentType: "application/json",
		});

		expect(
			detailReadCounts["overflow"],
			"Detail overflow catch-up must run",
		).toBeGreaterThan(0);
		expect(
			detailReadCounts["replacement"],
			"Detail must not replace either view",
		).toBe(0);
		expect(detailReadCounts["base"]).toBe(0);
		expect(detailReadCounts["resume"]).toBe(0);
		const expectedMarkers = Array.from(
			{ length: burstToolCalls },
			(_, index) => `load-tool-${burstToolCalls}-${index + 1}`,
		);
		for (const device of results) {
			const label = `device ${device.device}`;
			expect(device.resubscriptions, `${label} re-subscribed`).toBe(0);
			expect(
				device.delivered.filter((e) => e._tag === "snapshot"),
				`${label} received a replacement snapshot`,
			).toEqual([]);
			expect(
				device.missedFromOther,
				`${label} missed updates the other received`,
			).toEqual([]);
			expect(device.toolMarkers, label).toEqual(expectedMarkers);
			expect(device.mismatches, label).toEqual([]);
			expect(device.wire.pageErrors, label).toEqual([]);
		}
		const [first, ...others] = results.map(({ latest }) =>
			Object.fromEntries(latest),
		);
		for (const other of others) expect(other).toEqual(first);
	} finally {
		await Promise.allSettled(contexts.map((context) => context.close()));
	}
});
