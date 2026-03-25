// ─── Shared Arbitraries for Property-Based Testing ──────────────────────────
// Intentionally biased toward edge cases: empty, singleton, max-size, unicode,
// path traversal, long inputs, invalid shapes, duplicates, ordering permutations.
// Uses fc.oneof with { weight, arbitrary } syntax (fast-check v4).

import fc from "fast-check";
import type {
	FrontendDecision,
	IPCCommand,
	OpenCodeDecision,
	OpenCodeEvent,
	PartType,
	RecentProject,
	ToolStatus,
} from "../../src/lib/types.js";

// ─── Primitive generators ───────────────────────────────────────────────────

/** Strings biased toward edge cases */
export const edgeCaseString = fc.oneof(
	{ weight: 3, arbitrary: fc.constant("") },
	{ weight: 2, arbitrary: fc.constant(" ") },
	{ weight: 2, arbitrary: fc.constant("\0") },
	{ weight: 2, arbitrary: fc.constant("\n\r\t") },
	{ weight: 3, arbitrary: fc.string({ minLength: 0, maxLength: 5 }) },
	{ weight: 3, arbitrary: fc.string({ minLength: 50, maxLength: 200 }) },
	{ weight: 2, arbitrary: fc.string({ minLength: 0, maxLength: 100 }) },
	{ weight: 5, arbitrary: fc.string({ minLength: 1, maxLength: 50 }) },
	{ weight: 1, arbitrary: fc.constant("../../../etc/passwd") },
	{ weight: 1, arbitrary: fc.constant("..\\..\\..\\windows\\system32") },
	{ weight: 1, arbitrary: fc.constant("<script>alert('xss')</script>") },
	{ weight: 1, arbitrary: fc.constant("a".repeat(10_000)) },
	{ weight: 1, arbitrary: fc.constant("🔥🌈🦄💀") },
	{ weight: 1, arbitrary: fc.constant('{"nested": "json"}') },
);

/** A reasonable ID string */
export const idString = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 3, arbitrary: fc.stringMatching(/^[0-9a-f]{8,32}$/) },
	{ weight: 1, arbitrary: fc.constant("") },
	{ weight: 1, arbitrary: fc.constant("a".repeat(500)) },
);

/** Positive integers biased toward edge values */
export const edgeInt = fc.oneof(
	{ weight: 3, arbitrary: fc.constant(0) },
	{ weight: 2, arbitrary: fc.constant(1) },
	{ weight: 2, arbitrary: fc.constant(-1) },
	{ weight: 2, arbitrary: fc.constant(Number.MAX_SAFE_INTEGER) },
	{ weight: 1, arbitrary: fc.constant(Number.MIN_SAFE_INTEGER) },
	{ weight: 5, arbitrary: fc.integer({ min: 0, max: 100_000 }) },
);

/** Timestamps (epoch ms) */
export const timestamp = fc.integer({ min: 0, max: 2_000_000_000_000 });

// ─── Domain-specific generators ─────────────────────────────────────────────

/** All valid part types */
export const partType: fc.Arbitrary<PartType> = fc.constantFrom(
	"text",
	"reasoning",
	"tool",
	"file",
	"snapshot",
	"patch",
	"agent",
	"compaction",
	"subtask",
	"retry",
	"step-start",
	"step-finish",
);

/** Tool status values */
export const toolStatus: fc.Arbitrary<ToolStatus> = fc.constantFrom(
	"pending",
	"running",
	"completed",
	"error",
);

/** Known tool names (lowercase, OpenCode format) */
export const knownToolName = fc.constantFrom(
	"read",
	"edit",
	"write",
	"bash",
	"glob",
	"grep",
	"webfetch",
	"websearch",
	"todowrite",
	"todoread",
	"question",
	"task",
	"lsp",
	"skill",
);

/** Unknown tool names (passthrough) */
export const unknownToolName = fc.oneof(
	{ weight: 3, arbitrary: fc.constantFrom("patch", "list", "custom_tool") },
	{ weight: 2, arbitrary: fc.stringMatching(/^[a-z_]{1,20}$/) },
);

/** Any tool name (mix of known and unknown) */
export const anyToolName = fc.oneof(
	{ weight: 7, arbitrary: knownToolName },
	{ weight: 3, arbitrary: unknownToolName },
);

/** Frontend decision values */
export const frontendDecision: fc.Arbitrary<FrontendDecision> = fc.constantFrom(
	"allow",
	"deny",
	"allow_always",
);

/** OpenCode decision values */
export const openCodeDecision: fc.Arbitrary<OpenCodeDecision> = fc.constantFrom(
	"once",
	"always",
	"reject",
);

