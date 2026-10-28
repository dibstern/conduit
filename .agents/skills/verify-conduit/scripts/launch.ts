// Owns an isolated conduit server and its browser for the verification control CLI.
// Usage: node --import tsx launch.ts <run-dir>. Prints READY; SIGTERM tears it down.
// The process harness gives it a throwaway HOME/config/project under /tmp and replays
// recorded provider traffic, so it never touches the user's server on :2633 or spends
// real provider credits.
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pollDelay } from "node:timers/promises";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
	type Request,
	type Video,
} from "@playwright/test";
import type { ClaudeTraceName } from "../../../../test/e2e/helpers/claude-trace-replayer.js";
import {
	fixtureRows,
	signedInCodexDiscoveryTrace,
	type TraceRow,
} from "../../../../test/helpers/codex-app-server.js";
import { ProcessHarness } from "../../../../test/helpers/process-harness.js";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: launch.ts <run-dir>");
mkdirSync(runDir, { recursive: true });

// Claude prompts replay these traces from test/fixtures/claude-sdk-traces/, in order, one per prompt
// within each session: every session runner starts at the first. A prompt past the end fails its turn.
const claudeTurns = (
	process.env["CLAUDE_TURNS"] ??
	"pong-thinking-text-turn,pong-thinking-text-turn,pong-thinking-text-turn"
)
	.split(",")
	.filter(Boolean) as ClaudeTraceName[];

const harness = ProcessHarness.create({
	dist: resolve("dist"),
	opencodeRecording: process.env["OPENCODE_RECORDING"] ?? "chat-simple",
	// CLAUDE_DELAY_MS spaces replayed messages so in-progress states (background tasks, streaming) stay visible.
	claudeReplay: {
		turns: claudeTurns,
		delayMs: Number(process.env["CLAUDE_DELAY_MS"] ?? 0),
	},
	rootPrefix: "/tmp/conduit-verify-",
	serverLogFile: join(runDir, "server.log"),
});
const codexDir = join(harness.root, "codex");
const codexGate = join(codexDir, "gate");
// ProcessHarness gives Claude runners this hold path, overriding the service environment.
const claudeHold = join(harness.root, "claude-replay-hold");
const openCodeReleases: Array<() => void> = [];
const codexStage = { current: 0, total: 1 };
let codexStagePoller: ReturnType<typeof setInterval> | undefined;

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let control: Server | undefined;
let stopping = false;
let tracing = false;
const video = process.env["VIDEO"] === "1";
const recordedVideos: Video[] = [];
writeFileSync(join(runDir, "videos.json"), "[]\n");
// Relative to the required repo cwd: absolute worktree paths exceed macOS's sockaddr limit.
const controlSocket = relative(process.cwd(), join(runDir, "control.sock"));
const consoleMessages: Array<{
	level: string;
	text: string;
	location: { url: string; lineNumber: number; columnNumber: number };
	time: number;
}> = [];
const webSocketFrames: Array<{
	page: Page;
	time: number;
	direction: "in" | "out";
	event: string;
	detail: string;
	state: string;
	url: string;
	payload: unknown;
}> = [];
const networkRequests: Array<{
	time: number;
	method: string;
	url: string;
	status: number | null;
	resourceType: string;
	durationMs: number | null;
	failure?: string;
}> = [];
const requests = new WeakMap<Request, (typeof networkRequests)[number]>();

function nativeStarts(trace: TraceRow[]) {
	return trace.flatMap(({ dir, message }) =>
		dir === "in" && message?.method === "turn/started"
			? [message.params as { threadId: string; turn: { id: string } }]
			: [],
	);
}

function splitForkTrace(source: string | TraceRow[]) {
	const trace = typeof source === "string" ? fixtureRows(source) : source;
	const firstTurn = trace.findIndex(
		({ message }) => message?.method === "turn/start",
	);
	const forkIndex = trace.findIndex(
		({ message }, index) =>
			index > firstTurn && message?.method === "thread/fork",
	);
	const threadIndex = trace.findIndex(
		({ message }) =>
			message?.method === "thread/start" || message?.method === "thread/fork",
	);
	const parentThread = nativeStarts(trace)[0]?.threadId;
	if (!parentThread || forkIndex < 0)
		throw new Error("Missing native fork recording");
	const exit = trace.filter(({ dir }) => dir === "exit");
	return {
		parent: [
			...trace.slice(0, forkIndex),
			...trace
				.slice(forkIndex)
				.filter(
					({ dir, message }) =>
						dir === "in" && message?.params?.["threadId"] === parentThread,
				),
			...exit,
		],
		child: [
			...trace.slice(0, threadIndex),
			...trace
				.slice(forkIndex)
				.filter(
					({ dir, message }) =>
						(dir === "out" && message?.method === "thread/fork") ||
						message?.params?.["threadId"] !== parentThread,
				),
		],
	};
}

function forkStages(rows: TraceRow[]): TraceRow[][] {
	const firstTurn = rows.findIndex(
		({ message }) => message?.method === "turn/start",
	);
	if (
		!rows.some(
			({ message }, index) =>
				index > firstTurn && message?.method === "thread/fork",
		)
	)
		return [rows];
	const { parent, child } = splitForkTrace(rows);
	return [parent, ...forkStages(child)];
}

