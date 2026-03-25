import { describe, expect, it, vi } from "vitest";
import {
	dispatchMessage,
	filterAgents,
	getSessionInputDraft,
	type HandlerDeps,
	handleAddProject,
	handleAskUserResponse,
	handleCancel,
	handleDeleteSession,
	handleGetAgents,
	handleGetCommands,
	handleGetFileContent,
	handleGetFileList,
	handleGetModels,
	handleGetProjects,
	handleGetTodo,
	handleInputSync,
	handleListSessions,
	handleLoadMoreHistory,
	handleMessage,
	handleNewSession,
	handlePermissionResponse,
	handlePtyClose,
	handlePtyCreate,
	handlePtyInput,
	handlePtyResize,
	handleQuestionReject,
	handleRenameSession,
	handleRewind,
	handleSearchSessions,
	handleSwitchAgent,
	handleSwitchModel,
	handleSwitchSession,
	handleTerminalCommand,
	MESSAGE_HANDLERS,
	type PayloadMap,
} from "../../../src/lib/handlers/index.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

/** Cast a plain string to PermissionId for test data. */
const pid = (s: string) => s as PermissionId;

// ─── filterAgents ────────────────────────────────────────────────────────────

describe("filterAgents", () => {
	it("maps name/id fields and filters internal agents", () => {
		const raw = [
			{ id: "1", name: "coder", description: "Main agent" },
			{ id: "2", name: "title", description: "Title generator" },
			{ id: "3", name: "compaction" },
			{ id: "4", name: "researcher" },
		];
		const result = filterAgents(raw);
		expect(result).toHaveLength(2);
		expect(result.map((a) => a.id)).toEqual(["coder", "researcher"]);
	});

	it("filters out agents with empty id/name", () => {
		const raw = [
			{ id: "", name: "", description: "Empty" },
			{ id: "1", name: "coder" },
		];
		const result = filterAgents(raw);
		expect(result).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[0]!.id).toBe("coder");
	});

	it("uses id as fallback when name is empty", () => {
		const raw = [{ id: "my-agent", name: "" }];
		const result = filterAgents(raw);
		expect(result).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[0]!.id).toBe("my-agent");
	});

	it("filters out subagents when mode field is present", () => {
		const raw = [
			{ id: "1", name: "build", mode: "primary" },
			{ id: "2", name: "plan", mode: "primary" },
			{ id: "3", name: "general", mode: "subagent" },
			{ id: "4", name: "explore", mode: "subagent" },
		];
		const result = filterAgents(raw);
		expect(result.map((a) => a.id)).toEqual(["build", "plan"]);
	});

	it("filters out hidden agents when hidden field is present", () => {
		const raw = [
			{ id: "1", name: "build", mode: "primary", hidden: false },
			{ id: "2", name: "title", mode: "primary", hidden: true },
			{ id: "3", name: "compaction", mode: "primary", hidden: true },
		];
		const result = filterAgents(raw);
		expect(result.map((a) => a.id)).toEqual(["build"]);
	});

	it("includes custom agents with mode 'all'", () => {
		const raw = [
			{ id: "1", name: "build", mode: "primary" },
			{ id: "2", name: "my-custom", mode: "all", hidden: false },
			{ id: "3", name: "general", mode: "subagent" },
		];
		const result = filterAgents(raw);
		expect(result.map((a) => a.id)).toEqual(["build", "my-custom"]);
	});

	it("does not include mode/hidden in returned objects", () => {
		const raw = [
			{
				id: "1",
				name: "build",
				mode: "primary",
				hidden: false,
				description: "Main",
			},
		];
		const result = filterAgents(raw);
		expect(result[0]).toEqual({
			id: "build",
			name: "build",
			description: "Main",
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect("mode" in result[0]!).toBe(false);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect("hidden" in result[0]!).toBe(false);
	});
});

// ─── handleSwitchAgent ───────────────────────────────────────────────────────

describe("handleSwitchAgent", () => {
	it("sets agent override when agentId is provided", async () => {
		const infoSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: { ...createSilentLogger(), info: infoSpy },
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleSwitchAgent(deps, "client-1", { agentId: "coder" });
		expect(deps.overrides.setAgent).toHaveBeenCalledWith("session-1", "coder");
		expect(infoSpy).toHaveBeenCalled();
	});

	it("does not set agent when agentId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleSwitchAgent(deps, "client-1", { agentId: "" });
		expect(deps.overrides.setAgent).not.toHaveBeenCalled();
	});
});

// ─── handleSwitchModel ───────────────────────────────────────────────────────

