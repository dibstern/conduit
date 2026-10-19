/*
 * Failure cases written before the reader and contracts:
 * - Missing files are absent; malformed JSON and wrong field types are invalid.
 * - A non-object JSON value must not silently become an empty project file.
 * - Unknown keys are ignored while sessionMode accepts only Local/New worktree.
 * - Project saves preserve sessionMode and distinguish omission from null clearing.
 * - Editing the primary-folder file must affect the next read, without a cache.
 * - Setup events and the project save/read contracts must retain typed state.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectFileSchema } from "../../../src/lib/contracts/project-file.js";
import { StoredEventSchema } from "../../../src/lib/contracts/stored-event.js";
import {
	ProjectInfoSchema,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { readProjectFile } from "../../../src/lib/daemon/project-file.js";

const roots: string[] = [];
const root = () => {
	const directory = mkdtempSync(join(tmpdir(), "conduit-project-file-"));
	roots.push(directory);
	return directory;
};

afterEach(() => {
	for (const directory of roots.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("checked-in project file", () => {
	it("ignores unknown keys and retains optional setup and session-mode settings", () => {
		expect(
			Schema.decodeUnknownSync(ProjectFileSchema)({
				setupScript: "pnpm install\necho ready",
				sessionMode: "worktree",
				unknown: true,
			}),
		).toEqual({
			setupScript: "pnpm install\necho ready",
			sessionMode: "worktree",
		});
		expect(Schema.decodeUnknownSync(ProjectFileSchema)({})).toEqual({});
	});

	it("returns absent for a missing primary-folder file", async () => {
		expect(await Effect.runPromise(readProjectFile(root()))).toEqual({
			_tag: "absent",
		});
	});

	it.each([
		"{broken",
		'{"setupScript":42}',
		'{"sessionMode":"sometimes"}',
		'{"sessionMode":null}',
		"null",
		"[]",
		'"script"',
	])("reports invalid file %s without failing the read", async (contents) => {
		const directory = root();
		writeFileSync(join(directory, "conduit.json"), contents);
		const result = await Effect.runPromise(readProjectFile(directory));
		expect(result).toMatchObject({ _tag: "invalid" });
		if (result._tag === "invalid")
			expect(result.message).toContain("conduit.json");
	});

	it("reads edits afresh from the primary folder", async () => {
		const directory = root();
		const file = join(directory, "conduit.json");
		writeFileSync(file, '{"setupScript":"echo first"}');
		expect(await Effect.runPromise(readProjectFile(directory))).toEqual({
			_tag: "parsed",
			file: { setupScript: "echo first" },
		});
		writeFileSync(file, '{"setupScript":"echo second","unknown":true}');
		expect(await Effect.runPromise(readProjectFile(directory))).toEqual({
			_tag: "parsed",
			file: { setupScript: "echo second" },
		});
	});
});

describe("project setup contracts", () => {
	it.each([
		"local",
		"worktree",
		null,
	])("retains sessionMode %j in SaveProject, including an explicit clear", (sessionMode) => {
		const decoded = Schema.decodeUnknownSync(SaveProject.payloadSchema)({
			_tag: "SaveProject",
			folders: ["/workspace/app"],
			sessionMode,
		});
		expect(decoded.sessionMode).toBe(sessionMode);
	});

	it("exposes the stored mode to project edit mode", () => {
		expect(
			Schema.decodeUnknownSync(ProjectInfoSchema)({
				slug: "app",
				title: "App",
				folders: ["/workspace/app"],
				sessionMode: "worktree",
			}).sessionMode,
		).toBe("worktree");
	});

	it.each([
		"echo ready",
		"",
		" \n ",
	])("retains setupScript %j in SaveProject, including an explicit clear", (setupScript) => {
		const decoded = Schema.decodeUnknownSync(SaveProject.payloadSchema)({
			_tag: "SaveProject",
			folders: ["/workspace/app"],
			setupScript,
		});
		expect(decoded.setupScript).toBe(setupScript);
	});

	it("exposes the stored script to project edit mode", () => {
		expect(
			Schema.decodeUnknownSync(ProjectInfoSchema)({
				slug: "app",
				title: "App",
				folders: ["/workspace/app"],
				setupScript: "echo ready",
			}).setupScript,
		).toBe("echo ready");
	});

	it.each([
		["session.setup_started", { sessionId: "session", source: "daemon" }],
		["session.setup_output", { sessionId: "session", output: "installing\n" }],
		[
			"session.setup_finished",
			{ sessionId: "session", status: "failed", exitCode: 17 },
		],
		[
			"session.setup_finished",
			{ sessionId: "session", status: "timed_out", message: "Timed out" },
		],
		[
			"session.setup_finished",
			{
				sessionId: "session",
				status: "skipped",
				message: "Invalid conduit.json",
			},
		],
	])("decodes canonical %s state", (type, data) => {
		const event = {
			eventId: "event",
			sessionId: "session",
			projectId: "app",
			sequence: 1,
			streamVersion: 1,
			provider: "claude",
			metadata: {},
			type,
			data,
			createdAt: 1,
		};
		expect(Schema.decodeUnknownSync(StoredEventSchema)(event)).toMatchObject({
			type,
			data,
		});
	});
});
