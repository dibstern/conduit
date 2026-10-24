import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcessHarness } from "./process-harness.js";

export const PRE_RUNNER_SETTLED_ANSWERS_COMMIT =
	"312a926114d1b0feb54713208c3a7a380b4fc98e";

export type HistoricalRunnerBundle =
	| {
			available: true;
			commit: string;
			dist: string;
			buildId: string;
			cacheDir: string;
			logPath: string;
	  }
	| { available: false; commit: string; reason: string; logPath?: string };

const builds = new Map<string, Promise<HistoricalRunnerBundle>>();

/** Select only the runner executable; the daemon still uses the current build. */
export function launchHistoricalRunners(
	harness: ProcessHarness,
	bundle: Extract<HistoricalRunnerBundle, { available: true }>,
): () => void {
	const gate = join(harness.root, "historical-runner-entry.json");
	writeFileSync(
		gate,
		JSON.stringify({
			entry: join(bundle.dist, "src/bin/claude-session-runner.js"),
		}),
	);
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`const historicalRunnerGate = ${JSON.stringify(gate)};
const originalRunnerSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (Array.isArray(args) && existsSync(historicalRunnerGate)) {
    const index = args.findIndex(arg => /claude-session-runner\\.(?:js|ts)$/.test(arg));
    if (index >= 0) {
      args = [...args];
      args[index] = JSON.parse(readFileSync(historicalRunnerGate, "utf8")).entry;
    }
  }
  return originalRunnerSpawn(command, args, options);
};
syncBuiltinESMExports();\n`,
	);
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`const historicalNet = await import("node:net");
const historicalAppend = (await import("node:fs")).appendFileSync;
const historicalWireProof = ${JSON.stringify(join(harness.root, "historical-runner-commands.ndjson"))};
const originalHistoricalSocketWrite = historicalNet.Socket.prototype.write;
historicalNet.Socket.prototype.write = function(chunk, ...args) {
  if (typeof chunk === "string" && chunk.includes('"type":"command"')) {
    for (const line of chunk.trim().split("\\n")) {
      try {
        const message = JSON.parse(line);
        if (message.type === "command") {
          historicalAppend(historicalWireProof, JSON.stringify({
            pid: process.pid,
            commandId: message.commandId,
            type: message.command.type,
            sinkId: message.command.sinkId,
            requestId: message.command.requestId,
          }) + "\\n");
        }
      } catch {}
    }
  }
  return originalHistoricalSocketWrite.call(this, chunk, ...args);
};\n`,
	);
	return () => rmSync(gate, { force: true });
}

/** Build unchanged historical sources with their own dependency installation. */
export function historicalRunnerBundle(
	commit = PRE_RUNNER_SETTLED_ANSWERS_COMMIT,
): Promise<HistoricalRunnerBundle> {
	const existing = builds.get(commit);
	if (existing) return existing;
	const building = build(commit);
	builds.set(commit, building);
	return building;
}

async function build(commit: string): Promise<HistoricalRunnerBundle> {
	if (!/^[a-f0-9]{40}$/.test(commit))
		throw new Error("Historical runner bundles require a full pinned commit");
	const cacheRoot = join(tmpdir(), "conduit-historical-runner-bundles");
	mkdirSync(cacheRoot, { recursive: true });
	const cacheDir = join(
		cacheRoot,
		`${commit}-${process.platform}-${process.arch}-${process.versions.modules}`,
	);
	const cached = cachedBundle(cacheDir, commit);
	if (cached) return cached;
	const staging = mkdtempSync(join(cacheRoot, `${commit}-building-`));
	const source = join(staging, "source");
	const logPath = join(staging, "build.log");
	try {
		// An isolated clone also works when the shared repository metadata is
		// read-only. Never install into this worktree's node_modules symlink.
		await command(
			"git",
			["clone", "--shared", "--no-checkout", "--quiet", resolve("."), source],
			staging,
			logPath,
		);
		await command(
			"git",
			["checkout", "--detach", "--quiet", commit],
			source,
			logPath,
		);
		await command(
			"pnpm",
			["install", "--frozen-lockfile", "--prefer-offline"],
			source,
			logPath,
		);
		await command("pnpm", ["build"], source, logPath);
		const { buildId } = JSON.parse(
			readFileSync(join(source, "dist/build-ready.json"), "utf8"),
		) as { buildId: string };
		writeFileSync(
			join(staging, "bundle.json"),
			JSON.stringify({ commit, buildId }),
		);
		try {
			renameSync(staging, cacheDir);
		} catch (cause) {
			if (!cachedBundle(cacheDir, commit)) throw cause;
			rmSync(staging, { recursive: true, force: true });
		}
		const result = cachedBundle(cacheDir, commit);
		if (!result)
			throw new Error("Historical build did not emit a runner bundle");
		return result;
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		return {
			available: false,
			commit,
			logPath,
			reason: `Cannot produce historical runner ${commit}: ${reason}. Build log: ${logPath}`,
		};
	}
}

function cachedBundle(
	cacheDir: string,
	commit: string,
): Extract<HistoricalRunnerBundle, { available: true }> | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(join(cacheDir, "bundle.json"), "utf8"),
		) as { commit: string; buildId: string };
		const dist = join(cacheDir, "source/dist");
		if (
			manifest.commit !== commit ||
			typeof manifest.buildId !== "string" ||
			!existsSync(join(dist, "src/bin/claude-session-runner.js"))
		)
			return undefined;
		return {
			available: true,
			commit,
			dist,
			buildId: manifest.buildId,
			cacheDir,
			logPath: join(cacheDir, "build.log"),
		};
	} catch {
		return undefined;
	}
}

async function command(
	executable: string,
	args: string[],
	cwd: string,
	logPath: string,
): Promise<void> {
	const log = openSync(logPath, "a");
	try {
		await new Promise<void>((resolveCommand, reject) => {
			const child = spawn(executable, args, {
				cwd,
				env: { ...process.env, CI: "true" },
				detached: process.platform !== "win32",
				stdio: ["ignore", log, log],
			});
			const timeout = setTimeout(() => {
				if (child.pid === undefined) return;
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code !== "ESRCH") reject(cause);
				}
			}, 180_000);
			child.once("error", (cause) => {
				clearTimeout(timeout);
				reject(cause);
			});
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) resolveCommand();
				else
					reject(
						new Error(
							`${executable} ${args.join(" ")} exited ${signal ?? code}`,
						),
					);
			});
		});
	} finally {
		closeSync(log);
	}
}
