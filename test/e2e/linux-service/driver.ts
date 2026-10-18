import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Socket } from "effect/socket";
import { NodeSocket } from "@effect/platform-node";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Effect, Option, Schedule, Stream } from "effect";
import {
	AddInstance,
	CreatePty,
	CreateSession,
	GetInstances,
	GetStatus,
	ListDaemonSessions,
	ListPtys,
	LoadMoreHistory,
	PtyInput,
	SaveProject,
	StartInstance,
	SubmitInput,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { runnerDirectory } from "../../../src/lib/provider/runner/runner-registry.js";

// This driver can signal processes and edit a unit only inside our container.
assert.equal(process.platform, "linux", "Run this driver through run.sh");
assert.equal(process.env["CONDUIT_LINUX_SERVICE_E2E"], "1");
assert.equal(process.getuid?.(), 1001);
assert.equal(readFileSync("/proc/1/comm", "utf8").trim(), "systemd");
assert(existsSync("/run/conduit-m37913-e2e"));
assert.equal(process.cwd(), "/repo");
assert.equal(
	process.env["CONDUIT_CONFIG_DIR"],
	"/home/conduit/.config/conduit",
);

const config = "/home/conduit/.config/conduit";
const project = "/home/conduit/project";
const socket = join(config, "relay.sock");
const unit = "/home/conduit/.config/systemd/user/conduit.service";
const artifacts = "/artifacts";
const finalSentence = "Conduit runtime survival verified.";
const exec = promisify(execFile);
const systemctl = (args: string[]) => run("systemctl", ["--user", ...args]);
let projectSlug = "";
let phase = "startup";
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

interface ProcessInfo {
	pid: number;
	ppid: number;
	state: string;
	startTicks: string;
	argv: string[];
	cgroup: string;
}

function processInfo(pid: number): ProcessInfo | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const state = fields[0];
		const startTicks = fields[19];
		assert(state && startTicks);
		return {
			pid,
			ppid: Number(fields[1]),
			state,
			startTicks,
			argv: readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.split("\0")
				.filter(Boolean),
			cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(),
		};
	} catch {
		return undefined;
	}
}

function processes(): ProcessInfo[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name))
		.map((name) => processInfo(Number(name)))
		.filter(
			(info): info is ProcessInfo => info !== undefined && info.state !== "Z",
		);
}

function alive(info: ProcessInfo): boolean {
	const now = processInfo(info.pid);
	return (
		now !== undefined && now.state !== "Z" && now.startTicks === info.startTicks
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
	const pid = Number(
		await systemctl(["show", "conduit", "--property=MainPID", "--value"]),
	);
	const info = processInfo(pid);
	assert(info && info.state !== "Z", `No live conduit MainPID (${pid})`);
	assert(
		info.argv.includes("serve"),
		`MainPID is not conduit serve: ${info.argv.join(" ")}`,
	);
	await sendRpcRequest(socket, new GetStatus({}), {
		startupRetries: 0,
		requestTimeoutMs: 2000,
	});
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
						RpcClient.layerProtocolSocket({ retrySchedule: Schedule.stop }),
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
		assert(
			!events.some(
				(event) => event.event === "finished" || event.event === "disconnected",
			),
		);
	});
}

function assertMidTurn(marker: string) {
	const events = mockEvents(marker);
	const deltas = events.filter((event) => event.event === "delta");
	const index = deltas.at(-1)?.index ?? 0;
	assert(
		index > 0 && index < 35,
		`Disruption must happen mid-turn; ${marker} is at delta ${index}/40`,
	);
	assert(
		!events.some(
			(event) => event.event === "finished" || event.event === "disconnected",
		),
	);
	record("mock-mid-turn", { marker, delta: index });
}

