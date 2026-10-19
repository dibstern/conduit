import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("frontend WebSocket RPC client", () => {
	it("uses the shared transport Promise boundary", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/frontend/transport/ws-rpc-client.ts"),
			"utf8",
		);

		expect(source).toContain("runTransportEffect");
		expect(source).not.toContain("getRuntime");
		expect(source).not.toContain(".runPromise(");
	});
});
