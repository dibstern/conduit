import { describe, expect, it } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";
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
			directory: "/src/myapp",
			title: "myapp",
			instanceId: "personal",
		};
		expect(project.instanceId).toBe("personal");
	});

	it("ProjectInfo works without instanceId (backward compat)", () => {
		const project: ProjectInfo = {
			slug: "myapp",
			directory: "/src/myapp",
			title: "myapp",
		};
		expect(project.instanceId).toBeUndefined();
	});

	// ─── Behavioral tests ─────────────────────────────────────────────────────

	it("addInstance with all required fields returns correct values at runtime", () => {
		const manager = new InstanceManager(new ServiceRegistry());
		const config: InstanceConfig = {
			name: "Personal",
			port: 4096,
			managed: true,
		};
		const instance = manager.addInstance("personal", config);

		expect(instance.id).toBe("personal");
		expect(instance.name).toBe("Personal");
		expect(instance.port).toBe(4096);
		expect(instance.managed).toBe(true);
		expect(instance.status).toBe("stopped");
		expect(instance.restartCount).toBe(0);
		expect(typeof instance.createdAt).toBe("number");
	});

	it("InstanceConfig url field is optional — addInstance succeeds without url", () => {
		const manager = new InstanceManager(new ServiceRegistry());
		const configWithoutUrl: InstanceConfig = {
			name: "No URL",
			port: 4099,
			managed: true,
			// url intentionally omitted
		};
		const instance = manager.addInstance("no-url-instance", configWithoutUrl);

		expect(instance.id).toBe("no-url-instance");
		// URL is not exposed on OpenCodeInstance directly (stored in externalUrls map),
		// so verify the instance was created and the URL defaults to port-based
		expect(manager.getInstanceUrl("no-url-instance")).toBe(
			"http://localhost:4099",
		);
	});
});
