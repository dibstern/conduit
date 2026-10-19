/**
 * 82tn.1: capture one OpenCode server serving many directories (ADR-0002).
 * Opt in with RUN_EXPENSIVE_E2E=1; see the spike note for the rerun command.
 * No processes, fixture directories or recordings are created when skipped.
 */
import { execFileSync, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RecordingProxy } from "../../helpers/recording-proxy.js";
import type {
	OpenCodeInteraction,
	OpenCodeRecording,
} from "../fixtures/recorded/types.js";
import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../helpers/opencode-spawner.js";

// The shared spawner has no cwd option. Supply only that missing option here;
// changing process.cwd() is unsupported in Vitest's thread pool.
const spawnContext = vi.hoisted(() => ({
	cwd: undefined as string | undefined,
	children: [] as Pick<SpawnedOpenCode, "process" | "tmpDir">[],
}));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: (
			command: string,
			args: readonly string[],
			options: SpawnOptions,
		) => {
			const child = original.spawn(command, args, {
				...options,
				...(command === "opencode" && spawnContext.cwd
					? { cwd: spawnContext.cwd }
					: {}),
			});
			if (command === "opencode") {
				// Track before health succeeds so failed startup is cleaned up too.
				spawnContext.children.push({
					process: child,
					tmpDir: String(options.env?.["XDG_DATA_HOME"]),
				});
				child.stdout?.resume();
				child.stderr?.resume();
			}
			return child;
		},
	};
});

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";
const FIXTURE_DIR = join(
	import.meta.dirname,
	"../../fixtures/opencode-wire-traces",
);
const MODEL = {
	providerID: "opencode",
	modelID: process.env["E2E_MODEL"] ?? "mimo-v2.6-flash-free",
};
const MODEL_WAIT_MS = 180_000;
const PWD_PROMPT =
	'Use the bash tool exactly once to run the command "pwd". Do not set workdir or change directory. Reply with the tool\'s output, then stop.';
const IDENTITY = { "accept-encoding": "identity" };

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: {};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const accepted = (response: Reply) =>
	response.status >= 200 && response.status < 300;

interface Reply {
	status: number;
	body: unknown;
	elapsedMs: number;
}
interface WireEvent {
	stream: string;
	directory: string | null;
	type: string;
	properties: JsonObject;
	at: number;
}
const sessionOf = (event: WireEvent): unknown =>
	event.properties["sessionID"] ??
	object(event.properties["part"])["sessionID"] ??
	object(event.properties["info"])["sessionID"] ??
	(event.type.startsWith("session.")
		? object(event.properties["info"])["id"]
		: undefined);
const idle = (event: WireEvent) =>
	event.type === "session.idle" ||
	(event.type === "session.status" &&
		object(event.properties["status"])["type"] === "idle");

/** REST uses the SDK's default-directory shape: GET query, POST encoded header.
 * RecordingProxy drops stream provenance, so retain envelopes beside its trace.
 */
class Wire {
	readonly proxy: RecordingProxy;
	readonly events: WireEvent[] = [];
	readonly requests: {
		method: string;
		path: string;
		directory: string;
		status: number;
	}[] = [];
	readonly streamErrors: string[] = [];
	readonly additionalTraffic: OpenCodeInteraction[] = [];
	private readonly controllers: AbortController[] = [];
	private readonly pumps: Promise<void>[] = [];

	constructor(upstream: string) {
		this.proxy = new RecordingProxy(upstream);
	}