/** Invalid decision strings */
export const invalidDecision = fc.oneof(
	{ weight: 3, arbitrary: edgeCaseString },
	{
		weight: 2,
		arbitrary: fc.constantFrom(
			"Accept",
			"ALLOW",
			"block",
			"permit",
			"yes",
			"no",
		),
	},
);

// ─── SSE Event generators ───────────────────────────────────────────────────

/** Generate a message.part.delta event */
export const partDeltaEvent = fc
	.record({
		sessionID: idString,
		messageID: idString,
		partID: idString,
		field: fc.constantFrom("text", "reasoning"),
		delta: edgeCaseString,
	})
	.map(
		(props): OpenCodeEvent => ({
			type: "message.part.delta",
			properties: props,
		}),
	);

/** Generate a message.part.updated event for a tool part */
export const toolPartUpdatedEvent = fc
	.record({
		partID: idString,
		part: fc.record({
			type: fc.constant("tool" as PartType),
			callID: idString,
			tool: anyToolName,
			state: fc.record({
				status: toolStatus,
				input: fc.oneof(fc.constant(undefined), fc.jsonValue()),
				output: fc.oneof(fc.constant(undefined), edgeCaseString),
				error: fc.oneof(fc.constant(undefined), edgeCaseString),
			}),
		}),
	})
	.map(
		(props): OpenCodeEvent => ({
			type: "message.part.updated",
			properties: props,
		}),
	);

/** Generate a message.part.updated event for a reasoning part */
export const reasoningPartUpdatedEvent = fc
	.record({
		partID: idString,
		part: fc.record({
			type: fc.constant("reasoning" as PartType),
			time: fc.oneof(
				fc.constant(undefined),
				fc.record({
					start: fc.oneof(fc.constant(undefined), timestamp),
					end: fc.oneof(fc.constant(undefined), timestamp),
				}),
			),
		}),
	})
	.map(
		(props): OpenCodeEvent => ({
			type: "message.part.updated",
			properties: props,
		}),
	);

/** Generate a permission.asked event */
export const permissionAskedEvent = fc
	.record({
		id: idString.filter((s) => s.length > 0),
		sessionID: idString,
		permission: anyToolName,
		patterns: fc.array(edgeCaseString, { minLength: 0, maxLength: 5 }),
		metadata: fc.dictionary(
			fc.string({ minLength: 1, maxLength: 10 }),
			fc.string({ minLength: 0, maxLength: 50 }),
		),
		always: fc.array(edgeCaseString, { minLength: 0, maxLength: 3 }),
	})
	.map(
		(props): OpenCodeEvent => ({
			type: "permission.asked",
			properties: props,
		}),
	);

/** Generate a question.asked event */
export const questionAskedEvent = fc
	.record({
		id: idString.filter((s) => s.length > 0),
		sessionID: idString,
		questions: fc.array(
			fc.record({
				question: edgeCaseString,
				header: edgeCaseString,
				options: fc.array(
					fc.record({ label: edgeCaseString, description: edgeCaseString }),
					{ minLength: 0, maxLength: 4 },
				),
				multiple: fc.boolean(),
				custom: fc.oneof(fc.boolean(), fc.constant(undefined)),
			}),
			{ minLength: 1, maxLength: 4 },
		),
	})
	.map(
		(props): OpenCodeEvent => ({
			type: "question.asked",
			properties: props,
		}),
	);

/** Generate a session.status event */
export const sessionStatusEvent = fc.constantFrom("busy", "idle", "retry").map(
	(statusType): OpenCodeEvent => ({
		type: "session.status",
		properties: { status: { type: statusType } },
	}),
);

/** Generate a message.updated event */
export const messageUpdatedEvent = fc
	.record({
		sessionID: idString,
		message: fc.record({
			role: fc.constantFrom("assistant", "user"),
			cost: fc.oneof(
				fc.constant(undefined),
				fc.float({ min: 0, max: 100, noNaN: true }),
			),
			tokens: fc.record({
				input: fc.nat({ max: 100_000 }),
				output: fc.nat({ max: 100_000 }),
				cache: fc.record({
					read: fc.nat({ max: 100_000 }),
					write: fc.nat({ max: 100_000 }),
				}),
			}),
			time: fc.record({
				created: timestamp,
				completed: fc.oneof(fc.constant(undefined), timestamp),
			}),
		}),
	})
	.map(
		(props): OpenCodeEvent => ({
			type: "message.updated",
			properties: props,
		}),
	);

