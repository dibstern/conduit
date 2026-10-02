import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	type Stats,
	statSync,
	unwatchFile,
	watchFile,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Data } from "effect";
import type { ProjectShellEnvConfig } from "../contracts/project-shell-env.js";
import { createLogger } from "../logger.js";

type Env = Readonly<Record<string, string | undefined>>;
type EnvSource = "process" | "login" | "mise" | "interactive" | "overrides";

class ShellEnvResolveError extends Data.TaggedError("ShellEnvResolveError")<{
	readonly message: string;
}> {}

function parseEnv(output: string, source: string): Env {
	const records = output.split("\0").filter(Boolean);
	if (
		!output.endsWith("\0") ||
		records.some((record) => record.indexOf("=") < 1)
	)
		throw new ShellEnvResolveError({
			message: `${source} environment contains invalid records`,
		});
	return Object.fromEntries(
		records.map((record) => {
			const equals = record.indexOf("=");
			return [record.slice(0, equals), record.slice(equals + 1)];
		}),
	);
}

interface CachedEnv {
	config: ProjectShellEnvConfig;
	env?: Env;
	sources: EnvSource[];
	resolvedAt: number | null;
	attemptedAt: number;
	warnings: string[];
	pending?: Promise<void>;
	controller?: AbortController;
	dirty: boolean;
	closed: boolean;
	cleanup: () => void;
}

/** Find executables using the same PATH and cwd as a provider subprocess. */
export function findExecutable(
	name: string,
	env: Env,
	directory: string,
): string | undefined {
	if (env["PATH"] === undefined) return undefined;
	for (const entry of env["PATH"].split(delimiter)) {
		const candidate = resolve(directory, entry || ".", name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// A missing or non-executable PATH entry does not stop the search.
		}
	}
	return undefined;
}

/** Background-only shell I/O; get() always returns an immediate snapshot. */
export class ProjectShellEnvResolver {
	private readonly entries = new Map<string, CachedEnv>();
	private readonly baseEnv: Env;
	private readonly shell: string;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;
	private readonly watchIntervalMs: number;
	private closed = false;

	constructor(
		options: {
			env?: Env;
			shell?: string;
			ttlMs?: number;
			timeoutMs?: number;
			watchIntervalMs?: number;
		} = {},
	) {
		this.baseEnv = { ...(options.env ?? process.env) };
		this.shell = options.shell ?? this.baseEnv["SHELL"] ?? "/bin/sh";
		this.ttlMs = options.ttlMs ?? 5 * 60_000;
		this.timeoutMs = options.timeoutMs ?? 5_000;
		this.watchIntervalMs = options.watchIntervalMs ?? 1_000;
	}

	register(directory: string, config: ProjectShellEnvConfig = {}): void {
		if (this.closed) return;
		const key = resolve(directory);
		const nextConfig = {
			...config,
			...(config.overrides && { overrides: { ...config.overrides } }),
		};
		const existing = this.entries.get(key);
		if (existing) {
			if (!isDeepStrictEqual(existing.config, nextConfig)) {
				existing.config = nextConfig;
				this.invalidate(key, existing);
			}
			return;
		}
		const entry: CachedEnv = {
			config: nextConfig,
			sources: [],
			resolvedAt: null,
			attemptedAt: 0,
			warnings: [],
			dirty: false,
			closed: false,
			cleanup: () => {},
		};
		this.entries.set(key, entry);
		const home = this.baseEnv["HOME"] ?? homedir();
		const files = new Set([
			...[
				".zprofile",
				".zlogin",
				".zshrc",
				".zshenv",
				".bash_profile",
				".bash_login",
				".bashrc",
				".profile",
			].map((file) => join(home, file)),
			...[
				"mise.toml",
				".mise.toml",
				"mise.local.toml",
				".mise.local.toml",
				".tool-versions",
			].map((file) => join(key, file)),
			...(this.baseEnv["ZDOTDIR"]
				? [".zprofile", ".zlogin", ".zshrc", ".zshenv"].map((file) =>
						join(this.baseEnv["ZDOTDIR"] ?? home, file),
					)
				: []),
		]);
		const changed = (current: Stats, previous: Stats) => {
			if (
				current.mtimeMs !== previous.mtimeMs ||
				current.ctimeMs !== previous.ctimeMs ||
				current.ino !== previous.ino ||
				current.size !== previous.size
			) {
				this.invalidate(key, entry);
			}
		};
		for (const file of files) {
			watchFile(
				file,
				{ persistent: false, interval: this.watchIntervalMs },
				changed,
			);
		}
		const timer = setInterval(() => {
			void this.refresh(key);
		}, this.ttlMs);
		timer.unref();
		entry.cleanup = () => {
			clearInterval(timer);
			for (const file of files) unwatchFile(file, changed);
		};
		void this.refresh(key);
	}

