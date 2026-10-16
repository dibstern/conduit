import { readFileSync } from "node:fs";
import { CursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAuthStatus,
	CursorModel,
	CursorRuntimeProbe,
	CursorSdkPort,
	CursorStoredCredential,
} from "./sdk-port.js";

interface TraceRow {
	kind: string;
	data: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createTraceCursorSdkPort(path: string): CursorSdkPort {
	let contents: string | undefined;
	let rows: TraceRow[] = [];
	const cursors = new Map<string, number>();
	const reload = () => {
		let next: string;
		try {
			next = readFileSync(path, "utf8");
		} catch {
			throw new CursorSdkFailure({
				operation: "trace.read",
				reason: "Cursor SDK trace could not be read",
			});
		}
		if (next === contents) return;
		let values: unknown[];
		try {
			values = next
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown);
		} catch {
			throw new CursorSdkFailure({
				operation: "trace.decode",
				reason: "Invalid Cursor SDK trace JSON",
			});
		}
		const header = values.shift();
		if (
			!object(header) ||
			header["sdkVersion"] !== "1.0.37" ||
			typeof header["scenario"] !== "string" ||
			!(
				typeof header["model"] === "string" ||
				(object(header["model"]) && typeof header["model"]["id"] === "string")
			) ||
			typeof header["recordedAt"] !== "string"
		) {
			throw new CursorSdkFailure({
				operation: "trace.decode",
				reason: "Invalid Cursor SDK trace header",
			});
		}
		rows = values.filter(
			(value): value is TraceRow =>
				object(value) && typeof value["kind"] === "string",
		);
		cursors.clear();
		contents = next;
	};
	reload();
	const result = (kind: string): unknown => {
		reload();
		const matches = rows.filter(
			(row) => row.kind === kind || row.kind === `${kind}.error`,
		);
		const index = cursors.get(kind) ?? 0;
		const row = matches[Math.min(index, matches.length - 1)];
		cursors.set(kind, index + 1);
		if (row?.kind.endsWith(".error"))
			throw new CursorSdkFailure({
				operation: kind,
				reason: `Cursor ${kind} failed`,
			});
		return row?.data;
	};
	return {
		replay: true,
		async probeRuntime(): Promise<CursorRuntimeProbe> {
			const data = result("runtime.probe");
			// Spike captures predate the discovery probe; their SDK was loaded.
			if (data === undefined) return { available: true };
			if (!object(data) || typeof data["available"] !== "boolean") {
				throw new CursorSdkFailure({
					operation: "runtime.probe",
					reason: "Invalid Cursor runtime probe trace",
				});
			}
			return {
				available: data["available"],
				...(typeof data["reason"] === "string"
					? { reason: data["reason"] }
					: {}),
			};
		},
		async authStatus(): Promise<CursorAuthStatus> {
			const data = result("auth.status");
			if (
				data === undefined ||
				(object(data) && data["status"] === "logged-out")
			) {
				return { status: "logged-out" };
			}
			if (
				!object(data) ||
				data["status"] !== "logged-in" ||
				typeof data["backendUrl"] !== "string"
			) {
				throw new CursorSdkFailure({
					operation: "auth.status",
					reason: "Invalid Cursor auth status trace",
				});
			}
			return {
				status: "logged-in",
				backendUrl: data["backendUrl"],
				...(typeof data["email"] === "string" ? { email: data["email"] } : {}),
				...(typeof data["apiKeyExpiresAtMs"] === "number"
					? { apiKeyExpiresAtMs: data["apiKeyExpiresAtMs"] }
					: {}),
			};
		},
		async storedCredential(): Promise<CursorStoredCredential | undefined> {
			const data = result("credential.store");
			if (data === undefined || data === null) return undefined;
			if (!object(data) || typeof data["apiKey"] !== "string") {
				throw new CursorSdkFailure({
					operation: "credential.store",
					reason: "Invalid Cursor credential store trace",
				});
			}
			return {
				apiKey: "[REDACTED]",
				backendUrl:
					typeof data["backendUrl"] === "string"
						? data["backendUrl"]
						: "https://api2.cursor.sh",
				createdAtMs:
					typeof data["createdAtMs"] === "number" ? data["createdAtMs"] : 0,
				...(typeof data["apiKeyExpiresAtMs"] === "number"
					? { apiKeyExpiresAtMs: data["apiKeyExpiresAtMs"] }
					: {}),
			};
		},
		async modelsList(): Promise<readonly CursorModel[]> {
			const data = result("models.list");
			const models = object(data) ? data["models"] : data;
			if (
				!Array.isArray(models) ||
				!models.every(
					(model): model is CursorModel =>
						object(model) &&
						typeof model["id"] === "string" &&
						typeof model["displayName"] === "string",
				)
			) {
				throw new CursorSdkFailure({
					operation: "models.list",
					reason: "Invalid Cursor model list trace",
				});
			}
			return models;
		},
	};
}
