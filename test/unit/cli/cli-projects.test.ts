// ─── Projects Submenu — Unit Tests (Ticket 8.11) ──────────────────────────────
// Tests for showProjectsMenu, showProjectDetail, and getStatusIcon.
// Uses mock stdin (EventEmitter), stdout, and exit from the prompts test pattern.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	getStatusIcon,
	type ProjectStatus,
	type ProjectsMenuOptions,
	showProjectDetail,
	showProjectsMenu,
} from "../../../src/lib/cli/cli-projects.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
	const esc = String.fromCharCode(0x1b);
	return s.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

/** Create a mock stdin as an EventEmitter with setRawMode and pause/resume. */
function createMockStdin(): EventEmitter & {
	setRawMode: (mode: boolean) => void;
	resume: () => void;
	pause: () => void;
	setEncoding: (enc: string) => void;
	rawMode: boolean;
	paused: boolean;
} {
	const emitter = new EventEmitter() as EventEmitter & {
		setRawMode: (mode: boolean) => void;
		resume: () => void;
		pause: () => void;
		setEncoding: (enc: string) => void;
		rawMode: boolean;
		paused: boolean;
	};
	emitter.rawMode = false;
	emitter.paused = true;
	emitter.setRawMode = (mode: boolean) => {
		emitter.rawMode = mode;
	};
	emitter.resume = () => {
		emitter.paused = false;
	};
	emitter.pause = () => {
		emitter.paused = true;
	};
	emitter.setEncoding = () => {};
	return emitter;
}

/** Create mock I/O for the projects menu. */
function createMockIO() {
	const output: string[] = [];
	const stdout = {
		write(s: string) {
			output.push(s);
		},
	};
	let exitCode: number | undefined;
	let exitCalled = false;
	const exit = (code: number) => {
		exitCode = code;
		exitCalled = true;
	};
	const stdin = createMockStdin();
	return {
		stdin,
		stdout,
		output,
		exit,
		getExitCode: () => exitCode,
		wasExitCalled: () => exitCalled,
		/** Get all output as a single stripped string. */
		text: () => stripAnsi(output.join("")),
		/** Get all raw output as a single string. */
		raw: () => output.join(""),
	};
}

