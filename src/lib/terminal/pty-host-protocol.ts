import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { Data, Schema } from "effect";

export const PTY_HOST_PROTOCOL_VERSION = 1;
export const PTY_SCROLLBACK_BYTES = 50 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

export class PtyHostError extends Data.TaggedError("PtyHostError")<{
	readonly message: string;
	readonly cause?: unknown;
	readonly code?: string;
}> {}

export class PtyHostProtocolMismatch extends Data.TaggedError(
	"PtyHostProtocolMismatch",
)<{
	readonly message: string;
	readonly protocolVersion: number;
}> {}

export function ptyHostConfigPath(configDir: string): string {
	try {
		return realpathSync(configDir);
	} catch {
		return resolve(configDir);
	}
}

export function ptyHostSocketPath(configDir: string): string {
	const directory = ptyHostConfigPath(configDir);
	const socket = join(directory, "pty.sock");
	// Darwin sun_path includes a terminating NUL in its 104 bytes. The alias
	// points to the config directory, so the socket still lives there.
	// Also budget the host's private h-<UUID> socket used for atomic election.
	if (Buffer.byteLength(directory) + 1 + 38 < 104) return socket;
	const hash = createHash("sha256")
		.update(directory)
		.digest("hex")
		.slice(0, 16);
	return join(
		`/tmp/conduit-pty-${process.getuid?.() ?? "user"}-${hash}`,
		"pty.sock",
	);
}

const requestId = Schema.Int.pipe(Schema.positive());
const dimension = Schema.Int.pipe(Schema.between(1, 10000));
const ptyInfo = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
	status: Schema.Literal("running", "exited"),
	pid: Schema.Int,
});
const terminal = Schema.Struct({
	pty: ptyInfo,
	exitCode: Schema.NullOr(Schema.Int),
});

export const PtyHostRequestSchema = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("hello"),
		protocolVersion: Schema.Int,
		buildId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("create"),
		requestId,
		cwd: Schema.String,
		cols: dimension,
		rows: dimension,
		shell: Schema.String,
		env: Schema.Record({ key: Schema.String, value: Schema.String }),
	}),
	Schema.Struct({
		type: Schema.Literal("list"),
		requestId,
		cwd: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("attach"),
		requestId,
		id: Schema.String,
		cwd: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("input"),
		id: Schema.String,
		data: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("resize"),
		id: Schema.String,
		cols: dimension,
		rows: dimension,
	}),
	Schema.Struct({ type: Schema.Literal("close", "detach"), id: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("stop"),
		requestId,
		force: Schema.Boolean,
	}),
);
export type PtyHostRequest = typeof PtyHostRequestSchema.Type;

export const PtyHostMessageSchema = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("hello"),
		protocolVersion: Schema.Int,
		buildId: Schema.String,
		pid: Schema.Int,
		openTerminals: Schema.Int,
	}),
	Schema.Struct({ type: Schema.Literal("created"), requestId, pty: ptyInfo }),
	Schema.Struct({
		type: Schema.Literal("list"),
		requestId,
		terminals: Schema.Array(terminal),
	}),
	Schema.Struct({
		type: Schema.Literal("attached"),
		requestId,
		...terminal.fields,
		scrollback: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("stopped"),
		requestId,
		stopped: Schema.Boolean,
	}),
	Schema.Struct({
		type: Schema.Literal("error"),
		requestId: Schema.optional(Schema.Int),
		message: Schema.String,
	}),
	// No request IDs or acknowledgements on the input/output path.
	Schema.Struct({
		type: Schema.Literal("output"),
		id: Schema.String,
		data: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("exit"),
		id: Schema.String,
		exitCode: Schema.Int,
	}),
);
export type PtyHostMessage = typeof PtyHostMessageSchema.Type;
export type PtyHostHello = Extract<PtyHostMessage, { type: "hello" }>;

export function readPtyFrames<A>(
	socket: Socket,
	decode: (value: unknown) => A,
	onMessage: (message: A) => void,
	onError: (error: Error) => void,
): void {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (data: string) => {
		buffered += data;
		try {
			let end: number;
			while ((end = buffered.indexOf("\n")) >= 0) {
				const frame = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
					throw new PtyHostError({ message: "PTY host frame too large" });
				onMessage(decode(JSON.parse(frame)));
				if (socket.destroyed) return;
			}
			if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES)
				throw new PtyHostError({ message: "PTY host frame too large" });
		} catch (cause) {
			onError(cause instanceof Error ? cause : new Error(String(cause)));
		}
	});
}

export function writePtyFrame(
	socket: Socket,
	message: PtyHostRequest | PtyHostMessage,
): void {
	if (socket.destroyed || socket.writableEnded)
		throw new PtyHostError({ message: "PTY host disconnected" });
	if (socket.writableLength > MAX_FRAME_BYTES) {
		socket.destroy();
		throw new PtyHostError({
			message: "PTY host client is not reading output",
		});
	}
	socket.write(`${JSON.stringify(message)}\n`);
}

export class PtyScrollback {
	private readonly chunks: Buffer[] = [];
	private size = 0;

	constructor(private readonly capacity = PTY_SCROLLBACK_BYTES) {}

	append(data: string): void {
		if (!data) return;
		const chunk = Buffer.from(data);
		this.chunks.push(chunk);
		this.size += chunk.length;
		while (this.size > this.capacity) {
			const first = this.chunks[0];
			if (!first) break;
			const excess = this.size - this.capacity;
			if (first.length <= excess) {
				this.chunks.shift();
				this.size -= first.length;
			} else {
				let offset = excess;
				// Drop an incomplete UTF-8 codepoint at the start of the replay.
				while (offset < first.length && ((first[offset] ?? 0) & 0xc0) === 0x80)
					offset++;
				this.chunks[0] = Buffer.from(first.subarray(offset));
				this.size -= offset;
			}
		}
	}

	read(): string {
		return Buffer.concat(this.chunks, this.size).toString("utf8");
	}

	clear(): void {
		this.chunks.length = 0;
		this.size = 0;
	}
}
