import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	createServiceDriver,
	type ProcessInfo,
} from "../service-runtime/driver.js";
import { trackProcesses } from "./processes.js";

assert.equal(process.platform, "darwin", "Run this driver through run.sh");
assert.equal(process.env["CONDUIT_MACOS_SERVICE_E2E"], "1");
const home = process.env["HOME"] ?? "";
const config = process.env["CONDUIT_CONFIG_DIR"] ?? "";
const label = process.env["CONDUIT_SERVICE_LABEL"] ?? "";
const artifacts = process.env["CONDUIT_E2E_ARTIFACTS"] ?? "";
const project = process.cwd();
assert.match(label, /^dev\.conduit\.test\.[a-zA-Z0-9-]+$/);
assert.equal(config, join(home, ".config/conduit"));
assert.equal(project, join(resolve(home, ".."), "project"));
assert(artifacts && home.startsWith("/private/tmp/conduit-m37914-"));
const target = `gui/${process.getuid?.()}/${label}`;
const plist = join(home, "Library/LaunchAgents", `${label}.plist`);
const socket = join(config, "relay.sock");
const cli = fileURLToPath(
	new URL("../../../dist/src/bin/cli.js", import.meta.url),
);
const counter = fileURLToPath(
	new URL("../linux-service/counter.sh", import.meta.url),
);
const uninstallRespawns: ProcessInfo[] = [];
let uninstallServer: number | undefined;
const isServer = (info: ProcessInfo) =>
	info.argv.includes(cli) && info.argv.includes("serve");
const { processInfo, processes } = trackProcesses({
	project,
	home,
	registry: join(resolve(home, ".."), "processes.tsv"),
	onSeen(info) {
		check.record("owned-process-seen", { process: info });
		if (
			uninstallServer !== undefined &&
			isServer(info) &&
			info.pid !== uninstallServer
		)
			uninstallRespawns.push(info);
	},
});
const check = createServiceDriver({
	name: "macOS",
	config,
	project,
	artifacts,
	counter,
	processInfo,
	processes,
	serverPid: async (run) => {
		const output = await run("/bin/launchctl", ["print", target]);
		return Number(output.match(/^\s*pid = (\d+)/m)?.[1]);
	},
	assertOwners(server, owners) {
		assert(server.pgid && server.sid);
		for (const owner of owners) {
			assert(owner.pgid && owner.sid);
			assert.notEqual(
				owner.pgid,
				server.pgid,
				"Detached owner shares the launchd job's process group",
			);
		}
	},
});
const {
	record,
	run,
	eventually,
	alive,
	runtimeProcesses,
	server,
	startScenario,
	verifySurvival,
} = check;
let observationError: unknown;
// Also sample while uninstall's CLI is waiting for Shutdown. A replacement
// server need not reach RPC readiness to be caught and recorded here.
const observer = setInterval(() => {
	try {
		processes();
	} catch (error) {
		observationError = error;
	}
}, 100);
const deadline = setTimeout(() => {
	check.releaseHeldStreams();
	record("failure", { error: "Driver exceeded ten minutes" });
	writeFileSync(
		join(artifacts, "result.json"),
		JSON.stringify({
			passed: false,
			phase: check.phase,
			error: "Driver timeout",
		}),
	);
	process.exit(1);
}, 600_000);

async function freePort(): Promise<number> {
	return new Promise((fulfil, reject) => {
		const listener = createServer();
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => {
			const address = listener.address();
			assert(address && typeof address !== "string");
			listener.close((error) => (error ? reject(error) : fulfil(address.port)));
		});
	});
}