describe("handleSwitchModel", () => {
	it("sets model override and sends model_info to session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleSwitchModel(deps, "client-1", {
			modelId: "gpt-4",
			providerId: "openai",
		});
		expect(deps.overrides.setModel).toHaveBeenCalledWith("session-1", {
			providerID: "openai",
			modelID: "gpt-4",
		});
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
			type: "model_info",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("ignores switch_model when client has no session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleSwitchModel(deps, "client-1", {
			modelId: "gpt-4",
			providerId: "openai",
		});
		expect(deps.overrides.setModel).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "model_info",
			model: "gpt-4",
			provider: "openai",
		});
	});

	it("does nothing when modelId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleSwitchModel(deps, "client-1", {
			modelId: "",
			providerId: "openai",
		});
		expect(deps.overrides.setModel).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("does nothing when providerId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleSwitchModel(deps, "client-1", {
			modelId: "gpt-4",
			providerId: "",
		});
		expect(deps.overrides.setModel).not.toHaveBeenCalled();
	});
});

// ─── handleInputSync ─────────────────────────────────────────────────────────

describe("handleInputSync", () => {
	it("sends input_sync to same-session clients except sender", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([
			"client-1",
			"client-2",
			"client-3",
		]);
		await handleInputSync(deps, "client-1", { text: "hello world" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-2", {
			type: "input_sync",
			text: "hello world",
			from: "client-1",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-3", {
			type: "input_sync",
			text: "hello world",
			from: "client-1",
		});
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith(
			"client-1",
			expect.anything(),
		);
	});

	it("does nothing when sender has no session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleInputSync(deps, "client-1", { text: "hello" });
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalled();
		expect(deps.wsHandler.getClientsForSession).not.toHaveBeenCalled();
	});

	it("sends undefined text when payload is malformed (missing text)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([
			"client-1",
			"client-2",
		]);
		await handleInputSync(
			deps,
			"client-1",
			{} as unknown as PayloadMap["input_sync"],
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-2", {
			type: "input_sync",
			text: undefined,
			from: "client-1",
		});
	});
});

// ─── handleCancel ────────────────────────────────────────────────────────────

describe("handleCancel", () => {
	it("aborts active session and sends done to session viewers", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleCancel(deps, "client-1", {});
		expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith(
			"session-1",
		);
		expect(deps.client.abortSession).toHaveBeenCalledWith("session-1");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
			type: "done",
			code: 1,
		});
	});

	it("does nothing when no active session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleCancel(deps, "client-1", {});
		expect(deps.client.abortSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
	});

	it("still sends done to session if abort throws", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.client.abortSession).mockRejectedValue(
			new Error("abort fail"),
		);
		await handleCancel(deps, "client-1", {});
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
			type: "done",
			code: 1,
		});
	});
});

// ─── handleNewSession ────────────────────────────────────────────────────────

describe("handleNewSession", () => {
	it("creates a session with silent mode and scopes to client", async () => {
		const deps = createMockHandlerDeps();
		await handleNewSession(deps, "client-1", { title: "My Session" });
		expect(deps.sessionMgr.createSession).toHaveBeenCalledWith("My Session", {
			silent: true,
		});
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"session-new",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "session-new",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "session_list" }),
		);
	});

	it("passes undefined title when not provided (lets OpenCode auto-name)", async () => {
		const deps = createMockHandlerDeps();
		await handleNewSession(deps, "client-1", {});
		expect(deps.sessionMgr.createSession).toHaveBeenCalledWith(undefined, {
			silent: true,
		});
	});
});

// ─── handleMessage ───────────────────────────────────────────────────────────

describe("handleMessage", () => {
	it("sends message to active session and records user_message", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleMessage(deps, "client-1", { text: "Hello" });
		expect(deps.messageCache.recordEvent).toHaveBeenCalledWith("session-1", {
			type: "user_message",
			text: "Hello",
		});
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
			type: "status",
			status: "processing",
		});
		expect(deps.overrides.startProcessingTimeout).toHaveBeenCalledWith(
			"session-1",
			expect.any(Function),
		);
		expect(deps.client.sendMessageAsync).toHaveBeenCalledWith("session-1", {
			text: "Hello",
		});
	});

	it("returns early when text is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleMessage(deps, "client-1", { text: "" });
		expect(deps.client.sendMessageAsync).not.toHaveBeenCalled();
	});

	it("sends error when no active session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleMessage(deps, "client-1", { text: "Hello" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "NO_SESSION",
			message: "No active session. Create or switch to a session first.",
		});
	});

	it("includes agent/model overrides in prompt when set", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.overrides.getAgent).mockReturnValue("coder");
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "openai",
			modelID: "gpt-4",
		});
		vi.mocked(deps.overrides.isModelUserSelected).mockReturnValue(true);
		await handleMessage(deps, "client-1", { text: "Hello" });
		expect(deps.client.sendMessageAsync).toHaveBeenCalledWith("session-1", {
			text: "Hello",
			agent: "coder",
			model: { providerID: "openai", modelID: "gpt-4" },
		});
	});

	it("records pending user message so SSE echo is suppressed", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleMessage(deps, "client-1", { text: "Hello" });
		// pendingUserMessages.record() should have been called so that
		// sse-wiring can later consume() the echo and suppress it.
		expect(deps.pendingUserMessages.consume("session-1", "Hello")).toBe(true);
	});

	it("handles send failure gracefully", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		const sendErr = new Error("send failed");
		vi.mocked(deps.client.sendMessageAsync).mockRejectedValue(sendErr);
		await handleMessage(deps, "client-1", { text: "Hello" });
		expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith(
			"session-1",
		);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
			type: "done",
			code: 1,
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "SEND_FAILED" }),
		);
	});

	it("clears session input draft when message is sent", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([
			"client-1",
		]);

		// Simulate a draft being stored via input_sync
		await handleInputSync(deps, "client-1", { text: "my draft" });
		expect(getSessionInputDraft("session-1")).toBe("my draft");

		// Sending a message should clear the draft
		await handleMessage(deps, "client-1", { text: "my draft" });
		expect(getSessionInputDraft("session-1")).toBe("");
	});
});

