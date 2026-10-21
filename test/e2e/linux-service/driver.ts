import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	createServiceDriver,
	type ProcessInfo,
} from "../service-runtime/driver.js";

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
const systemctl = (args: string[]) => run("systemctl", ["--user", ...args]);

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

const check = createServiceDriver({
	name: "Linux",
	config,
	project,
	artifacts,
	counter: "/repo/test/e2e/linux-service/counter.sh",
	processInfo,
	processes,
	serverPid: async () =>
		Number(
			await systemctl(["show", "conduit", "--property=MainPID", "--value"]),
		),
	assertOwners: (server, owners) => {
		for (const owner of owners)
			assert.equal(
				owner.cgroup,
				server.cgroup,
				"Runtime owner must be in the service cgroup to exercise KillMode",
			);
	},
});
const {
	run,
	record,
	eventually,
	alive,
	runtimeProcesses,
	server,
	startScenario,
	verifySurvival,
	finalSentence,
} = check;

async function negativeControl() {
	check.phase = "CONTROL";
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
	const saved = await sendRpcRequest(socket, {
		_tag: "SaveProject",
		folders: [project],
		title: "Linux service E2E",
	});
	check.projectSlug = saved.savedSlug;
	record("project-registered", {
		projectSlug: check.projectSlug,
		folder: project,
	});
	const restart = await startScenario("A");
	await systemctl(["restart", "conduit"]);
	await verifySurvival(restart);
	const crash = await startScenario("B");
	process.kill(crash.before.server.pid, "SIGKILL");
	record("server-sigkill", { pid: crash.before.server.pid });
	await verifySurvival(crash);
	await negativeControl();

	check.phase = "C";
	const added = await sendRpcRequest(socket, {
		_tag: "AddInstance",
		name: "Linux service managed",
		driver: "opencode",
		managed: true,
		port: 27332,
	});
	const instanceId = added.addedInstanceId;
	assert(instanceId, "Managed OpenCode account was not created");
	await sendRpcRequest(
		socket,
		{ _tag: "StartInstance", instanceId },
		{
			requestTimeoutMs: 60_000,
		},
	).catch((error: unknown) => {
		// Under load OpenCode can miss the server's first 4s probe while it keeps starting.
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
	// Restart=on-failure has a five-second delay: verify no replacement appears.
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
		JSON.stringify(
			{ passed: false, phase: check.phase, error: String(error) },
			null,
			2,
		),
	);
	console.error(`FAIL ${check.phase}:`, error);
	process.exitCode = 1;
} finally {
	check.releaseHeldStreams();
}
