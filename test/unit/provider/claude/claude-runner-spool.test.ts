import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClaudeRunnerMessage,
	ClaudeRunnerSocket,
} from "../../../../src/lib/provider/claude/claude-runner-protocol.js";
import { ClaudeRunnerSpool } from "../../../../src/lib/provider/claude/claude-runner-spool.js";
import type { ClaudeSessionOutput } from "../../../../src/lib/provider/claude/claude-session-runner.js";

const scheduling = vi.hoisted(() => ({ yieldDeferred: false }));
vi.mock("effect", async (importOriginal) => {
	const effect = await importOriginal<typeof import("effect")>();
	return {
		...effect,
		Deferred: {
			...effect.Deferred,
			make: <A, E>() =>
				effect.Deferred.make<A, E>().pipe(
					effect.Effect.tap(() =>
						scheduling.yieldDeferred
							? effect.Effect.yieldNow()
							: effect.Effect.void,
					),
				),
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: vi.fn(fs.writeFileSync),
		renameSync: vi.fn(fs.renameSync),
	};
});

const directories: string[] = [];
const sockets: Socket[] = [];
const proofPath = "test-results/85kb-9-spool-measurements.json";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "conduit-spool-regression-"));
	directories.push(directory);
	const filename = join(directory, "runner.spool");
	const spool = new ClaudeRunnerSpool(filename);
	const socket = new Socket();
	sockets.push(socket);
	const connection = new ClaudeRunnerSocket(
		socket,
		() => {},
		() => {},
	);
	vi.spyOn(connection, "write").mockImplementation(() => {});
	return { spool, filename, connection };
}

function statusOutput(status: "idle" | "busy"): ClaudeSessionOutput {
	return {
		type: "event",
		sinkId: "turn-1",
		event: {
			eventId: `status-${status}`,
			type: "session.status",
			providerId: "claude",
			sessionId: "session-1",
			providerRefs: {},
			rawSource: { kind: "claude.sdk.translator" },
			createdAt: 0,
			data: { sessionId: "session-1", status },
		},
	};
}

