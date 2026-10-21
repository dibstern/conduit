import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Option, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { runnerDirectory } from "../../../src/lib/provider/runner/runner-registry.js";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	state: string;
	startTicks?: string;
	startTime?: string;
	argv: string[];
	cgroup?: string;
	pgid?: number;
	sid?: string;
}

export interface ServicePlatform {
	name: string;
	config: string;
	project: string;
	artifacts: string;
	counter: string;
	processInfo(pid: number): ProcessInfo | undefined;
	processes(): ProcessInfo[];
	serverPid(
		run: (command: string, args: string[]) => Promise<string>,
	): Promise<number>;
	assertOwners(server: ProcessInfo, owners: ProcessInfo[]): void;
}

// Both service managers exercise the same real-SDK, history and PTY checks.
export function createServiceDriver(platform: ServicePlatform) {
	const { config, project, artifacts, processInfo, processes } = platform;
	const socket = join(config, "relay.sock");
	const finalSentence = "Conduit runtime survival verified.";
	const exec = promisify(execFile);
	let projectSlug = "";
	let phase = "startup";
	const pendingMarkers = new Set<string>();
	mkdirSync(artifacts, { recursive: true });
	function record(event: string, data: Record<string, unknown>) {
		const entry = { at: new Date().toISOString(), phase, event, ...data };
		const line = JSON.stringify(entry);
		appendFileSync(join(artifacts, "evidence.jsonl"), `${line}\n`);
		console.log(line);
	}

	async function run(command: string, args: string[]) {
		try {
			const { stdout, stderr } = await exec(command, args, {
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			record("command", { command, args, stdout, stderr });
			return stdout.trim();
		} catch (error) {
			record("command-failed", { command, args, error: String(error) });
			throw error;
		}
	}

	async function eventually<T>(
		description: string,
		read: () => Promise<T>,
		timeoutMs = 60_000,
	): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		let last: unknown;
		while (Date.now() < deadline) {
			try {
				return await read();
			} catch (error) {
				last = error;
				await sleep(300);
			}
		}
		throw new Error(
			`${description} timed out after ${timeoutMs}ms: ${String(last)}`,
		);
	}

	function alive(info: ProcessInfo): boolean {
		const now = processInfo(info.pid);
		return (
			now !== undefined &&
			now.state !== "Z" &&
			now.startTicks === info.startTicks &&
			now.startTime === info.startTime
		);
	}

	function runtimeProcesses(): ProcessInfo[] {
		return processes().filter(
			({ argv }) =>
				argv.some(
					(arg) =>
						arg.endsWith("/claude-session-runner.js") ||
						arg.endsWith("/pty-host.js") ||
						arg.endsWith("/managed-opencode-supervisor.js"),
				) ||
				(argv.includes("serve") &&
					argv.some((arg) => /(^|\/)opencode$/.test(arg))),
		);
	}

	async function server(): Promise<ProcessInfo> {
		const pid = await platform.serverPid(run);
		const info = processInfo(pid);
		assert(info && info.state !== "Z", `No live conduit MainPID (${pid})`);
		assert(
			info.argv.includes("serve"),
			`MainPID is not conduit serve: ${info.argv.join(" ")}`,
		);
		await sendRpcRequest(
			socket,
			{ _tag: "GetStatus" },
			{
				startupRetries: 0,
				requestTimeoutMs: 2000,
			},
		);
		return info;
	}

	function runner(sessionId: string): ProcessInfo {
		const directory = runnerDirectory(project, config);
		for (const filename of readdirSync(directory)) {
			if (!/^[0-9a-f]{12}\.json$/.test(filename)) continue;
			const entry = JSON.parse(
				readFileSync(join(directory, filename), "utf8"),
			) as { sessionId?: string; pid?: number };
			if (entry.sessionId !== sessionId || entry.pid === undefined) continue;
			const info = processInfo(entry.pid);
			if (info && info.state !== "Z") {
				assert(
					info.argv.some((arg) => arg.endsWith("/claude-session-runner.js")),
				);
				assert(info.argv.includes(sessionId));
				return info;
			}
		}
		throw new Error(`No live runner registration for ${sessionId}`);
	}

	async function ptySnapshot() {
		// Same streaming browser RPC, with the CLI socket's NDJSON framing. Each
		// fresh subscription restores the PTY host's actual scrollback ring.
		return Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* NodeSocket.makeNet({ path: socket });
					return yield* Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						const snapshot = yield* client.SubscribePtys({ projectSlug }).pipe(
							Stream.filter((event) => event._tag === "snapshot"),
							Stream.runHead,
						);
						return Option.getOrThrow(snapshot);
					}).pipe(
						Effect.provide(
							RpcClient.layerProtocolSocket({
								retryPolicy: Schedule.recurs(0),
							}),
						),
						Effect.provideService(Socket.Socket, connection),
						Effect.provide(RpcSerialization.layerNdjson),
					);
				}),
			).pipe(Effect.timeout("10 seconds")),
		);
	}

	async function scrollback(ptyId: string): Promise<string> {
		const snapshot = await ptySnapshot();
		const row = snapshot.rows.find(({ pty }) => pty.id === ptyId);
		assert(row, `PTY ${ptyId} absent from SubscribePtys snapshot`);
		return row.scrollback;
	}

	interface MockEvent {
		event: string;
		marker?: string;
		id?: string;
		index?: number;
	}

	function mockEvents(marker: string): MockEvent[] {
		return readFileSync(join(artifacts, "mock-requests.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as MockEvent)
			.filter((event) => event.marker === marker);
	}

	async function streaming(marker: string) {
		await eventually(`real SDK streaming ${marker}`, async () => {
			const events = mockEvents(marker);
			assert(events.some((event) => event.event === "delta"));
			assert(events.some((event) => event.event === "held"));
			assert(
				!events.some(
					(event) =>
						event.event === "finished" || event.event === "disconnected",
				),
			);
		});
		record("mock-held", { marker });
	}

	function releaseStream(marker: string, reason: string) {
		record("mock-release-requested", { marker, reason });
		writeFileSync(join(artifacts, `${marker}.release`), `${reason}\n`);
		pendingMarkers.delete(marker);
	}

	function releaseHeldStreams() {
		// Files are shared with the mock on both platforms. Cleanup never waits
		// for the mock or for a held HTTP response to finish.
		for (const marker of pendingMarkers) releaseStream(marker, "cleanup");
	}

	function assertMidTurn(marker: string) {
		const events = mockEvents(marker);
		const deltas = events.filter((event) => event.event === "delta");
		const index = deltas.at(-1)?.index ?? 0;
		const held = events.find((event) => event.event === "held");
		assert(
			held?.id && index > 0 && index === held.index,
			`Disruption must happen mid-turn; ${marker} must be held at delta ${index}`,
		);
		assert(
			!events.some(
				(event) =>
					event.event === "released" ||
					event.event === "finished" ||
					event.event === "disconnected",
			),
			`${marker} was released, finished or disconnected before the mid-turn check`,
		);
		record("mock-mid-turn", { marker, id: held.id, delta: index });
		return held.id;
	}

	async function startScenario(label: "A" | "B" | "C" | "D" | "CONTROL") {
		phase = label;
		const marker = `CONDUIT_M37913_${label}`;
		pendingMarkers.add(marker);
		const { sessionId } = await sendRpcRequest(
			socket,
			{
				_tag: "CreateSession",
				projectSlug,
				originId: randomUUID(),
				providerId: "claude",
				permissionMode: "ask",
				title: `${platform.name} service ${label}`,
				model: { modelId: "sonnet", providerId: "claude" },
			},
			{ requestTimeoutMs: 60_000 },
		);
		record("session-created", { sessionId, marker });
		const result = await sendRpcRequest(
			socket,
			{
				_tag: "input.submit",
				sessionId,
				inputId: randomUUID(),
				text: `${marker}: Reply with a plain text response. Do not use tools.`,
				delivery: "queue",
			},
			{ requestTimeoutMs: 60_000 },
		);
		assert(result.ok, `Prompt rejected for ${sessionId}`);
		await streaming(marker);
		await eventually("runner registration", async () => runner(sessionId));
		const beforePtys = await sendRpcRequest(socket, {
			_tag: "ListPtys",
			projectSlug,
			originId: randomUUID(),
		});
		await sendRpcRequest(socket, {
			_tag: "CreatePty",
			projectSlug,
			originId: randomUUID(),
		});
		const pty = await eventually("new PTY", async () => {
			const current = await sendRpcRequest(socket, {
				_tag: "ListPtys",
				projectSlug,
				originId: randomUUID(),
			});
			const created = current.ptys.find(
				(item) => !beforePtys.ptys.some((old) => old.id === item.id),
			);
			assert(created, "New PTY not listed");
			return created;
		});
		await sendRpcRequest(socket, {
			_tag: "PtyInput",
			projectSlug,
			ptyId: pty.id,
			data: `exec /bin/bash '${platform.counter.replaceAll("'", "'\"'\"'")}' ${label}\r`,
		});
		const beforeText = await eventually(
			"counter ticks before disruption",
			async () => {
				const text = await scrollback(pty.id);
				assert(
					text.includes(`counter-pid ${pty.pid} ${label}`),
					"Counter did not exec over the PTY shell",
				);
				assert(text.includes(`tick 2 ${label}`));
				return text;
			},
		);
		const serverInfo = await server();
		const runnerInfo = runner(sessionId);
		const hosts = processes().filter(({ argv }) =>
			argv.some((arg) => arg.endsWith("/pty-host.js")),
		);
		assert.equal(hosts.length, 1, "Expected exactly one detached PTY host");
		const hostInfo = hosts[0];
		const counterInfo = processInfo(pty.pid);
		assert(hostInfo && counterInfo);
		platform.assertOwners(serverInfo, [runnerInfo, hostInfo, counterInfo]);
		const streamId = assertMidTurn(marker);
		const before = {
			server: serverInfo,
			runner: runnerInfo,
			ptyHost: hostInfo,
			counter: counterInfo,
		};
		writeFileSync(join(artifacts, `${label}-pty-before.txt`), beforeText);
		record("before", {
			sessionId,
			marker,
			ptyId: pty.id,
			pids: before,
			runtimes: runtimeProcesses(),
		});
		return {
			label,
			marker,
			streamId,
			sessionId,
			ptyId: pty.id,
			beforeText,
			before,
		};
	}

	type Scenario = Awaited<ReturnType<typeof startScenario>>;

	async function completedTurn(scenario: Scenario) {
		const text = await eventually(
			"finished turn persisted after restart",
			async () => {
				const history = await sendRpcRequest(socket, {
					_tag: "LoadMoreHistory",
					sessionId: scenario.sessionId,
				});
				const assistantText = history.messages
					.filter((message) => message.role === "assistant")
					.map(
						(message) =>
							message.text ??
							message.parts
								?.filter((part) => part.type === "text")
								.map((part) => part.text ?? "")
								.join("") ??
							"",
					)
					.join("\n");
				assert(
					assistantText.includes(finalSentence),
					"Final sentence not persisted",
				);
				const sessions = await sendRpcRequest(socket, {
					_tag: "ListDaemonSessions",
					projectSlug,
				});
				assert.equal(
					sessions.sessions.find((session) => session.id === scenario.sessionId)
						?.status,
					"idle",
					"Turn is not idle",
				);
				const events = mockEvents(scenario.marker);
				assert(
					!events.some((event) => event.event === "disconnected"),
					"Mock stream disconnected instead of surviving the disruption",
				);
				assert(
					events.some(
						(event) =>
							event.event === "finished" && event.id === scenario.streamId,
					),
					"Original mock stream has not ended",
				);
				return history.messages
					.map(
						(message) =>
							`${message.role}: ${message.text ?? message.parts?.map((part) => part.text ?? "").join("") ?? ""}`,
					)
					.join("\n\n");
			},
			90_000,
		);
		writeFileSync(join(artifacts, `${scenario.label}-transcript.txt`), text);
		record("transcript", { sessionId: scenario.sessionId, text });
	}

	async function verifySurvival(scenario: Scenario) {
		const afterServer = await eventually(
			"replacement server and IPC readiness",
			async () => {
				const current = await server();
				assert.notEqual(current.pid, scenario.before.server.pid);
				return current;
			},
		);
		for (const owner of [
			scenario.before.runner,
			scenario.before.ptyHost,
			scenario.before.counter,
		]) {
			assert(
				alive(owner),
				`Runtime PID ${owner.pid} died after ${scenario.label}`,
			);
		}
		assert.equal(runner(scenario.sessionId).pid, scenario.before.runner.pid);
		record("reconnected", {
			server: afterServer,
			runner: runner(scenario.sessionId),
			runtimes: runtimeProcesses(),
		});
		assert.equal(assertMidTurn(scenario.marker), scenario.streamId);
		releaseStream(scenario.marker, "runtime-survival-verified");
		await completedTurn(scenario);
		const beforeTicks = [
			...scenario.beforeText.matchAll(
				new RegExp(`tick (\\d+) ${scenario.label}\\b`, "g"),
			),
		].map((match) => Number(match[1]));
		const beforeMax = Math.max(...beforeTicks);
		const afterText = await eventually(
			"PTY scrollback spans restart",
			async () => {
				const text = await scrollback(scenario.ptyId);
				const afterTicks = [
					...text.matchAll(new RegExp(`tick (\\d+) ${scenario.label}\\b`, "g")),
				].map((match) => Number(match[1]));
				assert(
					text.includes(`tick 0 ${scenario.label}`),
					"Pre-restart scrollback missing",
				);
				assert(
					afterTicks.some((tick) => tick > beforeMax + 5),
					"Post-restart counter output missing",
				);
				return text;
			},
		);
		writeFileSync(
			join(artifacts, `${scenario.label}-pty-after.txt`),
			afterText,
		);
		for (const owner of [
			scenario.before.runner,
			scenario.before.ptyHost,
			scenario.before.counter,
		])
			assert(alive(owner));
		record("after", {
			server: afterServer,
			runner: runner(scenario.sessionId),
			ptyHost: processInfo(scenario.before.ptyHost.pid),
			counter: processInfo(scenario.before.counter.pid),
			beforeMax,
			scrollback: afterText,
		});
		console.log(
			`PASS ${scenario.label}: server replaced; runner, PTY host and counter survived; transcript and scrollback persisted.`,
		);
	}

	return {
		run,
		record,
		eventually,
		alive,
		runtimeProcesses,
		server,
		startScenario,
		verifySurvival,
		releaseHeldStreams,
		finalSentence,
		get phase() {
			return phase;
		},
		set phase(value: string) {
			phase = value;
		},
		get projectSlug() {
			return projectSlug;
		},
		set projectSlug(value: string) {
			projectSlug = value;
		},
	};
}
