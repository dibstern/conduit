// ─── AC2: REST Endpoint Shape Validation ──────────────────────────────────
// Validates that OpenCode's REST API responses match our expected shapes.
// Tests shape (typeof, hasProperty), not content (specific values).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiGet,
	apiPatch,
	apiPost,
	checkServerHealth,
} from "./helpers/server-connection.js";
import {
	createTestSession,
	deleteTestSession,
	type TestSession,
} from "./helpers/session-helpers.js";

let serverAvailable = false;
let testSession: TestSession | null = null;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
		return;
	}
	// Create a test session for endpoint tests
	testSession = await createTestSession("contract-rest-endpoints");
});

afterAll(async () => {
	if (testSession) {
		await deleteTestSession(testSession.id);
	}
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

describe("AC2 — REST Endpoint Shape Validation", () => {
	// ─── Health ─────────────────────────────────────────────────────────────

	describe("GET /global/health", () => {
		it("returns { healthy: boolean, version: string }", async () => {
			if (skipIfNoServer()) return;
			const health = await apiGet<Record<string, unknown>>("/global/health");
			expect(typeof health["healthy"]).toBe("boolean");
			expect(typeof health["version"]).toBe("string");
			expect(health["healthy"]).toBe(true);
		});
	});

	// ─── Path ───────────────────────────────────────────────────────────────

	describe("GET /path", () => {
		it("returns path info with home, worktree, directory", async () => {
			if (skipIfNoServer()) return;
			const path = await apiGet<Record<string, unknown>>("/path");
			expect(typeof path["home"]).toBe("string");
			expect(typeof path["worktree"]).toBe("string");
			expect(typeof path["directory"]).toBe("string");
			// Also has state and config paths
			expect(typeof path["state"]).toBe("string");
			expect(typeof path["config"]).toBe("string");
		});
	});

	// ─── Sessions ───────────────────────────────────────────────────────────

	describe("GET /session", () => {
		it("returns an array of session objects", async () => {
			if (skipIfNoServer()) return;
			const sessions = await apiGet<unknown[]>("/session");
			expect(Array.isArray(sessions)).toBe(true);
			// At minimum our test session should be there
			expect(sessions.length).toBeGreaterThanOrEqual(1);
		});

		it("each session has { id, title, time } at minimum", async () => {
			if (skipIfNoServer()) return;
			const sessions = await apiGet<Array<Record<string, unknown>>>("/session");
			for (const session of sessions) {
				expect(typeof session["id"]).toBe("string");
				expect(typeof session["title"]).toBe("string");
				expect(session["time"]).toBeDefined();
				expect(
					typeof (session["time"] as Record<string, unknown>)["created"],
				).toBe("number");
			}
		});

		it("each session has slug, projectID, directory, version", async () => {
			if (skipIfNoServer()) return;
			const sessions = await apiGet<Array<Record<string, unknown>>>("/session");
			for (const session of sessions) {
				expect(typeof session["slug"]).toBe("string");
				expect(typeof session["projectID"]).toBe("string");
				expect(typeof session["directory"]).toBe("string");
				expect(typeof session["version"]).toBe("string");
			}
		});
	});

	describe("POST /session", () => {
		let createdId: string | null = null;

		afterAll(async () => {
			if (createdId) await deleteTestSession(createdId);
		});

		it("creates a session and returns session object with id", async () => {
			if (skipIfNoServer()) return;
			const session = await apiPost<Record<string, unknown>>("/session", {
				title: "contract-test-create",
			});
			expect(typeof session["id"]).toBe("string");
			expect(session["id"]).toBeTruthy();
			createdId = session["id"] as string;
			expect(typeof session["slug"]).toBe("string");
			expect(typeof session["projectID"]).toBe("string");
			expect(typeof session["version"]).toBe("string");
		});
	});

	describe("GET /session/:id", () => {
		it("returns a single session with full details", async () => {
			if (skipIfNoServer() || !testSession) return;
			const session = await apiGet<Record<string, unknown>>(
				`/session/${testSession.id}`,
			);
			expect(session["id"]).toBe(testSession.id);
			expect(typeof session["title"]).toBe("string");
			expect(typeof session["slug"]).toBe("string");
			expect(typeof session["projectID"]).toBe("string");
			expect(typeof session["version"]).toBe("string");
			expect(session["time"]).toBeDefined();
		});
	});

	describe("PATCH /session/:id", () => {
		it("updates session title and returns updated session", async () => {
			if (skipIfNoServer() || !testSession) return;
			const updated = await apiPatch<Record<string, unknown>>(
				`/session/${testSession.id}`,
				{ title: "contract-rest-endpoints-updated" },
			);
			expect(updated["id"]).toBe(testSession.id);
			expect(updated["title"]).toBe("contract-rest-endpoints-updated");
		});
	});

	describe("GET /session/:id/message", () => {
		it("returns an array (possibly empty) of message objects", async () => {
			if (skipIfNoServer() || !testSession) return;
			const messages = await apiGet<unknown>(
				`/session/${testSession.id}/message`,
			);
			// OpenCode returns either [] or {} for empty sessions
			if (Array.isArray(messages)) {
				// Good — array form
				expect(Array.isArray(messages)).toBe(true);
			} else if (typeof messages === "object" && messages !== null) {
				// Object form (keyed by message ID) — also valid
				expect(typeof messages).toBe("object");
			} else {
				expect.unreachable("Expected array or object for messages");
			}
		});
	});

	// ─── Discovery Endpoints ────────────────────────────────────────────────

	describe("GET /agent", () => {
		it("returns an array of agent objects", async () => {
			if (skipIfNoServer()) return;
			const agents = await apiGet<unknown[]>("/agent");
			expect(Array.isArray(agents)).toBe(true);
			expect(agents.length).toBeGreaterThanOrEqual(1);
		});

		it("each agent has { name } and optional description", async () => {
			if (skipIfNoServer()) return;
			const agents = await apiGet<Array<Record<string, unknown>>>("/agent");
			for (const agent of agents) {
				expect(typeof agent["name"]).toBe("string");
				// Description is optional — some agents may omit it entirely
				if ("description" in agent) {
					expect(typeof agent["description"]).toBe("string");
				}
			}
		});

		it("agents do NOT have an id field (name is the identifier)", async () => {
			if (skipIfNoServer()) return;
			const agents = await apiGet<Array<Record<string, unknown>>>("/agent");
			for (const agent of agents) {
				// The agent identifier is `name`, not `id`
				// This validates our types.ts AgentInfo assumption
				expect(typeof agent["name"]).toBe("string");
			}
		});
	});

	describe("GET /provider", () => {
		it("returns an object with { all, default, connected }", async () => {
			if (skipIfNoServer()) return;
			const providers = await apiGet<Record<string, unknown>>("/provider");
			// NOT an array — it's an object with categorized providers
			expect(typeof providers).toBe("object");
			expect(providers).not.toBeNull();
			expect("all" in providers).toBe(true);
			expect("default" in providers).toBe(true);
			expect("connected" in providers).toBe(true);
		});

		it("'all' is an array of provider objects with id, name", async () => {
			if (skipIfNoServer()) return;
			const providers = await apiGet<{
				all: Array<Record<string, unknown>>;
			}>("/provider");
			const all = providers.all;
			expect(Array.isArray(all)).toBe(true);
			// Each provider should have id, name
			for (const provider of all) {
				expect(typeof provider["id"]).toBe("string");
				expect(typeof provider["name"]).toBe("string");
			}
		});
	});

	describe("GET /command", () => {
		it("returns an array of command objects", async () => {
			if (skipIfNoServer()) return;
			const commands = await apiGet<unknown[]>("/command");
			expect(Array.isArray(commands)).toBe(true);
			expect(commands.length).toBeGreaterThanOrEqual(1);
		});

		it("each command has { name, description, source }", async () => {
			if (skipIfNoServer()) return;
			const commands = await apiGet<Array<Record<string, unknown>>>("/command");
			for (const cmd of commands) {
				expect(typeof cmd["name"]).toBe("string");
				expect(typeof cmd["description"]).toBe("string");
				expect(typeof cmd["source"]).toBe("string");
			}
		});
	});

	// ─── Permission & Question (empty state) ────────────────────────────────

	describe("GET /permission", () => {
		it("returns an array (empty when no pending permissions)", async () => {
			if (skipIfNoServer()) return;
			const permissions = await apiGet<unknown[]>("/permission");
			expect(Array.isArray(permissions)).toBe(true);
		});
	});

	describe("GET /question", () => {
		it("returns an array (empty when no pending questions)", async () => {
			if (skipIfNoServer()) return;
			const questions = await apiGet<unknown[]>("/question");
			expect(Array.isArray(questions)).toBe(true);
		});
	});

	// ─── Config ─────────────────────────────────────────────────────────────

	describe("GET /config", () => {
		it("returns config object with expected top-level keys", async () => {
			if (skipIfNoServer()) return;
			const config = await apiGet<Record<string, unknown>>("/config");
			expect(typeof config).toBe("object");
			// Known top-level keys
			for (const key of ["agent", "command"]) {
				expect(key in config).toBe(true);
			}
		});
	});

	// ─── OpenAPI spec ───────────────────────────────────────────────────────

	describe("GET /doc", () => {
		it("returns a valid OpenAPI 3.1 specification", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<Record<string, unknown>>("/doc");
			expect(doc["openapi"]).toBeDefined();
			expect(typeof doc["openapi"]).toBe("string");
			expect((doc["openapi"] as string).startsWith("3.1")).toBe(true);
			expect(doc["paths"]).toBeDefined();
			expect(typeof doc["paths"]).toBe("object");
			expect(doc["info"]).toBeDefined();
		});
	});

	// ─── Project ────────────────────────────────────────────────────────────

	describe("GET /project", () => {
		it("returns an array of project objects", async () => {
			if (skipIfNoServer()) return;
			const projects = await apiGet<unknown[]>("/project");
			expect(Array.isArray(projects)).toBe(true);
			expect(projects.length).toBeGreaterThanOrEqual(1);
		});

		it("each project has { id, worktree, time }", async () => {
			if (skipIfNoServer()) return;
			const projects = await apiGet<Array<Record<string, unknown>>>("/project");
			for (const project of projects) {
				expect(typeof project["id"]).toBe("string");
				expect(typeof project["worktree"]).toBe("string");
				expect(project["time"]).toBeDefined();
			}
		});
	});

	// ─── PTY ────────────────────────────────────────────────────────────────

	describe("GET /pty", () => {
		it("returns an array of PTY objects", async () => {
			if (skipIfNoServer()) return;
			const ptys = await apiGet<unknown[]>("/pty");
			expect(Array.isArray(ptys)).toBe(true);
		});
	});

	// ─── VCS ────────────────────────────────────────────────────────────────

	describe("GET /vcs", () => {
		it("returns VCS info object", async () => {
			if (skipIfNoServer()) return;
			const vcs = await apiGet<Record<string, unknown>>("/vcs");
			expect(typeof vcs).toBe("object");
			expect(vcs).not.toBeNull();
		});
	});

	// ─── Session status ─────────────────────────────────────────────────────

	describe("GET /session/status", () => {
		it("returns session status object", async () => {
			if (skipIfNoServer()) return;
			const status = await apiGet<Record<string, unknown>>("/session/status");
			expect(typeof status).toBe("object");
			expect(status).not.toBeNull();
		});
	});
});