async function startScenario(label: "A" | "B" | "C" | "CONTROL") {
	phase = label;
	const marker = `CONDUIT_M37913_${label}`;
	const { sessionId } = await sendRpcRequest(
		socket,
		new CreateSession({
			projectSlug,
			originId: randomUUID(),
			providerId: "claude",
			permissionMode: "ask",
			title: `Linux service ${label}`,
			model: { modelId: "sonnet", providerId: "claude" },
		}),
		{ requestTimeoutMs: 60_000 },
	);
	record("session-created", { sessionId, marker });
	const result = await sendRpcRequest(
		socket,
		new SubmitInput({
			sessionId,
			inputId: randomUUID(),
			text: `${marker}: Reply with a plain text response. Do not use tools.`,
			delivery: "queue",
		}),
		{ requestTimeoutMs: 60_000 },
	);
	assert(result.ok, `Prompt rejected for ${sessionId}`);
	await streaming(marker);
	await eventually("runner registration", async () => runner(sessionId));
	const beforePtys = await sendRpcRequest(
		socket,
		new ListPtys({ projectSlug, originId: randomUUID() }),
	);
	await sendRpcRequest(
		socket,
		new CreatePty({ projectSlug, originId: randomUUID() }),
	);
	const pty = await eventually("new PTY", async () => {
		const current = await sendRpcRequest(
			socket,
			new ListPtys({ projectSlug, originId: randomUUID() }),
		);
		const created = current.ptys.find(
			(item) => !beforePtys.ptys.some((old) => old.id === item.id),
		);
		assert(created, "New PTY not listed");
		return created;
	});
	await sendRpcRequest(
		socket,
		new PtyInput({
			projectSlug,
			ptyId: pty.id,
			data: `exec /bin/bash /repo/test/e2e/linux-service/counter.sh ${label}\r`,
		}),
	);
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
	for (const owner of [runnerInfo, hostInfo, counterInfo]) {
		assert.equal(
			owner.cgroup,
			serverInfo.cgroup,
			"Runtime owner must be in the service cgroup to exercise KillMode",
		);
	}
	assertMidTurn(marker);
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
	return { label, marker, sessionId, ptyId: pty.id, beforeText, before };
}

type Scenario = Awaited<ReturnType<typeof startScenario>>;