// ─── handlePermissionResponse ────────────────────────────────────────────────

describe("handlePermissionResponse", () => {
	it("forwards resolved permission to OpenCode and broadcasts", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.permissionBridge.onPermissionResponse).mockReturnValue({
			mapped: "once",
			toolName: "Bash",
		});
		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("perm-1"),
			decision: "allow",
		});
		expect(deps.client.replyPermission).toHaveBeenCalledWith({
			id: "perm-1",
			decision: "once",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "permission_resolved",
			requestId: pid("perm-1"),
			decision: "once",
		});
	});

	it("does nothing when bridge returns null (unknown/duplicate)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.permissionBridge.onPermissionResponse).mockReturnValue(null);
		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("perm-1"),
			decision: "allow",
		});
		expect(deps.client.replyPermission).not.toHaveBeenCalled();
	});

	it("uses client session in log (not global active)", async () => {
		const infoSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: { ...createSilentLogger(), info: infoSpy },
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-X");
		vi.mocked(deps.permissionBridge.onPermissionResponse).mockReturnValue({
			mapped: "once",
			toolName: "Bash",
		});

		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("perm-1"),
			decision: "allow",
		});

		// Log should contain session-X (client session), not session-1 (global)
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("session=session-X"),
		);
	});

	it("persists tool-level permission rule to config on allow_always with persistScope='tool'", async () => {
		const deps = createMockHandlerDeps();
		deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
			mapped: "always",
			toolName: "read",
		});
		deps.client.getConfig = vi.fn().mockResolvedValue({
			permission: { bash: "ask" },
		});
		deps.client.updateConfig = vi.fn().mockResolvedValue({});

		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("r1"),
			decision: "allow_always",
			persistScope: "tool",
		});

		expect(deps.client.replyPermission).toHaveBeenCalledWith({
			id: "r1",
			decision: "always",
		});
		expect(deps.client.getConfig).toHaveBeenCalled();
		expect(deps.client.updateConfig).toHaveBeenCalledWith({
			permission: { bash: "ask", read: "allow" },
		});
	});

	it("persists pattern-level permission rule on allow_always with persistScope='pattern'", async () => {
		const deps = createMockHandlerDeps();
		deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
			mapped: "always",
			toolName: "bash",
		});
		deps.client.getConfig = vi.fn().mockResolvedValue({
			permission: { bash: { "*": "ask" } },
		});
		deps.client.updateConfig = vi.fn().mockResolvedValue({});

		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("r1"),
			decision: "allow_always",
			persistScope: "pattern",
			persistPattern: "git *",
		});

		expect(deps.client.updateConfig).toHaveBeenCalledWith({
			permission: { bash: { "*": "ask", "git *": "allow" } },
		});
	});

	it("does not call updateConfig when persistScope is absent", async () => {
		const deps = createMockHandlerDeps();
		deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
			mapped: "always",
			toolName: "read",
		});

		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("r1"),
			decision: "allow_always",
		});

		expect(deps.client.replyPermission).toHaveBeenCalled();
		expect(deps.client.updateConfig).not.toHaveBeenCalled();
	});

	it("handles config persistence failure gracefully (non-fatal)", async () => {
		const deps = createMockHandlerDeps();
		deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
			mapped: "always",
			toolName: "read",
		});
		deps.client.getConfig = vi
			.fn()
			.mockRejectedValue(new Error("network error"));

		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("r1"),
			decision: "allow_always",
			persistScope: "tool",
		});

		// Reply still sent despite config failure
		expect(deps.client.replyPermission).toHaveBeenCalledWith({
			id: "r1",
			decision: "always",
		});
	});

	it("handles string permission config (simple form) when persisting tool-level", async () => {
		const deps = createMockHandlerDeps();
		deps.permissionBridge.onPermissionResponse = vi.fn().mockReturnValue({
			mapped: "always",
			toolName: "read",
		});
		deps.client.getConfig = vi.fn().mockResolvedValue({
			permission: "ask",
		});
		deps.client.updateConfig = vi.fn().mockResolvedValue({});

		await handlePermissionResponse(deps, "client-1", {
			requestId: pid("r1"),
			decision: "allow_always",
			persistScope: "tool",
		});

		// When config is a simple string, expand to object form
		expect(deps.client.updateConfig).toHaveBeenCalledWith({
			permission: { "*": "ask", read: "allow" },
		});
	});
});

