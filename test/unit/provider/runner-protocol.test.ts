import { mkdtempSync, rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import {
	type RunnerMessage,
	RunnerSocket,
	runnerDeliveryEvidence,
	runnerFailure,
	sendToken,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import type { SessionCommand } from "../../../src/lib/provider/runner/session-runner.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

const send: SessionCommand = {
	type: "send-turn",
	sinkId: "sink",
	aborted: false,
	input: {
		sessionId: "session",
		inputId: "input",
		runId: "run",
		workspaceRoot: "/private/tmp",
		extraFolders: [],
		providerState: {},
		prompt: "hello",
		history: [],
	},
};

effectIt.effect("fallback status asks by the transmission's token alone", () =>
	Effect.gen(function* () {
		const requests: RunnerMessage[] = [];
		const f = yield* Effect.acquireRelease(
			Effect.tryPromise(() =>
				fixture((message, socket) => {
					if (message.type !== "command-status") return;
					requests.push(message);
					socket.write(
						`${JSON.stringify({ type: "command-status-reply", requestId: message.requestId, result: message.commandId === fallback ? "not_received" : "completed" })}\n`,
					);
				}),
			),
			(f) => Effect.tryPromise(() => f.close()).pipe(Effect.orDie),
		);
		// A rejected resume and its fresh fallback are distinct transmissions (4.8).
		const primary = sendToken("hold", "resume", 1);
		const fallback = sendToken("hold", "resume", 2);
		expect(yield* f.client.commandStatusEffect(primary)).toBe("completed");
		expect(yield* f.client.commandStatusEffect(fallback)).toBe("not_received");
		expect(requests).toEqual([
			{
				type: "command-status",
				requestId: expect.any(String),
				commandId: primary,
			},
			{
				type: "command-status",
				requestId: expect.any(String),
				commandId: fallback,
			},
		]);
	}).pipe(Effect.scoped),
);

async function fixture(
	reply: (message: RunnerMessage, socket: Socket) => void,
) {
	const directory = mkdtempSync(join(tmpdir(), "runner-protocol-"));
	const path = join(directory, "runner.sock");
	const peers = new Set<Socket>();
	const server = createServer((socket) => {
		peers.add(socket);
		let buffer = "";
		socket.on("data", (data) => {
			buffer += data.toString();
			let end = buffer.indexOf("\n");
			while (end !== -1) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				reply(JSON.parse(line) as RunnerMessage, socket);
				end = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
	const socket = new Socket();
	const client = new RunnerSocket(
		socket,
		() => {},
		() => {},
	);
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.connect(path, resolve);
	});
	return {
		client,
		socket,
		close: async () => {
			client.destroy();
			for (const peer of peers) peer.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

for (const reason of ["exiting", "retiring", "interrupted"] as const) {
	it(`retains typed ${reason} refusal evidence before acceptance`, async () => {
		const commands: RunnerMessage[] = [];
		const f = await fixture((message, socket) => {
			if (message.type !== "command") return;
			commands.push(message);
			socket.write(
				`${JSON.stringify({ type: "command-refused", commandId: message.commandId, attempt: 0, reason })}\n`,
			);
		});
		try {
			const result = await runtime.runPromise(
				Effect.result(f.client.commandEffect("send", send)),
			);
			expect(commands).toMatchObject([
				{ type: "command", command: { type: "send-turn", runId: "run" } },
			]);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure")
				expect(runnerDeliveryEvidence(result.failure)).toEqual({
					_tag: "Refused",
					reason,
				});
		} finally {
			await f.close();
		}
	});
}

for (const accepted of [false, true]) {
	it(`42: legacy idle reply ${accepted ? "after" : "before"} acceptance ${accepted ? "does not release" : "proves refusal"}`, async () => {
		const f = await fixture((message, socket) => {
			if (message.type !== "command") return;
			if (accepted)
				socket.write(
					`${JSON.stringify({ type: "command-accepted", commandId: message.commandId, attempt: 0, sinkId: "sink" })}\n`,
				);
			socket.write(
				`${JSON.stringify({ type: "command-reply", commandId: message.commandId, failure: { operation: "send-turn", message: "idle", code: "runner_idle_exit" } })}\n`,
			);
		});
		try {
			const result = await runtime.runPromise(
				Effect.result(f.client.commandEffect("send", send)),
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure")
				expect(runnerDeliveryEvidence(result.failure)).toEqual(
					accepted ? undefined : { _tag: "Refused", reason: "exiting" },
				);
		} finally {
			await f.close();
		}
	});
}

it("a write never called is NotSent; a called write that fails stays uncertain", async () => {
	const f = await fixture(() => {});
	try {
		const write = vi.spyOn(f.socket, "write").mockImplementation(() => {
			throw runnerFailure("write runner frame", "injected write failure");
		});
		const failed = await runtime.runPromise(
			Effect.result(f.client.commandEffect("called", send)),
		);
		expect(write).toHaveBeenCalledTimes(1);
		expect(failed._tag).toBe("Failure");
		if (failed._tag === "Failure")
			expect(runnerDeliveryEvidence(failed.failure)).toBeUndefined();
		write.mockRestore();
		f.client.destroy();
		const closedWrite = vi.spyOn(f.socket, "write");
		const closed = await runtime.runPromise(
			Effect.result(f.client.commandEffect("not-called", send)),
		);
		expect(closedWrite).not.toHaveBeenCalled();
		expect(closed._tag).toBe("Failure");
		if (closed._tag === "Failure")
			expect(runnerDeliveryEvidence(closed.failure)).toEqual({
				_tag: "NotSent",
			});
		closedWrite.mockRestore();
	} finally {
		await f.close();
	}
});