	async request(
		directory: string,
		path: string,
		body?: unknown,
	): Promise<Reply> {
		const method = body === undefined ? "GET" : "POST";
		const started = performance.now();
		const response = await fetch(
			`${this.proxy.url}${path}${method === "GET" ? `?directory=${encodeURIComponent(directory)}` : ""}`,
			{
				method,
				headers: {
					...IDENTITY,
					...(method === "POST"
						? {
								"content-type": "application/json",
								"x-opencode-directory": encodeURIComponent(directory),
							}
						: {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		const text = await response.text();
		let parsed: unknown = text;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			// Preserve HTML/error bodies as observations, including unsupported APIs.
		}
		this.requests.push({ method, path, directory, status: response.status });
		return {
			status: response.status,
			body: parsed,
			elapsedMs: performance.now() - started,
		};
	}

	async stream(directory?: string): Promise<void> {
		const path = directory
			? `/event?directory=${encodeURIComponent(directory)}`
			: "/global/event";
		const controller = new AbortController();
		this.controllers.push(controller);
		const response = await fetch(`${this.proxy.url}${path}`, {
			headers: IDENTITY,
			signal: controller.signal,
		});
		const reader = response.body?.getReader();
		if (!response.ok || !reader)
			throw new Error(`SSE ${path}: ${response.status}`);
		this.pumps.push(
			(async () => {
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) return;
						buffer += decoder.decode(value, { stream: true });
						const blocks = buffer.split(/\r?\n\r?\n/);
						buffer = blocks.pop() ?? "";
						for (const block of blocks) {
							const data = block
								.split(/\r?\n/)
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trimStart())
								.join("\n");
							if (!data) continue;
							const envelope = object(JSON.parse(data));
							const event = object(envelope["payload"] ?? envelope);
							if (typeof event["type"] !== "string") continue;
							this.events.push({
								stream: path,
								directory:
									typeof envelope["directory"] === "string"
										? envelope["directory"]
										: null,
								type: event["type"],
								properties: object(event["properties"]),
								at: performance.now(),
							});
						}
					}
				} catch (error) {
					if (!controller.signal.aborted)
						this.streamErrors.push(`${path}: ${String(error)}`);
				} finally {
					reader.releaseLock();
				}
			})(),
		);
		// Await this connection's handshake, not an earlier stream's event.
		const deadline = performance.now() + 30_000;
		while (!this.events.some((event) => event.stream === path)) {
			if (performance.now() > deadline || this.streamErrors.length)
				throw new Error(`No SSE handshake: ${path}`);
			await pause(50);
		}
	}

	async close(): Promise<void> {
		for (const controller of this.controllers) controller.abort();
		// The proxy owns upstream readers independently of downstream disconnects.
		// reset() cancels them; copy recordings before closing this wire.
		this.proxy.reset();
		await Promise.allSettled(this.pumps);
		await this.proxy.stop();
	}

	coverage(sessionID: string) {
		return [...new Set(this.events.map((event) => event.stream))].map(
			(stream) => {
				const events = this.events.filter(
					(event) => event.stream === stream && sessionOf(event) === sessionID,
				);
				return {
					stream,
					count: events.length,
					types: [...new Set(events.map((event) => event.type))],
					envelopeDirectories: [
						...new Set(events.map((event) => event.directory)),
					],
				};
			},
		);
	}
}

/** Observe only this prompt's events. Optional/API/model outcomes are data, not
 * assertions. Permission replies follow OpenCodeAPI.permission.reply verbatim.
 */
