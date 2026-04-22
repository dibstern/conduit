import { afterEach, describe, expect, it } from "vitest";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";

describe("PersistenceLayer", () => {
	let layer: PersistenceLayer | null = null;

	afterEach(() => {
		layer?.close();
		layer = null;
	});

	it("creates an in-memory persistence layer", () => {
		layer = PersistenceLayer.memory();
		expect(layer).toBeDefined();
		expect(layer.eventStore).toBeDefined();
		expect(layer.commandReceipts).toBeDefined();
		expect(layer.db).toBeDefined();
	});

	it("runs migrations on creation", () => {
		layer = PersistenceLayer.memory();
		const rows = layer.db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='events'",
		);
		expect(rows).toHaveLength(1);
	});

	it("schema tables exist after creation", () => {
		layer = PersistenceLayer.memory();
		const tables = layer.db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.map((r) => r.name)
			.filter((n) => !n.startsWith("_") && !n.startsWith("sqlite_"));
		expect(tables).toContain("events");
		expect(tables).toContain("sessions");
		expect(tables).toContain("messages");
		expect(tables).toContain("turns");
		expect(tables).toContain("command_receipts");
	});

	it("event store can append after session is seeded", () => {
		layer = PersistenceLayer.memory();
		const now = Date.now();
		layer.db.execute(
			`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
			["s1", "opencode", "Test", "idle", now, now],
		);
		const event = canonicalEvent(
			"session.created",
			"s1",
			{
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			},
			{ createdAt: now },
		);
		const stored = layer.eventStore.append(event);
		expect(stored.sequence).toBe(1);
	});

	it("creates a file-backed persistence layer", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "persistence-layer-test-"),
		);
		const dbPath = path.join(tmpDir, "conduit.db");
		try {
			layer = PersistenceLayer.open(dbPath);
			expect(layer.eventStore).toBeDefined();
			const stat = fs.statSync(dbPath);
			expect(stat.isFile()).toBe(true);
		} finally {
			layer?.close();
			layer = null;
			fs.rmSync(tmpDir, { recursive: true });
		}
	});

	it("close() is idempotent", () => {
		layer = PersistenceLayer.memory();
		layer.close();
		expect(() => layer?.close()).not.toThrow();
		layer = null;
	});
});