/** Generate an unknown event type */
export const unknownEvent = fc
	.record({
		type: fc.oneof(
			{ weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 30 }) },
			{ weight: 1, arbitrary: fc.constant("some.random.event") },
			{ weight: 1, arbitrary: fc.constant("") },
		),
		properties: fc.dictionary(
			fc.string({ minLength: 1, maxLength: 10 }),
			fc.jsonValue(),
		),
	})
	.filter((e) => {
		const known = [
			"message.part.delta",
			"message.part.updated",
			"message.part.removed",
			"message.updated",
			"message.removed",
			"session.status",
			"permission.asked",
			"question.asked",
		];
		return (
			!known.includes(e.type) &&
			!e.type.startsWith("pty.") &&
			!e.type.startsWith("file.")
		);
	}) as fc.Arbitrary<OpenCodeEvent>;

// ─── IPC generators ─────────────────────────────────────────────────────────

/** Valid IPC commands */
export const validIPCCommand: fc.Arbitrary<IPCCommand> = fc.oneof(
	fc.record({ cmd: fc.constant("get_status") }),
	fc.record({ cmd: fc.constant("list_projects") }),
	fc.record({ cmd: fc.constant("shutdown") }),
	fc.record({ cmd: fc.constant("restart_with_config") }),
	fc.record({
		cmd: fc.constant("add_project"),
		directory: fc.string({ minLength: 1, maxLength: 200 }),
	}),
	fc.record({
		cmd: fc.constant("remove_project"),
		slug: fc.string({ minLength: 1, maxLength: 50 }),
	}),
	fc.record({
		cmd: fc.constant("set_pin"),
		pin: fc.stringMatching(/^\d{4,8}$/),
	}),
	fc.record({
		cmd: fc.constant("set_keep_awake"),
		enabled: fc.boolean(),
	}),
	fc.record({
		cmd: fc.constant("set_keep_awake_command" as const),
		command: fc.string({ minLength: 1, maxLength: 50 }),
		args: fc.array(fc.string({ minLength: 0, maxLength: 30 }), {
			maxLength: 5,
		}),
	}),
	fc.record({
		cmd: fc.constant("set_project_title"),
		slug: fc.string({ minLength: 1, maxLength: 50 }),
		title: fc.string({ minLength: 0, maxLength: 100 }),
	}),
	fc.record({
		cmd: fc.constant("set_agent"),
		slug: fc.string({ minLength: 1, maxLength: 50 }),
		agent: fc.constantFrom("build", "plan", "general"),
	}),
	fc.record({
		cmd: fc.constant("set_model"),
		slug: fc.string({ minLength: 1, maxLength: 50 }),
		provider: fc.string({ minLength: 1, maxLength: 50 }),
		model: fc.string({ minLength: 1, maxLength: 100 }),
	}),
	fc.record({ cmd: fc.constant("instance_list") }),
	fc.record({
		cmd: fc.constant("instance_add"),
		name: fc.string({ minLength: 1, maxLength: 50 }),
		managed: fc.constant(true),
		port: fc.integer({ min: 1, max: 65535 }),
	}),
	fc.record({
		cmd: fc.constant("instance_add"),
		name: fc.string({ minLength: 1, maxLength: 50 }),
		managed: fc.constant(false),
		url: fc.constant("http://host:4096"),
	}),
	fc.record({
		cmd: fc.constant("instance_add"),
		name: fc.string({ minLength: 1, maxLength: 50 }),
		managed: fc.constant(false),
		port: fc.integer({ min: 1, max: 65535 }),
	}),
	fc.record({
		cmd: fc.constant("instance_remove"),
		id: fc.string({ minLength: 1, maxLength: 50 }),
	}),
	fc.record({
		cmd: fc.constant("instance_start"),
		id: fc.string({ minLength: 1, maxLength: 50 }),
	}),
	fc.record({
		cmd: fc.constant("instance_stop"),
		id: fc.string({ minLength: 1, maxLength: 50 }),
	}),
	fc.record({
		cmd: fc.constant("instance_status"),
		id: fc.string({ minLength: 1, maxLength: 50 }),
	}),
) as fc.Arbitrary<IPCCommand>;

/** Invalid IPC commands */
export const invalidIPCCommand = fc.oneof(
	{
		weight: 3,
		arbitrary: fc
			.record({ cmd: fc.string({ minLength: 1, maxLength: 30 }) })
			.filter(
				(c) =>
					c.cmd !== "" &&
					![
						"get_status",
						"list_projects",
						"shutdown",
						"restart_with_config",
						"add_project",
						"remove_project",
						"set_pin",
						"set_keep_awake",
						"set_keep_awake_command",
						"set_project_title",
						"set_agent",
						"set_model",
						"instance_list",
						"instance_add",
						"instance_remove",
						"instance_start",
						"instance_stop",
						"instance_status",
					].includes(c.cmd),
			),
	},
	{ weight: 2, arbitrary: fc.constant({ cmd: "nonexistent" }) },
	{ weight: 1, arbitrary: fc.constant({ cmd: "" }) },
) as fc.Arbitrary<IPCCommand>;

