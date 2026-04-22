import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CommandReceipt,
	CommandReceiptRepository,
} from "../../../src/lib/persistence/command-receipts.js";
import { createCommandId } from "../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("CommandReceiptRepository", () => {
	let client: SqliteClient;
	let repo: CommandReceiptRepository;

	beforeEach(() => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		repo = new CommandReceiptRepository(client);
	});

	afterEach(() => {
		client?.close();
	});

	describe("check", () => {
		it("returns undefined for an unknown command ID", () => {
			const result = repo.check("cmd_nonexistent");
			expect(result).toBeUndefined();
		});

		it("returns the receipt for a known command ID", () => {
			const commandId = createCommandId();
			const receipt: CommandReceipt = {
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 42,
				createdAt: Date.now(),
			};
			repo.record(receipt);
			const result = repo.check(commandId);
			expect(result).toBeDefined();
			expect(result?.commandId).toBe(commandId);
			expect(result?.status).toBe("accepted");
			expect(result?.resultSequence).toBe(42);
		});
	});

	describe("record", () => {
		it("records an accepted receipt", () => {
			const commandId = createCommandId();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 1,
				createdAt: Date.now(),
			});
			const result = repo.check(commandId);
			expect(result?.status).toBe("accepted");
		});

		it("records a rejected receipt with error", () => {
			const commandId = createCommandId();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "rejected",
				error: "Session not found",
				createdAt: Date.now(),
			});
			const result = repo.check(commandId);
			expect(result?.status).toBe("rejected");
			expect(result?.error).toBe("Session not found");
			expect(result?.resultSequence).toBeUndefined();
		});

		it("throws on duplicate command ID", () => {
			const commandId = createCommandId();
			const receipt: CommandReceipt = {
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 1,
				createdAt: Date.now(),
			};
			repo.record(receipt);
			expect(() => repo.record(receipt)).toThrow();
		});

		it("records timestamps accurately", () => {
			const commandId = createCommandId();
			const now = Date.now();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 5,
				createdAt: now,
			});
			const result = repo.check(commandId);
			expect(result?.createdAt).toBe(now);
		});
	});

	describe("idempotent command processing pattern", () => {
		it("supports the check-then-execute pattern", () => {
			const commandId = createCommandId();
			const existing = repo.check(commandId);
			expect(existing).toBeUndefined();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 10,
				createdAt: Date.now(),
			});
			const cached = repo.check(commandId);
			expect(cached).toBeDefined();
			expect(cached?.resultSequence).toBe(10);
		});

		it("handles multiple commands for the same session", () => {
			const cmd1 = createCommandId();
			const cmd2 = createCommandId();
			repo.record({
				commandId: cmd1,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 1,
				createdAt: Date.now(),
			});
			repo.record({
				commandId: cmd2,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 5,
				createdAt: Date.now(),
			});
			expect(repo.check(cmd1)?.resultSequence).toBe(1);
			expect(repo.check(cmd2)?.resultSequence).toBe(5);
		});
	});
});