function startTurn(
	wire: Wire,
	sessionID: string,
	directory: string,
	text: string,
) {
	const started = performance.now();
	const offset = wire.events.length;
	let done = false;
	const events = () => {
		const observed = wire.events
			.slice(offset)
			.filter((event) => sessionOf(event) === sessionID);
		// A session can appear on several streams. Prefer the global stream,
		// with a directory-stream fallback, so text deltas aren't counted twice.
		const stream = observed.some((event) => event.stream === "/global/event")
			? "/global/event"
			: observed[0]?.stream;
		return observed.filter((event) => event.stream === stream);
	};
	const finished = (async () => {
		const response = await wire.request(
			directory,
			`/session/${sessionID}/prompt_async`,
			{
				model: MODEL,
				agent: "build",
				parts: [{ type: "text", text }],
			},
		);
		const permissions: {
			request: JsonObject;
			directory: string;
			response: Reply;
		}[] = [];
		const answered = new Set<string>();
		let ended: WireEvent | undefined;
		while (accepted(response) && performance.now() - started < MODEL_WAIT_MS) {
			for (const event of events()) {
				const id = event.properties["id"];
				if (
					event.type !== "permission.asked" ||
					typeof id !== "string" ||
					answered.has(id)
				)
					continue;
				answered.add(id);
				const scope = event.directory ?? directory;
				permissions.push({
					request: event.properties,
					directory: scope,
					response: await wire.request(
						scope,
						`/session/${sessionID}/permissions/${id}`,
						{ response: "once" },
					),
				});
			}
			ended = events().find(idle);
			if (ended || events().some((event) => event.type === "session.error"))
				break;
			await pause(50);
		}
		const timedOut =
			accepted(response) &&
			!ended &&
			!events().some((event) => event.type === "session.error");
		let timeoutCleanup: { abort: Reply; idleObserved: boolean } | null = null;
		if (timedOut) {
			// A surprising timeout is evidence. Release the session before the
			// next scenario so its pending turn cannot answer that prompt.
			const scope =
				events().find((event) => event.directory)?.directory ?? directory;
			const abort = await wire.request(
				scope,
				`/session/${sessionID}/abort`,
				{},
			);
			const deadline = performance.now() + 10_000;
			while (!events().some(idle) && performance.now() < deadline)
				await pause(50);
			timeoutCleanup = { abort, idleObserved: events().some(idle) };
		}
		const observed = events();
		const assistantIDs = new Set(
			observed
				.filter(
					(event) =>
						event.type === "message.updated" &&
						object(event.properties["info"])["role"] === "assistant",
				)
				.map((event) => object(event.properties["info"])["id"]),
		);
		const firstText = observed.find((event) => {
			const part = object(event.properties["part"]);
			return (
				(event.type === "message.part.updated" &&
					part["type"] === "text" &&
					assistantIDs.has(part["messageID"]) &&
					typeof part["text"] === "string" &&
					part["text"].length > 0) ||
				(event.type === "message.part.delta" &&
					assistantIDs.has(event.properties["messageID"]) &&
					event.properties["field"] === "text" &&
					Boolean(event.properties["delta"]))
			);
		});
		const parts = new Map<unknown, JsonObject>();
		for (const event of observed) {
			if (event.type === "message.part.updated") {
				const part = object(event.properties["part"]);
				parts.set(part["id"], part);
			} else if (
				event.type === "message.part.delta" &&
				event.properties["field"] === "text"
			) {
				const id = event.properties["partID"];
				const part = parts.get(id) ?? {
					id,
					type: "text",
					messageID: event.properties["messageID"],
				};
				parts.set(id, {
					...part,
					text:
						String(part["text"] ?? "") +
						String(event.properties["delta"] ?? ""),
				});
			}
		}
		return {
			response,
			permissions,
			latencyLabel: "model-dominated",
			firstAssistantTextMs: firstText ? firstText.at - started : null,
			idleMs: ended ? ended.at - started : null,
			elapsedMs: performance.now() - started,
			timedOut,
			timeoutCleanup,
			errors: observed
				.filter((event) => event.type === "session.error")
				.map((event) => event.properties),
			tools: [...parts.values()].filter((part) => part["type"] === "tool"),
			assistantText: [...parts.values()]
				.filter(
					(part) =>
						part["type"] === "text" && assistantIDs.has(part["messageID"]),
				)
				.map((part) => part["text"])
				.join("\n"),
		};
	})().finally(() => {
		done = true;
	});
	return { finished, events, isDone: () => done };
}

function rss(server: SpawnedOpenCode) {
	try {
		const value = Number(
			execFileSync("ps", ["-o", "rss=", "-p", String(server.process.pid)], {
				encoding: "utf8",
				timeout: 10_000,
			}).trim(),
		);
		return {
			rssKiB: Number.isFinite(value) && value > 0 ? value : null,
			error: null,
		};
	} catch (error) {
		return { rssKiB: null, error: String(error) };
	}
}

async function stopServer(server: Pick<SpawnedOpenCode, "process" | "tmpDir">) {
	try {
		if (
			server.process.exitCode === null &&
			server.process.signalCode === null
		) {
			const exited = new Promise<void>((resolve) =>
				server.process.once("close", () => resolve()),
			);
			server.process.kill("SIGTERM");
			const force = setTimeout(() => server.process.kill("SIGKILL"), 3_000);
			try {
				await exited;
			} finally {
				clearTimeout(force);
			}
		}
	} finally {
		rmSync(server.tmpDir, { recursive: true, force: true });
	}
}