/** Invalid JSON strings */
export const invalidJSON = fc.oneof(
	{ weight: 3, arbitrary: fc.constant("{invalid json}") },
	{ weight: 2, arbitrary: fc.constant("") },
	{ weight: 2, arbitrary: fc.constant("null") },
	{ weight: 1, arbitrary: fc.constant("undefined") },
	{ weight: 1, arbitrary: fc.constant("[1,2,3]") },
	{ weight: 1, arbitrary: fc.constant('"just a string"') },
	{ weight: 1, arbitrary: fc.constant("{") },
	{ weight: 1, arbitrary: fc.constant('{"no_cmd": true}') },
);

// ─── Auth generators ────────────────────────────────────────────────────────

/** Valid PINs (4-8 digits) */
export const validPin = fc.stringMatching(/^\d{4,8}$/);

/** Invalid PINs */
export const invalidPin = fc.oneof(
	{ weight: 3, arbitrary: fc.constant("") },
	{ weight: 2, arbitrary: fc.constant("123") }, // too short
	{ weight: 2, arbitrary: fc.constant("123456789") }, // too long
	{ weight: 2, arbitrary: fc.constant("abcdef") }, // non-digit
	{ weight: 1, arbitrary: fc.constant("12 34") }, // spaces
	{ weight: 1, arbitrary: fc.constant("12.34") }, // punctuation
	{ weight: 2, arbitrary: edgeCaseString },
);

/** IP addresses */
export const ipAddress = fc.oneof(
	{ weight: 5, arbitrary: fc.ipV4() },
	{ weight: 2, arbitrary: fc.constantFrom("127.0.0.1", "::1", "192.168.1.1") },
	{ weight: 1, arbitrary: fc.constant("0.0.0.0") },
);

// ─── Recent Projects generators ─────────────────────────────────────────────

/** A recent project entry */
export const recentProject: fc.Arbitrary<RecentProject> = fc
	.record({
		directory: fc.oneof(
			{
				weight: 5,
				arbitrary: fc
					.string({ minLength: 1, maxLength: 100 })
					.map((s) => `/home/user/${s}`),
			},
			{ weight: 2, arbitrary: fc.constant("/") },
			{
				weight: 1,
				arbitrary: fc.constant("/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p"),
			},
		),
		slug: fc
			.string({ minLength: 1, maxLength: 30 })
			.map(
				(s) => s.replace(/[^a-z0-9-]/g, "-").replace(/^-|-$/g, "") || "project",
			),
		title: fc.oneof(
			fc.constant(undefined),
			fc.string({ minLength: 0, maxLength: 50 }),
		),
		lastUsed: timestamp,
	})
	.map(({ title, ...rest }) => ({
		...rest,
		...(title != null && { title }),
	}));

/** A list of recent projects */
export const recentProjectList = fc.array(recentProject, {
	minLength: 0,
	maxLength: 30,
});

// ─── Path traversal generators ──────────────────────────────────────────────

/** Strings that look like path traversal attempts */
export const pathTraversal = fc.oneof(
	{ weight: 3, arbitrary: fc.constant("../../../etc/passwd") },
	{ weight: 2, arbitrary: fc.constant("..\\..\\..\\windows\\system32") },
	{ weight: 2, arbitrary: fc.constant("/etc/shadow") },
	{ weight: 1, arbitrary: fc.constant("....//....//....//etc/hosts") },
	{ weight: 1, arbitrary: fc.constant("..%2F..%2F..%2Fetc%2Fpasswd") },
	{ weight: 1, arbitrary: fc.constant("\x00/etc/passwd") },
);

// ─── Directory path generators ──────────────────────────────────────────────

/** Realistic directory paths */
export const directoryPath = fc.oneof(
	{
		weight: 5,
		arbitrary: fc
			.array(fc.string({ minLength: 1, maxLength: 20 }), {
				minLength: 1,
				maxLength: 5,
			})
			.map((parts) => `/${parts.join("/")}`),
	},
	{ weight: 2, arbitrary: fc.constant("/Users/me/my-app") },
	{ weight: 1, arbitrary: fc.constant("/") },
	{ weight: 1, arbitrary: fc.constant("C:\\Users\\me\\my-app") },
	{ weight: 1, arbitrary: pathTraversal },
);
