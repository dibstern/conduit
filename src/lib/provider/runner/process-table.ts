import { execFile, execFileSync } from "node:child_process";
import { Brand, Effect, Scheduler, Schema } from "effect";

export const StartTime = Schema.NonEmptyString.pipe(Schema.brand("StartTime"));
export type StartTime = typeof StartTime.Type;
// Readers already prove the text nonempty; avoid compiling a schema on a read.
const startTime = Brand.nominal<StartTime>();
export const ProcessStart = Schema.Struct({
	startTime: StartTime,
	startKey: Schema.optionalKey(Schema.String),
});
export type ProcessStart = typeof ProcessStart.Type;
export type Observed =
	| ({
			readonly state: "running" | "zombie";
			readonly pgid?: number;
	  } & ProcessStart)
	| { readonly state: "gone" | "unknown" };
export type ProcessMember = { readonly pid: number } & ProcessStart;
export interface Observation {
	readonly processes: ReadonlyMap<number, Observed>;
	readonly group: readonly ProcessMember[] | undefined;
}
type RecordedMember = {
	readonly pid: number;
	readonly startTime: string;
	readonly startKey?: string;
};
export type SignalTarget =
	| { readonly process: RecordedMember }
	| { readonly group: number; readonly pins: readonly RecordedMember[] };
export type SignalOutcome = "delivered" | "refused" | "failed" | "stale";
type StopSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTable {
	identify(pids: readonly number[]): ReadonlyMap<number, Observed>;
	observe(query: {
		readonly pgid: number;
		readonly pids: readonly number[];
	}): Effect.Effect<Observation>;
	signal(target: SignalTarget, signal: StopSignal): SignalOutcome;
	argv(pid: number): readonly string[] | undefined;
}

export interface ProcessAdapter {
	read(pids: readonly number[]): ReadonlyMap<number, Observed>;
	group(pgid: number): Effect.Effect<ReadonlyMap<number, Observed> | undefined>;
	signal(target: number, signal: StopSignal): void;
	argv(pid: number): readonly string[] | undefined;
}

export function sameProcess(
	recorded: {
		readonly pid: number;
		readonly startTime?: string;
		readonly startKey?: string;
	},
	seen: Observed | undefined,
): "same" | "gone" | "unknown" {
	if (seen?.state !== "running")
		return seen?.state === "gone" || seen?.state === "zombie"
			? "gone"
			: "unknown";
	const scheme = recorded.startKey?.split(":", 1)[0];
	if (
		(scheme === "d" || scheme === "l") &&
		seen.startKey?.startsWith(`${scheme}:`)
	)
		return recorded.startKey === seen.startKey ? "same" : "gone";
	if (recorded.startTime === undefined) return "unknown";
	return recorded.startTime === seen.startTime ? "same" : "gone";
}

export function makeProcessTable(adapter: ProcessAdapter): ProcessTable {
	const table: ProcessTable = {
		identify(pids) {
			const result = new Map<number, Observed>();
			const valid = [...new Set(pids)].filter(
				(pid) => Number.isInteger(pid) && pid > 0 && pid <= 2147483647,
			);
			let read: ReadonlyMap<number, Observed> | undefined;
			try {
				if (valid.length) read = adapter.read(valid);
			} catch {
				// An unreadable table is never evidence of exit.
			}
			for (const pid of pids)
				result.set(pid, read?.get(pid) ?? { state: "unknown" });
			return result;
		},
		observe: ({ pgid, pids }) =>
			Effect.gen(function* () {
				if (yield* Scheduler.PreventSchedulerYield)
					return yield* Effect.die(
						"Process-table observation inside a SQL write",
					);
				const before = table.identify(pids);
				const pins: ProcessMember[] = [];
				for (const [pid, seen] of before)
					if (seen.state === "running" && seen.pgid === pgid)
						pins.push({
							pid,
							startTime: seen.startTime,
							...(seen.startKey === undefined
								? {}
								: { startKey: seen.startKey }),
						});
				if (!pins.length) return { processes: before, group: undefined };
				const listed = yield* Effect.suspend(() => adapter.group(pgid)).pipe(
					Effect.catchDefect(() => Effect.succeed(undefined)),
				);
				const after = table.identify(pids);
				const pinned = pins.some((pin) => {
					const seen = after.get(pin.pid);
					return (
						sameProcess(pin, seen) === "same" &&
						seen?.state === "running" &&
						seen.pgid === pgid
					);
				});
				if (!pinned || !listed?.size)
					return { processes: after, group: undefined };
				const processes = new Map(listed);
				for (const [pid, seen] of after) processes.set(pid, seen);
				const group: ProcessMember[] = [];
				for (const [pid, seen] of listed) {
					if (
						(seen.state !== "running" && seen.state !== "zombie") ||
						seen.pgid !== pgid
					)
						return { processes: after, group: undefined };
					group.push({
						pid,
						startTime: seen.startTime,
						...(seen.startKey === undefined ? {} : { startKey: seen.startKey }),
					});
				}
				return { processes, group };
			}),
		signal(target, signal) {
			const pins = "process" in target ? [target.process] : target.pins;
			const seen = table.identify(pins.map((pin) => pin.pid));
			if (
				!pins.some((pin) => {
					const current = seen.get(pin.pid);
					return (
						sameProcess(pin, current) === "same" &&
						("process" in target ||
							(current?.state === "running" && current.pgid === target.group))
					);
				})
			)
				return "stale";
			const pid = "process" in target ? target.process.pid : -target.group;
			if (
				!Number.isInteger(pid) ||
				pid === 0 ||
				Math.abs(pid) > 2147483647 ||
				("group" in target && target.group <= 0)
			)
				return "stale";
			try {
				adapter.signal(pid, signal);
				return "delivered";
			} catch (error) {
				return error instanceof Error &&
					"code" in error &&
					(error.code === "EPERM" || error.code === "EACCES")
					? "refused"
					: "failed";
			}
		},
		argv(pid) {
			if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647)
				return undefined;
			try {
				return adapter.argv(pid);
			} catch {
				return undefined;
			}
		},
	};
	return table;
}