/** Keep the recording schema intact. Normalize dynamic content recursively,
 * including object keys and IDs embedded in REST paths and model/tool text.
 * Actual timings stay in measurements; replay delays and wall clocks are zeroed.
 */
function normalizer(paths: [string, string][], token: string) {
	const ids = new Map<string, string>();
	const counts = new Map<string, number>();
	const replaceID = (id: string) => {
		if (!ids.has(id)) {
			const kind = id.includes("_") ? (id.split("_")[0] ?? "id") : "project";
			const count = (counts.get(kind) ?? 0) + 1;
			counts.set(kind, count);
			ids.set(id, `${kind}_${count}`);
		}
		return ids.get(id) ?? id;
	};
	const substitutions = paths
		.flatMap(([path, label]) => [
			[path, label],
			[encodeURIComponent(path), label],
			// Sessions outside a git repo report `path` relative to worktree "/".
			[path.replace(/^\//, ""), label],
		])
		.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0));
	const normalize = (value: unknown, key = ""): unknown => {
		if (typeof value === "string") {
			let text = value.replaceAll(token, "<TOKEN>");
			for (const [path, label] of substitutions)
				if (path && label) text = text.replaceAll(path, label);
			return text
				.replace(
					/\b(?:ses|msg|prt|call|perm|per|req|que|evt)_[A-Za-z0-9_-]+\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g,
					replaceID,
				)
				.replace(
					/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
					"1970-01-01T00:00:00.000Z",
				);
		}
		if (
			typeof value === "number" &&
			(key === "delayMs" || value > 1_000_000_000_000)
		)
			return 0;
		if (Array.isArray(value)) return value.map((item) => normalize(item));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([name, item]) => [
					String(normalize(name)),
					normalize(item, name),
				]),
			);
		return value;
	};
	return normalize;
}