afterEach(() => {
	scheduling.yieldDeferred = false;
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("Claude runner output spool", () => {
	it("emits idle without waiting for ack while preserving replay and awaiting other statuses", async () => {
		const { spool, filename, connection } = fixture();
		spool.attach(connection, 0);
		const emitted = await Effect.runPromise(
			spool.emit(statusOutput("idle")).pipe(Effect.timeoutOption("100 millis")),
		);
		expect(Option.isSome(emitted)).toBe(true);
		spool.disconnect(connection);
		const persisted = readFileSync(filename, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as ClaudeRunnerMessage);
		expect(persisted).toMatchObject([
			{
				type: "output",
				sequence: 1,
				output: { type: "event", event: { data: { status: "idle" } } },
			},
		]);
		spool.attach(connection, 0);
		expect(
			vi.mocked(connection.write).mock.calls.map(([frame]) => frame),
		).toMatchObject([
			{ type: "output", sequence: 1 },
			{ type: "output", sequence: 1 },
		]);
		spool.reply({
			type: "output-reply",
			outputId: "1",
			sequence: 1,
			result: {},
		});
		expect(readFileSync(filename).length).toBe(0);
		const busy = Effect.runFork(spool.emit(statusOutput("busy")));
		await Effect.runPromise(Effect.yieldNow());
		expect(Option.isNone(await Effect.runPromise(Fiber.poll(busy)))).toBe(true);
		spool.reply({
			type: "output-reply",
			outputId: "2",
			sequence: 2,
			result: {},
		});
		await Effect.runPromise(Fiber.join(busy));
	});

	it("drains retained notifications only after durable acknowledgement", async () => {
		const { spool, connection } = fixture();
		spool.attach(connection, 0);
		await Effect.runPromise(
			spool.emit({ type: "release-sink", sinkId: "turn-1" }),
		);
		const drain = Effect.runFork(spool.drainEffect());
		await Effect.runPromise(Effect.yieldNow());
		expect(Option.isNone(await Effect.runPromise(Fiber.poll(drain)))).toBe(
			true,
		);
		spool.reply({
			type: "output-reply",
			outputId: "1",
			sequence: 1,
			result: {},
		});
		await Effect.runPromise(
			Fiber.join(drain).pipe(Effect.timeout("100 millis")),
		);
		await Effect.runPromise(
			spool.drainEffect().pipe(Effect.timeout("100 millis")),
		);
	});

	it("removes cancelled drain listeners before a later acknowledgement", async () => {
		const { spool, connection } = fixture();
		spool.attach(connection, 0);
		await Effect.runPromise(
			spool.emit({ type: "release-sink", sinkId: "turn-1" }),
		);
		for (let index = 0; index < 20; index++) {
			const drain = Effect.runFork(spool.drainEffect());
			await Effect.runPromise(Effect.yieldNow());
			expect(Reflect.get(spool, "drainWaiters")).toHaveProperty("size", 1);
			await Effect.runPromise(Fiber.interrupt(drain));
			expect(Reflect.get(spool, "drainWaiters")).toHaveProperty("size", 0);
		}
		spool.reply({
			type: "output-reply",
			outputId: "1",
			sequence: 1,
			result: {},
		});
		await Effect.runPromise(
			spool.drainEffect().pipe(Effect.timeout("100 millis")),
		);
		expect(Reflect.get(spool, "drainWaiters")).toHaveProperty("size", 0);
	});

	it("writes concurrent notification and release frames in sequence order", async () => {
		scheduling.yieldDeferred = true;
		const { spool, connection } = fixture();
		const frames: ClaudeRunnerMessage[] = [];
		vi.mocked(connection.write).mockImplementation((message) => {
			frames.push(message);
			if (message.type === "output")
				spool.reply({
					type: "output-reply",
					outputId: message.outputId,
					sequence: message.sequence,
					result: {},
				});
		});
		spool.attach(connection, 0);
		await Effect.runPromise(
			Effect.all(
				[
					spool.emit({
						type: "cancel-interaction",
						sinkId: "turn-1",
						requestId: "request-1",
					}),
					spool.emit({ type: "release-sink", sinkId: "turn-1" }),
				],
				{ concurrency: "unbounded" },
			).pipe(Effect.timeout("1 second")),
		);
		expect(
			frames
				.filter((frame) => frame.type === "output")
				.map((frame) => frame.sequence),
		).toEqual([1, 2]);
	});

	it("compacts a disconnected backlog with linear bytes written and empties after full ack", async () => {
		const { spool, filename, connection } = fixture();
		spool.attach(connection, 0);
		spool.disconnect(connection);
		for (let index = 0; index < 1000; index++)
			await Effect.runPromise(
				spool.emit({
					type: "cancel-interaction",
					sinkId: "turn-1",
					requestId: `${index}-${"x".repeat(512)}`,
				}),
			);
		const backlogBytes = readFileSync(filename).length;
		vi.mocked(writeFileSync).mockClear();
		vi.mocked(renameSync).mockClear();
		spool.attach(connection, 0);
		for (let sequence = 1; sequence <= 1000; sequence++)
			spool.reply({
				type: "output-reply",
				outputId: String(sequence),
				sequence,
				result: {},
			});
		const rewrittenBytes = vi
			.mocked(writeFileSync)
			.mock.calls.reduce(
				(total, [path, contents]) =>
					String(path).startsWith(filename)
						? total + Buffer.byteLength(contents)
						: total,
				0,
			);
		const compactions = vi
			.mocked(renameSync)
			.mock.calls.filter(([, target]) => target === filename).length;
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			proofPath,
			JSON.stringify(
				{
					frames: 1000,
					backlogBytes,
					rewrittenBytes,
					compactions,
					remainingBytes: readFileSync(filename).length,
				},
				null,
				2,
			),
		);
		expect(readFileSync(filename).length).toBe(0);
		expect(rewrittenBytes).toBeLessThan(backlogBytes * 2);
		expect(compactions).toBeLessThanOrEqual(12);
	});

	it("preserves the previous spool when compaction is interrupted", async () => {
		const { spool, filename, connection } = fixture();
		spool.attach(connection, 0);
		spool.disconnect(connection);
		for (let index = 0; index < 4; index++)
			await Effect.runPromise(
				spool.emit({
					type: "cancel-interaction",
					sinkId: "turn-1",
					requestId: `request-${index}`,
				}),
			);
		const original = readFileSync(filename, "utf8");
		const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(writeFileSync).mockImplementationOnce(
			(path, contents, options) => {
				fs.writeFileSync(path, String(contents).slice(0, 10), options);
				throw new Error("compaction interrupted");
			},
		);
		expect(() =>
			spool.reply({
				type: "output-reply",
				outputId: "3",
				sequence: 3,
				result: {},
			}),
		).toThrow("compaction interrupted");
		expect(readFileSync(filename, "utf8")).toBe(original);
		spool.attach(connection, 3);
		const replayed = vi
			.mocked(connection.write)
			.mock.calls.map(([frame]) => frame);
		expect(replayed).toMatchObject([{ type: "output", sequence: 4 }]);
		spool.reply({
			type: "output-reply",
			outputId: "4",
			sequence: 4,
			result: {},
		});
		expect(readFileSync(filename).length).toBe(0);
	});
});
