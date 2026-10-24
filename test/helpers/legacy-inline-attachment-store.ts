import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createProjectStoreFixture } from "./daemon-store-import-manifest.js";

export const legacyImageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
	"base64",
);
export const legacyImageUrl = `data:image/png;name=legacy%20image.png;base64,${legacyImageBytes.toString("base64")}`;
export const legacyImageRef = {
	attachmentHash: createHash("sha256")
		.update("image/png\0")
		.update(legacyImageBytes)
		.digest("hex"),
	mime: "image/png",
	name: "legacy image.png",
};

/** SQL deliberately bypasses today's schemas to recreate the pre-cutover forms. */
export async function createLegacyInlineAttachmentStore(
	root: string,
	projectId: string,
	options: { sourcePath?: string; unprojected?: boolean } = {},
) {
	const sessionId = `ses_${projectId}`;
	const fixture = await createProjectStoreFixture(root, projectId, {
		...options,
		sessionId,
		transcript: { prompt: "Legacy image import", reply: "Imported reply" },
	});
	const userId = `${sessionId}_user`;
	const assistantId = `${sessionId}_assistant`;
	const file = {
		id: `${sessionId}_snapshot_image`,
		type: "file",
		mime: "image/png",
		filename: "legacy image.png",
		url: legacyImageUrl,
	};
	const message = {
		id: assistantId,
		sessionID: sessionId,
		role: "assistant",
		time: { created: 1000, completed: 1020 },
		parts: [
			{ id: `${assistantId}_text`, type: "text", text: "Imported reply" },
			file,
		],
	};
	const request = { text: "Legacy queued image", images: [legacyImageUrl] };
	const db = new DatabaseSync(fixture.sourcePath);
	try {
		const append = db.prepare(`INSERT INTO events
			(event_id, session_id, stream_version, type, data, metadata, provider, created_at, project_id)
			VALUES (?, ?, (SELECT MAX(stream_version) + 1 FROM events WHERE session_id = ?), ?, ?, '{}', 'claude', 1100, ?)`);
		for (const [suffix, type, payload] of [
			[
				"admitted",
				"input.admitted",
				{
					sessionId,
					inputId: `${sessionId}_input`,
					delivery: "queue",
					request,
				},
			],
			[
				"file",
				"file.attached",
				{
					messageId: userId,
					partId: `${sessionId}_attached`,
					mime: file.mime,
					filename: file.filename,
					url: legacyImageUrl,
				},
			],
			[
				"snapshot",
				"message.snapshot",
				{ messageId: assistantId, digest: "legacy-snapshot", message },
			],
		] as const)
			append.run(
				`${sessionId}_${suffix}_event`,
				sessionId,
				sessionId,
				type,
				JSON.stringify(payload),
				projectId,
			);
		db.prepare("UPDATE messages SET rest_payload = ? WHERE id = ?").run(
			JSON.stringify(message),
			assistantId,
		);
		db.prepare(`INSERT INTO message_parts
			(id, message_id, type, sort_order, created_at, updated_at, metadata, rest_payload)
			VALUES (?, ?, 'file', 1, 1000, 1000, ?, ?)`).run(
			`${sessionId}_attached`,
			userId,
			JSON.stringify({
				mime: file.mime,
				filename: file.filename,
				url: legacyImageUrl,
			}),
			JSON.stringify(file),
		);
		db.prepare(`INSERT INTO pending_inputs
			(input_id, session_id, text, images, request, state, admitted_at, version)
			VALUES (?, ?, ?, ?, ?, 'queued', 1100, 0)`).run(
			`${sessionId}_input`,
			sessionId,
			request.text,
			JSON.stringify(request.images),
			JSON.stringify(request),
		);
		for (const [index, status] of [
			"pending",
			"running",
			"retryable_failed",
			"completed",
			"failed",
			"cancelled",
		].entries())
			db.prepare(`INSERT INTO provider_command_outbox
				(request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (?, ?, ?, ?, 'claude', 'send_turn', ?, ?, 1100, 1100)`).run(
				index + 1,
				`${sessionId}_command_${index}`,
				projectId,
				sessionId,
				JSON.stringify({
					...request,
					inputId: `${sessionId}_input`,
					nativeThread: { firstSequence: 1 },
				}),
				status,
			);
		if (!options.unprojected)
			db.exec(
				"UPDATE projector_cursors SET last_applied_seq = (SELECT MAX(sequence) FROM events)",
			);
		db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE");
	} finally {
		db.close();
	}
	return { ...fixture, sessionId, userId, assistantId };
}