	get(directory: string): Env {
		const key = resolve(directory);
		if (!this.entries.has(key)) this.register(key);
		const entry = this.entries.get(key);
		if (entry && Date.now() - entry.attemptedAt >= this.ttlMs) {
			void this.refresh(key);
		}
		return entry?.env ?? { ...this.baseEnv, ...entry?.config.overrides };
	}

	/** Pre-warming waits for a current capture; sends keep reading the cache. */
	async waitUntilReady(directory: string): Promise<boolean> {
		if (this.closed) return false;
		const key = resolve(directory);
		this.get(key);
		const entry = this.entries.get(key);
		if (!entry || entry.closed) return false;
		await entry.pending;
		return (
			!this.closed &&
			!entry.closed &&
			this.entries.get(key) === entry &&
			entry.env !== undefined
		);
	}

	snapshot(directory: string): {
		sources: readonly EnvSource[];
		resolvedAt: number | null;
		warnings: readonly string[];
		resolving: boolean;
	} {
		const entry = this.entries.get(resolve(directory));
		return {
			sources: entry?.env
				? [...entry.sources]
				: [
						"process",
						...(entry?.config.overrides &&
						Object.keys(entry.config.overrides).length > 0
							? ["overrides" as const]
							: []),
					],
			resolvedAt: entry?.resolvedAt ?? null,
			warnings: [...(entry?.warnings ?? [])],
			resolving: entry?.pending !== undefined,
		};
	}

	directories(): readonly string[] {
		return [...this.entries.keys()];
	}

	/** Awaitable only for diagnostics/tests; runtime callers use get(). */
	refresh(directory: string): Promise<void> {
		const key = resolve(directory);
		const entry = this.entries.get(key);
		if (!entry || entry.closed) return Promise.resolve();
		if (entry.pending) return entry.pending;
		const controller = new AbortController();
		entry.attemptedAt = Date.now();
		entry.controller = controller;
		const config = entry.config;
		// Defer even spawning the shell until after the caller has returned.
		entry.pending = Promise.resolve().then(async () => {
			if (entry.closed) return;
			try {
				let env = await this.shellEnv(
					key,
					this.baseEnv,
					false,
					controller.signal,
				);
				const sources: EnvSource[] = ["login"];
				const mise = findExecutable("mise", env, key);
				if (mise) {
					const output = await this.run(
						mise,
						["env", "-s", "bash"],
						key,
						env,
						controller.signal,
						"mise",
					);
					// Shell output includes unsets that mise's JSON output omits.
					env = parseEnv(
						(
							await this.run(
								"/bin/sh",
								[
									"-c",
									'eval "$1" && /usr/bin/env -0',
									"conduit-mise-env",
									output.toString("utf8"),
								],
								key,
								env,
								controller.signal,
								"mise",
							)
						).toString("utf8"),
						"mise",
					);
					sources.push("mise");
				}
				if (config.interactive === true) {
					env = await this.shellEnv(key, env, true, controller.signal);
					sources.push("interactive");
				}
				if (config.overrides && Object.keys(config.overrides).length > 0) {
					env = { ...env, ...config.overrides };
					sources.push("overrides");
				}
				if (entry.closed || entry.dirty) return;
				entry.env = env;
				entry.sources = sources;
				entry.resolvedAt = Date.now();
				entry.warnings = [];
			} catch (error) {
				if (entry.closed) return;
				const warning =
					error instanceof ShellEnvResolveError
						? error.message
						: "Environment resolution failed";
				entry.warnings = [warning];
				createLogger("shell-env").warn(
					`Project ${key}: ${warning}; keeping previous environment`,
				);
			} finally {
				delete entry.pending;
				delete entry.controller;
				if (entry.dirty && !entry.closed) {
					entry.dirty = false;
					await this.refresh(key);
				}
			}
		});
		return entry.pending;
	}