// ─── handleAskUserResponse ───────────────────────────────────────────────────

describe("handleAskUserResponse", () => {
	it("forwards answer and broadcasts resolved", async () => {
		const deps = createMockHandlerDeps();
		await handleAskUserResponse(deps, "client-1", {
			toolId: "q-1",
			answers: { "0": "Option A" },
		});
		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "q-1",
			answers: [["Option A"]],
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "q-1",
		});
	});

	it("restarts processing timeout after successful reply", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleAskUserResponse(deps, "client-1", {
			toolId: "q-1",
			answers: { "0": "yes" },
		});
		expect(deps.overrides.startProcessingTimeout).toHaveBeenCalledWith(
			"session-1",
			expect.any(Function),
		);
	});

	it("falls back to listPendingQuestions when replyQuestion fails", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.replyQuestion)
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValueOnce(undefined);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{ id: "que_fallback" },
		]);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "toolu_123",
			answers: { "0": "yes" },
		});

		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_fallback",
			answers: [["yes"]],
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "que_fallback",
		});
	});

	it("logs dropped answer when replyQuestion fails and no pending questions", async () => {
		const warnSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: { ...createSilentLogger(), warn: warnSpy },
		});
		vi.mocked(deps.client.replyQuestion).mockRejectedValue(
			new Error("not found"),
		);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([]);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "toolu_123",
			answers: { "0": "yes" },
		});

		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		// broadcast should NOT have been called since both paths failed
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
		// Should log a "DROPPED" message via warn
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DROPPED"));
		// Should send ask_user_error to the client
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "ask_user_error",
			toolId: "toolu_123",
			message: expect.stringContaining("terminal session"),
		});
	});
});

// ─── handleQuestionReject ────────────────────────────────────────────────────

describe("handleQuestionReject", () => {
	it("rejects question and broadcasts resolved", async () => {
		const deps = createMockHandlerDeps();
		await handleQuestionReject(deps, "client-1", { toolId: "q-1" });
		expect(deps.client.rejectQuestion).toHaveBeenCalledWith("q-1");
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "q-1",
		});
	});

	it("restarts processing timeout after successful reject", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleQuestionReject(deps, "client-1", { toolId: "q-1" });
		expect(deps.overrides.startProcessingTimeout).toHaveBeenCalledWith(
			"session-1",
			expect.any(Function),
		);
	});

	it("falls back to listPendingQuestions when rejectQuestion fails", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.rejectQuestion)
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValueOnce(undefined);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{ id: "que_from_api" },
		]);

		await handleQuestionReject(deps, "client-1", { toolId: "toolu_123" });

		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		expect(deps.client.rejectQuestion).toHaveBeenCalledWith("que_from_api");
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "que_from_api",
		});
	});

	it("does nothing when toolId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleQuestionReject(deps, "client-1", { toolId: "" });
		expect(deps.client.rejectQuestion).not.toHaveBeenCalled();
	});

	it("uses client session in log (not global active)", async () => {
		const infoSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: { ...createSilentLogger(), info: infoSpy },
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-X");

		await handleQuestionReject(deps, "client-1", { toolId: "q-1" });

		// Log should contain session-X (client session), not session-1 (global)
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("session=session-X"),
		);
	});
});

// ─── handleSwitchSession ─────────────────────────────────────────────────────

