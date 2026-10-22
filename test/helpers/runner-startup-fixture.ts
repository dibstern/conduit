import childProcess, { type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { isRecord } from "../../src/lib/utils.js";

/** Installed only in a ProcessHarness's private preload, never in production. */
export function installRunnerStartupFixture(root: string): void {
	if (process.env["HOME"] !== join(root, "home"))
		throw new Error("Runner startup fixture requires isolated HOME");
	const gate = join(root, "runner-startup-gate");
	const selected = join(root, "runner-startup-selected.json");
	const blocked = join(root, "runner-startup-blocked");
	const record = (kind: string, data: Record<string, unknown> = {}) =>
		appendFileSync(
			join(root, "runner-startup-evidence.jsonl"),
			JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...data }) +
				"\n",
		);
	const send = process.send?.bind(process);
	if (/claude-session-runner\.(js|ts)$/.test(process.argv[1] ?? "")) {
		if (!send) throw new Error("Runner startup fixture requires IPC");
		Object.assign(process, {
			send(...args: Parameters<NonNullable<typeof process.send>>) {
				const [message] = args;
				if (
					!isRecord(message) ||
					message["type"] !== "listening" ||
					!existsSync(selected)
				)
					return send(...args);
				const selection: unknown = JSON.parse(readFileSync(selected, "utf8"));
				if (!isRecord(selection) || selection["pid"] !== process.pid)
					return send(...args);
				record("child-ready");
				if (selection["mode"] === "never" || selection["mode"] === "eperm")
					return true;
				send({
					channel: "conduit-process-test",
					kind: "startup-gated",
					pid: process.pid,
				});
				const poll = setInterval(() => {
					if (!existsSync(blocked)) return;
					clearInterval(poll);
					record("child-submitting");
					send(message, (error) =>
						record("child-sent", { error: error?.message ?? null }),
					);
				}, 5);
				return true;
			},
		});
		return;
	}

	const kill = process.kill.bind(process);
	process.kill = (pid, signal) => {
		if (signal !== 0 && existsSync(selected)) {
			const selection: unknown = JSON.parse(readFileSync(selected, "utf8"));
			if (
				isRecord(selection) &&
				selection["mode"] === "eperm" &&
				selection["pid"] === pid
			) {
				record("parent-kill", { childPid: pid, signal, error: "EPERM" });
				throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
			}
		}
		if (signal !== 0)
			record("parent-kill", { childPid: pid, signal: signal ?? "SIGTERM" });
		return kill(pid, signal);
	};
	let active: { child: ChildProcess; deadline?: number } | undefined;
	const spawn = childProcess.spawn;
	Object.assign(childProcess, {
		spawn(...args: Parameters<typeof spawn>) {
			const child = spawn(...args);
			if (!args[1]?.some((arg) => /claude-session-runner\.(js|ts)$/.test(arg)))
				return child;
			child.on("exit", (exitCode, signal) =>
				record("parent-exit", { childPid: child.pid, exitCode, signal }),
			);
			if (!existsSync(gate)) return child;
			const mode = readFileSync(gate, "utf8");
			unlinkSync(gate);
			active = { child };
			writeFileSync(selected, JSON.stringify({ pid: child.pid, mode }));
			child.on("message", (message: unknown) => {
				if (!isRecord(message)) return;
				if (message["type"] === "listening")
					record("parent-received", { childPid: child.pid });
				if (message["kind"] !== "startup-gated") return;
				setImmediate(() => {
					if (!active?.deadline)
						throw new Error("Missing runner startup deadline");
					record("parent-blocked", { childPid: child.pid });
					writeFileSync(blocked, "release listening");
					const until = active.deadline + 500;
					while (Date.now() < until)
						Atomics.wait(
							new Int32Array(new SharedArrayBuffer(4)),
							0,
							0,
							until - Date.now(),
						);
					record("parent-unblocked", { childPid: child.pid });
				});
			});
			return child;
		},
	});
	syncBuiltinESMExports();
	const timeout = globalThis.setTimeout;
	Object.assign(globalThis, {
		setTimeout(
			callback: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) {
			const startedAt = Date.now();
			const timer = timeout(callback, delay, ...args);
			if (
				active &&
				active.deadline === undefined &&
				delay ===
					Number(process.env["CONDUIT_TEST_RUNNER_STARTUP_TIMEOUT_MS"]) &&
				new Error().stack?.includes("process-session-runner")
			) {
				active.deadline = startedAt + delay;
				record("parent-deadline", {
					childPid: active.child.pid,
					startedAt,
					deadline: active.deadline,
					timeoutMs: delay,
				});
			}
			return timer;
		},
	});
}
