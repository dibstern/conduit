export interface GapEndpointsOptions {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
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
		const res = await this.get("/permission");
		return Array.isArray(res) ? res : [];
	}

	async listPendingQuestions(): Promise<unknown[]> {
		const res = await this.get("/question");
		return Array.isArray(res) ? res : [];
	}

	async replyQuestion(id: string, answers: string[][]): Promise<void> {
		await this.post(`/question/${id}/reply`, { answers });
	}

	async rejectQuestion(id: string): Promise<void> {
		await this.post(`/question/${id}/reject`, {});
	}

	async listSkills(
		directory?: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/skill?directory=${encodeURIComponent(directory)}`
			: "/skill";
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
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
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	private async get(path: string): Promise<unknown> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "GET",
				headers: this.headers,
			}),
		);
		if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
		if (res.status === 204) return undefined;
		return res.json();
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify(body),
			}),
		);
		if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
		if (res.status === 204) return undefined;
		const ct = res.headers.get("content-type") ?? "";
		if (ct.includes("application/json")) return res.json();
		return undefined;
	}
}
