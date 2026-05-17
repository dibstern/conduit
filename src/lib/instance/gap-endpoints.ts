import { Data } from "effect";
import {
	decodeOpenCodeMessageListResponse,
	decodeOpenCodePendingPermissionListResponse,
	decodeOpenCodePendingQuestionListResponse,
	decodeOpenCodeQuestionRejectBody,
	decodeOpenCodeQuestionReplyBody,
	decodeOpenCodeSkillListResponse,
	decodeOpenCodeUndefinedResponse,
	encodeOpenCodeQuestionRejectBody,
	encodeOpenCodeQuestionReplyBody,
} from "../contracts/providers/opencode-sdk.js";
import { OpenCodeApiError } from "../errors.js";

type DecodeResponse<T> = (raw: unknown) => T;
type EncodeBody<T> = (body: T) => unknown;

export interface GapEndpointsOptions {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
}

export class GapEndpointHttpError extends Data.TaggedError(
	"GapEndpointHttpError",
)<{
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly status: number;
}> {
	override get message(): string {
		return `${this.method} ${this.path} failed: ${this.status}`;
	}
}

export class GapEndpoints {
	private readonly baseUrl: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly headers: Record<string, string>;

	constructor(options: GapEndpointsOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			...options.headers,
		};
	}

	async listPendingPermissions(): Promise<unknown[]> {
		return this.get("/permission", decodeOpenCodePendingPermissionListResponse);
	}

	async listPendingQuestions(): Promise<unknown[]> {
		return this.get("/question", decodeOpenCodePendingQuestionListResponse);
	}

	async replyQuestion(id: string, answers: string[][]): Promise<void> {
		await this.post(
			`/question/${id}/reply`,
			decodeOpenCodeQuestionReplyBody,
			encodeOpenCodeQuestionReplyBody,
			{ answers },
			decodeOpenCodeUndefinedResponse,
		);
	}

	async rejectQuestion(id: string): Promise<void> {
		await this.post(
			`/question/${id}/reject`,
			decodeOpenCodeQuestionRejectBody,
			encodeOpenCodeQuestionRejectBody,
			{},
			decodeOpenCodeUndefinedResponse,
		);
	}

	async listSkills(
		directory?: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/skill?directory=${encodeURIComponent(directory)}`
			: "/skill";
		return this.get(path, decodeOpenCodeSkillListResponse);
	}

	async getMessagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<unknown[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.before) params.set("before", options.before);
		const query = params.toString();
		const path = `/session/${sessionId}/message${query ? `?${query}` : ""}`;
		return this.get(path, decodeOpenCodeMessageListResponse);
	}

	private async get<T>(
		path: string,
		decodeResponse: DecodeResponse<T>,
	): Promise<T> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "GET",
				headers: this.headers,
			}),
		);
		if (!res.ok) {
			throw new GapEndpointHttpError({
				method: "GET",
				path,
				status: res.status,
			});
		}
		const data =
			res.status === 204
				? undefined
				: await parseJsonResponse("GET", path, res.status, res);
		return decodeGapResponse("GET", path, res.status, decodeResponse, data);
	}

	private async post<T, Body>(
		path: string,
		validateBody: DecodeResponse<Body>,
		encodeBody: EncodeBody<Body>,
		body: Body,
		decodeResponse: DecodeResponse<T>,
	): Promise<T> {
		const encodedBody = encodeGapRequest(
			"POST",
			path,
			validateBody,
			encodeBody,
			body,
		);
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify(encodedBody),
			}),
		);
		if (!res.ok) {
			throw new GapEndpointHttpError({
				method: "POST",
				path,
				status: res.status,
			});
		}
		let data: unknown;
		if (res.status !== 204) {
			const ct = res.headers.get("content-type") ?? "";
			if (ct.includes("application/json")) {
				data = await parseJsonResponse("POST", path, res.status, res);
			}
		}
		return decodeGapResponse("POST", path, res.status, decodeResponse, data);
	}
}

async function parseJsonResponse(
	method: "GET" | "POST",
	path: string,
	status: number,
	res: Response,
): Promise<unknown> {
	try {
		return await res.json();
	} catch (err) {
		throw toMalformedGapError({
			message: `Malformed OpenCode gap JSON during ${method} ${path}`,
			method,
			path,
			status,
			err,
		});
	}
}

function encodeGapRequest<T>(
	method: "POST",
	path: string,
	validateBody: DecodeResponse<T>,
	encodeBody: EncodeBody<T>,
	data: T,
): unknown {
	try {
		validateBody(data);
		return encodeBody(data);
	} catch (err) {
		throw toMalformedGapError({
			message: `Malformed OpenCode gap request during ${method} ${path}`,
			method,
			path,
			status: 400,
			err,
		});
	}
}

function decodeGapResponse<T>(
	method: "GET" | "POST",
	path: string,
	status: number,
	decodeResponse: DecodeResponse<T>,
	data: unknown,
): T {
	try {
		return decodeResponse(data);
	} catch (err) {
		throw toMalformedGapError({
			message: `Malformed OpenCode gap response during ${method} ${path}`,
			method,
			path,
			status,
			err,
		});
	}
}

function toMalformedGapError(options: {
	message: string;
	method: "GET" | "POST";
	path: string;
	status: number;
	err: unknown;
}): OpenCodeApiError {
	const cause =
		options.err instanceof Error ? options.err : new Error(String(options.err));
	const parseDetails = cause.message.slice(0, 2000);
	return new OpenCodeApiError({
		message: options.message,
		endpoint: options.path,
		responseStatus: options.status,
		responseBody: { parseDetails },
		cause,
		context: {
			method: options.method,
			path: options.path,
			parseDetails,
		},
	});
}