describe("handleSwitchSession", () => {
	it("associates client with session and sends history (per-tab)", async () => {
		const deps = createMockHandlerDeps();
		await handleSwitchSession(deps, "client-1", { sessionId: "s2" });
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"s2",
		);
	});

	it("does nothing when sessionId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleSwitchSession(deps, "client-1", { sessionId: "" });
		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
	});

	it("uses cached events when available with chat content", async () => {
		const deps = createMockHandlerDeps();
		const cachedEvents: RelayMessage[] = [
			{ type: "user_message", text: "hi" },
			{ type: "delta", text: "hello" },
		];
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(cachedEvents);
		await handleSwitchSession(deps, "client-1", { sessionId: "s2" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "session_switched",
			id: "s2",
			// Session is idle and cache has no done — synthetic done is appended
			events: [...cachedEvents, { type: "done", code: 0 }],
		});
	});

	it("falls back to REST history when cache is empty", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.messageCache.getEvents).mockReturnValue(null);
		vi.mocked(deps.sessionMgr.loadPreRenderedHistory).mockResolvedValue({
			messages: [{ role: "user", content: "hi" }] as unknown[],
			hasMore: false,
			total: 1,
		} as Awaited<ReturnType<typeof deps.sessionMgr.loadPreRenderedHistory>>);
		await handleSwitchSession(deps, "client-1", { sessionId: "s2" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "session_switched",
				id: "s2",
				history: expect.objectContaining({ hasMore: false }),
			}),
		);
	});
});

// ─── handleDeleteSession ─────────────────────────────────────────────────────

describe("handleDeleteSession", () => {
	it("removes cache and deletes session with silent mode", async () => {
		const deps = createMockHandlerDeps();
		await handleDeleteSession(deps, "client-1", { sessionId: "s2" });
		expect(deps.messageCache.remove).toHaveBeenCalledWith("s2");
		expect(deps.sessionMgr.deleteSession).toHaveBeenCalledWith("s2", {
			silent: true,
		});
	});

	it("does nothing when sessionId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleDeleteSession(deps, "client-1", { sessionId: "" });
		expect(deps.sessionMgr.deleteSession).not.toHaveBeenCalled();
	});

	it("broadcasts updated session list", async () => {
		const deps = createMockHandlerDeps();
		await handleDeleteSession(deps, "client-1", { sessionId: "s2" });
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "session_list" }),
		);
	});

	it("calls listSessions once and sendDualSessionLists for broadcast when viewer is active", async () => {
		const deps = createMockHandlerDeps();
		// Client IS viewing the deleted session → triggers viewer redirect
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([
			"client-1",
		]);

		await handleDeleteSession(deps, "client-1", { sessionId: "s2" });

		// handleDeleteSession calls listSessions() once for viewer redirect,
		// then sendDualSessionLists() for the broadcast + handleViewSession
		// also calls sendDualSessionLists() for the per-client list.
		expect(deps.sessionMgr.listSessions).toHaveBeenCalledTimes(1);
		expect(deps.sessionMgr.sendDualSessionLists).toHaveBeenCalled();
	});
});

// ─── handleRenameSession ─────────────────────────────────────────────────────

describe("handleRenameSession", () => {
	it("renames the session", async () => {
		const deps = createMockHandlerDeps();
		await handleRenameSession(deps, "client-1", {
			sessionId: "s1",
			title: "New Title",
		});
		expect(deps.sessionMgr.renameSession).toHaveBeenCalledWith(
			"s1",
			"New Title",
		);
	});

	it("does nothing when sessionId or title is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleRenameSession(deps, "client-1", {
			sessionId: "",
			title: "Title",
		});
		expect(deps.sessionMgr.renameSession).not.toHaveBeenCalled();

		await handleRenameSession(deps, "client-1", {
			sessionId: "s1",
			title: "",
		});
		expect(deps.sessionMgr.renameSession).not.toHaveBeenCalled();
	});
});

// ─── handleListSessions ──────────────────────────────────────────────────────

describe("handleListSessions", () => {
	it("sends session list to requesting client", async () => {
		const deps = createMockHandlerDeps();
		await handleListSessions(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_list" }),
		);
	});
});

// ─── handleSearchSessions ────────────────────────────────────────────────────

describe("handleSearchSessions", () => {
	it("searches sessions and sends results", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.sessionMgr.searchSessions).mockResolvedValue([
			{ id: "s1", title: "Match", updatedAt: 0, messageCount: 1 },
		]);
		await handleSearchSessions(deps, "client-1", { query: "test" });
		expect(deps.sessionMgr.searchSessions).toHaveBeenCalledWith(
			"test",
			undefined,
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "session_list" }),
		);
	});
});

// ─── handleLoadMoreHistory ───────────────────────────────────────────────────

describe("handleLoadMoreHistory", () => {
	it("loads history page for specified session", async () => {
		const deps = createMockHandlerDeps();
		await handleLoadMoreHistory(deps, "client-1", {
			sessionId: "s2",
			offset: 10,
		});
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"s2",
			10,
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "history_page", sessionId: "s2" }),
		);
	});

	it("falls back to client session when sessionId not provided", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleLoadMoreHistory(deps, "client-1", { offset: 5 });
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"session-1",
			5,
		);
	});
});

// ─── handleGetAgents ─────────────────────────────────────────────────────────

describe("handleGetAgents", () => {
	it("fetches and filters agents, sends to client", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listAgents).mockResolvedValue([
			{ id: "1", name: "coder" },
			{ id: "2", name: "title" },
		]);
		await handleGetAgents(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "agent_list",
			agents: [{ id: "coder", name: "coder", description: undefined }],
		});
	});
});