/** Wait for a given number of milliseconds. */
function tick(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send a sequence of keys with delays between them. */
async function sendKeys(
	stdin: EventEmitter,
	keys: string[],
	delay = 15,
): Promise<void> {
	for (const key of keys) {
		stdin.emit("data", key);
		await tick(delay);
	}
}

/** Create a sample project. */
function makeProject(overrides?: Partial<ProjectStatus>): ProjectStatus {
	return {
		slug: "my-project",
		path: "/home/user/my-project",
		sessions: 3,
		clients: 1,
		isProcessing: false,
		...overrides,
	};
}

/** Create default options with common mocks. */
function defaultOpts(
	io: ReturnType<typeof createMockIO>,
	overrides?: Partial<ProjectsMenuOptions>,
): ProjectsMenuOptions {
	return {
		stdin: io.stdin as unknown as ProjectsMenuOptions["stdin"],
		stdout: io.stdout,
		exit: io.exit,
		getProjects: () => [],
		cwd: "/home/user/work",
		addProject: vi.fn().mockResolvedValue({ ok: true, slug: "new-proj" }),
		removeProject: vi.fn().mockResolvedValue({ ok: true }),
		setProjectTitle: vi.fn().mockResolvedValue({ ok: true }),
		onBack: vi.fn(),
		...overrides,
	};
}

// ─── getStatusIcon ────────────────────────────────────────────────────────────

describe("getStatusIcon", () => {
	it("returns lightning bolt for processing projects", () => {
		const proj = makeProject({ isProcessing: true });
		expect(getStatusIcon(proj)).toBe("\u26A1");
	});

	it("returns green circle for projects with active clients", () => {
		const proj = makeProject({ clients: 2, isProcessing: false });
		expect(getStatusIcon(proj)).toBe("\uD83D\uDFE2");
	});

	it("returns pause icon for idle projects", () => {
		const proj = makeProject({ clients: 0, isProcessing: false });
		expect(getStatusIcon(proj)).toBe("\u23F8");
	});
});

// ─── showProjectsMenu — Rendering ────────────────────────────────────────────

describe("showProjectsMenu rendering", () => {
	it("renders project list with status icons", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({
				slug: "p1",
				path: "/a",
				isProcessing: true,
				sessions: 1,
			}),
			makeProject({
				slug: "p2",
				path: "/b",
				clients: 2,
				isProcessing: false,
				sessions: 5,
			}),
			makeProject({
				slug: "p3",
				path: "/c",
				clients: 0,
				isProcessing: false,
				sessions: 0,
			}),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		// All three status icons should appear
		expect(text).toContain("\u26A1"); // processing
		expect(text).toContain("\uD83D\uDFE2"); // active clients
		expect(text).toContain("\u23F8"); // idle

		// Clean up
		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows sessions count for each project", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({ slug: "p1", path: "/a", sessions: 1 }),
			makeProject({ slug: "p2", path: "/b", sessions: 7 }),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		expect(text).toContain("1 session");
		expect(text).not.toMatch(/1 sessions/);
		expect(text).toContain("7 sessions");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows project path in dim", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({ slug: "p1", path: "/home/user/cool-project" }),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		expect(text).toContain("/home/user/cool-project");
		// Verify dim ANSI is used (the path should be wrapped in dim)
		expect(io.raw()).toContain("\x1b[2m/home/user/cool-project");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows 'Add current directory' when cwd not registered", async () => {
		const io = createMockIO();
		const projects = [makeProject({ slug: "p1", path: "/other/path" })];
		const opts = defaultOpts(io, {
			getProjects: () => projects,
			cwd: "/home/user/work",
		});
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		expect(text).toContain("Add");
		expect(text).toContain("work");
		expect(text).toContain("/home/user/work");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("hides 'Add current directory' when cwd already registered", async () => {
		const io = createMockIO();
		const projects = [makeProject({ slug: "p1", path: "/home/user/work" })];
		const opts = defaultOpts(io, {
			getProjects: () => projects,
			cwd: "/home/user/work",
		});
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		// Should NOT show "Add work" option since cwd is already in the list
		expect(text).not.toContain("add_cwd");
		// The "Add project..." should still be there
		expect(text).toContain("Add project...");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("empty project list shows only add options", async () => {
		const io = createMockIO();
		const opts = defaultOpts(io, {
			getProjects: () => [],
			cwd: "/home/user/work",
		});
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		// Should have both add options
		expect(text).toContain("Add");
		expect(text).toContain("work");
		expect(text).toContain("Add project...");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("multiple projects rendered in order", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({
				slug: "alpha",
				path: "/a/alpha",
				title: "Alpha Project",
			}),
			makeProject({
				slug: "beta",
				path: "/b/beta",
				title: "Beta Project",
			}),
			makeProject({
				slug: "gamma",
				path: "/c/gamma",
				title: "Gamma Project",
			}),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });
		void showProjectsMenu(opts);
		await tick();

		const text = io.text();
		const alphaIdx = text.indexOf("Alpha Project");
		const betaIdx = text.indexOf("Beta Project");
		const gammaIdx = text.indexOf("Gamma Project");
		expect(alphaIdx).toBeLessThan(betaIdx);
		expect(betaIdx).toBeLessThan(gammaIdx);

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── showProjectsMenu — Actions ──────────────────────────────────────────────

describe("showProjectsMenu actions", () => {
	it("add_cwd calls addProject with cwd", async () => {
		const io = createMockIO();
		const addProject = vi.fn().mockResolvedValue({ ok: true, slug: "work" });
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 1) {
					// On re-render, exit
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return [];
			},
			cwd: "/home/user/work",
			addProject,
		});

		void showProjectsMenu(opts);
		await tick();

		// First item should be "Add work (cwd)" — select it with Enter
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		expect(addProject).toHaveBeenCalledWith("/home/user/work");
	});

	it("add_cwd shows success message", async () => {
		const io = createMockIO();
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 1) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return [];
			},
			cwd: "/home/user/work",
			addProject: vi.fn().mockResolvedValue({ ok: true, slug: "work" }),
		});

		void showProjectsMenu(opts);
		await tick();

		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		const text = io.text();
		expect(text).toContain("Added: work");
	});

	it("add_cwd shows error message on failure", async () => {
		const io = createMockIO();
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 1) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return [];
			},
			cwd: "/home/user/work",
			addProject: vi.fn().mockResolvedValue({
				ok: false,
				error: "Permission denied",
			}),
		});

		void showProjectsMenu(opts);
		await tick();

		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		const text = io.text();
		expect(text).toContain("Permission denied");
	});

	it("add_other prompts for directory path", async () => {
		const io = createMockIO();
		const addProject = vi.fn().mockResolvedValue({ ok: true, slug: "other" });
		let callCount = 0;
		const mockFs = {
			statSync: () => ({ isDirectory: () => true }),
		};

		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 1) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return [];
			},
			cwd: "/home/user/work",
			addProject,
			fs: mockFs,
		});

		void showProjectsMenu(opts);
		await tick();

		// Navigate to "Add project..." (second item, after "Add work")
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick();

		// Now the text prompt should appear for "Directory path"
		const text = io.text();
		expect(text).toContain("Directory path");

		// Type a path and confirm — just press Enter for default (cwd)
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		expect(addProject).toHaveBeenCalled();
	});

	it("back calls onBack callback", async () => {
		const io = createMockIO();
		const onBack = vi.fn();
		const opts = defaultOpts(io, {
			getProjects: () => [],
			cwd: "/home/user/work",
			onBack,
		});

		void showProjectsMenu(opts);
		await tick();

		// Press Backspace to trigger the back item
		await sendKeys(io.stdin, ["\x7f"]);
		await tick(50);

		expect(onBack).toHaveBeenCalled();
	});

	it("renders visible Back menu item", async () => {
		const io = createMockIO();
		const opts = defaultOpts(io, {
			getProjects: () => [],
			cwd: "/home/user/work",
		});

		void showProjectsMenu(opts);
		await tick();

		// The "Back" item should be rendered in the menu
		expect(io.text()).toContain("Back");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("selecting visible Back item calls onBack", async () => {
		const io = createMockIO();
		const onBack = vi.fn();
		const opts = defaultOpts(io, {
			getProjects: () => [],
			cwd: "/home/user/work",
			onBack,
		});

		void showProjectsMenu(opts);
		await tick();

		// Items: "Add cwd" (cwd not registered), "Add project...", "Back"
		// Navigate to last item (Back) and press Enter
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick(50);

		expect(onBack).toHaveBeenCalled();
	});

	it("Escape key triggers back", async () => {
		const io = createMockIO();
		const onBack = vi.fn();
		const opts = defaultOpts(io, {
			getProjects: () => [],
			cwd: "/home/user/work",
			onBack,
		});

		void showProjectsMenu(opts);
		await tick();

		// Press Escape to trigger back
		await sendKeys(io.stdin, ["\x1b"]);
		await tick(50);

		expect(onBack).toHaveBeenCalled();
	});

	it("selects project detail when project chosen", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({
				slug: "my-proj",
				path: "/a/my-proj",
				title: "My Project",
				sessions: 5,
				clients: 2,
			}),
		];
		// We need cwd to match so "Add cwd" is not shown
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 1) {
					// This is the detail menu re-render; exit via Ctrl+C
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return projects;
			},
			cwd: "/a/my-proj", // matches project so no "Add cwd"
		});

		void showProjectsMenu(opts);
		await tick();

		// Menu items should be: "Add project...", "My Project"
		// Navigate down to "My Project" and select
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick(50);

		// Should show project detail view
		const text = io.text();
		expect(text).toContain("My Project");
		expect(text).toContain("my-proj");
	});
});