async function start() {
	// Cursor replays test/fixtures/cursor-sdk-traces/<CURSOR_TRACE>.jsonl, derived the same way
	// as test/integration/daemon/cursor-turn.test.ts: borrow basic's model catalog if the trace
	// has none, and add a redacted stored credential so the account reads as logged in.
	// The player repeats the last recorded turn for every later prompt.
	type CursorRow = { kind?: string };
	const cursorTraceRows = (name: string): CursorRow[] =>
		readFileSync(
			resolve(`test/fixtures/cursor-sdk-traces/${name}.jsonl`),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as CursorRow);
	const cursorRows = cursorTraceRows(process.env["CURSOR_TRACE"] ?? "basic");
	if (!cursorRows.some(({ kind }) => kind === "models.list")) {
		const catalog = cursorTraceRows("basic").find(
			({ kind }) => kind === "models.list",
		);
		if (catalog) cursorRows.splice(1, 0, catalog);
	}
	cursorRows.splice(1, 0, {
		kind: "credential.store",
		data: {
			apiKey: "[REDACTED]",
			backendUrl: "https://api2.cursor.sh",
			createdAtMs: 0,
		},
	} as CursorRow);
	const cursorTrace = join(harness.root, "cursor-replay.jsonl");
	writeFileSync(
		cursorTrace,
		`${cursorRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);

	// Codex replays test/fixtures/codex-app-server-traces/<CODEX_TURN>.jsonl for every turn
	// runner, matching request methods only, never prompt text. The signed-in discovery trace
	// makes the daemon auto-add account "codex-2". Forks and side threads get the next slice.
	mkdirSync(codexDir, { recursive: true });
	writeFileSync(codexGate, String(Number.MAX_SAFE_INTEGER));
	const writeCodexTrace = (name: string, trace: TraceRow[]) => {
		const path = join(codexDir, `${name}.jsonl`);
		const lines = trace.map((row) =>
			JSON.stringify(row).replaceAll("/workspace", harness.projectDir),
		);
		writeFileSync(`${path}.tmp`, `${lines.join("\n")}\n`);
		renameSync(`${path}.tmp`, path);
		return path;
	};
	const stages = forkStages(
		fixtureRows(process.env["CODEX_TURN"] ?? "two-turns"),
	);
	codexStage.total = stages.length;
	const [firstStage] = stages;
	if (!firstStage) throw new Error("codex fixture has no turn stages");
	const codexTurnTrace = writeCodexTrace("turn", firstStage);
	if (stages.length > 1) {
		codexStagePoller = setInterval(() => {
			try {
				const n = Number(
					query(
						"select count(distinct t.session_id) as n from turns t join sessions s on s.id = t.session_id where s.model_provider = 'codex' and t.state <> 'pending' and t.run_id is not null",
					)[0]?.["n"] ?? 0,
				);
				const next = Math.min(n, stages.length - 1);
				const stage = stages[next];
				if (stage && next > codexStage.current) {
					writeCodexTrace("turn", stage);
					codexStage.current = next;
					console.log(`codex trace stage ${next}/${stages.length}`);
				}
			} catch {
				// The store may not exist until startup finishes.
			}
		}, 100);
		codexStagePoller.unref();
	}
	const discovery = signedInCodexDiscoveryTrace();
	const codexTraceMap = join(codexDir, "trace-map.json");
	writeFileSync(
		codexTraceMap,
		JSON.stringify({
			"*": {
				"codex-discovery": { trace: writeCodexTrace("discovery", discovery) },
				"codex-discovery-auth": {
					trace: writeCodexTrace(
						"auth",
						discovery.slice(
							0,
							discovery.findIndex(
								({ message }) => message?.method === "model/list",
							),
						),
					),
				},
				"codex-usage": {
					trace: writeCodexTrace("usage", fixtureRows("usage-read")),
				},
			},
		}),
	);

	// SEED_ACCOUNTS=0 leaves the Cursor account out (Codex's still auto-adds), so the add-account feature can create it
	// through Settings.
	const seedAccounts = process.env["SEED_ACCOUNTS"] !== "0";
	const replayEnvironment: Record<string, string> = {
		CONDUIT_TEST_CLAUDE_REPLAY_HOLD: claudeHold,
		CONDUIT_TEST_CLAUDE_REPLAY_SUBAGENT_READS: "1",
	};
	await harness.restart({
		serviceEnvironment: {
			...replayEnvironment,
			// The production capture opens with "w". This isolated preload changes only
			// that capture path to append, including discovery and usage transports.
			NODE_OPTIONS: `--import=${new URL("./codex-capture.mjs", import.meta.url).href}`,
			CONDUIT_CURSOR_SDK_TRACE: cursorTrace,
			CONDUIT_CURSOR_SDK_CAPTURE: join(runDir, "cursor-capture.jsonl"),
			CONDUIT_TEST_CODEX_TRACE_MAP: codexTraceMap,
			// The turn runner's env lacks NODE_ENV=test, so it skips the map and reads this.
			CONDUIT_CODEX_APP_SERVER_TRACE: codexTurnTrace,
			CONDUIT_CODEX_APP_SERVER_TRACE_GATE: codexGate,
			CONDUIT_CODEX_APP_SERVER_CAPTURE: join(runDir, "codex-wire.jsonl"),
			CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: join(
				runDir,
				"codex-trace-report.jsonl",
			),
			// Anything that escapes replay fails instead of spawning a real Codex CLI.
			CONDUIT_CODEX_BINARY: join(codexDir, "no-real-codex"),
		},
	});
	if (seedAccounts) {
		const added = await harness.requestRpc({
			_tag: "AddInstance",
			name: "Cursor replay",
			driver: "cursor",
		});
		if (!added.addedInstanceId) throw new Error("no Cursor account allocated");
	}
	if (stopping) return;
	const port = await new Promise<number>((done, reject) => {
		const reservation = createNetServer();
		reservation.once("error", reject);
		reservation.listen(0, "127.0.0.1", () => {
			const address = reservation.address();
			if (!address || typeof address === "string")
				return reject(new Error("no CDP port"));
			reservation.close((error) =>
				error ? reject(error) : done(address.port),
			);
		});
	});
	browser = await chromium.launch({
		headless: process.env["HEADED"] !== "1",
		// stop() owns shutdown: Playwright's own signal handlers would close the
		// browser under it, before context.close can finalize the videos.
		handleSIGTERM: false,
		handleSIGINT: false,
		handleSIGHUP: false,
		args: [
			`--remote-debugging-port=${port}`,
			"--remote-debugging-address=127.0.0.1",
		],
	});
	let browserPid: number | null = null;
	try {
		const cdp = await browser.newBrowserCDPSession();
		try {
			const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
			browserPid =
				processInfo.find((entry) => entry.type === "browser")?.id ?? null;
		} finally {
			await cdp.detach();
		}
	} catch (error) {
		console.error("browser pid:", error);
	}
	const phone = process.env["VIEWPORT"] === "phone";
	const viewport = phone
		? { width: 393, height: 852 }
		: { width: 1440, height: 900 };
	context = await browser.newContext({
		viewport,
		isMobile: phone,
		hasTouch: phone,
		...(video
			? { recordVideo: { dir: join(runDir, "videos"), size: viewport } }
			: {}),
	});
	context.on("request", (request) => {
		if (
			request.resourceType() === "websocket" ||
			request.headers()["upgrade"]?.toLowerCase() === "websocket"
		)
			return;
		const url = new URL(request.url());
		const entry: (typeof networkRequests)[number] = {
			time: Date.now(),
			method: request.method(),
			url:
				url.origin === new URL(harness.baseUrl).origin
					? `${url.pathname}${url.search}`
					: url.href,
			status: null,
			resourceType: request.resourceType(),
			durationMs: null,
		};
		requests.set(request, entry);
		networkRequests.push(entry);
		if (networkRequests.length > 2000) networkRequests.shift();
	});
	context.on("response", (response) => {
		const entry = requests.get(response.request());
		if (entry) entry.status = response.status();
	});
	context.on("requestfinished", (request) => {
		const entry = requests.get(request);
		if (entry) entry.durationMs = Math.max(0, Date.now() - entry.time);
	});
	context.on("requestfailed", (request) => {
		const entry = requests.get(request);
		if (entry) {
			entry.durationMs = Math.max(0, Date.now() - entry.time);
			entry.failure = request.failure()?.errorText ?? "request failed";
		}
	});
	// Install listeners before the first navigation, including every page created by an attached tool.
	context.on("page", (opened) => {
		const recording = opened.video();
		if (recording) recordedVideos.push(recording);
		opened.on("websocket", (socket) => {
			const recordFrame = (direction: "in" | "out", data: string | Buffer) => {
				const text = data.toString();
				let payload: unknown = text;
				try {
					payload = JSON.parse(text);
				} catch {}
				const message =
					payload && typeof payload === "object"
						? (payload as Record<string, unknown>)
						: undefined;
				webSocketFrames.push({
					page: opened,
					time: Date.now(),
					direction,
					event: direction === "in" ? "framereceived" : "framesent",
					detail: String(
						message?.["method"] ??
							message?.["_tag"] ??
							message?.["type"] ??
							"frame",
					),
					state: "open",
					url: socket.url(),
					payload,
				});
				if (webSocketFrames.length > 2000) webSocketFrames.shift();
			};
			socket.on("framereceived", ({ payload }) => recordFrame("in", payload));
			socket.on("framesent", ({ payload }) => recordFrame("out", payload));
		});
		const record = (entry: (typeof consoleMessages)[number]) => {
			consoleMessages.push(entry);
			if (consoleMessages.length > 2000) consoleMessages.shift();
		};
		opened.on("console", (message) =>
			record({
				level: message.type(),
				text: message.text(),
				location: message.location(),
				time: Date.now(),
			}),
		);
		opened.on("pageerror", (error) =>
			record({
				level: "error",
				text: error.stack ?? error.message,
				location: { url: opened.url(), lineNumber: 0, columnNumber: 0 },
				time: Date.now(),
			}),
		);
	});
	await context.addInitScript(() => {
		const state = Object.assign(window, {
			__verifyMutationAt: performance.now(),
		});
		new MutationObserver(() => {
			state.__verifyMutationAt = performance.now();
		}).observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
	});
	page = await context.newPage();
	page.setDefaultTimeout(10_000);
	await page.goto(harness.baseUrl);
	await waitReady(page);
	if (stopping) return;
	rmSync(controlSocket, { force: true });
	control = createServer((request, response) => {
		void (async () => {
			response.setHeader("Content-Type", "application/json");
			try {
				if (request.method !== "POST")
					throw new ControlError(
						"use POST JSON {op,args}",
						"run conduit-verify --help",
					);
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of request) {
					const buffer = Buffer.from(chunk as Uint8Array);
					size += buffer.length;
					if (size > 1024 * 1024)
						throw new ControlError(
							"request exceeds 1 MB",
							"use upload-image for files",
						);
					chunks.push(buffer);
				}
				const body = JSON.parse(Buffer.concat(chunks).toString()) as {
					op?: unknown;
					args?: unknown;
				};
				if (
					typeof body.op !== "string" ||
					!body.args ||
					typeof body.args !== "object" ||
					Array.isArray(body.args)
				)
					throw new ControlError(
						"expected {op:string,args:object}",
						"run conduit-verify --help",
					);
				const result = await operate(body.op, body.args as Args);
				response.end(
					JSON.stringify(
						{ ok: true, result: result ?? null },
						(_key, value: unknown) =>
							typeof value === "bigint" ? value.toString() : value,
					),
				);
			} catch (error) {
				response.end(
					JSON.stringify({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						hint:
							error instanceof ControlError
								? error.hint
								: "run conduit-verify snapshot or logs to inspect the current state",
					}),
				);
			}
		})();
	});
	await new Promise<void>((done, reject) => {
		control?.once("error", reject);
		control?.listen(controlSocket, done);
	});

	writeFileSync(
		join(runDir, "instance.json"),
		JSON.stringify(
			{
				baseUrl: harness.baseUrl,
				runDir,
				controlSocket,
				cdpUrl: `http://127.0.0.1:${port}`,
				root: harness.root,
				configDir: harness.configDir,
				projectDir: harness.projectDir,
				launcherPid: process.pid,
				serverPid: harness.generations.at(-1)?.pid,
				browserPid,
				video,
			},
			null,
			2,
		),
	);
	console.log(`READY ${harness.baseUrl}`);
}

