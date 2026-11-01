import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	type Stats,
	statSync,
	unwatchFile,
	watchFile,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Data } from "effect";
import type {
	ProjectShellEnvConfig,
	ProjectShellEnvSnapshot,
} from "../contracts/project-shell-env.js";
import { spawnOwnedSubprocess } from "../domain/daemon/Services/subprocess.js";
import { createLogger } from "../logger.js";

type Env = Readonly<Record<string, string | undefined>>;
type EnvSource = "process" | "login" | "mise" | "interactive" | "overrides";

const EFFECTIVE_DIRECTORY_IDLE_MS = 60_000;

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
	readonly directory: string;
	readonly projectId: string | undefined;
	root: boolean;
	lastUsedAt: number;
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
	private readonly processes = new Set<
		ReturnType<typeof spawnOwnedSubprocess>
	>();
	private readonly entries = new Map<string, CachedEnv>();
	private readonly projectConfigs = new Map<string, ProjectShellEnvConfig>();
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

	register(
		directory: string,
		config: ProjectShellEnvConfig = {},
		projectId?: string,
	): void {
		this.registerEntry(directory, config, projectId, true);
		const resolved = resolve(directory);
		for (const entry of this.entries.values()) {
			if (
				entry.projectId === projectId &&
				(projectId !== undefined || entry.directory === resolved)
			)
				entry.root = entry.directory === resolved;
		}
	}

	private registerEntry(
		directory: string,
		config: ProjectShellEnvConfig = {},
		projectId?: string,
		root = false,
	): void {
		if (this.closed) return;
		const resolved = resolve(directory);
		const key = this.cacheKey(resolved, projectId);
		const nextConfig = {
			...config,
			...(config.overrides && { overrides: { ...config.overrides } }),
		};
		if (projectId !== undefined) {
			this.projectConfigs.set(projectId, nextConfig);
			for (const entry of this.entries.values()) {
				if (
					entry.projectId !== projectId ||
					isDeepStrictEqual(entry.config, nextConfig)
				)
					continue;
				entry.config = nextConfig;
				this.invalidate(entry);
			}
		}
		const existing = this.entries.get(key);
		if (existing) {
			existing.root ||= root;
			if (!isDeepStrictEqual(existing.config, nextConfig)) {
				existing.config = nextConfig;
				this.invalidate(existing);
			}
			return;
		}
		const entry: CachedEnv = {
			directory: resolved,
			projectId,
			root,
			lastUsedAt: Date.now(),
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
			].map((file) => join(resolved, file)),
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
				this.invalidate(entry);
			}
		};
		for (const file of files) {
			watchFile(
				file,
				{ persistent: false, interval: this.watchIntervalMs },
				changed,
			);
		}
		const timer = setInterval(
			() => {
				if (
					!entry.root &&
					Date.now() - entry.lastUsedAt >= EFFECTIVE_DIRECTORY_IDLE_MS
				)
					this.remove(resolved, projectId);
				else if (Date.now() - entry.attemptedAt >= this.ttlMs)
					void this.refresh(resolved, projectId);
			},
			Math.min(this.ttlMs, EFFECTIVE_DIRECTORY_IDLE_MS),
		);
		timer.unref();
		entry.cleanup = () => {
			clearInterval(timer);
			for (const file of files) unwatchFile(file, changed);
		};
		void this.refresh(resolved, projectId);
	}

	get(directory: string, projectId?: string): Env {
		return this.getSnapshot(directory, projectId).env;
	}

	getSnapshot(directory: string, projectId?: string): ProjectShellEnvSnapshot {
		const key = this.cacheKey(directory, projectId);
		if (!this.entries.has(key))
			this.registerEntry(
				directory,
				projectId === undefined ? {} : this.projectConfigs.get(projectId),
				projectId,
			);
		const entry = this.entries.get(key);
		if (entry) entry.lastUsedAt = Date.now();
		if (entry && Date.now() - entry.attemptedAt >= this.ttlMs) {
			void this.refresh(directory, projectId);
		}
		return {
			env:
				entry?.env ??
				Object.freeze({ ...this.baseEnv, ...entry?.config.overrides }),
			declared: entry?.config ?? {},
		};
	}

	/** Pre-warming waits for a current capture; sends keep reading the cache. */
	async waitUntilReady(
		directory: string,
		projectId?: string,
	): Promise<boolean> {
		if (this.closed) return false;
		const key = this.cacheKey(directory, projectId);
		this.get(directory, projectId);
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

	snapshot(
		directory: string,
		projectId?: string,
	): {
		sources: readonly EnvSource[];
		resolvedAt: number | null;
		warnings: readonly string[];
		resolving: boolean;
	} {
		const entry = this.entries.get(this.cacheKey(directory, projectId));
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
		return [
			...new Set(
				Array.from(this.entries.values(), ({ directory }) => directory),
			),
		];
	}

	registrations(): readonly {
		directory: string;
		projectId: string | undefined;
	}[] {
		return Array.from(this.entries.values(), ({ directory, projectId }) => ({
			directory,
			projectId,
		}));
	}

	/** Awaitable only for diagnostics/tests; runtime callers use get(). */
	refresh(directory: string, projectId?: string): Promise<void> {
		const resolved = resolve(directory);
		const entry = this.entries.get(this.cacheKey(resolved, projectId));
		if (!entry || entry.closed) return Promise.resolve();
		if (!entry.root && !existsSync(resolved)) {
			this.remove(resolved, projectId);
			return Promise.resolve();
		}
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
					resolved,
					this.baseEnv,
					false,
					controller.signal,
				);
				const sources: EnvSource[] = ["login"];
				const mise = findExecutable("mise", env, resolved);
				if (mise) {
					const output = await this.run(
						mise,
						["env", "-s", "bash"],
						resolved,
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
								resolved,
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
					env = await this.shellEnv(resolved, env, true, controller.signal);
					sources.push("interactive");
				}
				if (config.overrides && Object.keys(config.overrides).length > 0) {
					env = { ...env, ...config.overrides };
					sources.push("overrides");
				}
				if (entry.closed || entry.dirty) return;
				entry.env = Object.freeze(env);
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
					`Project ${resolved}: ${warning}; keeping previous environment`,
				);
			} finally {
				delete entry.pending;
				delete entry.controller;
				if (entry.dirty && !entry.closed) {
					entry.dirty = false;
					await this.refresh(resolved, projectId);
				}
			}
		});
		return entry.pending;
	}

	remove(directory: string, projectId?: string): void {
		const key = this.cacheKey(directory, projectId);
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.closed = true;
		entry.controller?.abort();
		entry.cleanup();
		this.entries.delete(key);
		if (
			projectId !== undefined &&
			!Array.from(this.entries.values()).some(
				(entry) => entry.projectId === projectId,
			)
		)
			this.projectConfigs.delete(projectId);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const { directory, projectId } of this.entries.values())
			this.remove(directory, projectId);
		await Promise.all([...this.processes].map((process) => process.stop()));
	}

	private cacheKey(directory: string, projectId?: string): string {
		return JSON.stringify([projectId, resolve(directory)]);
	}

	private invalidate(entry: CachedEnv): void {
		if (entry.closed) return;
		if (entry.pending) entry.dirty = true;
		else void this.refresh(entry.directory, entry.projectId);
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
			const owned = spawnOwnedSubprocess(command, args, {
				cwd,
				env,
			});
			this.processes.add(owned);
			const { child } = owned;
			child.stdin.end();
			const chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const finish = (error?: ShellEnvResolveError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal.removeEventListener("abort", cancelled);
				void owned.stop().then(() => {
					this.processes.delete(owned);
					if (error) reject(error);
					else accept(Buffer.concat(chunks));
				}, reject);
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
				if (settled) return;
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
