// A saved session page opens exactly like a cold one (conduit-test-y7eo.14),
// through the built server and a real browser. Each scenario opens one session
// in a browser that may hold a saved page for it, then in a fresh browser, and
// compares the two transcripts. The JSON artifact holds both for every
// scenario, with what the wire and the saved records showed.
//
// Ways it can fail, each checked below:
// - the saved page is drawn only after the server answers, so it saves nothing;
// - a saved page is shown but never resumed from, so every open costs a full
//   snapshot, or it is resumed from without the checksum confirming it;
// - changes made while the daemon was down never reach a page drawn from a
//   saved record;
// - a record from another build, or one that no longer decodes, is drawn, or
//   its resume point is sent;
// - a resume point minted by another store (reset, fresh install) is honoured,
//   so the server sends deltas against rows it never had;
// - a store restored from a backup answers with an older snapshot, and the
//   newer record is kept, or its rows stay on screen;
// - unavailable storage (private browsing) or a full quota breaks the open or
//   throws, instead of opening cold; an aborted write takes back a read;
// - more than 20 sessions are kept, or the wrong ones are dropped.
//
//   CONDUIT_TEST_DIST=dist pnpm exec playwright test \
//     --config test/e2e/playwright-harness.config.ts --workers=1 harness-session-cache

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserContext, Page } from "@playwright/test";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventPayloadMap,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import {
	type SavedSummary,
	savedTranscripts,
} from "../helpers/saved-transcripts.js";

const SESSION = "cache-check";
const LRU = Array.from({ length: 21 }, (_, n) => `cache-lru-${n}`);
const START = Date.UTC(2026, 9, 1);
const MISMATCH = "[resume] checksum mismatch";

const replyEnd = (tag: string, turn: number) => `END-OF-${tag}-${turn}.`;

const event =
	(sessionId: string, createdAt: number) =>
	<T extends CanonicalEventType>(type: T, data: EventPayloadMap[T]) =>
		canonicalEvent(type, sessionId, data, { provider: "claude", createdAt });

/** One prompt and its reply. `phase` keeps every seeding later than the last. */
const turns = (
	sessionId: string,
	phase: number,
	tag: string,
	count: number,
): CanonicalEvent[] =>
	Array.from({ length: count }, (_, turn) => {
		const at = START + phase * 10_000_000 + turn * 1000;
		const user = `${sessionId}-${tag}-u${turn}`;
		const assistant = `${sessionId}-${tag}-a${turn}`;
		const prompt = event(sessionId, at);
		const answer = event(sessionId, at + 500);
		return [
			prompt("message.created", { messageId: user, role: "user", sessionId }),
			prompt("text.delta", {
				messageId: user,
				partId: `${user}-0`,
				text: `Prompt ${tag} ${turn}.`,
			}),
			answer("message.created", {
				messageId: assistant,
				role: "assistant",
				sessionId,
			}),
			answer("text.delta", {
				messageId: assistant,
				partId: `${assistant}-text`,
				text: `Reply ${tag} ${turn}.\n${replyEnd(tag, turn)}`,
			}),
			answer("turn.completed", {
				messageId: assistant,
				tokens: { input: 10, output: 10 },
				duration: 1000,
			}),
		];
	}).flat();

const created = (sessionId: string, title: string): CanonicalEvent =>
	event(sessionId, START)("session.created", {
		sessionId,
		title,
		provider: "claude",
		providerSessionId: sessionId,
	});

const seed = (filename: string, events: readonly CanonicalEvent[]) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* commit([...events], { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
		),
	);

/** Every value anywhere in a frame that matches `match`. */
const find = (value: unknown, match: (value: object) => boolean): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};
const tagged = (tag: string) => (value: object) =>
	"_tag" in value && value._tag === tag;

const parse = (message: string | Buffer): unknown => {
	try {
		return JSON.parse(message.toString());
	} catch {
		return undefined;
	}
};

/** The transcript's text, without the "↓ Latest" button, which shows or not
 * depending on where the tab happens to be scrolled. */
