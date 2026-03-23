import * as fs from "node:fs/promises";
import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { handleListDirectories } from "../../../src/lib/handlers/settings.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

vi.mock("node:fs/promises");

// biome-ignore lint/suspicious/noExplicitAny: test helper returns untyped relay messages
function lastSent(deps: ReturnType<typeof createMockHandlerDeps>): any {
	const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
	return calls[calls.length - 1]?.[1];
}

describe("handleListDirectories", () => {
	it("returns directories matching prefix", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "personal", isDirectory: () => true, isFile: () => false },
			{ name: "work", isDirectory: () => true, isFile: () => false },
			{ name: "notes.txt", isDirectory: () => false, isFile: () => true },
			// biome-ignore lint/suspicious/noExplicitAny: mock Dirent objects
		] as any);

		await handleListDirectories(deps, "c1", { path: "/Users/me/p" });

		expect(fs.readdir).toHaveBeenCalledWith("/Users/me", {
			withFileTypes: true,
		});
		const msg = lastSent(deps);
		expect(msg.type).toBe("directory_list");
		expect(msg.entries).toEqual(["/Users/me/personal/"]);
	});

	it("returns all directories when prefix is empty (trailing slash)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "src", isDirectory: () => true, isFile: () => false },
			{ name: "docs", isDirectory: () => true, isFile: () => false },
			{ name: ".git", isDirectory: () => true, isFile: () => false },
			// biome-ignore lint/suspicious/noExplicitAny: mock Dirent objects
		] as any);

		await handleListDirectories(deps, "c1", { path: "/project/" });

		const msg = lastSent(deps);
		expect(msg.entries).toEqual(["/project/src/", "/project/docs/"]);
	});

	it("includes hidden dirs when prefix starts with dot", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: ".git", isDirectory: () => true, isFile: () => false },
			{ name: ".config", isDirectory: () => true, isFile: () => false },
			{ name: "src", isDirectory: () => true, isFile: () => false },
			// biome-ignore lint/suspicious/noExplicitAny: mock Dirent objects
		] as any);

		await handleListDirectories(deps, "c1", { path: "/project/." });

		const msg = lastSent(deps);
		expect(msg.entries).toEqual(["/project/.git/", "/project/.config/"]);
	});

	it("returns empty entries for non-existent directory", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(fs.readdir).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);

		await handleListDirectories(deps, "c1", { path: "/nonexistent/foo" });

		const msg = lastSent(deps);
		expect(msg.type).toBe("directory_list");
		expect(msg.entries).toEqual([]);
	});

	it("resolves ~ to home directory", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: "src", isDirectory: () => true, isFile: () => false },
			// biome-ignore lint/suspicious/noExplicitAny: mock Dirent objects
		] as any);

		await handleListDirectories(deps, "c1", { path: "~/s" });

		const home = os.homedir();
		expect(fs.readdir).toHaveBeenCalledWith(home, { withFileTypes: true });
		const msg = lastSent(deps);
		expect(msg.entries).toEqual([`${home}/src/`]);
	});

	it("caps results at 50", async () => {
		const deps = createMockHandlerDeps();
		const entries = Array.from({ length: 60 }, (_, i) => ({
			name: `dir${String(i).padStart(3, "0")}`,
			isDirectory: () => true,
			isFile: () => false,
		}));
		// biome-ignore lint/suspicious/noExplicitAny: mock Dirent objects
		vi.mocked(fs.readdir).mockResolvedValue(entries as any);

		await handleListDirectories(deps, "c1", { path: "/test/" });

		const msg = lastSent(deps);
		expect(msg.entries).toHaveLength(50);
	});

	it("returns empty for empty path", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(fs.readdir).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);

		await handleListDirectories(deps, "c1", { path: "" });

		const msg = lastSent(deps);
		expect(msg.entries).toEqual([]);
	});
});
