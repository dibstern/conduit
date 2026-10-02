import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Deferred, Effect } from "effect";
import type {
	ClaudeRunnerMessage,
	ClaudeRunnerSocket,
} from "./claude-runner-protocol.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
} from "./claude-session-runner.js";

type OutputFrame = Extract<ClaudeRunnerMessage, { type: "output" }>;

/** The live runner owns the spool. It never opens Conduit's event store. */
export class ClaudeRunnerSpool {
	private sequence = 0;
	private connection: ClaudeRunnerSocket | undefined;
	private spooled = false;
	private spooledBytes = 0;
	private acknowledgedBytes = 0;
	private spooledThroughSequence = 0;
	private readonly retained = new Map<number, OutputFrame>();
	private readonly drainWaiters = new Set<() => void>();
	private readonly waiters = new Map<
		number,
		Deferred.Deferred<ClaudeSessionOutputReply, ClaudeSessionFailure>
	>();
	private readonly pendingInteractions = new Map<
		string,
		{ sequence: number; output: ClaudeSessionOutput }
	>();
	constructor(private readonly filename: string) {
		writeFileSync(filename, "", { mode: 0o600 });
	}

	get hasHeldWork(): boolean {
		return this.retained.size > 0 || this.pendingInteractions.size > 0;
	}

	get pendingOutputs(): readonly {
		sequence: number;
		output: ClaudeSessionOutput;
	}[] {
		return [...this.pendingInteractions.values()];
	}

	drainEffect(): Effect.Effect<void> {
		return Effect.async<void>((resume) => {
			if (this.retained.size === 0) {
				resume(Effect.void);
				return;
			}
			const complete = () => resume(Effect.void);
			this.drainWaiters.add(complete);
			return Effect.sync(() => {
				this.drainWaiters.delete(complete);
			});
		});
	}

	attach(connection: ClaudeRunnerSocket, acknowledgedSequence: number): void {
		this.connection = connection;
		this.truncate(acknowledgedSequence);
		for (const frame of this.retained.values()) connection.write(frame);
	}

	disconnect(connection: ClaudeRunnerSocket): void {
		if (this.connection !== connection) return;
		this.connection = undefined;
		this.writeSpool();
		for (const [sequence, frame] of this.retained) {
			if (this.needsReply(frame.output)) continue;
			const waiter = this.waiters.get(sequence);
			if (waiter) Deferred.unsafeDone(waiter, Effect.succeed({}));
			this.waiters.delete(sequence);
		}
	}

	reply(message: Extract<ClaudeRunnerMessage, { type: "output-reply" }>): void {
		if (message.sequence === undefined) return;
		const waiter = this.waiters.get(message.sequence);
		if (waiter)
			Deferred.unsafeDone(
				waiter,
				message.failure
					? Effect.fail(message.failure)
					: Effect.succeed(message.result ?? {}),
			);
		this.waiters.delete(message.sequence);
		if (!message.failure) this.truncate(message.sequence);
	}

	emit(
		output: ClaudeSessionOutput,
	): Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure> {
		return Effect.gen(this, function* () {
			// Cleanup and the idle tail must not hold the next SDK enqueue.
			// Both notices remain retained until their durable acknowledgement.
			const notification =
				output.type === "release-sink" ||
				(output.type === "event" &&
					output.event.type === "session.status" &&
					typeof output.event.data === "object" &&
					output.event.data !== null &&
					"status" in output.event.data &&
					output.event.data.status === "idle");
			// Deferred construction may yield. Allocate the sequence only once
			// waiter registration and frame writing can run without interruption.
			const waiter = notification
				? undefined
				: yield* Deferred.make<
						ClaudeSessionOutputReply,
						ClaudeSessionFailure
					>();
			const sequence = ++this.sequence;
			const frame: OutputFrame = {
				type: "output",
				outputId: String(sequence),
				sequence,
				output,
			};
			if (
				output.type === "permission-request" ||
				output.type === "question-request"
			)
				this.pendingInteractions.set(output.request.requestId, {
					sequence,
					output,
				});
			else if (output.type === "cancel-interaction")
				this.pendingInteractions.delete(output.requestId);
			else if (output.type === "release-sink")
				for (const [id, pending] of this.pendingInteractions)
					if (
						"sinkId" in pending.output &&
						pending.output.sinkId === output.sinkId
					)
						this.pendingInteractions.delete(id);
			this.retained.set(sequence, frame);
			if (waiter && (this.connection || this.needsReply(output)))
				this.waiters.set(sequence, waiter);
			if (this.connection) this.connection.write(frame);
			else {
				this.spooled = true;
				const line = `${JSON.stringify(frame)}\n`;
				appendFileSync(this.filename, line);
				this.spooledBytes += Buffer.byteLength(line);
				this.spooledThroughSequence = sequence;
				if (!this.needsReply(output)) return {};
			}
			return waiter ? yield* Deferred.await(waiter) : {};
		});
	}

	private needsReply(output: ClaudeSessionOutput): boolean {
		return (
			output.type === "read-turn-history" ||
			output.type === "materialize-subagents"
		);
	}

	private truncate(sequence: number): void {
		for (const [retainedSequence, frame] of this.retained) {
			if (retainedSequence > sequence) break;
			if (this.waiters.has(retainedSequence)) continue;
			this.retained.delete(retainedSequence);
			if (this.spooled && retainedSequence <= this.spooledThroughSequence)
				this.acknowledgedBytes += Buffer.byteLength(JSON.stringify(frame)) + 1;
		}
		if (this.retained.size === 0) {
			for (const complete of this.drainWaiters) complete();
			this.drainWaiters.clear();
		}
		// Reclaim at least half the file per rewrite, keeping replay compaction
		// linear in backlog size. A complete ack always leaves an empty file.
		if (
			this.spooled &&
			(this.retained.size === 0 ||
				this.acknowledgedBytes >= this.spooledBytes / 2)
		)
			this.writeSpool();
	}

	private writeSpool(): void {
		const contents = [...this.retained.values()]
			.map((frame) => `${JSON.stringify(frame)}\n`)
			.join("");
		const temporary = `${this.filename}.tmp`;
		try {
			writeFileSync(temporary, contents, { mode: 0o600 });
			renameSync(temporary, this.filename);
		} finally {
			rmSync(temporary, { force: true });
		}
		this.spooled = this.retained.size > 0;
		this.spooledBytes = Buffer.byteLength(contents);
		this.acknowledgedBytes = 0;
		this.spooledThroughSequence = this.sequence;
	}
}