const transcriptOf = (page: Page) =>
	page.locator("#messages").evaluate((messages: HTMLElement) => {
		const button = messages.querySelector<HTMLElement>("#scroll-btn");
		if (!button) return messages.innerText;
		const display = button.style.display;
		button.style.display = "none";
		try {
			return messages.innerText;
		} finally {
			button.style.display = display;
		}
	});

/** A browser whose /rpc frames are recorded, and whose session detail replies
 * can be held back. */
interface Tab {
	readonly context: BrowserContext;
	readonly sent: unknown[];
	readonly received: unknown[];
	readonly held: (() => void)[];
	holding: boolean;
}

const detailRequests = (sent: readonly unknown[]) =>
	sent.flatMap((value) =>
		find(
			value,
			(found) =>
				tagged("Request")(found) &&
				"tag" in found &&
				found.tag === "SubscribeSessionDetail",
		),
	);

const isDetailReply = (value: unknown, ids: ReadonlySet<string>) =>
	find(
		value,
		(found) =>
			tagged("Chunk")(found) &&
			"requestId" in found &&
			ids.has(String(found.requestId)),
	).length > 0;

/** The detail envelopes the page was given since `from`. */
const detailEnvelopes = (tab: Tab, from: number) => {
	const ids = new Set(
		detailRequests(tab.sent).map((request) =>
			"id" in request ? String(request.id) : "",
		),
	);
	return tab.received
		.slice(from)
		.flatMap((value) =>
			find(
				value,
				(found) =>
					tagged("Chunk")(found) &&
					"requestId" in found &&
					ids.has(String(found.requestId)),
			),
		)
		.flatMap((chunk): object[] =>
			"values" in chunk && Array.isArray(chunk.values) ? chunk.values : [],
		);
};

test.describe.configure({ retries: 0 });