// ─── handleGetModels ─────────────────────────────────────────────────────────

describe("handleGetModels", () => {
	it("fetches providers and sends model_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [{ id: "gpt-4", name: "GPT-4" }],
				},
			],
			defaults: {},
			connected: ["openai"],
		});
		await handleGetModels(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "model_list" }),
		);
	});
});

// ─── handleGetCommands ───────────────────────────────────────────────────────

describe("handleGetCommands", () => {
	it("fetches and sends command list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listCommands).mockResolvedValue([
			{ name: "/help", description: "Get help" },
		]);
		await handleGetCommands(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "command_list",
			commands: [{ name: "/help", description: "Get help" }],
		});
	});
});

// ─── handleGetProjects ───────────────────────────────────────────────────────

describe("handleGetProjects", () => {
	it("uses getProjects callback when available", async () => {
		const projects = [{ slug: "proj", title: "Project", directory: "/test" }];
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test",
				slug: "proj",
				getProjects: () => projects,
			} as unknown as HandlerDeps["config"],
		});
		await handleGetProjects(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "project_list",
			projects,
			current: "proj",
		});
	});

	it("falls back to OpenCode API when getProjects not set", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listProjects).mockResolvedValue([
			{ id: "p1", name: "Project 1", path: "/p1" },
		] as Awaited<ReturnType<typeof deps.client.listProjects>>);
		await handleGetProjects(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "project_list" }),
		);
	});
});

// ─── handleAddProject ────────────────────────────────────────────────────────

describe("handleAddProject", () => {
	it("sends error when directory is missing", async () => {
		const deps = createMockHandlerDeps();
		await handleAddProject(
			deps,
			"client-1",
			{} as unknown as PayloadMap["add_project"],
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INVALID_REQUEST",
			message: "add_project requires a non-empty 'directory' field",
		});
	});

	it("sends error when addProject not supported", async () => {
		const deps = createMockHandlerDeps();
		await handleAddProject(deps, "client-1", { directory: "/foo" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "NOT_SUPPORTED",
			message: "Adding projects is not supported in this mode",
		});
	});

	it("forwards instanceId from payload to addProject callback", async () => {
		const addProject = vi.fn().mockResolvedValue({
			slug: "test-gen",
			title: "test-generator-skill",
			directory: "/home/user/src/work/ds/test-generator-skill",
			instanceId: "work",
		});
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test/project",
				slug: "test-project",
				addProject,
				getProjects: () => [
					{
						slug: "test-gen",
						title: "test-generator-skill",
						directory: "/home/user/src/work/ds/test-generator-skill",
						instanceId: "work",
					},
				],
			} as unknown as HandlerDeps["config"],
		});

		await handleAddProject(deps, "client-1", {
			directory: "/home/user/src/work/ds/test-generator-skill",
			instanceId: "work",
		});

		expect(addProject).toHaveBeenCalledWith(
			"/home/user/src/work/ds/test-generator-skill",
			"work",
		);
	});

	it("passes undefined instanceId when not provided in payload", async () => {
		const addProject = vi.fn().mockResolvedValue({
			slug: "myproj",
			title: "myproj",
			directory: "/foo",
		});
		const deps = createMockHandlerDeps({
			config: {
				httpServer: {} as unknown,
				opencodeUrl: "http://localhost:4096",
				projectDir: "/test/project",
				slug: "test-project",
				addProject,
				getProjects: () => [
					{ slug: "myproj", title: "myproj", directory: "/foo" },
				],
			} as unknown as HandlerDeps["config"],
		});

		await handleAddProject(deps, "client-1", { directory: "/foo" });

		expect(addProject).toHaveBeenCalledWith("/foo", undefined);
	});
});

// ─── handleGetFileList ───────────────────────────────────────────────────────

describe("handleGetFileList", () => {
	it("lists directory and sends file_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listDirectory).mockResolvedValue([
			{ name: "foo.ts", type: "file" },
		] as Awaited<ReturnType<typeof deps.client.listDirectory>>);
		await handleGetFileList(deps, "client-1", { path: "src" });
		expect(deps.client.listDirectory).toHaveBeenCalledWith("src");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "file_list", path: "src" }),
		);
	});
});

// ─── handleGetFileContent ────────────────────────────────────────────────────

describe("handleGetFileContent", () => {
	it("fetches file content and sends to client", async () => {
		const deps = createMockHandlerDeps();
		await handleGetFileContent(deps, "client-1", { path: "src/index.ts" });
		expect(deps.client.getFileContent).toHaveBeenCalledWith("src/index.ts");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "file_content",
				path: "src/index.ts",
			}),
		);
	});

	it("does nothing when path is empty", async () => {
		const deps = createMockHandlerDeps();
		await handleGetFileContent(deps, "client-1", { path: "" });
		expect(deps.client.getFileContent).not.toHaveBeenCalled();
	});
});