export function makeMemoryProcessAdapter(input: {
	readonly processes: ReadonlyMap<number, Observed>;
	readonly argv?: ReadonlyMap<number, readonly string[]>;
	readonly group?: ProcessAdapter["group"];
	readonly signal?: ProcessAdapter["signal"];
}): ProcessAdapter & {
	readonly calls: {
		reads: number[][];
		groups: number[];
		signals: { target: number; signal: StopSignal }[];
	};
} {
	const calls: {
		reads: number[][];
		groups: number[];
		signals: { target: number; signal: StopSignal }[];
	} = { reads: [], groups: [], signals: [] };
	return {
		calls,
		read: (pids) => {
			calls.reads.push([...pids]);
			return new Map(
				pids.map((pid) => [pid, input.processes.get(pid) ?? { state: "gone" }]),
			);
		},
		group: (pgid) =>
			Effect.suspend(() => {
				calls.groups.push(pgid);
				if (input.group) return input.group(pgid);
				const result = new Map<number, Observed>();
				for (const [pid, seen] of input.processes) {
					if (seen.state === "unknown") return Effect.succeed(undefined);
					if (
						(seen.state === "running" || seen.state === "zombie") &&
						seen.pgid === pgid
					)
						result.set(pid, seen);
				}
				return Effect.succeed(result);
			}),
		signal: (target, signal) => {
			calls.signals.push({ target, signal });
			input.signal?.(target, signal);
		},
		argv: (pid) => input.argv?.get(pid),
	};
}

function absent(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ESRCH";
	}
}