const stop = async (code = 0) => {
	if (stopping) return;
	stopping = true;
	await startup.catch(() => {});
	clearInterval(codexStagePoller);
	for (const provider of ["claude", "codex", "opencode"]) {
		try {
			releaseReplays({ [provider]: true });
		} catch {}
	}
	try {
		await context?.close();
	} catch (error) {
		console.error("context close:", error);
		code = 1;
	}
	try {
		await browser?.close();
	} catch (error) {
		console.error("browser close:", error);
		code = 1;
	}
	try {
		// Context.close waits for all pages' recordings, including pages closed earlier.
		// A page that never painted rejects path(); skip it without losing other evidence.
		const settled = await Promise.allSettled(
			recordedVideos.map(async (recording) => resolve(await recording.path())),
		);
		const videos: string[] = [];
		for (const result of settled) {
			if (result.status === "rejected") continue;
			try {
				const file = statSync(result.value);
				if (!file.isFile() || file.size === 0)
					throw new Error("recording is not a non-empty file");
				videos.push(result.value);
			} catch (error) {
				console.error(`video ${result.value}:`, error);
				code = 1;
			}
		}
		writeFileSync(join(runDir, "videos.json"), `${JSON.stringify(videos)}\n`);
		console.log(`VIDEOS ${JSON.stringify(videos)}`);
	} catch (error) {
		console.error("videos:", error);
		code = 1;
	}
	try {
		if (control?.listening) {
			control.closeAllConnections();
			await new Promise<void>((done) => control?.close(() => done()));
		}
		// Evidence first: dispose deletes the harness root.
		const daemonLog = join(harness.configDir, "daemon.log");
		writeFileSync(
			join(runDir, "daemon.log"),
			existsSync(daemonLog) ? readFileSync(daemonLog) : harness.logTail,
		);
	} catch (error) {
		console.error("evidence:", error);
		code = 1;
	}
	try {
		await harness.dispose();
	} catch (error) {
		console.error("teardown:", error);
		code = 1;
	} finally {
		writeFileSync(
			join(runDir, "harness-proof.json"),
			JSON.stringify(harness.proof(), null, 2),
		);
		rmSync(controlSocket, { force: true });
		console.log(code ? "STOPPED_DIRTY" : "STOPPED");
		process.exit(code);
	}
};
process.on("SIGTERM", () => {
	void stop();
});
process.on("SIGINT", () => {
	void stop();
});
process.on("SIGHUP", () => {
	void stop();
});