	remove(directory: string): void {
		const key = resolve(directory);
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.closed = true;
		entry.controller?.abort();
		entry.cleanup();
		this.entries.delete(key);
	}

	close(): void {
		this.closed = true;
		for (const directory of this.entries.keys()) this.remove(directory);
	}

	private invalidate(key: string, entry: CachedEnv): void {
		if (entry.closed) return;
		if (entry.pending) entry.dirty = true;
		else void this.refresh(key);
	}

	private async shellEnv(
		directory: string,
		env: Env,
		interactive: boolean,
		signal: AbortSignal,
	): Promise<Env> {
		const marker = randomUUID();
		const start = `conduit_${marker}_start\0`;
		const end = `conduit_${marker}_end\0`;
		const command = `printf '%s\\0' 'conduit_${marker}_start' && /usr/bin/env -0 && printf '%s\\0' 'conduit_${marker}_end'`;
		const output = (
			await this.run(
				this.shell,
				interactive ? ["-l", "-i", "-c", command] : ["-l", "-c", command],
				directory,
				env,
				signal,
				interactive ? "Interactive shell" : "Login shell",
			)
		).toString("utf8");
		const first = output.indexOf(start);
		const last = output.indexOf(end, first + start.length);
		if (first < 0 || last < 0)
			throw new ShellEnvResolveError({
				message: "Shell environment markers missing",
			});
		return parseEnv(output.slice(first + start.length, last), "Shell");
	}

	private run(
		command: string,
		args: string[],
		cwd: string,
		env: Env,
		signal: AbortSignal,
		source: string,
	): Promise<Buffer> {
		return new Promise((accept, reject) => {
			if (signal.aborted) {
				reject(
					new ShellEnvResolveError({
						message: "Environment resolution cancelled",
					}),
				);
				return;
			}
			const child = spawn(command, args, {
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			const chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const kill = () => {
				try {
					if (process.platform !== "win32" && child.pid)
						process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {
					/* The process may already have exited. */
				}
			};
			const finish = (error?: ShellEnvResolveError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal.removeEventListener("abort", cancelled);
				if (error) {
					kill();
					reject(error);
				} else accept(Buffer.concat(chunks));
			};
			const cancelled = () =>
				finish(
					new ShellEnvResolveError({
						message: "Environment resolution cancelled",
					}),
				);
			const timeout = setTimeout(
				() =>
					finish(
						new ShellEnvResolveError({
							message: `${source} timeout after ${this.timeoutMs}ms`,
						}),
					),
				this.timeoutMs,
			);
			timeout.unref();
			signal.addEventListener("abort", cancelled, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 1024 * 1024)
					finish(
						new ShellEnvResolveError({
							message: `${source} output exceeds 1 MiB`,
						}),
					);
				else chunks.push(chunk);
			});
			// Shell startup output can contain credentials; never include it in diagnostics.
			child.stderr.resume();
			child.once("error", () =>
				finish(
					new ShellEnvResolveError({
						message: `${source} could not start in ${cwd}`,
					}),
				),
			);
			child.once("close", (code) =>
				finish(
					code === 0
						? undefined
						: new ShellEnvResolveError({
								message: `${source} exited with code ${code ?? "unknown"}`,
							}),
				),
			);
		});
	}
}