async function completedTurn(scenario: Scenario) {
	const text = await eventually(
		"finished turn persisted after restart",
		async () => {
			const history = await sendRpcRequest(
				socket,
				new LoadMoreHistory({ sessionId: scenario.sessionId }),
			);
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
			const sessions = await sendRpcRequest(
				socket,
				new ListDaemonSessions({ projectSlug }),
			);
			assert.equal(
				sessions.sessions.find((session) => session.id === scenario.sessionId)
					?.status,
				"idle",
				"Turn is not idle",
			);
			assert(
				mockEvents(scenario.marker).some((event) => event.event === "finished"),
				"Mock stream has not ended",
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
	writeFileSync(join(artifacts, `${scenario.label}-pty-after.txt`), afterText);
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

async function negativeControl() {
	phase = "CONTROL";
	const original = readFileSync(unit, "utf8");
	assert.match(original, /^KillMode=process$/m);
	try {
		writeFileSync(unit, original.replace(/^KillMode=process\r?\n/m, ""));
		await systemctl(["daemon-reload"]);
		assert.equal(
			await systemctl(["show", "conduit", "--property=KillMode", "--value"]),
			"control-group",
		);
		const scenario = await startScenario("CONTROL");
		await systemctl(["restart", "conduit"]);
		await eventually(
			"negative control must kill the runner",
			async () => assert(!alive(scenario.before.runner)),
			30_000,
		);
		const afterServer = await eventually(
			"negative-control replacement server",
			server,
		);
		assert.notEqual(afterServer.pid, scenario.before.server.pid);
		record("negative-control-detected", {
			runnerBefore: scenario.before.runner,
			runnerAliveAfter: alive(scenario.before.runner),
			serverAfter: afterServer,
			runtimes: runtimeProcesses(),
		});
		console.log(
			"PASS negative control: removing KillMode killed the active runner on restart.",
		);
	} finally {
		writeFileSync(unit, original);
		await systemctl(["daemon-reload"]);
		assert.equal(
			await systemctl(["show", "conduit", "--property=KillMode", "--value"]),
			"process",
		);
		record("unit-restored", { killMode: "process" });
	}
}

async function main() {
	await eventually("installed service readiness", server);
	assert.match(readFileSync(unit, "utf8"), /^KillMode=process$/m);
	const saved = await sendRpcRequest(
		socket,
		new SaveProject({ folders: [project], title: "Linux service E2E" }),
	);
	projectSlug = saved.savedSlug;
	record("project-registered", { projectSlug, folder: project });
	const restart = await startScenario("A");
	await systemctl(["restart", "conduit"]);
	await verifySurvival(restart);
	const crash = await startScenario("B");
	process.kill(crash.before.server.pid, "SIGKILL");
	record("server-sigkill", { pid: crash.before.server.pid });
	await verifySurvival(crash);
	await negativeControl();

	phase = "C";
	const added = await sendRpcRequest(
		socket,
		new AddInstance({
			name: "Linux service managed",
			driver: "opencode",
			managed: true,
			port: 27332,
		}),
	);
	const instanceId = added.addedInstanceId;
	assert(instanceId, "Managed OpenCode account was not created");
	await sendRpcRequest(socket, new StartInstance({ instanceId }), {
		requestTimeoutMs: 60_000,
	}).catch((error: unknown) => {
		// Under load OpenCode can miss the server's first 4s probe while it keeps starting.
		if (!String(error).includes("is unreachable")) throw error;
		record("managed-opencode-slow-start", { error: String(error) });
	});
	const opencode = await eventually(
		"real managed OpenCode starts",
		async () => {
			const { instances } = await sendRpcRequest(socket, new GetInstances({}));
			const instance = instances.find(({ id }) => id === instanceId);
			const pid = instance?.pid;
			assert(instance && pid, "Real managed OpenCode has no pid yet");
			return { ...instance, pid };
		},
		120_000,
	);
	const opencodeBefore = processInfo(opencode.pid);
	assert(opencodeBefore);
	record("managed-opencode-started", {
		instance: opencode,
		process: opencodeBefore,
	});
	const uninstall = await startScenario("C");
	const beforeRuntimes = runtimeProcesses();
	assert(
		beforeRuntimes.some(({ argv }) =>
			argv.some((arg) => arg.endsWith("/managed-opencode-supervisor.js")),
		),
		"Managed OpenCode supervisor was not exercised",
	);
	await run(process.execPath, ["dist/src/bin/cli.js", "service", "uninstall"]);
	await eventually(
		"uninstall ends runtime owners",
		async () => {
			assert.deepEqual(
				runtimeProcesses(),
				[],
				"Runtime owner remains after uninstall",
			);
			for (const info of [
				...Object.values(uninstall.before),
				opencodeBefore,
				...beforeRuntimes,
			])
				assert(!alive(info), `PID ${info.pid} remains after uninstall`);
		},
		30_000,
	);
	assert(!existsSync(unit), "Uninstall left the unit file behind");
	// Restart=always has a five-second delay: verify no replacement appears.
	await sleep(6500);
	assert.deepEqual(runtimeProcesses(), []);
	assert(!alive(uninstall.before.counter));
	const activeState = await systemctl([
		"show",
		"conduit",
		"--property=ActiveState",
		"--value",
	]);
	assert.equal(activeState, "inactive", "Service restarted after uninstall");
	record("uninstalled", {
		activeState,
		serverBefore: uninstall.before.server,
		serverAliveAfter: alive(uninstall.before.server),
		ownersBefore: beforeRuntimes,
		ownersAfter: runtimeProcesses(),
		opencodeAliveAfter: alive(opencodeBefore),
	});
	console.log(
		"PASS C: uninstall stopped runners, PTY host, counter and real managed OpenCode; service stayed stopped.",
	);
	writeFileSync(
		join(artifacts, "result.json"),
		JSON.stringify(
			{
				passed: true,
				scenarios: ["A", "B", "negative control", "C"],
				finalSentence,
			},
			null,
			2,
		),
	);
}

try {
	await main();
} catch (error) {
	record("failure", {
		error: error instanceof Error ? error.stack : String(error),
		runtimes: runtimeProcesses(),
	});
	writeFileSync(
		join(artifacts, "result.json"),
		JSON.stringify({ passed: false, phase, error: String(error) }, null, 2),
	);
	console.error(`FAIL ${phase}:`, error);
	process.exitCode = 1;
}
