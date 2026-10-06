import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import type {
	InstanceConfig,
	InstanceStatus,
	OpenCodeInstance,
} from "../../../src/lib/types.js";

describe("Instance types", () => {
	it("OpenCodeInstance has required fields", () => {
		const instance: OpenCodeInstance = {
			id: "personal",
			name: "Personal",
			port: 4096,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: Date.now(),
		};
		expect(instance.id).toBe("personal");
		expect(instance.status).toBe("healthy");
		expect(instance.managed).toBe(true);
	});

	it("OpenCodeInstance supports optional fields", () => {
		const instance: OpenCodeInstance = {
			id: "work",
			name: "Work",
			port: 4097,
			managed: true,
			status: "starting",
			pid: 12345,
			env: { ANTHROPIC_API_KEY: "sk-test" },
			lastHealthCheck: Date.now(),
			restartCount: 0,
			createdAt: Date.now(),
		};
		expect(instance.pid).toBe(12345);
		expect(instance.env).toBeDefined();
	});

	it("InstanceConfig has required fields", () => {
		const config: InstanceConfig = {
			name: "Personal",
			port: 4096,
			managed: true,
		};
		expect(config.name).toBe("Personal");
	});

	it("InstanceStatus type is usable", () => {
		const status: InstanceStatus = "healthy";
		expect(status).toBe("healthy");
	});

	it("ProjectInfo has optional instanceId", () => {
		const project: ProjectInfo = {
			slug: "myapp",
			folders: ["/src/myapp"],
			title: "myapp",
			instanceId: "personal",
		};
		expect(project.instanceId).toBe("personal");
	});

	it("ProjectInfo works without instanceId (backward compat)", () => {
		const project: ProjectInfo = {
			slug: "myapp",
			folders: ["/src/myapp"],
			title: "myapp",
		};
		expect(project.instanceId).toBeUndefined();
	});
});