export function makePsProcessAdapter(): ProcessAdapter {
	return {
		group: (pgid) =>
			Effect.callback((resume) => {
				let child: ReturnType<typeof execFile>;
				try {
					child = execFile(
						"ps",
						["-axo", "pid=,pgid=,lstart=,stat="],
						{
							encoding: "utf8",
							env: { ...process.env, LC_ALL: "C" },
							timeout: 1000,
						},
						(error, stdout) => {
							if (error) return resume(Effect.succeed(undefined));
							const result = new Map<number, Observed>();
							for (const line of stdout.split("\n")) {
								if (!line.trim()) continue;
								const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(
									line,
								);
								if (!match?.[1] || !match[2] || !match[3] || !match[4])
									return resume(Effect.succeed(undefined));
								if (Number(match[2]) === pgid)
									result.set(Number(match[1]), {
										state: match[4].startsWith("Z") ? "zombie" : "running",
										pgid,
										startTime: startTime(match[3]),
									});
							}
							resume(Effect.succeed(result));
						},
					);
				} catch {
					resume(Effect.succeed(undefined));
					return;
				}
				return Effect.sync(() => {
					child.kill();
				});
			}),
		signal: (target, signal) => {
			process.kill(target, signal);
		},
		read(pids) {
			const result = new Map<number, Observed>();
			for (const pid of pids)
				if (absent(pid)) result.set(pid, { state: "gone" });
			const live = pids.filter((pid) => !result.has(pid));
			if (!live.length) return result;
			try {
				const output = execFileSync(
					"ps",
					["-o", "pid=,pgid=,lstart=,stat=", "-p", live.join(",")],
					{
						encoding: "utf8",
						env: { ...process.env, LC_ALL: "C" },
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 1000,
					},
				);
				for (const line of output.split("\n")) {
					const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
					if (match?.[1] && match[2] && match[3] && match[4])
						result.set(Number(match[1]), {
							state: match[4].startsWith("Z") ? "zombie" : "running",
							pgid: Number(match[2]),
							startTime: startTime(match[3]),
						});
				}
			} catch {
				// Match the existing point reader: failed ps is not proof of exit.
			}
			for (const pid of live)
				if (!result.has(pid))
					result.set(pid, { state: absent(pid) ? "gone" : "unknown" });
			return result;
		},
		argv(pid) {
			const command = execFileSync(
				"ps",
				["-ww", "-o", "command=", "-p", String(pid)],
				{
					encoding: "utf8",
					env: { ...process.env, LC_ALL: "C" },
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 1000,
				},
			).trim();
			// ps flattens argv without quoting. Exact boundaries require a native adapter.
			return command ? command.split(/\s+/) : undefined;
		},
	};
}