async function main() {
	await eventually("installed service readiness", server);
	const saved = await sendRpcRequest(socket, {
		_tag: "SaveProject",
		folders: [project],
		title: "macOS service E2E",
	});
	check.projectSlug = saved.savedSlug;
	record("project-registered", {
		projectSlug: check.projectSlug,
		folder: project,
	});

	const restart = await startScenario("A");
	const controlLine = readFileSync(
		join(resolve(home, ".."), "controls.tsv"),
		"utf8",
	)
		.trim()
		.split("\n")
		.at(-1);
	assert(controlLine);
	const [controlPid, controlStart] = controlLine.split("\t");
	const control = processInfo(Number(controlPid));
	assert(control && alive(control), "Non-detached negative control is missing");
	assert.equal(control.startTime, controlStart);
	assert.equal(
		control.pgid,
		restart.before.server.pgid,
		"Control must share the launchd job's group",
	);
	record("negative-control-before", { process: control });
	await run("/bin/launchctl", ["kickstart", "-k", target]);
	await eventually(
		"launchd kills the non-detached control",
		async () => assert(!alive(control)),
		30_000,
	);
	record("negative-control-detected", {
		before: control,
		aliveAfter: alive(control),
	});
	await verifySurvival(restart);

	const crash = await startScenario("B");
	process.kill(crash.before.server.pid, "SIGKILL");
	record("server-sigkill", { process: crash.before.server });
	await verifySurvival(crash);

	const reinstall = await startScenario("C");
	await run(process.execPath, [
		cli,
		"service",
		"install",
		"--host",
		"127.0.0.1",
		"--claude-config-dir",
		`${home}/.claude`,
	]);
	await verifySurvival(reinstall);

	check.phase = "D";
	const added = await sendRpcRequest(socket, {
		_tag: "AddInstance",
		name: "macOS service managed",
		driver: "opencode",
		managed: true,
		port: await freePort(),
	});
	const instanceId = added.addedInstanceId;
	assert(instanceId, "Managed OpenCode instance was not created");
	await run("/opt/homebrew/bin/opencode", ["--version"]);
	await sendRpcRequest(
		socket,
		{ _tag: "StartInstance", instanceId },
		{ requestTimeoutMs: 60_000 },
	).catch((error: unknown) => {
		if (!String(error).includes("is unreachable")) throw error;
		record("managed-opencode-slow-start", { error: String(error) });
	});
	const opencode = await eventually(
		"real managed OpenCode starts",
		async () => {
			const { instances } = await sendRpcRequest(socket, {
				_tag: "GetInstances",
			});
			const instance = instances.find(({ id }) => id === instanceId);
			assert(instance?.pid, "Real managed OpenCode has no PID yet");
			const info = processInfo(instance.pid);
			assert(info && alive(info));
			return info;
		},
		120_000,
	);
	record("managed-opencode-started", { process: opencode });
	const uninstall = await startScenario("D");
	const before = processes();
	const serverLaunchesPath = join(resolve(home, ".."), "servers.tsv");
	const launchesBefore = readFileSync(serverLaunchesPath, "utf8");
	assert(
		before.some(({ argv }) =>
			argv.some((arg) => arg.endsWith("/managed-opencode-supervisor.js")),
		),
		"Managed supervisor was not exercised",
	);
	uninstallServer = uninstall.before.server.pid;
	await run(process.execPath, [cli, "service", "uninstall"]);
	await eventually(
		"uninstall ends every recorded owner",
		async () => {
			assert.deepEqual(
				runtimeProcesses(),
				[],
				"Runtime owner remains after uninstall",
			);
			for (const info of [
				...before,
				opencode,
				...Object.values(uninstall.before),
			])
				assert(!alive(info), `PID ${info.pid} remains after uninstall`);
		},
		30_000,
	);
	assert(!existsSync(plist), "Uninstall left the plist behind");
	const observeUntil = Date.now() + 15_000;
	do {
		assert.equal(
			observationError,
			undefined,
			`Process observer failed: ${String(observationError)}`,
		);
		const remaining = processes();
		assert.deepEqual(
			remaining,
			[],
			"A process for the isolated service survived or reappeared",
		);
		await sleep(100);
	} while (Date.now() < observeUntil);
	assert.deepEqual(
		uninstallRespawns,
		[],
		"KeepAlive respawned the server during uninstall",
	);
	const launchesAfter = readFileSync(serverLaunchesPath, "utf8");
	record("uninstall-server-launches", {
		before: launchesBefore,
		after: launchesAfter,
	});
	assert.equal(
		launchesAfter,
		launchesBefore,
		"Launcher recorded a server respawn during uninstall",
	);
	let absent = false;
	try {
		await run("/bin/launchctl", ["print", target]);
	} catch (error) {
		assert(error instanceof Error && "stderr" in error);
		assert.match(
			String(error.stderr),
			/could not find (?:specified )?service|no such process/i,
		);
		absent = true;
	}
	assert(absent, "launchctl still has the uninstalled job");
	record("uninstalled", {
		before,
		after: processes(),
		observedQuietMs: 15_000,
		respawns: uninstallRespawns,
	});
	console.log(
		"PASS D: uninstall stopped every owner and stayed stopped for 15s.",
	);
	writeFileSync(
		join(artifacts, "result.json"),
		JSON.stringify(
			{
				passed: true,
				scenarios: ["A", "B", "C", "D", "negative control"],
				finalSentence: check.finalSentence,
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
	});
	writeFileSync(
		join(artifacts, "result.json"),
		JSON.stringify(
			{ passed: false, phase: check.phase, error: String(error) },
			null,
			2,
		),
	);
	console.error(`FAIL ${check.phase}:`, error);
	process.exitCode = 1;
} finally {
	clearInterval(observer);
	clearTimeout(deadline);
	check.releaseHeldStreams();
}