// ─── handleRewind ────────────────────────────────────────────────────────────

describe("handleRewind", () => {
	it("reverts session and invalidates cache", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleRewind(deps, "client-1", { messageId: "msg-1" });
		expect(deps.client.revertSession).toHaveBeenCalledWith(
			"session-1",
			"msg-1",
		);
		expect(deps.messageCache.remove).toHaveBeenCalledWith("session-1");
	});

	it("also supports uuid field (legacy)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleRewind(deps, "client-1", { uuid: "msg-2" });
		expect(deps.client.revertSession).toHaveBeenCalledWith(
			"session-1",
			"msg-2",
		);
	});

	it("does nothing when no messageId and no active session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleRewind(deps, "client-1", { messageId: "msg-1" });
		expect(deps.client.revertSession).not.toHaveBeenCalled();
	});
});

// ─── handleGetTodo ───────────────────────────────────────────────────────────

describe("handleGetTodo", () => {
	it("sends empty todo state", async () => {
		const deps = createMockHandlerDeps();
		await handleGetTodo(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "todo_state",
			items: [],
		});
	});
});

// ─── PTY handlers ────────────────────────────────────────────────────────────

describe("handlePtyCreate", () => {
	it("creates PTY and connects upstream", async () => {
		const deps = createMockHandlerDeps();
		await handlePtyCreate(deps, "client-1", {});
		expect(deps.client.createPty).toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "pty_created" }),
		);
		expect(deps.connectPtyUpstream).toHaveBeenCalledWith("pty-1");
	});

	it("sends error when createPty fails", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.createPty).mockRejectedValue(
			new Error("create fail"),
		);
		await handlePtyCreate(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "PTY_CREATE_FAILED" }),
		);
	});

	it("sends error and cleans up when upstream connection fails", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.connectPtyUpstream).mockRejectedValue(
			new Error("connect fail"),
		);
		await handlePtyCreate(deps, "client-1", {});
		// Should broadcast pty_created then pty_deleted (cleanup)
		const broadcastCalls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
		expect(broadcastCalls.some((c) => c[0].type === "pty_created")).toBe(true);
		expect(broadcastCalls.some((c) => c[0].type === "pty_deleted")).toBe(true);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "PTY_CONNECT_FAILED" }),
		);
	});

	it("handles createPty returning no id", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.createPty).mockResolvedValue({} as { id: string });
		await handlePtyCreate(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "PTY_CREATE_FAILED",
			message: "Terminal creation returned no ID",
		});
	});

	it("uses client session in log (not global active)", async () => {
		const infoSpy = vi.fn();
		const warnSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: {
				...createSilentLogger(),
				info: infoSpy,
				warn: warnSpy,
			},
		});
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-X");

		await handlePtyCreate(deps, "client-1", {});

		// Log lines should contain session-X (client session), not session-1
		const allCalls = [...infoSpy.mock.calls, ...warnSpy.mock.calls];
		const logCalls = allCalls.map((c: unknown[]) => c[0]);
		const sessionLogs = logCalls.filter(
			(msg: unknown) => typeof msg === "string" && msg.includes("session="),
		);
		expect(sessionLogs.length).toBeGreaterThan(0);
		for (const msg of sessionLogs) {
			expect(msg).toContain("session=session-X");
			expect(msg).not.toContain("session=session-1");
		}
	});
});

describe("handlePtyInput", () => {
	it("forwards input data to pty manager", async () => {
		const deps = createMockHandlerDeps();
		await handlePtyInput(deps, "client-1", {
			ptyId: "pty-1",
			data: "ls\n",
		});
		expect(deps.ptyManager.sendInput).toHaveBeenCalledWith("pty-1", "ls\n");
	});

	it("does nothing when ptyId or data is empty", async () => {
		const deps = createMockHandlerDeps();
		await handlePtyInput(deps, "client-1", { ptyId: "", data: "ls\n" });
		expect(deps.ptyManager.sendInput).not.toHaveBeenCalled();

		await handlePtyInput(deps, "client-1", { ptyId: "pty-1", data: "" });
		expect(deps.ptyManager.sendInput).not.toHaveBeenCalled();
	});
});

describe("handlePtyResize", () => {
	it("resizes PTY via client API", async () => {
		const deps = createMockHandlerDeps();
		await handlePtyResize(deps, "client-1", {
			ptyId: "pty-1",
			cols: 120,
			rows: 40,
		});
		expect(deps.client.resizePty).toHaveBeenCalledWith("pty-1", 120, 40);
	});

	it("logs but does not error when resize fails", async () => {
		const warnSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: { ...createSilentLogger(), warn: warnSpy },
		});
		vi.mocked(deps.client.resizePty).mockRejectedValue(
			new Error("resize fail"),
		);
		await handlePtyResize(deps, "client-1", {
			ptyId: "pty-1",
			cols: 80,
			rows: 24,
		});
		expect(warnSpy).toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalled();
	});
});