// ─── showProjectDetail ───────────────────────────────────────────────────────

describe("showProjectDetail", () => {
	it("displays project info (name, slug, path)", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({
				slug: "test-proj",
				path: "/home/user/test-proj",
				title: "Test Project",
			}),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });

		void showProjectDetail(opts, "test-proj", projects);
		await tick();

		const text = io.text();
		expect(text).toContain("Test Project");
		expect(text).toContain("test-proj");
		expect(text).toContain("/home/user/test-proj");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows sessions and clients", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({ slug: "p1", path: "/a", sessions: 5, clients: 3 }),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });

		void showProjectDetail(opts, "p1", projects);
		await tick();

		const text = io.text();
		expect(text).toContain("5 sessions");
		expect(text).toContain("3 clients");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows singular session/client for count of 1", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({ slug: "p1", path: "/a", sessions: 1, clients: 1 }),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });

		void showProjectDetail(opts, "p1", projects);
		await tick();

		const text = io.text();
		expect(text).toContain("1 session");
		expect(text).not.toMatch(/1 sessions/);
		expect(text).toContain("1 client");
		expect(text).not.toMatch(/1 clients/);

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("set title prompts and calls setProjectTitle", async () => {
		const io = createMockIO();
		const setProjectTitle = vi.fn().mockResolvedValue({ ok: true });
		const projects = [makeProject({ slug: "p1", path: "/a" })];
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 0) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return projects;
			},
			setProjectTitle,
		});

		void showProjectDetail(opts, "p1", projects);
		await tick();

		// First item is "Set title" — select it
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Now in promptText — type a title and confirm
		// Type "New Title"
		for (const ch of "New Title") {
			io.stdin.emit("data", ch);
			await tick(5);
		}
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		expect(setProjectTitle).toHaveBeenCalledWith("p1", "New Title");
	});

	it("set title shows success", async () => {
		const io = createMockIO();
		const projects = [makeProject({ slug: "p1", path: "/a" })];
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 0) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return projects;
			},
			setProjectTitle: vi.fn().mockResolvedValue({ ok: true }),
		});

		void showProjectDetail(opts, "p1", projects);
		await tick();

		// Select "Set title"
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Type and confirm
		for (const ch of "Hello") {
			io.stdin.emit("data", ch);
			await tick(5);
		}
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		const text = io.text();
		expect(text).toContain("Title updated");
	});

	it("remove project calls removeProject", async () => {
		const io = createMockIO();
		const removeProject = vi.fn().mockResolvedValue({ ok: true });
		const projects = [makeProject({ slug: "p1", path: "/a" })];
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 0) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return projects;
			},
			removeProject,
		});

		void showProjectDetail(opts, "p1", projects);
		await tick();

		// Navigate to "Remove project" (second item) and select
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick(50);

		expect(removeProject).toHaveBeenCalledWith("p1");
	});

	it("remove project shows success", async () => {
		const io = createMockIO();
		const projects = [makeProject({ slug: "p1", path: "/a" })];
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 0) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return projects;
			},
			removeProject: vi.fn().mockResolvedValue({ ok: true }),
		});

		void showProjectDetail(opts, "p1", projects);
		await tick();

		// Navigate to "Remove project" and select
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick(50);

		const text = io.text();
		expect(text).toContain("Removed: p1");
	});

	it("back returns to project list", async () => {
		const io = createMockIO();
		const projects = [makeProject({ slug: "p1", path: "/a" })];
		let callCount = 0;
		const opts = defaultOpts(io, {
			getProjects: () => {
				callCount++;
				if (callCount > 0) {
					setTimeout(() => io.stdin.emit("data", "\x03"), 30);
				}
				return projects;
			},
		});

		void showProjectDetail(opts, "p1", projects);
		await tick();

		// Press Backspace for "Back"
		await sendKeys(io.stdin, ["\x7f"]);
		await tick(50);

		// Should re-render project list (getProjects called again)
		expect(callCount).toBeGreaterThanOrEqual(1);
	});

	it("shows 'Change title' when project has existing title", async () => {
		const io = createMockIO();
		const projects = [
			makeProject({
				slug: "p1",
				path: "/a",
				title: "Existing Title",
			}),
		];
		const opts = defaultOpts(io, { getProjects: () => projects });

		void showProjectDetail(opts, "p1", projects);
		await tick();

		const text = io.text();
		expect(text).toContain("Change title");
		expect(text).toContain("Title:");
		expect(text).toContain("Existing Title");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows 'Set title' when project has no custom title", async () => {
		const io = createMockIO();
		const projects = [makeProject({ slug: "p1", path: "/a" })];
		const opts = defaultOpts(io, { getProjects: () => projects });

		void showProjectDetail(opts, "p1", projects);
		await tick();

		const text = io.text();
		expect(text).toContain("Set title");
		expect(text).not.toContain("Change title");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});