test("a session opened from its saved page ends where a cold open does", async ({
	browser,
	harness,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop",
		"The cache and the wire are the same on every device.",
	);
	test.setTimeout(600_000);
	const store = harness.projectStorePath();
	const viewport = testInfo.project.use.viewport ?? null;
	const url = (sessionId: string) =>
		`${harness.baseUrl}/s/${sessionId}?p=process-test`;
	const restart = () =>
		harness.restart({ keepPort: true, skipBrowserProbe: true });

	await harness.terminate();
	await seed(store, [
		created(SESSION, "Cache check"),
		...LRU.map((id, n) => created(id, `Cache LRU ${n}`)),
		...turns(SESSION, 1, "base", 2),
		...LRU.flatMap((id) => turns(id, 1, "lru", 1)),
	]);
	await restart();

	const openTab = async (init?: () => void): Promise<Tab> => {
		const context = await browser.newContext({ viewport });
		if (init) await context.addInitScript(init);
		const tab: Tab = {
			context,
			sent: [],
			received: [],
			held: [],
			holding: false,
		};
		await context.routeWebSocket(
			(target) => target.pathname === "/rpc",
			(socket) => {
				const server = socket.connectToServer();
				socket.onMessage((message) => {
					tab.sent.push(parse(message));
					server.send(message);
				});
				server.onMessage((message) => {
					const value = parse(message);
					const deliver = () => {
						tab.received.push(value);
						socket.send(message);
					};
					const ids = new Set(
						detailRequests(tab.sent).map((request) =>
							"id" in request ? String(request.id) : "",
						),
					);
					if (tab.holding && isDetailReply(value, ids)) tab.held.push(deliver);
					else deliver();
				});
			},
		);
		return tab;
	};

	/** Runs `work` in a page of the tab's origin that is not the app. */
	const atOrigin = async <T>(tab: Tab, work: (page: Page) => Promise<T>) => {
		const page = await tab.context.newPage();
		try {
			await page.goto(`${harness.baseUrl}/health`);
			return await work(page);
		} finally {
			await page.close();
		}
	};

	/** Patch the session's saved record, or delete it with `null`. */
	const edit = (
		tab: Tab,
		sessionId: string,
		patch: Readonly<Record<string, unknown>> | null,
	) =>
		atOrigin(tab, (page) =>
			page.evaluate(
				([id, change]) =>
					new Promise<void>((resolve, reject) => {
						const request = indexedDB.open("conduit-saved-transcripts");
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const db = request.result;
							const transaction = db.transaction("transcripts", "readwrite");
							const cursor = transaction
								.objectStore("transcripts")
								.openCursor(id);
							cursor.onsuccess = () => {
								const at = cursor.result;
								if (!at) return;
								if (change === null) at.delete();
								else at.update({ ...at.value, ...change });
							};
							transaction.oncomplete = () => {
								db.close();
								resolve();
							};
							transaction.onabort = () => {
								db.close();
								reject(transaction.error);
							};
						};
					}),
				[sessionId, patch] as const,
			),
		);

	const coldOpen = async (sessionId: string, shown: string) => {
		const context = await browser.newContext({ viewport });
		try {
			const page = await context.newPage();
			await page.goto(url(sessionId));
			await expect(page.locator("#messages")).toContainText(shown, {
				timeout: 30_000,
			});
			return await transcriptOf(page);
		} finally {
			await context.close();
		}
	};

	const records = async (page: Page): Promise<Record<string, SavedSummary>> =>
		savedTranscripts(page).catch(() => ({}));

	/**
	 * Open `sessionId` in the tab until it shows `shown` and its detail
	 * subscription synchronized, then compare it with a cold open.
	 * `drawnHeld` holds every detail reply until that text is on screen;
	 * `settled` waits for the saved records to reach the expected state.
	 */
	const visit = async (
		tab: Tab,
		sessionId: string,
		shown: string,
		options: {
			readonly drawnHeld?: string;
			readonly settled?: (saved: Record<string, SavedSummary>) => boolean;
			readonly cold?: false;
		} = {},
	) => {
		const sentFrom = tab.sent.length;
		const receivedFrom = tab.received.length;
		const page = await tab.context.newPage();
		let mismatches = 0;
		const pageErrors: string[] = [];
		page.on("console", (message) => {
			if (message.text().includes(MISMATCH)) mismatches += 1;
		});
		page.on("pageerror", (error) => pageErrors.push(error.message));
		try {
			tab.holding = options.drawnHeld !== undefined;
			await page.goto(url(sessionId));
			let drawnBeforeReply:
				| { readonly drawn: boolean; readonly repliesDelivered: number }
				| undefined;
			if (options.drawnHeld !== undefined) {
				const drawn = await page
					.locator("#messages .msg-assistant", { hasText: options.drawnHeld })
					.first()
					.waitFor({ timeout: 30_000 })
					.then(
						() => true,
						() => false,
					);
				drawnBeforeReply = {
					drawn,
					repliesDelivered: detailEnvelopes(tab, receivedFrom).length,
				};
				tab.holding = false;
				for (const deliver of tab.held.splice(0)) deliver();
			}
			await expect(page.locator("#messages")).toContainText(shown, {
				timeout: 30_000,
			});
			await expect
				.poll(
					() => detailEnvelopes(tab, receivedFrom).some(tagged("synchronized")),
					{ timeout: 30_000 },
				)
				.toBe(true);
			const settled =
				options.settled === undefined ||
				(await expect
					.poll(async () => options.settled?.(await records(page)), {
						timeout: 10_000,
					})
					.toBe(true)
					.then(
						() => true,
						() => false,
					));
			const cold =
				options.cold === false ? undefined : await coldOpen(sessionId, shown);
			const transcriptEqualsCold =
				cold === undefined
					? undefined
					: await expect
							.poll(() => transcriptOf(page), { timeout: 10_000 })
							.toBe(cold)
							.then(
								() => true,
								() => false,
							);
			const envelopes = detailEnvelopes(tab, receivedFrom);
			const requests = detailRequests(tab.sent.slice(sentFrom));
			return {
				sessionId,
				cached: await transcriptOf(page),
				cold,
				verdicts: {
					transcriptEqualsCold,
					...(drawnBeforeReply === undefined ? {} : { drawnBeforeReply }),
					detailRequests: requests.length,
					resumePointSent:
						find(requests[0], (found) => "resumePoint" in found).length > 0,
					detailSnapshots: envelopes.filter(tagged("snapshot")).length,
					checkedSyncs: envelopes.filter(
						(envelope) =>
							tagged("synchronized")(envelope) && "checksum" in envelope,
					).length,
					mismatches,
					pageErrors,
					settled,
					record: (await records(page))[sessionId] ?? null,
				},
			};
		} finally {
			tab.holding = false;
			for (const deliver of tab.held.splice(0)) deliver();
			await page.close();
		}
	};

	const scenarios: {
		name: string;
		result: Awaited<ReturnType<typeof visit>>;
		expected: Record<string, unknown>;
	}[] = [];
	const run = async (
		name: string,
		result: Promise<Awaited<ReturnType<typeof visit>>>,
		expected: Record<string, unknown>,
	) => {
		const done = await result;
		scenarios.push({ name, result: done, expected });
		return done;
	};
	const cold = { resumePointSent: false, detailSnapshots: 1 };
	const resumed = {
		resumePointSent: true,
		detailSnapshots: 0,
		checkedSyncs: 1,
		mismatches: 0,
	};
	const clean = { transcriptEqualsCold: true, pageErrors: [] };
	const sequenceOf = (record: SavedSummary | undefined | null) =>
		typeof record?.sequence === "number" ? record.sequence : undefined;

	// First open: cold, and its snapshot is saved once synchronized.
	const tab = await openTab();
	const first = await run(
		"first-open",
		visit(tab, SESSION, replyEnd("base", 1), {
			settled: (saved) => saved[SESSION] !== undefined,
		}),
		{ ...clean, ...cold, settled: true },
	);

	// A reload draws the saved page while every detail reply is held, then
	// resumes from it: no snapshot, and the checksum confirms it.
	await run(
		"cached-open",
		visit(tab, SESSION, replyEnd("base", 1), {
			drawnHeld: replyEnd("base", 1),
		}),
		{
			...clean,
			...resumed,
			drawnBeforeReply: { drawn: true, repliesDelivered: 0 },
		},
	);

	// The daemon restarts with a turn added while it was down: only the turn
	// arrives on top of the saved page.
	await harness.terminate();
	await seed(store, turns(SESSION, 2, "away", 1));
	await restart();
	const shown = replyEnd("away", 0);
	await run("restart-with-changes", visit(tab, SESSION, shown), {
		...clean,
		...resumed,
	});

	// A record from another build is dropped unread and replaced.
	await edit(tab, SESSION, { buildId: "stale-build" });
	await run(
		"build-id-changed",
		visit(tab, SESSION, shown, {
			settled: (saved) =>
				saved[SESSION] !== undefined &&
				saved[SESSION].buildId === first.verdicts.record?.buildId,
		}),
		{ ...clean, ...cold, settled: true },
	);

	// A record that no longer decodes is dropped and replaced.
	await edit(tab, SESSION, { snapshot: { garbage: true } });
	const corrupt = await run(
		"corrupt-record",
		visit(tab, SESSION, shown, {
			settled: (saved) => sequenceOf(saved[SESSION]) !== undefined,
		}),
		{ ...clean, ...cold, settled: true },
	);

	// Another store answers: the point is sent, refused, and a snapshot both
	// replaces the page and the record.
	await harness.terminate();
	const db = new DatabaseSync(store);
	try {
		db.prepare("UPDATE store_identity SET value = 'another-store'").run();
	} finally {
		db.close();
	}
	await restart();
	await run(
		"other-store",
		visit(tab, SESSION, shown, {
			settled: (saved) =>
				saved[SESSION] !== undefined &&
				saved[SESSION].resumePoint !== corrupt.verdicts.record?.resumePoint,
		}),
		{ ...clean, resumePointSent: true, detailSnapshots: 1, settled: true },
	);

	// A store restored from a backup is behind the saved record: its older
	// snapshot replaces the record, and the rows past it leave the screen.
	await harness.terminate();
	const backup = join(harness.root, "session-cache-backup");
	mkdirSync(backup, { recursive: true });
	const files = ["", "-wal", "-shm"].map((suffix) => ({
		live: `${store}${suffix}`,
		kept: join(backup, `events.db${suffix}`),
	}));
	for (const { live, kept } of files)
		if (existsSync(live)) copyFileSync(live, kept);
	await seed(store, turns(SESSION, 3, "ahead", 1));
	await restart();
	await edit(tab, SESSION, null);
	const ahead = await run(
		"ahead-of-backup",
		visit(tab, SESSION, replyEnd("ahead", 0), {
			settled: (saved) => saved[SESSION] !== undefined,
		}),
		{ ...clean, ...cold, settled: true },
	);
	await harness.terminate();
	for (const { live, kept } of files) {
		rmSync(live, { force: true });
		if (existsSync(kept)) copyFileSync(kept, live);
	}
	await restart();
	const aheadSequence = sequenceOf(ahead.verdicts.record);
	const restored = await run(
		"restored-store",
		visit(tab, SESSION, shown, {
			settled: (saved) => {
				const sequence = sequenceOf(saved[SESSION]);
				return (
					sequence !== undefined &&
					aheadSequence !== undefined &&
					sequence < aheadSequence
				);
			},
		}),
		{ ...clean, resumePointSent: true, detailSnapshots: 1, settled: true },
	);
	await tab.context.close();

	// Private browsing: storage refuses to open, and every open is cold.
	const blocked = await openTab(() =>
		Object.defineProperty(window, "indexedDB", {
			configurable: true,
			get() {
				throw new DOMException("The operation is insecure.", "SecurityError");
			},
		}),
	);
	for (const name of ["storage-unavailable", "storage-unavailable-reload"])
		await run(name, visit(blocked, SESSION, shown), { ...clean, ...cold });
	await blocked.context.close();

	// Over quota: every write aborts. A read still draws and resumes, and a
	// failed save leaves no record and no error.
	const full = await openTab();
	await run(
		"quota-saved-first",
		visit(full, SESSION, shown, {
			settled: (saved) => saved[SESSION] !== undefined,
		}),
		{ ...clean, ...cold, settled: true },
	);
	// As a quota failure does, the write is refused after it was queued, and
	// the whole transaction goes with it.
	await full.context.addInitScript(() => {
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (
			this: IDBObjectStore,
			...args: Parameters<IDBObjectStore["put"]>
		) {
			const request = put.apply(this, args);
			request.addEventListener("success", () => this.transaction.abort());
			return request;
		};
	});
	await run("quota-cached-open", visit(full, SESSION, shown), {
		...clean,
		...resumed,
	});
	await edit(full, SESSION, { buildId: "stale-build" });
	await run(
		"quota-failed-save",
		visit(full, SESSION, shown, {
			settled: (saved) => saved[SESSION] === undefined,
		}),
		{ ...clean, ...cold, settled: true, record: null },
	);
	await full.context.close();

	// The 20 most recently opened sessions are kept; the oldest go.
	const recent = await openTab();
	for (const sessionId of [SESSION, ...LRU]) {
		const latest = sessionId === SESSION ? shown : replyEnd("lru", 0);
		await visit(recent, sessionId, latest, {
			cold: false,
			settled: (saved) => saved[sessionId] !== undefined,
		});
	}
	const kept = Object.keys(
		await atOrigin(recent, (page) => records(page)),
	).sort();
	await recent.context.close();

	const report = {
		schema: 1,
		project: testInfo.project.name,
		recordedAt: new Date().toISOString(),
		scenarios: scenarios.map(({ name, result, expected }) => ({
			name,
			sessionId: result.sessionId,
			cached: result.cached,
			cold: result.cold,
			verdicts: result.verdicts,
			expected,
		})),
		lru: { opened: [SESSION, ...LRU], kept },
		restoredSequence: {
			ahead: aheadSequence,
			restored: sequenceOf(restored.verdicts.record),
		},
	};
	mkdirSync("test-results", { recursive: true });
	const output = join(
		"test-results",
		`session-cache.${testInfo.project.name}.json`,
	);
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	await testInfo.attach("session-cache-report", { path: output });

	for (const { name, result, expected } of scenarios)
		expect(result.verdicts, name).toMatchObject(expected);
	expect(kept).toEqual(LRU.slice(1).sort());
});