export function makeDarwinProcessAdapter(): ProcessAdapter & {
	selfCheck(): void;
} {
	// Node emits this synchronously while loading the builtin. Restore the hook
	// immediately so no other warning or later emitter is affected.
	const emitWarning = process.emitWarning;
	let ffi: typeof import("node:ffi") | undefined;
	try {
		process.emitWarning = (warning: string | Error, ...options: unknown[]) => {
			if (
				warning ===
					"FFI is an experimental feature and might change at any time" &&
				options[0] === "ExperimentalWarning"
			)
				return;
			Reflect.apply(emitWarning, process, [warning, ...options]);
		};
		ffi = process.getBuiltinModule("node:ffi");
	} finally {
		process.emitWarning = emitWarning;
	}
	if (!ffi)
		throw new Error(
			process.execArgv.includes("--no-experimental-ffi")
				? "FFI disabled by --no-experimental-ffi"
				: "node:ffi missing or disabled",
		);
	const { functions } = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
		sysctl: {
			arguments: [
				"pointer",
				"uint32",
				"pointer",
				"pointer",
				"pointer",
				"uint64",
			],
			return: "int32",
		},
		localtime_r: { arguments: ["pointer", "pointer"], return: "pointer" },
		getpgid: { arguments: ["int32"], return: "int32" },
		__error: { arguments: [], return: "pointer" },
	});
	const mib = Buffer.alloc(16);
	const size = Buffer.alloc(8);
	const argMax = Buffer.alloc(4);
	mib.writeInt32LE(1, 0);
	mib.writeInt32LE(8, 4); // KERN_ARGMAX
	size.writeBigUInt64LE(4n);
	if (functions.sysctl(mib, 2, argMax, size, null, 0n) !== 0)
		throw new Error("sysctl KERN_ARGMAX failed");
	const argvCapacity = argMax.readInt32LE();
	if (argvCapacity <= 0 || argvCapacity > 8 * 1024 * 1024)
		throw new Error("sysctl KERN_ARGMAX outside supported bounds");
	// KERN_PROCARGS2 can succeed with a zero-filled payload when undersized,
	// rather than report ENOMEM. Reserve the kernel's maximum once.
	const buffers = {
		info: Buffer.alloc(648),
		group: Buffer.alloc(648 * 16),
		argv: Buffer.alloc(argvCapacity),
	};
	const tm = Buffer.alloc(56);
	const binding = ffi;
	function query(pid: number, kind: "info" | "group" | "argv"): Buffer {
		mib.writeInt32LE(1, 0); // CTL_KERN
		mib.writeInt32LE(kind === "argv" ? 49 : 14, 4); // KERN_PROCARGS2 / KERN_PROC
		mib.writeInt32LE(kind === "argv" ? pid : kind === "group" ? 2 : 1, 8); // KERN_PROC_PGRP / KERN_PROC_PID
		mib.writeInt32LE(pid, 12);
		for (let attempt = 0; attempt < 4; attempt++) {
			const buffer = buffers[kind];
			size.writeBigUInt64LE(BigInt(buffer.length));
			const rc = functions.sysctl(
				mib,
				kind === "argv" ? 3 : 4,
				buffer,
				size,
				null,
				0n,
			);
			const length = Number(size.readBigUInt64LE());
			if (rc === 0 && length <= buffer.length)
				return buffer.subarray(0, length);
			const errno = binding.getInt32(functions.__error());
			if (rc === -1 && (errno === 3 || errno === 2))
				return buffer.subarray(0, 0);
			if (rc !== -1 || errno !== 12)
				throw new Error(`sysctl failed: errno ${errno}`);
			const capacity = Math.max(buffer.length * 2, length);
			if (capacity > 8 * 1024 * 1024)
				throw new Error("sysctl buffer limit exceeded");
			buffers[kind] = Buffer.alloc(capacity);
		}
		throw new Error("sysctl buffer kept growing");
	}
	function observed(info: Buffer): Observed {
		const seconds = info.readBigInt64LE();
		const micros = info.readInt32LE(8);
		if (!functions.localtime_r(info.subarray(0, 8), tm))
			throw new Error("localtime_r failed");
		const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
			tm.readInt32LE(24)
		];
		const month = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		][tm.readInt32LE(16)];
		const date = String(tm.readInt32LE(12)).padStart(2, " ");
		const clock = [8, 4, 0]
			.map((offset) => String(tm.readInt32LE(offset)).padStart(2, "0"))
			.join(":");
		return {
			state: info.readUInt8(36) === 5 ? "zombie" : "running",
			pgid: info.readInt32LE(564),
			startTime: startTime(
				`${day} ${month} ${date} ${clock} ${tm.readInt32LE(20) + 1900}`,
			),
			startKey: `d:${seconds}.${micros}`,
		};
	}

	return {
		selfCheck() {
			const own = query(process.pid, "info");
			if (
				own.length !== 648 ||
				own.readInt32LE(40) !== process.pid ||
				own.readInt32LE(560) !== process.ppid ||
				own.readInt32LE(564) !== functions.getpgid(0) ||
				Math.abs(
					Number(own.readBigInt64LE()) - (Date.now() / 1000 - process.uptime()),
				) > 5
			)
				throw new Error(
					"sysctl self-check failed: incompatible kinfo_proc layout or start time",
				);
		},
		group: (pgid) =>
			Effect.sync(() => {
				try {
					const bytes = query(pgid, "group");
					if (bytes.length % 648 !== 0) return undefined;
					const result = new Map<number, Observed>();
					for (let offset = 0; offset < bytes.length; offset += 648) {
						const info = bytes.subarray(offset, offset + 648);
						if (info.readInt32LE(564) !== pgid) return undefined;
						result.set(info.readInt32LE(40), observed(info));
					}
					return result;
				} catch {
					return undefined;
				}
			}),
		signal: (target, signal) => {
			process.kill(target, signal);
		},
		read(pids) {
			const result = new Map<number, Observed>();
			for (const pid of pids) {
				try {
					const info = query(pid, "info");
					if (!info.length) {
						result.set(pid, { state: "gone" });
						continue;
					}
					if (info.length !== 648 || info.readInt32LE(40) !== pid)
						throw new Error("unexpected kinfo_proc");
					result.set(pid, observed(info));
				} catch {
					result.set(pid, { state: "unknown" });
				}
			}
			return result;
		},
		argv(pid) {
			const bytes = query(pid, "argv");
			if (bytes.length < 4) return undefined;
			const argc = bytes.readInt32LE();
			let offset = bytes.indexOf(0, 4);
			if (offset < 0 || argc <= 0) return undefined;
			while (offset < bytes.length && bytes[offset] === 0) offset++;
			const args: string[] = [];
			for (let i = 0; i < argc; i++) {
				const end = bytes.indexOf(0, offset);
				if (end < 0) return undefined;
				args.push(bytes.toString("utf8", offset, end));
				offset = end + 1;
			}
			return args;
		},
	};
}

export function makeProductionProcessTable(
	warn: (message: string) => void = console.warn,
): ProcessTable {
	if (process.platform === "darwin") {
		try {
			const adapter = makeDarwinProcessAdapter();
			adapter.selfCheck();
			// Exercise the formatter and its FFI binding as part of the one-time check.
			if (adapter.read([process.pid]).get(process.pid)?.state !== "running")
				throw new Error("native start-time self-check failed");
			return makeProcessTable(adapter);
		} catch (error) {
			warn(
				`Native process table unavailable; using ps: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return makeProcessTable(makePsProcessAdapter());
}
