import { describe, expect, it, vi } from "vitest";
import {
	handleRemoveProject,
	handleRenameProject,
} from "../../../src/lib/handlers/settings.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper returns untyped relay messages
function lastSentTo(deps: ReturnType<typeof createMockHandlerDeps>): any {
	const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
	return calls[calls.length - 1]?.[1];
}

// biome-ignore lint/suspicious/noExplicitAny: test helper returns untyped relay messages
function lastBroadcast(deps: ReturnType<typeof createMockHandlerDeps>): any {
	const calls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
	return calls[calls.length - 1]?.[0];
}

describe("handleRemoveProject", () => {
	it("calls removeProject and broadcasts updated project list", async () => {
		const removeProject = vi.fn().mockResolvedValue(undefined);
		const getProjects = vi
			.fn()
			.mockReturnValue([
				{ slug: "remaining", title: "Remaining", directory: "/remaining" },
			]);
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown as HandlerDeps["config"]["httpServer"],
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				removeProject,
				getProjects,
			} as unknown as HandlerDeps["config"],
		});

		await handleRemoveProject(deps, "c1", { slug: "old-project" });

		expect(removeProject).toHaveBeenCalledWith("old-project");
		const msg = lastBroadcast(deps);
		expect(msg.type).toBe("project_list");
		expect(msg.projects).toHaveLength(1);
	});

	it("sends error when removeProject is not available", async () => {
		const deps = createMockHandlerDeps();

		await handleRemoveProject(deps, "c1", { slug: "foo" });

		const msg = lastSentTo(deps);
		expect(msg.type).toBe("error");
	});

	it("sends error for empty slug", async () => {
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown as HandlerDeps["config"]["httpServer"],
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				removeProject: vi.fn(),
			} as unknown as HandlerDeps["config"],
		});

		await handleRemoveProject(deps, "c1", { slug: "" });

		const msg = lastSentTo(deps);
		expect(msg.type).toBe("error");
	});
});

describe("handleRenameProject", () => {
	it("calls setProjectTitle and broadcasts updated project list", async () => {
		const setProjectTitle = vi.fn();
		const getProjects = vi
			.fn()
			.mockReturnValue([
				{ slug: "my-proj", title: "New Name", directory: "/my-proj" },
			]);
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown as HandlerDeps["config"]["httpServer"],
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				setProjectTitle,
				getProjects,
			} as unknown as HandlerDeps["config"],
		});

		await handleRenameProject(deps, "c1", {
			slug: "my-proj",
			title: "New Name",
		});

		expect(setProjectTitle).toHaveBeenCalledWith("my-proj", "New Name");
		const msg = lastBroadcast(deps);
		expect(msg.type).toBe("project_list");
	});

	it("trims title and rejects empty", async () => {
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown as HandlerDeps["config"]["httpServer"],
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				setProjectTitle: vi.fn(),
			} as unknown as HandlerDeps["config"],
		});

		await handleRenameProject(deps, "c1", { slug: "proj", title: "   " });

		const msg = lastSentTo(deps);
		expect(msg.type).toBe("error");
	});

	it("truncates title to 100 chars", async () => {
		const setProjectTitle = vi.fn();
		const getProjects = vi.fn().mockReturnValue([]);
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown as HandlerDeps["config"]["httpServer"],
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "test",
				setProjectTitle,
				getProjects,
			} as unknown as HandlerDeps["config"],
		});

		const longTitle = "A".repeat(150);
		await handleRenameProject(deps, "c1", { slug: "proj", title: longTitle });

		expect(setProjectTitle).toHaveBeenCalledWith("proj", "A".repeat(100));
	});

	it("sends error when setProjectTitle is not available", async () => {
		const deps = createMockHandlerDeps();

		await handleRenameProject(deps, "c1", {
			slug: "proj",
			title: "New Name",
		});

		const msg = lastSentTo(deps);
		expect(msg.type).toBe("error");
	});
});
