import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { makeWorktreeLive } from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";

describe("daemon Worktree setup runner", () => {
	let fixture: string;
	let directory: string;
	const setupEffect = (
		script: string,
		env: Readonly<Record<string, string | undefined>> = {
			...process.env,
			SHELL: "/bin/sh",
		},
		setupTimeoutMs = 2_000,
		cwd = directory,
	) =>
		Effect.flatMap(WorktreeServiceTag, (service) =>
			Stream.runCollect(service.runSetup(cwd, script, env)),
		).pipe(Effect.provide(makeWorktreeLive(fixture, { setupTimeoutMs })));
	const outputText = (
		updates: readonly { readonly _tag: string; readonly output?: string }[],
	) =>
		updates
			.filter((update) => update._tag === "output")
			.map((update) => update.output ?? "")
			.join("");
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const pidIsAlive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const expectStopped = async (pidFile: string) => {
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		await expect.poll(() => pidIsAlive(pid), { timeout: 10_000 }).toBe(false);
	};

	beforeEach(() => {
		fixture = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-worktree-setup-")),
		);
		directory = join(fixture, "worktree");
		mkdirSync(directory);
	});

	afterEach(() => {
		rmSync(fixture, { recursive: true, force: true });
	});

	it("runs in the effective directory and streams output before finishing", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"printf 'stdout-first\\n'; printf 'stderr-second\\n' >&2; printf '%s' \"$CONDUIT_SETUP_ENV\" > marker",
				{ ...process.env, SHELL: "/bin/sh", CONDUIT_SETUP_ENV: "project" },
			),
		);
		expect(readFileSync(join(directory, "marker"), "utf8")).toBe("project");
		expect(outputText(updates)).toBe("stdout-first\nstderr-second\n");
		expect(updates.at(-1)).toEqual({
			_tag: "finished",
			status: "succeeded",
			exitCode: 0,
		});
	});

	it("reports non-zero exit with stdout and stderr intact", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"printf 'failed output\\n'; printf 'error detail\\n' >&2; exit 23",
			),
		);
		expect(outputText(updates)).toBe("failed output\nerror detail\n");
		expect(updates.at(-1)).toEqual({
			_tag: "finished",
			status: "failed",
			exitCode: 23,
		});
	});

	it("times out a hanging script and kills the entire process group", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let markReady = () => {};
		const ready = new Promise<void>((resolve) => {
			markReady = resolve;
		});
		const running = Effect.runFork(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service
					.runSetup(
						directory,
						"echo $$ > shell.pid; sleep 60 & echo $! > child.pid; printf 'ready\\n'; wait",
						{ ...process.env, SHELL: "/bin/sh" },
					)
					.pipe(
						Stream.tap((update) =>
							Effect.sync(() => {
								if (update._tag === "output") markReady();
							}),
						),
						Stream.runCollect,
					),
			).pipe(
				Effect.provide(makeWorktreeLive(fixture, { setupTimeoutMs: 100 })),
			),
		);
		onTestFinished(async () => {
			vi.useRealTimers();
			await Effect.runPromise(Fiber.interrupt(running));
		});
		try {
			// Let the real shell create both descendants before advancing its deadline.
			await Promise.race([
				ready,
				Effect.runPromise(Fiber.await(running)).then(() => {
					throw new Error("Setup finished before emitting readiness");
				}),
			]);
			await vi.advanceTimersByTimeAsync(99);
			expect(running.pollUnsafe()).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			const updates = await Effect.runPromise(Fiber.join(running));
			expect(updates.at(-1)).toMatchObject({
				_tag: "finished",
				status: "timed_out",
			});
			vi.useRealTimers();
			await expectStopped(join(directory, "shell.pid"));
			await expectStopped(join(directory, "child.pid"));
		} finally {
			vi.useRealTimers();
			await Effect.runPromise(Fiber.interrupt(running));
		}
	});

	it("caps large output once without splitting a UTF-8 character", async () => {
		const body = "process.stdout.write('🙂'.repeat(40_000));";
		const updates = await Effect.runPromise(
			setupEffect(`${shellQuote(process.execPath)} -e ${shellQuote(body)}`),
		);
		const text = outputText(updates);
		expect(text).not.toContain("\uFFFD");
		expect(text.startsWith("🙂".repeat(16_384))).toBe(true);
		expect(text.match(/\[Setup output truncated after 64 KiB\]/g)).toHaveLength(
			1,
		);
		expect(Buffer.byteLength(text)).toBeLessThan(65_700);
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
	});

	it("decodes UTF-8 characters split between streamed chunks", async () => {
		const body =
			"const bytes = Buffer.from('🙂'); process.stdout.write(bytes.subarray(0, 2)); setTimeout(() => process.stdout.write(bytes.subarray(2)), 30);";
		const updates = await Effect.runPromise(
			setupEffect(`${shellQuote(process.execPath)} -e ${shellQuote(body)}`),
		);
		expect(outputText(updates)).toBe("🙂");
	});

	it("kills a background descendant holding output pipes after the shell exits", async () => {
		const updates = await Effect.runPromise(
			setupEffect("sleep 60 & echo $! > child.pid; printf 'shell done\\n'"),
		);
		expect(outputText(updates)).toBe("shell done\n");
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
		await expectStopped(join(directory, "child.pid"));
	});

	it("interrupts the setup shell and its descendants when the stream closes", async () => {
		const fiber = Effect.runFork(
			setupEffect("echo $$ > shell.pid; sleep 60 & echo $! > child.pid; wait"),
		);
		try {
			await expect
				.poll(() => existsSync(join(directory, "child.pid")))
				.toBe(true);
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
		await expectStopped(join(directory, "shell.pid"));
		await expectStopped(join(directory, "child.pid"));
	});

	it("gives the user's setup script closed stdin", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"if IFS= read -r value; then printf 'unexpected input'; else printf 'stdin closed'; fi",
			),
		);
		expect(outputText(updates)).toBe("stdin closed");
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
	});

	it("stops the setup process group when its fixture daemon is killed abruptly", async () => {
		const serviceUrl = new URL(
			"../../../src/lib/domain/daemon/Services/worktree-service.ts",
			import.meta.url,
		).href;
		const layerUrl = new URL(
			"../../../src/lib/domain/daemon/Layers/worktree-layer.ts",
			import.meta.url,
		).href;
		const script = "echo $$ > shell.pid; sleep 60 & echo $! > child.pid; wait";
		const parent = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import { Effect, Stream } from "effect";
import { WorktreeServiceTag } from ${JSON.stringify(serviceUrl)};
import { makeWorktreeLive } from ${JSON.stringify(layerUrl)};
Effect.runFork(Effect.flatMap(WorktreeServiceTag, (service) =>
  Stream.runDrain(service.runSetup(${JSON.stringify(directory)}, ${JSON.stringify(script)}, { ...process.env, SHELL: "/bin/sh" }))
).pipe(Effect.provide(makeWorktreeLive(${JSON.stringify(fixture)}, { setupTimeoutMs: 60_000 }))));`,
			],
			{ cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
		);
		let parentStderr = "";
		parent.stderr.on("data", (chunk: Buffer) => {
			parentStderr = (parentStderr + chunk.toString()).slice(-2_000);
		});
		const parentExited = new Promise<void>((accept, reject) => {
			parent.once("close", () => accept());
			parent.once("error", reject);
		});
		const childPidFile = join(directory, "child.pid");
		let groupPid: number | undefined;
		try {
			await expect
				.poll(
					() => {
						if (parent.exitCode !== null || parent.signalCode !== null)
							throw new Error(
								`Fixture daemon exited before setup: ${parentStderr}`,
							);
						// The shell creates child.pid before writing it. Killing the daemon
						// inside that gap leaves an empty file, so wait for the whole pid.
						return (
							existsSync(childPidFile) &&
							/^\d+\n$/.test(readFileSync(childPidFile, "utf8"))
						);
					},
					// A cold tsx start takes seconds when the machine is busy.
					{ timeout: 30_000 },
				)
				.toBe(true);
			groupPid = Number(readFileSync(join(directory, "shell.pid"), "utf8"));
			expect(Number.isSafeInteger(groupPid) && groupPid > 0).toBe(true);
			expect(parent.kill("SIGKILL")).toBe(true);
			await parentExited;
			await expectStopped(join(directory, "shell.pid"));
			await expectStopped(childPidFile);
		} finally {
			parent.kill("SIGKILL");
			await parentExited;
			// This PID came from the process group started by this fixture, never
			// from persisted daemon state. Clean it up even if the assertion fails.
			if (groupPid) {
				try {
					process.kill(-groupPid, "SIGKILL");
				} catch {
					// Successful watchdog cleanup already removed this owned group.
				}
			}
		}
	}, 60_000);

	it("uses the configured user's shell with login and command flags", async () => {
		const shell = join(fixture, "user-shell");
		writeFileSync(
			shell,
			'#!/bin/sh\nprintf \'%s\' "$1" > shell-flags\nexec /bin/sh -c "$2"\n',
		);
		chmodSync(shell, 0o755);
		await Effect.runPromise(
			setupEffect("printf 'custom shell' > marker", {
				...process.env,
				SHELL: shell,
			}),
		);
		expect(readFileSync(join(directory, "shell-flags"), "utf8")).toBe("-lc");
		expect(readFileSync(join(directory, "marker"), "utf8")).toBe(
			"custom shell",
		);
	});

	it.each([
		undefined,
		"/conduit-test-missing-shell",
	])("falls back to /bin/sh when SHELL is %s", async (shell) => {
		const updates = await Effect.runPromise(
			setupEffect("printf 'fallback' > marker", {
				...process.env,
				SHELL: shell,
			}),
		);
		expect(readFileSync(join(directory, "marker"), "utf8")).toBe("fallback");
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
	});

	it("returns a failed terminal update when its working directory is missing", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"printf 'unreachable'",
				{ ...process.env, SHELL: "/bin/sh" },
				2_000,
				join(fixture, "missing"),
			),
		);
		expect(updates).toEqual([
			{
				_tag: "finished",
				status: "failed",
				message: expect.stringContaining("Could not start setup script"),
			},
		]);
	});
});