describe.skipIf(!RUN_EXPENSIVE)("OpenCode directory spike capture", () => {
	it("captures directory, isolation, permission and cost policy evidence", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "opencode-directory-spike-")),
		);
		const directories = {
			A: join(root, "A"),
			B: join(root, "B"),
			C: join(root, "C"),
			N: join(root, "N"),
			E: join(root, "E"),
		};
		const { A, B, C, N, E } = directories;
		const token = randomBytes(24).toString("hex");
		const servers: SpawnedOpenCode[] = [];
		const cleanupFailures: unknown[] = [];
		const recordings: OpenCodeRecording[] = [];
		const scenarios: Record<string, unknown> = {};
		const sessions: Record<string, string> = {};
		const paths: [string, string][] = [
			...Object.entries(directories).map(([name, path]): [string, string] => [
				path,
				`<${name}>`,
			]),
			[root, "<ROOT>"],
		];
		let version = "unknown";
		const spawnServer = async (cwd: string) => {
			spawnContext.cwd = cwd;
			try {
				const server = await spawnOpenCode({
					timeoutMs: 60_000,
					env: {
						OPENCODE_CONFIG: "",
						OPENCODE_CONFIG_DIR: "",
						OPENCODE_CONFIG_CONTENT: "{}",
					},
				});
				// spawnOpenCode awaits a free port before spawning; keep the scope set
				// through startup. All server starts in this file are sequential.
				servers.push(server);
				paths.push(
					[server.tmpDir, `<SERVER_${servers.length}_DATA>`],
					[realpathSync(server.tmpDir), `<SERVER_${servers.length}_DATA>`],
					[server.url, `<SERVER_${servers.length}>`],
				);
				return server;
			} finally {
				spawnContext.cwd = undefined;
			}
		};
		const scenario = async (
			name: string,
			server: SpawnedOpenCode,
			run: (wire: Wire) => Promise<unknown>,
		) => {
			const wire = new Wire(server.url);
			try {
				await wire.proxy.start();
				paths.push([wire.proxy.url, `<PROXY_${recordings.length + 1}>`]);
				const result = await run(wire);
				// Let sibling SSE connections drain already-forwarded events.
				await pause(200);
				scenarios[name] = {
					result,
					requests: wire.requests,
					streamErrors: wire.streamErrors,
				};
				recordings.push({
					name: `directory-${name}`,
					recordedAt: new Date().toISOString(),
					opencodeVersion: version,
					interactions: [
						...wire.proxy.getRecording(),
						...wire.additionalTraffic,
					],
				});
			} finally {
				await wire.close();
			}
		};
		const create = async (wire: Wire, directory: string, title: string) => {
			const response = await wire.request(directory, "/session", { title });
			expect(accepted(response), JSON.stringify(response)).toBe(true);
			const id = object(response.body)["id"];
			expect(typeof id).toBe("string");
			if (typeof id !== "string")
				throw new Error("Session creation returned no id");
			return { id, response };
		};
		const probe = async (
			wire: Wire,
			id: string,
			target: string,
			ownDirectory: string,
		) => {
			const turn = await startTurn(wire, id, target, PWD_PROMPT).finished;
			return {
				target,
				turn,
				lookupAtTarget: await wire.request(target, `/session/${id}`),
				lookupAtOrigin: await wire.request(ownDirectory, `/session/${id}`),
				streams: wire.coverage(id),
			};
		};
		const assertPwd = (
			turn: Awaited<ReturnType<typeof startTurn>["finished"]>,
			directory: string,
		) => {
			const outputs = turn.tools
				.filter((tool) => tool["tool"] === "bash")
				.map((tool) => String(object(tool["state"])["output"] ?? ""));
			expect(
				outputs.some((output) => output.includes(directory)),
				JSON.stringify(turn),
			).toBe(true);
		};
		try {
			for (const directory of [A, B, C, E]) mkdirSync(directory);
			for (const [name, directory] of [
				["A", A],
				["B", B],
			] as const) {
				writeFileSync(
					join(directory, "initial.txt"),
					`Distinct project ${name}\n`,
				);
				const git = (args: string[]) =>
					execFileSync(
						"git",
						[
							"-c",
							"core.hooksPath=/dev/null",
							"-c",
							"commit.gpgsign=false",
							...args,
						],
						{
							cwd: directory,
							encoding: "utf8",
							timeout: 10_000,
							stdio: "pipe",
						},
					);
				git(["init"]);
				git(["add", "initial.txt"]);
				git([
					"-c",
					"user.name=Directory spike",
					"-c",
					"user.email=spike@example.invalid",
					"commit",
					"-m",
					`Initial ${name}`,
				]);
			}
			writeFileSync(join(E, "token.txt"), `${token}\n`);
			version = execFileSync("opencode", ["--version"], {
				encoding: "utf8",
				timeout: 10_000,
			}).trim();
			const server = await spawnServer(A);
			const bootRss = rss(server);

			// S7 runs first: model traffic and /event subscriptions initialize
			// directories, which would confound cold contact and boot RSS.
			await scenario("s7-cost", server, async (wire) => {
				const contacts = [];
				const checkpoints = [];
				for (let count = 1; count <= 10; count++) {
					const directory = join(root, `cost-${count}`);
					mkdirSync(directory);
					const cold = await wire.request(directory, "/project/current");
					const afterCold = rss(server);
					const warm = await wire.request(directory, "/project/current");
					contacts.push({ directory, cold, warm, afterCold });
					if ([1, 5, 10].includes(count))
						checkpoints.push({ newDirectoryCount: count, ...afterCold });
				}
				const separate = [];
				// Keep all three alive while sampling their sum.
				for (const directory of [A, B, C]) {
					const other = await spawnServer(directory);
					const proxy = new Wire(other.url);
					try {
						await proxy.proxy.start();
						const contact = await proxy.request(directory, "/project/current");
						separate.push({ directory, server: other, contact });
						// One S7 recording includes comparison traffic as well.
						wire.additionalTraffic.push(...proxy.proxy.getRecording());
					} finally {
						await proxy.close();
					}
				}
				const comparison = separate.map(
					({ directory, server: other, contact }) => ({
						directory,
						contact,
						...rss(other),
					}),
				);
				const total = comparison.every((sample) => sample.rssKiB !== null)
					? comparison.reduce((sum, sample) => sum + (sample.rssKiB ?? 0), 0)
					: null;
				for (const { server: other } of separate) await stopServer(other);
				return {
					bootRss,
					contactMethod: "GET /project/current",
					latencyLabel:
						"local REST round trip through RecordingProxy; no model",
					contacts,
					checkpoints,
					comparison,
					separateServersSummedRssKiB: total,
				};
			});

			await scenario("s1-multi-directory", server, async (wire) => {
				await wire.stream();
				const created = [];
				for (const [name, directory] of [
					["A", A],
					["B", B],
					["C", C],
				] as const) {
					const session = await create(wire, directory, `directory-${name}`);
					sessions[name] = session.id;
					created.push({ name, directory, ...session });
				}
				for (const directory of [A, B, C]) await wire.stream(directory);
				const results = [];
				for (const session of created) {
					const result = await probe(
						wire,
						session.id,
						session.directory,
						session.directory,
					);
					assertPwd(result.turn, session.directory);
					results.push({ ...session, ...result });
				}
				return {
					setup:
						"POST /session before per-directory stream subscriptions; no registration/config call",
					results,
				};
			});

			await scenario("s2-new-directory", server, async (wire) => {
				await wire.stream();
				mkdirSync(N);
				const session = await create(wire, N, "directory-N-created-after-boot");
				for (const directory of [A, B, C, N]) await wire.stream(directory);
				const result = await probe(wire, session.id, N, N);
				assertPwd(result.turn, N);
				return {
					createdAfterBoot: true,
					setup:
						"mkdir only, then POST /session; no project registration/config call",
					session,
					...result,
				};
			});

			const a = sessions["A"];
			const b = sessions["B"];
			const c = sessions["C"];
			if (!a || !b || !c) throw new Error("S1 did not create A/B/C sessions");
			await scenario("s3-resume-other-directory", server, async (wire) => {
				await wire.stream();
				for (const directory of [A, B, C]) await wire.stream(directory);
				return {
					bTargetingC: await probe(wire, b, C, B),
					cTargetingA: await probe(wire, c, A, C),
				};
			});

			await scenario("s4-fork-other-directory", server, async (wire) => {
				await wire.stream();
				for (const directory of [A, B, C]) await wire.stream(directory);
				const fork = await wire.request(C, `/session/${b}/fork`, {});
				const id = object(fork.body)["id"];
				if (!accepted(fork) || typeof id !== "string")
					return { fork, prompt: "Not attempted: fork returned no session" };
				// No destination field exists on classic fork. Target C using the
				// request directory and observe what the server actually chooses.
				return {
					fork,
					probe: await probe(
						wire,
						id,
						C,
						typeof object(fork.body)["directory"] === "string"
							? String(object(fork.body)["directory"])
							: C,
					),
				};
			});

			await scenario("s5-hung-session-isolation", server, async (wire) => {
				await wire.stream();
				for (const directory of [A, B, C]) await wire.stream(directory);
				const hung = startTurn(
					wire,
					a,
					A,
					'Use the bash tool to run the command "sleep 60 && echo hung-done". Do not change directory. Then reply HUNG-FINISHED.',
				);
				// Observe rejections without an unhandled promise while waiting for
				// the tool boundary. Transport failures still fail the capture.
				const hungResult = hung.finished;
				await Promise.race([
					hungResult,
					(async () => {
						while (
							!hung.isDone() &&
							!hung.events().some((event) => {
								const part = object(event.properties["part"]);
								return (
									part["tool"] === "bash" &&
									object(part["state"])["status"] === "running" &&
									String(
										object(object(part["state"])["input"])["command"],
									).includes("sleep 60")
								);
							})
						)
							await pause(50);
					})(),
				]);
				const toolStarted = hung.events().find((event) => {
					const part = object(event.properties["part"]);
					return (
						part["tool"] === "bash" &&
						object(part["state"])["status"] === "running"
					);
				});
				const peerStartedAt = performance.now();
				const overlapEstablished = Boolean(toolStarted) && !hung.isDone();
				const peers = Promise.all([
					startTurn(wire, b, B, "Reply with only ISOLATION-B.").finished,
					startTurn(wire, c, C, "Reply with only ISOLATION-C.").finished,
				]);
				// Abort while the 60-second tool is still running even if a peer's
				// model takes longer. Peer waits continue across the abort.
				await Promise.race([peers, pause(40_000)]);
				const abortAt = performance.now();
				const aIdleBeforeAbort = hung.events().some(idle);
				const abort = await wire.request(A, `/session/${a}/abort`, {});
				const [aResult, peerResults] = await Promise.all([hungResult, peers]);
				const followups = await Promise.all([
					startTurn(wire, b, B, "Reply with only AFTER-ABORT-B.").finished,
					startTurn(wire, c, C, "Reply with only AFTER-ABORT-C.").finished,
				]);
				return {
					toolStarted: toolStarted?.properties ?? null,
					overlapEstablished,
					aIdleBeforeAbort,
					abortAfterToolStartedMs: toolStarted
						? abortAt - toolStarted.at
						: null,
					abort,
					aResult,
					aIdleAfterAbort: wire.events.some(
						(event) =>
							sessionOf(event) === a && idle(event) && event.at >= abortAt,
					),
					peers: peerResults,
					peerIdleBeforeAbort: [b, c].map((id) =>
						wire.events.some(
							(event) =>
								sessionOf(event) === id &&
								idle(event) &&
								event.at >= peerStartedAt &&
								event.at < abortAt,
						),
					),
					postAbortFollowups: followups,
					peerErrors: wire.events
						.filter(
							(event) =>
								[b, c].includes(String(sessionOf(event))) &&
								event.type === "session.error",
						)
						.map((event) => ({
							stream: event.stream,
							properties: event.properties,
						})),
					statuses: await Promise.all(
						[A, B, C].map((directory) =>
							wire.request(directory, "/session/status"),
						),
					),
				};
			});

			await scenario("s6-external-folder-access", server, async (wire) => {
				await wire.stream();
				for (const directory of [A, B, C]) await wire.stream(directory);
				const config = await wire.request(B, "/config");
				const turn = await startTurn(
					wire,
					b,
					B,
					`Use the read tool to read the file at this absolute path: ${join(E, "token.txt")} . Do not use bash or other tools. Reply with the file contents. If permission is requested, wait for my reply.`,
				).finished;
				return {
					permissionConfig:
						"OpenCode defaults; no session permission overrides",
					config,
					tokenFile: join(E, "token.txt"),
					turn,
					permissionTypes: turn.permissions.map(
						(permission) => permission.request["permission"],
					),
					tokenReturned: turn.assistantText.includes(token),
					tokenInReadOutput: turn.tools.some(
						(tool) =>
							tool["tool"] === "read" &&
							String(object(tool["state"])["output"] ?? "").includes(token),
					),
					streams: wire.coverage(b),
				};
			});

			// Publish only after all deterministic assertions and scenarios pass.
			const normalize = normalizer(paths, token);
			mkdirSync(FIXTURE_DIR, { recursive: true });
			for (const recording of recordings)
				writeFileSync(
					join(FIXTURE_DIR, `${recording.name}.json`),
					`${JSON.stringify(normalize(recording), null, "\t")}\n`,
				);
			writeFileSync(
				join(FIXTURE_DIR, "directory-spike-measurements.json"),
				`${JSON.stringify(normalize({ version, platform: { os: platform(), arch: arch(), release: release() }, model: MODEL, serverCwd: A, scenarios }), null, "\t")}\n`,
			);
		} finally {
			const cleanup = await Promise.allSettled(
				spawnContext.children.map(stopServer),
			);
			rmSync(root, { recursive: true, force: true });
			for (const result of cleanup)
				if (result.status === "rejected") cleanupFailures.push(result.reason);
		}
		if (cleanupFailures.length)
			throw new AggregateError(
				cleanupFailures,
				"OpenCode spike cleanup failed",
			);
	}, 2_400_000);
});