type Args = Record<string, unknown>;
class ControlError extends Error {
	constructor(
		message: string,
		readonly hint: string,
	) {
		super(message);
	}
}
// The phone root shows the session list and hides the composer, so its sidebar counts as ready.
function waitReady(p: Page) {
	return p
		.locator(
			process.env["VIEWPORT"] === "phone"
				? "#input:visible, #new-session-btn:visible"
				: "#input:visible",
		)
		.first()
		.waitFor();
}
function currentPage() {
	if (!page || page.isClosed())
		throw new ControlError(
			"page is detached",
			"run down then up to attach a new page",
		);
	return page;
}
function textArg(args: Args, name: string) {
	const value = args[name];
	if (typeof value !== "string")
		throw new ControlError(`missing ${name}`, "run conduit-verify --help");
	return value;
}
function numberArg(args: Args, name: string, fallback: number) {
	const value = args[name] ?? fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new ControlError(
			`${name} must be a positive integer`,
			"run conduit-verify --help",
		);
	return value;
}
async function unique(selector: string) {
	const locator = currentPage().locator(selector);
	const count = await locator.count();
	if (count !== 1)
		throw new ControlError(
			`selector matched ${count} elements: ${selector}`,
			"run conduit-verify snapshot to find a stable handle",
		);
	return locator;
}
function query(sql: string, bindings: string[] = []) {
	const db = new DatabaseSync(join(harness.configDir, "events.db"), {
		readOnly: true,
	});
	try {
		return db.prepare(sql).all(...bindings);
	} finally {
		db.close();
	}
}
function sessionId() {
	return (
		new URL(currentPage().url()).pathname.match(/^\/s\/([^/]+)/)?.[1] ?? null
	);
}
function turnState(id: string | null) {
	return id
		? query(
				"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at DESC, rowid DESC",
				[id],
			).map((row) => String(row["state"]))
		: [];
}
async function settle(timeout: number) {
	const started = performance.now();
	let quietSince = started;
	let previous = "";
	let observed: unknown;
	while (performance.now() - started < timeout) {
		const id = sessionId();
		const states = turnState(id);
		const dom = await currentPage().evaluate(() => ({
			quietMs:
				performance.now() -
				((window as unknown as { __verifyMutationAt: number })
					.__verifyMutationAt ?? performance.now()),
			stop: !!document.querySelector("#stop")?.getClientRects().length,
			queued: [
				...document.querySelectorAll('[data-testid="pending-input-row"]'),
			].map((row) => row.getAttribute("data-input-id")),
			paused: !!document.querySelector('[data-testid="pending-input-paused"]'),
		}));
		const now = performance.now();
		const signature = JSON.stringify({
			id,
			states,
			queued: dom.queued,
			paused: dom.paused,
		});
		const inactive =
			!states.some((state) => state === "pending" || state === "running") &&
			!dom.stop &&
			(dom.queued.length === 0 || dom.paused);
		if (!inactive || signature !== previous) quietSince = now;
		previous = signature;
		observed = {
			states,
			...dom,
			quietForMs: Math.round(now - quietSince),
			path: new URL(currentPage().url()).pathname,
		};
		if (inactive && dom.quietMs >= 300 && now - quietSince >= 750)
			return {
				settled: true,
				ms: Math.round(performance.now() - started),
				turnStatus: states[0] ?? null,
			};
		// Poll store and DOM signals; elapsed time alone never marks a turn settled.
		await pollDelay(40);
	}
	throw new ControlError(
		`settle timeout after ${timeout} ms; last observed ${JSON.stringify(observed)}`,
		"run conduit-verify store turns, console, ws-log and logs to inspect the unfinished turn",
	);
}
async function pickModel(args: Args) {
	const p = currentPage();
	const harnessName = textArg(args, "harness");
	if (!["claude", "opencode", "codex", "cursor"].includes(harnessName))
		throw new ControlError(
			`unknown harness ${harnessName}`,
			"choose claude, opencode, codex or cursor",
		);
	const trigger = p.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-words-sheet-trigger"]:visible, [data-testid="composer-word-model"]:visible',
	);
	await trigger.click();
	if (
		(await trigger.getAttribute("aria-label"))?.startsWith("Composer options:")
	)
		await p.getByTestId("composer-harness-trigger").click();
	await p.getByTestId("model-picker").waitFor({ state: "visible" });
	// Close the picker and sheet on failure too, so a bad model leaves no overlay behind.
	try {
		const back = p.getByTestId("picker-back");
		if (await back.isVisible()) await back.click();
		await p.getByTestId(`picker-harness-${harnessName}`).click();
		await p.getByTestId("picker-row-model").click();
		// JSON string quoting is also valid CSS attribute quoting, including dotted model ids.
		await p
			.locator(
				`[data-testid="model-picker-list"] [data-model-id=${JSON.stringify(textArg(args, "model"))}][data-provider-id=${JSON.stringify(textArg(args, "provider"))}]`,
			)
			.click();
	} finally {
		const picker = p.getByTestId("model-picker");
		if (await picker.isVisible()) await p.keyboard.press("Escape");
		// Phone model selection can return to the Composer sheet. Close it too.
		const sheet = p.getByTestId("composer-more-sheet");
		if (await sheet.isVisible()) {
			await p.keyboard.press("Escape");
			await sheet.waitFor({ state: "hidden" });
		}
	}
	return trigger.evaluate((trigger) => ({
		instanceId: trigger.getAttribute("data-instance-id"),
		shownProvider: trigger.getAttribute("data-shown-provider"),
		shownModel: trigger.getAttribute("data-shown-model"),
		sendDisabled:
			(document.querySelector("#send") as HTMLButtonElement | null)?.disabled ??
			true,
	}));
}
function artifact(folder: string, extension: string, requested: unknown) {
	if (typeof requested === "string") {
		const file = resolve(requested);
		mkdirSync(resolve(file, ".."), { recursive: true });
		return file;
	}
	const dir = join(runDir, folder);
	mkdirSync(dir, { recursive: true });
	const numbers = readdirSync(dir).map((name) =>
		Number(name.match(/^(\d+)\./)?.[1] ?? 0),
	);
	return join(
		dir,
		`${String(Math.max(0, ...numbers) + 1).padStart(3, "0")}.${extension}`,
	);
}
function releaseReplays(args: Args) {
	const providers = ["claude", "codex", "opencode"] as const;
	if (
		Object.entries(args).some(
			([name, value]) =>
				!providers.some((provider) => provider === name) ||
				typeof value !== "boolean",
		)
	)
		throw new ControlError(
			"release accepts boolean provider flags",
			"use release [--claude] [--codex] [--opencode]; none releases all",
		);
	const released = providers.filter(
		(provider) => Object.keys(args).length === 0 || args[provider] === true,
	);
	const claudeReached: object[] = [];
	if (released.includes("claude")) {
		if (existsSync(`${claudeHold}.reached`)) {
			for (const line of readFileSync(`${claudeHold}.reached`, "utf8").split(
				"\n",
			)) {
				try {
					const entry: unknown = JSON.parse(line);
					if (entry && typeof entry === "object" && !Array.isArray(entry))
						claudeReached.push(entry);
				} catch {}
			}
		}
		rmSync(claudeHold, { force: true });
		rmSync(`${claudeHold}.reached`, { force: true });
	}
	if (released.includes("codex"))
		writeFileSync(codexGate, String(Number.MAX_SAFE_INTEGER));
	if (released.includes("opencode")) {
		for (const release of openCodeReleases.splice(0)) release();
		// A hold armed before any prompt stays armed after its release; clear it.
		const mock = harness["recordedOpenCode"];
		if (mock) mock["nextPromptHold"] = undefined;
	}
	return { released, claudeReached };
}
async function operate(op: string, args: Args): Promise<unknown> {
	const p = currentPage();
	switch (op) {
		case "info":
			return {
				pageUrl: p.url(),
				pageAttached: !p.isClosed() && !!browser?.isConnected(),
				codexStage,
				video,
			};
		case "hold": {
			const hint =
				"use hold --claude T:M, hold --codex N or hold --opencode session.status|permission.asked|question.asked";
			if (Object.keys(args).length !== 1)
				throw new ControlError("hold requires exactly one provider", hint);
			const claude = args["claude"];
			const codex = args["codex"];
			const opencode = args["opencode"];
			if (typeof claude === "string" && /^\d+:\d+$/.test(claude)) {
				const point = claude.split(":").map(Number);
				if (!point.every((n) => Number.isSafeInteger(n) && n > 0))
					throw new ControlError("Claude T:M requires positive integers", hint);
				const [turn, message] = point;
				writeFileSync(
					`${claudeHold}.tmp`,
					JSON.stringify({ turn, message, id: Date.now() }),
				);
				renameSync(`${claudeHold}.tmp`, claudeHold);
			} else if (
				typeof codex === "string" &&
				/^\d+$/.test(codex) &&
				Number.isSafeInteger(Number(codex))
			) {
				writeFileSync(codexGate, codex);
			} else if (
				opencode === "session.status" ||
				opencode === "permission.asked" ||
				opencode === "question.asked"
			) {
				const mock = harness["recordedOpenCode"];
				if (!mock)
					throw new ControlError("OpenCode replay mock is absent", hint);
				try {
					openCodeReleases.push(mock.holdNextPrompt(opencode));
				} catch (error) {
					throw new ControlError(
						error instanceof Error ? error.message : String(error),
						"run release --opencode before holding another prompt",
					);
				}
			} else throw new ControlError("invalid replay hold", hint);
			return { held: args };
		}
		case "release":
			return releaseReplays(args);
		case "home":
			await p.goto(harness.baseUrl);
			await waitReady(p);
			return { path: new URL(p.url()).pathname };
		case "reload":
			await p.reload();
			await waitReady(p);
			return { path: new URL(p.url()).pathname };
		case "feature-flag": {
			const name = textArg(args, "name");
			const state = textArg(args, "state");
			const url = new URL(p.url());
			const flags = (url.searchParams.get("feats") ?? "")
				.split(",")
				.filter(Boolean);
			const next = flags.filter((flag) => flag.trim().toLowerCase() !== name);
			if (state === "on") next.push(name);
			else {
				await p.evaluate((flag) => {
					let stored: unknown;
					try {
						stored = JSON.parse(localStorage.getItem("feature-flags") ?? "[]");
					} catch {
						stored = [];
					}
					localStorage.setItem(
						"feature-flags",
						JSON.stringify(
							Array.isArray(stored)
								? stored.filter((value: unknown) => value !== flag)
								: [],
						),
					);
				}, name);
			}
			if (next.length) url.searchParams.set("feats", next.join(","));
			else url.searchParams.delete("feats");
			await p.goto(url.href);
			await waitReady(p);
			return p.evaluate(() => {
				const stored: unknown = JSON.parse(
					localStorage.getItem("feature-flags") ?? "[]",
				);
				return {
					flags: Array.isArray(stored)
						? stored.filter(
								(value: unknown): value is string => typeof value === "string",
							)
						: [],
				};
			});
		}
		case "scroll": {
			const locator = await unique(textArg(args, "selector"));
			const containers = await locator.evaluateHandle((element) => {
				const nodes: HTMLElement[] = [];
				for (
					let node: Element | null = element;
					node;
					node = node.parentElement
				) {
					if (
						node instanceof HTMLElement &&
						/^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)
					)
						nodes.push(node);
				}
				const root =
					document.scrollingElement instanceof HTMLElement
						? document.scrollingElement
						: document.documentElement;
				if (!nodes.includes(root)) nodes.push(root);
				return nodes.map((element) => ({ element, before: element.scrollTop }));
			});
			try {
				await locator.scrollIntoViewIfNeeded();
				if (args["to"] !== undefined) {
					await containers.evaluate((scrollers, to) => {
						const [own] = scrollers;
						if (!own) throw new Error("no scroll container");
						const { element } = own;
						element.scrollTo({
							top: to === "top" ? 0 : element.scrollHeight,
							behavior: "instant",
						});
					}, args["to"]);
				} else if (typeof args["by"] === "number") {
					await locator.hover();
					await p.mouse.wheel(0, args["by"]);
				}
				return await containers.evaluate(async (scrollers, own) => {
					// Wheel dispatch returns before scrolling finishes. Wait for stable frames, also at a boundary.
					let positions = scrollers.map(({ element }) => element.scrollTop);
					let quiet = 0;
					for (let frame = 0; frame < 120 && quiet < 4; frame++) {
						await new Promise<void>((done) =>
							requestAnimationFrame(() => done()),
						);
						const next = scrollers.map(({ element }) => element.scrollTop);
						quiet = next.every((top, index) => top === positions[index])
							? quiet + 1
							: 0;
						positions = next;
					}
					// A wheel can chain past an inner container with no room to scroll.
					const [nearest] = scrollers;
					if (!nearest) throw new Error("no scroll container");
					const { element } = own
						? nearest
						: (scrollers.find(
								({ element, before }) => element.scrollTop !== before,
							) ?? nearest);
					return {
						scrollTop: element.scrollTop,
						scrollHeight: element.scrollHeight,
						clientHeight: element.clientHeight,
					};
				}, args["to"] !== undefined);
			} finally {
				await containers.dispose();
			}
		}
		case "select-project": {
			const project = textArg(args, "project");
			const chip = p.getByTestId("session-scope-chip");
			if (!(await chip.isVisible())) {
				const back = p.getByTestId("session-bar-back");
				if (await back.isVisible()) await back.click();
			}
			if (
				!(await p
					.getByRole("menuitemradio", { name: "All projects", exact: true })
					.isVisible())
			)
				await (await unique("[data-testid=session-scope-chip]")).click();
			const rows = p.getByRole("menuitemradio");
			try {
				await rows.first().waitFor({ state: "visible" });
				const available = await rows.evaluateAll((elements) =>
					elements.flatMap((element) => {
						const token = [...element.querySelectorAll("span")]
							.map((span) => span.textContent?.trim() ?? "")
							.find((text) => /^project:\S+$/.test(text));
						return token
							? [
									{
										slug: token.slice("project:".length),
										name:
											element.querySelector(".truncate")?.textContent?.trim() ??
											"",
									},
								]
							: [];
					}),
				);
				const slugs = available.filter((entry) => entry.slug === project);
				const matches = slugs.length
					? slugs
					: available.filter((entry) => entry.name === project);
				const [target] = matches;
				if (!target || matches.length !== 1)
					throw new ControlError(
						`${matches.length ? "ambiguous" : "unknown"} project '${project}'; available projects: ${available.map(({ name, slug }) => `${name} (${slug})`).join(", ") || "none"}`,
						"run select-project with one of the listed slugs; use snapshot to inspect the scope menu or add a project first",
					);
				const row = rows.filter({
					has: p.getByText(`project:${target.slug}`, { exact: true }),
				});
				if ((await row.count()) !== 1)
					throw new ControlError(
						"project menu changed during selection",
						"run select-project again; use snapshot to inspect the scope menu",
					);
				await row.click();
				await p.waitForURL((url) => url.searchParams.get("p") === target.slug);
				const url = new URL(p.url());
				return { slug: target.slug, path: `${url.pathname}${url.search}` };
			} finally {
				if (await rows.first().isVisible()) await p.keyboard.press("Escape");
			}
		}
		case "new-session": {
			const back = p.getByTestId("session-bar-back");
			if (await back.isVisible()) await back.click();
			await p.locator("#new-session-btn").click();
			await p.locator("#input").waitFor({ state: "visible" });
			return { path: new URL(p.url()).pathname };
		}
		case "open-session":
			await p.goto(
				`${harness.baseUrl}/s/${encodeURIComponent(textArg(args, "id"))}`,
			);
			await p.locator("#input").waitFor({ state: "visible" });
			return { path: new URL(p.url()).pathname };
		case "pick-model":
			return pickModel(args);
		case "send": {
			const started = performance.now();
			const timeout = numberArg(args, "timeout", 60_000);
			if (args["harness"] || args["model"] || args["provider"])
				await pickModel(args);
			await p.locator("#input").fill(textArg(args, "text"));
			const send = p.locator("#send");
			if (await send.isDisabled())
				throw new ControlError(
					"send is disabled",
					"fill a prompt and use pick-model with an available harness, model and provider; snapshot shows missing preconditions",
				);
			const beforeId = sessionId();
			const beforeTurns = turnState(beforeId).length;
			const replies = p.locator(".msg-assistant .md-content");
			const beforeReplies = await replies.count();
			await send.click();
			await p.waitForURL(/\/s\/[^/?]+/, { timeout });
			let turnStatus = turnState(sessionId())[0] ?? null;
			if (!args["noWait"]) {
				while (
					turnState(sessionId()).length <=
					(sessionId() === beforeId ? beforeTurns : 0)
				) {
					if (performance.now() - started >= timeout)
						throw new ControlError(
							"send timeout waiting for a persisted turn",
							"inspect store turns, logs and ws-log",
						);
					await pollDelay(40);
				}
				turnStatus = (
					await settle(
						Math.max(1, timeout - Math.round(performance.now() - started)),
					)
				).turnStatus;
			}
			// A failed turn renders no assistant text, so only a reply added by this send counts.
			const fresh =
				(await replies.count()) >
				(sessionId() === beforeId ? beforeReplies : 0);
			return {
				path: new URL(p.url()).pathname,
				sessionId: sessionId(),
				reply: fresh ? await replies.last().textContent() : null,
				turnStatus,
				ms: Math.round(performance.now() - started),
			};
		}
		case "click": {
			const button = args["button"] ?? "left";
			if (button !== "left" && button !== "right" && button !== "middle")
				throw new ControlError(
					"invalid mouse button",
					"use --button left, right or middle",
				);
			const locator = await unique(textArg(args, "selector"));
			if (args["double"]) await locator.dblclick({ button });
			else await locator.click({ button });
			return { clicked: args["selector"] };
		}
		case "hover":
			await (await unique(textArg(args, "selector"))).hover();
			return { hovered: args["selector"] };
		case "fill":
			await (await unique(textArg(args, "selector"))).fill(
				textArg(args, "text"),
			);
			return { filled: args["selector"] };
		case "type": {
			const focused = await unique(":focus");
			await focused.pressSequentially(textArg(args, "text"));
			return { typed: true };
		}
		case "press": {
			// Page-level shortcuts (Esc to the parent, etc.) fire with nothing focused.
			const key = textArg(args, "key");
			const focused = p.locator(":focus");
			if (await focused.count()) await focused.press(key);
			else await p.keyboard.press(key);
			return { pressed: key };
		}
		case "eval": {
			const source = textArg(args, "source");
			if (!/^\s*(async\s*)?(\(|function\b|[\w$]+\s*=>)/.test(source))
				throw new ControlError(
					"eval source is not a function expression",
					`wrap it: () => ${source}`,
				);
			return p.evaluate(`(${source})()`);
		}
		case "upload-image": {
			const file = resolve(textArg(args, "file"));
			if (!existsSync(file))
				throw new ControlError(
					`image does not exist: ${file}`,
					"pass a readable local image path",
				);
			const beforeCount = await p.getByTestId("draft-attachment").count();
			const menu = p.getByTestId("attach-menu");
			if (!(await menu.isVisible())) await p.locator("#attach-btn").click();
			const [chooser] = await Promise.all([
				p.waitForEvent("filechooser"),
				p.locator("#attach-photos").click(),
			]);
			await chooser.setFiles(file);
			if (await menu.isVisible()) await p.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });
			await p.waitForFunction(
				(count) =>
					document.querySelectorAll('[data-testid="draft-attachment"]').length >
					count,
				beforeCount,
			);
			await p.waitForFunction(() =>
				[
					...document.querySelectorAll('[data-testid="draft-attachment"]'),
				].every((chip) => chip.getAttribute("data-status") !== "saving"),
			);
			return p.getByTestId("draft-attachment").evaluateAll((chips) =>
				chips.map((chip) => ({
					id: chip.getAttribute("data-attachment-id"),
					status: chip.getAttribute("data-status"),
					text: chip.textContent,
					image: !!chip.querySelector("img"),
				})),
			);
		}
		case "wait-settle":
			return settle(numberArg(args, "timeout", 60_000));
		case "snapshot": {
			const snapshot = await p.locator("body").ariaSnapshot();
			if (typeof args["file"] === "string") {
				const file = artifact("snapshots", "yml", args["file"]);
				writeFileSync(file, snapshot);
				return { file };
			}
			const bytes = Buffer.from(snapshot);
			return {
				snapshot: bytes.subarray(0, 20_000).toString(),
				truncated: bytes.length > 20_000,
				...(bytes.length > 20_000
					? {
							note: "truncated at 20 KB; use snapshot --file for the complete tree",
						}
					: {}),
			};
		}
		case "screenshot": {
			const file = artifact("shots", "png", args["file"]);
			await p.screenshot({ path: file });
			return { file };
		}
		case "store": {
			const kind = textArg(args, "kind");
			if (kind === "sql") {
				const sql = textArg(args, "sql").trim().replace(/;\s*$/, "");
				if (!/^select\b/i.test(sql) || sql.includes(";"))
					throw new ControlError(
						"store sql accepts one SELECT statement only",
						"use store sql 'SELECT ...'; mutations are not a verification path",
					);
				return query(sql);
			}
			if (kind === "sessions")
				return query(
					"SELECT id, provider, model_provider, model_id, title, status FROM sessions ORDER BY created_at, id",
				);
			if (kind !== "messages" && kind !== "turns")
				throw new ControlError(
					`unknown store view ${kind}`,
					"use store sessions, messages, turns or sql",
				);
			const where =
				typeof args["session"] === "string" ? " WHERE session_id = ?" : "";
			return query(
				`SELECT ${kind === "messages" ? "session_id, role, text, created_at" : "session_id, state"} FROM ${kind}${where} ORDER BY ${kind === "messages" ? "created_at" : "requested_at"}, rowid`,
				typeof args["session"] === "string" ? [args["session"]] : [],
			);
		}
		case "console":
			return consoleMessages.filter(
				(entry) =>
					(!args["level"] ||
						entry.level ===
							(args["level"] === "warning" ? "warning" : args["level"])) &&
					(typeof args["since"] !== "number" || entry.time >= args["since"]),
			);
		case "ws-log": {
			return webSocketFrames
				.filter((entry) => entry.page === p)
				.slice(-numberArg(args, "last", 300))
				.map(({ time, direction, event, detail, state, url, payload }) => ({
					time,
					direction,
					event,
					detail,
					state,
					url,
					...(args["payloads"] ? { payload } : {}),
				}));
		}
		case "network-log": {
			const pattern =
				typeof args["grep"] === "string" ? new RegExp(args["grep"]) : null;
			const failed = (entry: (typeof networkRequests)[number]) =>
				!!entry.failure || (entry.status !== null && entry.status >= 400);
			const entries = networkRequests
				.filter(
					(entry) =>
						(!args["failed"] || failed(entry)) &&
						(!pattern || pattern.test(entry.url)),
				)
				.slice(-numberArg(args, "last", 100));
			if (!args["summary"]) return entries;
			const byStatus: Record<string, number> = {};
			const byMethodPath: Record<string, number> = {};
			for (const entry of entries) {
				const status = String(
					entry.status ?? (entry.failure ? "failed" : "pending"),
				);
				const path = `${entry.method} ${new URL(entry.url, harness.baseUrl).pathname}`;
				byStatus[status] = (byStatus[status] ?? 0) + 1;
				byMethodPath[path] = (byMethodPath[path] ?? 0) + 1;
			}
			return {
				total: entries.length,
				byStatus,
				byMethodPath,
				failures: entries.filter(failed),
			};
		}
		case "logs": {
			if (args["level"] !== undefined) {
				const level = args["level"];
				if (level !== "verbose" && level !== "info" && level !== "warn")
					throw new ControlError(
						`invalid log level ${String(level)}`,
						"use verbose, info or warn",
					);
				await harness.requestRpc({ _tag: "SetLogLevel", level });
			}
			const file = join(runDir, "server.log");
			if (!existsSync(file)) return [];
			const length = statSync(file).size;
			const buffer = Buffer.alloc(
				Math.min(length, numberArg(args, "bytes", 8000)),
			);
			const fd = openSync(file, "r");
			try {
				readSync(fd, buffer, 0, buffer.length, length - buffer.length);
			} finally {
				closeSync(fd);
			}
			const pattern =
				typeof args["grep"] === "string" ? new RegExp(args["grep"]) : null;
			return buffer
				.toString()
				.split(/\r?\n/)
				.filter((line) => line && (!pattern || pattern.test(line)));
		}
		case "perf-metrics": {
			const cdp = await p.context().newCDPSession(p);
			try {
				await cdp.send("Performance.enable");
				const result = await cdp.send("Performance.getMetrics");
				return Object.fromEntries(
					result.metrics.map(({ name, value }) => [name, value]),
				);
			} finally {
				await cdp.detach();
			}
		}
		case "trace": {
			const action = textArg(args, "action");
			if (action === "start") {
				if (tracing)
					throw new ControlError(
						"trace is already recording",
						"run trace stop first",
					);
				await p.context().tracing.start({ screenshots: true, snapshots: true });
				tracing = true;
				return { recording: true };
			}
			if (action !== "stop" || !tracing)
				throw new ControlError(
					"no active trace to stop",
					"run trace start before trace stop",
				);
			const file = artifact("traces", "zip", args["file"]);
			await p.context().tracing.stop({ path: file });
			tracing = false;
			return {
				file,
				viewCommand: `pnpm exec playwright show-trace ${JSON.stringify(file)}`,
			};
		}
		default:
			throw new ControlError(
				`unknown operation ${op}`,
				"run conduit-verify --help",
			);
	}
}

const startup = start();
void startup.catch((error: unknown) => {
	// The FATAL prefix is what `up` quotes as the failure reason.
	console.error("FATAL startup:", error);
	void stop(1);
});