describe("handlePtyClose", () => {
	it("closes session and deletes PTY", async () => {
		const deps = createMockHandlerDeps();
		await handlePtyClose(deps, "client-1", { ptyId: "pty-1" });
		expect(deps.ptyManager.closeSession).toHaveBeenCalledWith("pty-1");
		expect(deps.client.deletePty).toHaveBeenCalledWith("pty-1");
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "pty_deleted",
			ptyId: "pty-1",
		});
	});

	it("does nothing when ptyId is empty", async () => {
		const deps = createMockHandlerDeps();
		await handlePtyClose(deps, "client-1", { ptyId: "" });
		expect(deps.ptyManager.closeSession).not.toHaveBeenCalled();
	});
});

// ─── handleTerminalCommand ───────────────────────────────────────────────────

describe("handleTerminalCommand", () => {
	it("delegates create action to createAndConnectPty", async () => {
		const deps = createMockHandlerDeps();
		await handleTerminalCommand(deps, "client-1", { action: "create" });
		expect(deps.client.createPty).toHaveBeenCalled();
		expect(deps.connectPtyUpstream).toHaveBeenCalled();
	});

	it("handles close action", async () => {
		const deps = createMockHandlerDeps();
		await handleTerminalCommand(deps, "client-1", {
			action: "close",
			ptyId: "pty-1",
		});
		expect(deps.ptyManager.closeSession).toHaveBeenCalledWith("pty-1");
		expect(deps.client.deletePty).toHaveBeenCalledWith("pty-1");
	});

	it("handles list action and reconnects running PTYs", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listPtys).mockResolvedValue([
			{ id: "pty-1", status: "running" },
		]);
		await handleTerminalCommand(deps, "client-1", { action: "list" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "pty_list" }),
		);
		// Should attempt to reconnect the running PTY
		expect(deps.connectPtyUpstream).toHaveBeenCalledWith("pty-1", -1);
	});

	it("list action skips reconnect for already-tracked PTYs", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listPtys).mockResolvedValue([
			{ id: "pty-1", status: "running" },
		]);
		vi.mocked(deps.ptyManager.hasSession).mockReturnValue(true);
		await handleTerminalCommand(deps, "client-1", { action: "list" });
		expect(deps.connectPtyUpstream).not.toHaveBeenCalled();
	});
});

// ─── dispatchMessage ─────────────────────────────────────────────────────────

describe("dispatchMessage", () => {
	it("dispatches to known handler", async () => {
		const deps = createMockHandlerDeps();
		await dispatchMessage(deps, "client-1", "get_todo", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "todo_state",
			items: [],
		});
	});

	it("logs unknown handler names", async () => {
		const warnSpy = vi.fn();
		const deps = createMockHandlerDeps({
			log: { ...createSilentLogger(), warn: warnSpy },
		});
		await dispatchMessage(deps, "client-1", "unknown_handler", {});
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Unhandled: unknown_handler"),
		);
	});

	it("dispatch table has entries for all expected handlers", () => {
		const expectedHandlers = [
			"message",
			"permission_response",
			"ask_user_response",
			"question_reject",
			"new_session",
			"switch_session",
			"view_session",
			"delete_session",
			"rename_session",
			"fork_session",
			"list_sessions",
			"search_sessions",
			"load_more_history",
			"get_agents",
			"switch_agent",
			"get_models",
			"switch_model",
			"set_default_model",
			"switch_variant",
			"get_commands",
			"get_projects",
			"add_project",
			"list_directories",
			"remove_project",
			"rename_project",
			"get_file_list",
			"get_file_content",
			"get_file_tree",
			"get_tool_content",
			"terminal_command",
			"pty_create",
			"pty_input",
			"pty_resize",
			"pty_close",
			"cancel",
			"rewind",
			"input_sync",
			"get_todo",
			"instance_add",
			"instance_remove",
			"instance_start",
			"instance_stop",
			"instance_update",
			"instance_rename",
			"set_project_instance",
			"proxy_detect",
			"scan_now",
		];
		const table = MESSAGE_HANDLERS as Record<string, unknown>;
		for (const name of expectedHandlers) {
			expect(table[name]).toBeDefined();
			expect(typeof table[name]).toBe("function");
		}
		// Reverse check: no handlers in production that we don't expect
		expect(Object.keys(MESSAGE_HANDLERS).sort()).toEqual(
			[...expectedHandlers].sort(),
		);
	});
});
