# Phase 6: @effect/rpc IPC Protocol Upgrade

> **Prerequisites:** Phase 5 complete. All modules Effect-native. Read [conventions.md](conventions.md).
> **Dependency:** Phases 1-5 complete.
> **Merge milestone:** M5 — final milestone.

> ## AUDIT FIX (C6): @effect/rpc API Correction
>
> **The code samples in Tasks 40-44 use the WRONG `@effect/rpc` API.** The
> APIs `Rpc.effect()`, `RpcRouter.make()`, and `RpcRouter.toHandler()` do NOT
> exist in `@effect/rpc`. The actual API (verified against installed types) is:
>
> | Plan (wrong) | Actual API |
> |---|---|
> | `Rpc.effect(RequestClass, handler)` | `Rpc.make(tag, options)` |
> | `RpcRouter.make(...handlers)` | `RpcGroup.make(...rpcs)` |
> | `RpcRouter.toHandler(router)` | `RpcGroup.toHandlersContext()` / `RpcGroup.toLayer()` |
> | Manual client encode/decode | `RpcClient.make(group)` returning callable object |
>
> **The executing agent MUST:**
> 1. Read the actual `@effect/rpc` type definitions before implementing Tasks 40-44
> 2. Use `Rpc.make()` + `RpcGroup` pattern, NOT `Rpc.effect()` + `RpcRouter`
> 3. Verify each API call compiles before committing
>
> The TaggedRequest definitions in Task 39 are CORRECT — `Schema.TaggedRequest`
> is the right pattern. Only the router/server/client wiring in Tasks 40-44
> uses the wrong API.
>
> **Additionally (C10):** Task 40 InstanceStatus handler uses `req.id` in a
> `.pipe()` chain outside the callback where `req` is in scope. Move the
> `Effect.annotateLogs("instanceId", req.id)` call inside `Effect.gen`.

**Goal:** Replace the `cmd`-discriminated `Schema.Union` IPC protocol with `@effect/rpc` using `Schema.TaggedRequest`. This gives type-safe request→response pairing, automatic serialization, built-in batching support, and eliminates the manual dispatch switch statement. The protocol wire format changes from `{"cmd":"add_project",...}` to `{"_tag":"AddProject",...}`.

---

## Task 38: Install @effect/rpc

**Step 1: Install the dependency**

```bash
pnpm add @effect/rpc
```

Pin the exact version in `package.json` (no caret) — consistent with the version pinning convention for all `@effect/*` packages. The version must be compatible with `effect 3.21.2`.

**Step 2: Verify installation**

```bash
node -e "require('@effect/rpc')" && echo "OK"
```

If the version of `@effect/rpc` is not compatible with `effect 3.21.2`, install the specific version that matches. Check the `@effect/rpc` changelog for the version that targets Effect 3.21.x.

**Step 3: Update conventions.md**

Add the pinned version to the Tech Stack table in `conventions.md`:

```
@effect/rpc         0.x.x    (Phase 6 — pin exact)
```

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml docs/plans/effect-ts-next-wave/conventions.md
git commit -m "chore: install @effect/rpc for Phase 6 IPC upgrade"
```

---

## Task 39: Define Schema.TaggedRequest classes for all 19 commands

> **NOTE:** This task defines the _new_ protocol types using `Schema.TaggedRequest`
> with `_tag` as the discriminant. These exist alongside the old `IPCCommandSchema`
> (which uses `cmd`). The old schema is NOT deleted until Task 43.

**Files:**
- Create: `src/lib/effect/ipc-requests.ts`
- Test: `test/unit/daemon/ipc-requests.test.ts`

### Step 1: Write the failing test

```typescript
// test/unit/daemon/ipc-requests.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Schema, Either, Effect } from "effect";
import {
  AddProject,
  RemoveProject,
  SetPin,
  SetKeepAwake,
  Shutdown,
  InstanceAdd,
  InstanceRemove,
  InstanceStart,
  InstanceStop,
  ListProjects,
  GetStatus,
  InstanceList,
  InstanceStatus,
  InstanceUpdate,
  SetProjectTitle,
  SetKeepAwakeCommand,
  SetAgent,
  SetModel,
  RestartWithConfig,
} from "../../../src/lib/effect/ipc-requests.js";

describe("IPC TaggedRequest schemas", () => {
  describe("AddProject", () => {
    it.effect("decodes with _tag discriminant", () =>
      Effect.gen(function* () {
        const raw = { _tag: "AddProject", directory: "/home/user/project" };
        const decoded = yield* Schema.decodeUnknown(AddProject)(raw);
        expect(decoded._tag).toBe("AddProject");
        expect(decoded.directory).toBe("/home/user/project");
      })
    );

    it("rejects without directory", () => {
      const raw = { _tag: "AddProject" };
      const result = Schema.decodeUnknownEither(AddProject)(raw);
      expect(Either.isLeft(result)).toBe(true);
    });

    it("rejects empty directory", () => {
      const raw = { _tag: "AddProject", directory: "" };
      const result = Schema.decodeUnknownEither(AddProject)(raw);
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("RemoveProject", () => {
    it.effect("decodes with slug", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(RemoveProject)({
          _tag: "RemoveProject",
          slug: "my-project",
        });
        expect(decoded.slug).toBe("my-project");
      })
    );
  });

  describe("SetPin", () => {
    it.effect("decodes valid 4-digit pin", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetPin)({
          _tag: "SetPin",
          pin: "1234",
        });
        expect(decoded.pin).toBe("1234");
      })
    );

    it.effect("decodes valid 8-digit pin", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetPin)({
          _tag: "SetPin",
          pin: "12345678",
        });
        expect(decoded.pin).toBe("12345678");
      })
    );

    it("rejects non-numeric pin", () => {
      const result = Schema.decodeUnknownEither(SetPin)({
        _tag: "SetPin",
        pin: "abcd",
      });
      expect(Either.isLeft(result)).toBe(true);
    });

    it("rejects too-short pin", () => {
      const result = Schema.decodeUnknownEither(SetPin)({
        _tag: "SetPin",
        pin: "12",
      });
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("SetKeepAwake", () => {
    it.effect("decodes boolean enabled field", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetKeepAwake)({
          _tag: "SetKeepAwake",
          enabled: true,
        });
        expect(decoded.enabled).toBe(true);
      })
    );
  });

  describe("Shutdown", () => {
    it.effect("decodes with no payload", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(Shutdown)({
          _tag: "Shutdown",
        });
        expect(decoded._tag).toBe("Shutdown");
      })
    );
  });

  describe("InstanceAdd", () => {
    it.effect("decodes managed instance with port", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(InstanceAdd)({
          _tag: "InstanceAdd",
          name: "test-instance",
          port: 4096,
          managed: true,
        });
        expect(decoded.name).toBe("test-instance");
        expect(decoded.port).toBe(4096);
        expect(decoded.managed).toBe(true);
      })
    );

    it.effect("decodes unmanaged instance with url", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(InstanceAdd)({
          _tag: "InstanceAdd",
          name: "remote",
          managed: false,
          url: "http://remote:4096",
        });
        expect(decoded.managed).toBe(false);
        expect(decoded.url).toBe("http://remote:4096");
      })
    );

    it.effect("decodes with optional env", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(InstanceAdd)({
          _tag: "InstanceAdd",
          name: "with-env",
          port: 4096,
          managed: true,
          env: { NODE_ENV: "production" },
        });
        expect(decoded.env).toEqual({ NODE_ENV: "production" });
      })
    );

    it("rejects without name", () => {
      const result = Schema.decodeUnknownEither(InstanceAdd)({
        _tag: "InstanceAdd",
        port: 4096,
        managed: true,
      });
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("InstanceRemove / InstanceStart / InstanceStop / InstanceStatus", () => {
    for (const [Cls, tag] of [
      [InstanceRemove, "InstanceRemove"],
      [InstanceStart, "InstanceStart"],
      [InstanceStop, "InstanceStop"],
      [InstanceStatus, "InstanceStatus"],
    ] as const) {
      it.effect(`${tag} decodes with id`, () =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknown(Cls)({
            _tag: tag,
            id: "inst-123",
          });
          expect(decoded.id).toBe("inst-123");
        })
      );
    }
  });

  describe("ListProjects / GetStatus / InstanceList (no payload)", () => {
    for (const [Cls, tag] of [
      [ListProjects, "ListProjects"],
      [GetStatus, "GetStatus"],
      [InstanceList, "InstanceList"],
    ] as const) {
      it.effect(`${tag} decodes with no payload`, () =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknown(Cls)({ _tag: tag });
          expect(decoded._tag).toBe(tag);
        })
      );
    }
  });

  describe("InstanceUpdate", () => {
    it.effect("decodes with partial update fields", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(InstanceUpdate)({
          _tag: "InstanceUpdate",
          id: "inst-1",
          name: "new-name",
          port: 5000,
        });
        expect(decoded.id).toBe("inst-1");
        expect(decoded.name).toBe("new-name");
        expect(decoded.port).toBe(5000);
        expect(decoded.env).toBeUndefined();
      })
    );
  });

  describe("SetProjectTitle", () => {
    it.effect("decodes with slug and title", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetProjectTitle)({
          _tag: "SetProjectTitle",
          slug: "my-proj",
          title: "My Project",
        });
        expect(decoded.slug).toBe("my-proj");
        expect(decoded.title).toBe("My Project");
      })
    );
  });

  describe("SetKeepAwakeCommand", () => {
    it.effect("decodes with command and args", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetKeepAwakeCommand)({
          _tag: "SetKeepAwakeCommand",
          command: "caffeinate",
          args: ["-d"],
        });
        expect(decoded.command).toBe("caffeinate");
        expect(decoded.args).toEqual(["-d"]);
      })
    );

    it.effect("defaults args to empty array when omitted", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetKeepAwakeCommand)({
          _tag: "SetKeepAwakeCommand",
          command: "caffeinate",
        });
        expect(decoded.args).toEqual([]);
      })
    );
  });

  describe("SetAgent", () => {
    it.effect("decodes with slug and agent", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetAgent)({
          _tag: "SetAgent",
          slug: "my-proj",
          agent: "claude-sonnet",
        });
        expect(decoded.slug).toBe("my-proj");
        expect(decoded.agent).toBe("claude-sonnet");
      })
    );
  });

  describe("SetModel", () => {
    it.effect("decodes with slug, provider, model", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(SetModel)({
          _tag: "SetModel",
          slug: "my-proj",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        });
        expect(decoded.slug).toBe("my-proj");
        expect(decoded.provider).toBe("anthropic");
        expect(decoded.model).toBe("claude-sonnet-4-20250514");
      })
    );
  });

  describe("RestartWithConfig", () => {
    it.effect("decodes with no payload", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(RestartWithConfig)({
          _tag: "RestartWithConfig",
        });
        expect(decoded._tag).toBe("RestartWithConfig");
      })
    );
  });

  // --- Wire format tests ---

  describe("wire format", () => {
    it("uses _tag (not cmd) as discriminant", () => {
      // Old format should NOT decode
      const oldFormat = { cmd: "add_project", directory: "/path" };
      const result = Schema.decodeUnknownEither(AddProject)(oldFormat);
      expect(Either.isLeft(result)).toBe(true);
    });

    it.effect("encodes to JSON with _tag field", () =>
      Effect.gen(function* () {
        const request = new AddProject({ directory: "/path" });
        const encoded = yield* Schema.encode(AddProject)(request);
        expect(encoded._tag).toBe("AddProject");
        expect(encoded.directory).toBe("/path");
      })
    );
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/daemon/ipc-requests.test.ts`
Expected: FAIL — module not found

### Step 3: Define all 19 TaggedRequest classes

```typescript
// src/lib/effect/ipc-requests.ts
//
// @effect/rpc TaggedRequest definitions for all 19 IPC commands.
//
// Each class pairs a request schema with its success/failure response schemas,
// giving fully type-safe request→response pairing at the type level.
// The _tag field is the discriminant (PascalCase), replacing the old `cmd` field.
//
// Usage:
//   new AddProject({ directory: "/path" })        → type-safe request
//   client(new AddProject({ directory: "/path" })) → Effect<AddProjectSuccess, AddProjectError>
//

import { Schema } from "effect";

// ─── Shared response schemas ────────────────────────────────────────────────
// These schemas define the shape of success responses for each command.
// The `ok` field is always `true` on success. Specific commands add extra fields.

const OkResponse = Schema.Struct({
  ok: Schema.Literal(true),
});

const OkWithSlugAndPath = Schema.Struct({
  ok: Schema.Literal(true),
  slug: Schema.String,
  path: Schema.String,
});

const OkWithProjects = Schema.Struct({
  ok: Schema.Literal(true),
  projects: Schema.Array(Schema.Unknown),
});

const OkWithStatus = Schema.Struct({
  ok: Schema.Literal(true),
  pid: Schema.optional(Schema.Number),
  port: Schema.optional(Schema.Number),
  clientCount: Schema.optional(Schema.Number),
  keepAwake: Schema.optional(Schema.Boolean),
  tls: Schema.optional(Schema.Boolean),
  shuttingDown: Schema.optional(Schema.Boolean),
  projectCount: Schema.optional(Schema.Number),
  instanceCount: Schema.optional(Schema.Number),
});

const OkWithInstances = Schema.Struct({
  ok: Schema.Literal(true),
  instances: Schema.Array(Schema.Unknown),
});

const OkWithInstance = Schema.Struct({
  ok: Schema.Literal(true),
  instance: Schema.Unknown,
});

const OkWithKeepAwake = Schema.Struct({
  ok: Schema.Literal(true),
  supported: Schema.Boolean,
  active: Schema.Boolean,
});

// ─── Shared error schema ────────────────────────────────────────────────────
// Protocol-level error: the command was received and dispatched but the handler
// reported a failure. For commands that cannot fail at the protocol level,
// use Schema.Never as the failure schema.

export class IpcError extends Schema.TaggedError<IpcError>()(
  "IpcError",
  { message: Schema.String },
) {}

// ─── Non-empty string filter ────────────────────────────────────────────────
// Used for fields like slug, directory, id, name that must not be empty.

const NonEmptyString = Schema.String.pipe(
  Schema.filter((s) => s.length > 0, {
    message: () => "must be a non-empty string",
  }),
);

// ─── Pin pattern filter ─────────────────────────────────────────────────────
// PIN must be 4-8 digits (matches existing ipc-protocol.ts validation).

const PinString = Schema.String.pipe(
  Schema.pattern(/^\d{4,8}$/, {
    message: () => "must be a 4-8 digit PIN",
  }),
);

// ─── Port number filter ─────────────────────────────────────────────────────

const Port = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 65535),
);

// ─── TaggedRequest definitions ──────────────────────────────────────────────
//
// Schema.TaggedRequest<Tag>() creates a class with:
//   - `_tag` discriminant field (set to Tag)
//   - `success` schema for the response on success
//   - `failure` schema for the response on failure
//   - Payload fields from the schema struct
//
// Convention:
//   - PascalCase _tag matching the old snake_case cmd:
//     add_project → AddProject, instance_start → InstanceStart
//   - Fields match existing IPCCommand types from src/lib/types.ts

// ── 1. AddProject ───────────────────────────────────────────────────────────

export class AddProject extends Schema.TaggedRequest<AddProject>()(
  "AddProject",
  {
    failure: IpcError,
    success: OkWithSlugAndPath,
    payload: { directory: NonEmptyString },
  },
) {}

// ── 2. RemoveProject ────────────────────────────────────────────────────────

export class RemoveProject extends Schema.TaggedRequest<RemoveProject>()(
  "RemoveProject",
  {
    failure: IpcError,
    success: OkResponse,
    payload: { slug: NonEmptyString },
  },
) {}

// ── 3. SetPin ───────────────────────────────────────────────────────────────

export class SetPin extends Schema.TaggedRequest<SetPin>()(
  "SetPin",
  {
    failure: IpcError,
    success: OkResponse,
    payload: { pin: PinString },
  },
) {}

// ── 4. SetKeepAwake ─────────────────────────────────────────────────────────

export class SetKeepAwake extends Schema.TaggedRequest<SetKeepAwake>()(
  "SetKeepAwake",
  {
    failure: IpcError,
    success: OkWithKeepAwake,
    payload: { enabled: Schema.Boolean },
  },
) {}

// ── 5. Shutdown ─────────────────────────────────────────────────────────────

export class Shutdown extends Schema.TaggedRequest<Shutdown>()(
  "Shutdown",
  {
    failure: Schema.Never,
    success: OkResponse,
    payload: {},
  },
) {}

// ── 6. InstanceAdd ──────────────────────────────────────────────────────────

export class InstanceAdd extends Schema.TaggedRequest<InstanceAdd>()(
  "InstanceAdd",
  {
    failure: IpcError,
    success: OkWithInstance,
    payload: {
      name: NonEmptyString,
      managed: Schema.Boolean,
      port: Schema.optional(Port),
      env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
      url: Schema.optional(Schema.String),
    },
  },
) {}

// ── 7. InstanceRemove ───────────────────────────────────────────────────────

export class InstanceRemove extends Schema.TaggedRequest<InstanceRemove>()(
  "InstanceRemove",
  {
    failure: IpcError,
    success: OkResponse,
    payload: { id: NonEmptyString },
  },
) {}

// ── 8. InstanceStart ────────────────────────────────────────────────────────

export class InstanceStart extends Schema.TaggedRequest<InstanceStart>()(
  "InstanceStart",
  {
    failure: IpcError,
    success: OkResponse,
    payload: { id: NonEmptyString },
  },
) {}

// ── 9. InstanceStop ─────────────────────────────────────────────────────────

export class InstanceStop extends Schema.TaggedRequest<InstanceStop>()(
  "InstanceStop",
  {
    failure: IpcError,
    success: OkResponse,
    payload: { id: NonEmptyString },
  },
) {}

// ── 10. ListProjects ────────────────────────────────────────────────────────

export class ListProjects extends Schema.TaggedRequest<ListProjects>()(
  "ListProjects",
  {
    failure: IpcError,
    success: OkWithProjects,
    payload: {},
  },
) {}

// ── 11. GetStatus ───────────────────────────────────────────────────────────

export class GetStatus extends Schema.TaggedRequest<GetStatus>()(
  "GetStatus",
  {
    failure: Schema.Never,
    success: OkWithStatus,
    payload: {},
  },
) {}

// ── 12. InstanceList ────────────────────────────────────────────────────────

export class InstanceList extends Schema.TaggedRequest<InstanceList>()(
  "InstanceList",
  {
    failure: IpcError,
    success: OkWithInstances,
    payload: {},
  },
) {}

// ── 13. InstanceStatus ──────────────────────────────────────────────────────

export class InstanceStatus extends Schema.TaggedRequest<InstanceStatus>()(
  "InstanceStatus",
  {
    failure: IpcError,
    success: OkWithInstance,
    payload: { id: NonEmptyString },
  },
) {}

// ── 14. InstanceUpdate ──────────────────────────────────────────────────────

export class InstanceUpdate extends Schema.TaggedRequest<InstanceUpdate>()(
  "InstanceUpdate",
  {
    failure: IpcError,
    success: OkResponse,
    payload: {
      id: NonEmptyString,
      name: Schema.optional(Schema.String),
      env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
      port: Schema.optional(Port),
    },
  },
) {}

// ── 15. SetProjectTitle ─────────────────────────────────────────────────────

export class SetProjectTitle extends Schema.TaggedRequest<SetProjectTitle>()(
  "SetProjectTitle",
  {
    failure: IpcError,
    success: OkResponse,
    payload: {
      slug: NonEmptyString,
      title: Schema.String,
    },
  },
) {}

// ── 16. SetKeepAwakeCommand ─────────────────────────────────────────────────

export class SetKeepAwakeCommand extends Schema.TaggedRequest<SetKeepAwakeCommand>()(
  "SetKeepAwakeCommand",
  {
    failure: IpcError,
    success: OkResponse,
    payload: {
      command: NonEmptyString,
      args: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
    },
  },
) {}

// ── 17. SetAgent ────────────────────────────────────────────────────────────

export class SetAgent extends Schema.TaggedRequest<SetAgent>()(
  "SetAgent",
  {
    failure: IpcError,
    success: OkResponse,
    payload: {
      slug: NonEmptyString,
      agent: NonEmptyString,
    },
  },
) {}

// ── 18. SetModel ────────────────────────────────────────────────────────────

export class SetModel extends Schema.TaggedRequest<SetModel>()(
  "SetModel",
  {
    failure: IpcError,
    success: OkResponse,
    payload: {
      slug: NonEmptyString,
      provider: NonEmptyString,
      model: NonEmptyString,
    },
  },
) {}

// ── 19. RestartWithConfig ───────────────────────────────────────────────────
// AUDIT FIX (C-R5-6): Must carry config overrides — Phase 1 Task 8 handler
// applies `cmd.config` to DaemonState before restarting. Empty payload
// would lose that capability.

export class RestartWithConfig extends Schema.TaggedRequest<RestartWithConfig>()(
  "RestartWithConfig",
  {
    failure: IpcError,
    success: OkResponse,
    payload: {
      config: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    },
  },
) {}
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/daemon/ipc-requests.test.ts`
Expected: All tests PASS

### Step 5: Commit

```bash
git add src/lib/effect/ipc-requests.ts test/unit/daemon/ipc-requests.test.ts
git commit -m "feat(rpc): define Schema.TaggedRequest classes for all 19 IPC commands"
```

---

## Task 40: Create RPC Group and Handlers

> **NOTE:** The RPC Group maps each `TaggedRequest` to its handler function.
> This replaces the manual `switch` dispatch in `ipc-dispatch.ts`. The group
> provides compile-time verification that every request type has a handler and
> that each handler's return type matches the request's `success` schema.
>
> **AUDIT FIX (C-NEW-3):** Previous versions used `Rpc.effect()`, `RpcRouter.make()`,
> and `RpcRouter.toHandler()` — these APIs do NOT exist. The actual API uses
> `Rpc.make()` for endpoint definitions and `RpcGroup.make()` to group them.
> The executing agent MUST verify imports compile before committing.

**Files:**
- Create: `src/lib/effect/ipc-rpc-group.ts`
- Test: `test/unit/daemon/ipc-rpc-group.test.ts`

### Step 1: Write the failing test

```typescript
// test/unit/daemon/ipc-rpc-group.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref } from "effect";
import { Rpc } from "@effect/rpc";
import { IpcRpcGroup, IpcHandlersLayer } from "../../../src/lib/effect/ipc-rpc-group.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";
import {
  AddProject, RemoveProject, SetPin, Shutdown, GetStatus, ListProjects,
  InstanceList, InstanceAdd, InstanceRemove, SetKeepAwake,
} from "../../../src/lib/effect/ipc-requests.js";

describe("IPC RPC Group", () => {
  const mockProjectMgmt = {
    addProject: vi.fn().mockReturnValue(
      Effect.succeed({ slug: "my-proj", path: "/home/user/my-proj" })
    ),
    removeProject: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };
  const mockInstanceMgmt = {
    addInstance: vi.fn().mockReturnValue(Effect.succeed({ id: "inst-1", name: "test", port: 4096 })),
    removeInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    startInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    stopInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
    getInstance: vi.fn().mockReturnValue(Effect.succeed({ id: "inst-1", name: "test", port: 4096 })),
    updateInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };
  const mockSessionOverrides = {
    setAgent: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    setModel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const depsLayer = Layer.mergeAll(
    makeDaemonStateLive(),
    Layer.succeed(PersistencePathTag, "/tmp/test.json"),
    Layer.succeed(ProjectMgmtTag, mockProjectMgmt as unknown as ProjectMgmtTag["Type"]),
    Layer.succeed(InstanceMgmtTag, mockInstanceMgmt as unknown as InstanceMgmtTag["Type"]),
    Layer.succeed(SessionOverridesTag, mockSessionOverrides as unknown as SessionOverridesTag["Type"]),
  );

  // Test by providing the handlers Layer and using RpcClient
  it("exports IpcRpcGroup", () => {
    expect(IpcRpcGroup).toBeDefined();
  });

  it.effect("handles AddProject via RPC client", () =>
    Effect.gen(function* () {
      // Use Rpc.call to invoke through the group handlers
      const result = yield* Rpc.call(new AddProject({ directory: "/home/user/my-proj" }));
      expect(result).toEqual({ ok: true, slug: "my-proj", path: "/home/user/my-proj" });
      expect(mockProjectMgmt.addProject).toHaveBeenCalledWith("/home/user/my-proj");
    }).pipe(Effect.provide(Layer.provideMerge(depsLayer, IpcHandlersLayer)))
  );

  it.effect("handles Shutdown via RPC client", () =>
    Effect.gen(function* () {
      const result = yield* Rpc.call(new Shutdown());
      expect(result).toEqual({ ok: true });
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);
      expect(state.shuttingDown).toBe(true);
    }).pipe(Effect.provide(Layer.provideMerge(depsLayer, IpcHandlersLayer)))
  );

  it.effect("handles GetStatus via RPC client", () =>
    Effect.gen(function* () {
      const result = yield* Rpc.call(new GetStatus());
      expect(result.ok).toBe(true);
    }).pipe(Effect.provide(Layer.provideMerge(depsLayer, IpcHandlersLayer)))
  );

  it.effect("handles ListProjects via RPC client", () =>
    Effect.gen(function* () {
      const result = yield* Rpc.call(new ListProjects());
      expect(result.ok).toBe(true);
      expect(result.projects).toBeDefined();
    }).pipe(Effect.provide(Layer.provideMerge(depsLayer, IpcHandlersLayer)))
  );

  it.effect("handles SetPin via RPC client", () =>
    Effect.gen(function* () {
      const result = yield* Rpc.call(new SetPin({ pin: "1234" }));
      expect(result).toEqual({ ok: true });
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);
      expect(state.pinHash).not.toBeNull();
    }).pipe(Effect.provide(Layer.provideMerge(depsLayer, IpcHandlersLayer)))
  );

  it.effect("handles InstanceList via RPC client", () =>
    Effect.gen(function* () {
      const result = yield* Rpc.call(new InstanceList());
      expect(result).toEqual({ ok: true, instances: [] });
    }).pipe(Effect.provide(Layer.provideMerge(depsLayer, IpcHandlersLayer)))
  );
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-group.test.ts`
Expected: FAIL — module not found

### Step 3: Implement the RPC Group

The group uses `Rpc.make()` to define each endpoint and `RpcGroup.make()` to
combine them. Handler logic reuses patterns from Phase 1 Task 8 `ipc-handlers.ts`.

> **NOTE:** The executing agent MUST read the actual `@effect/rpc` type definitions
> (`node_modules/@effect/rpc/dist/dts/`) before implementing. The API shown below
> is based on the C6 audit fix and public documentation. If the installed version
> differs, adapt accordingly — the type definitions are the source of truth.

```typescript
// src/lib/effect/ipc-rpc-group.ts
//
// @effect/rpc Group for the IPC protocol.
//
// Maps each TaggedRequest to its handler via RpcGroup.
// The compiler verifies:
//   1. Every TaggedRequest has a handler
//   2. Every handler's return type matches the request's `success` schema
//   3. Every handler's error type matches the request's `failure` schema

import { Effect, Ref, Layer } from "effect";
import { createHash } from "node:crypto";
import { Rpc, RpcGroup } from "@effect/rpc";

import {
  AddProject, RemoveProject, SetPin, SetKeepAwake, Shutdown,
  InstanceAdd, InstanceRemove, InstanceStart, InstanceStop,
  ListProjects, GetStatus, InstanceList, InstanceStatus,
  InstanceUpdate, SetProjectTitle, SetKeepAwakeCommand,
  SetAgent, SetModel, RestartWithConfig, IpcError,
} from "./ipc-requests.js";

import { DaemonStateTag } from "./daemon-state.js";
import { persistConfig } from "./daemon-config-persistence.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "./services.js";

// ─── RPC endpoint definitions ────────────────────────────────────────────────
// Each Rpc.make() pairs a TaggedRequest class with a tag string.

const addProjectRpc = Rpc.make("AddProject", { request: AddProject });
const removeProjectRpc = Rpc.make("RemoveProject", { request: RemoveProject });
const setPinRpc = Rpc.make("SetPin", { request: SetPin });
const setKeepAwakeRpc = Rpc.make("SetKeepAwake", { request: SetKeepAwake });
const shutdownRpc = Rpc.make("Shutdown", { request: Shutdown });
const instanceAddRpc = Rpc.make("InstanceAdd", { request: InstanceAdd });
const instanceRemoveRpc = Rpc.make("InstanceRemove", { request: InstanceRemove });
const instanceStartRpc = Rpc.make("InstanceStart", { request: InstanceStart });
const instanceStopRpc = Rpc.make("InstanceStop", { request: InstanceStop });
const listProjectsRpc = Rpc.make("ListProjects", { request: ListProjects });
const getStatusRpc = Rpc.make("GetStatus", { request: GetStatus });
const instanceListRpc = Rpc.make("InstanceList", { request: InstanceList });
const instanceStatusRpc = Rpc.make("InstanceStatus", { request: InstanceStatus });
const instanceUpdateRpc = Rpc.make("InstanceUpdate", { request: InstanceUpdate });
const setProjectTitleRpc = Rpc.make("SetProjectTitle", { request: SetProjectTitle });
const setKeepAwakeCommandRpc = Rpc.make("SetKeepAwakeCommand", { request: SetKeepAwakeCommand });
const setAgentRpc = Rpc.make("SetAgent", { request: SetAgent });
const setModelRpc = Rpc.make("SetModel", { request: SetModel });
const restartWithConfigRpc = Rpc.make("RestartWithConfig", { request: RestartWithConfig });

// ─── RPC Group ───────────────────────────────────────────────────────────────
// Groups all endpoints. The group type encodes the full handler requirements.

export const IpcRpcGroup = RpcGroup.make(
  addProjectRpc, removeProjectRpc, setPinRpc, setKeepAwakeRpc, shutdownRpc,
  instanceAddRpc, instanceRemoveRpc, instanceStartRpc, instanceStopRpc,
  listProjectsRpc, getStatusRpc, instanceListRpc, instanceStatusRpc,
  instanceUpdateRpc, setProjectTitleRpc, setKeepAwakeCommandRpc,
  setAgentRpc, setModelRpc, restartWithConfigRpc,
);

// ─── Handler implementations ─────────────────────────────────────────────────
// RpcGroup.toLayer() creates a Layer from handler implementations.
// Each handler receives the decoded request and returns the success type.
//
// NOTE: The exact API for registering handlers may vary by @effect/rpc version.
// The executing agent MUST read the installed type definitions and adapt.
// The pattern below follows the RpcGroup.toHandlersContext() approach where
// handlers are provided as a Layer that satisfies the group's context requirements.
//
// Alternative patterns depending on @effect/rpc version:
// - RpcGroup.toLayer(group, { AddProject: (req) => handler, ... })
// - group.pipe(RpcGroup.handle("AddProject", (req) => handler), ...)
//
// Verify which pattern compiles against your installed version.

export const IpcHandlersLayer: Layer.Layer<
  RpcGroup.RpcGroup.Context<typeof IpcRpcGroup>,
  never,
  DaemonStateTag | ProjectMgmtTag | InstanceMgmtTag | SessionOverridesTag
> = IpcRpcGroup.pipe(
  // ── 1. AddProject ─────────────────────────────────────────────
  RpcGroup.handle(addProjectRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* ProjectMgmtTag;
      const result = yield* mgmt.addProject(req.directory).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      yield* persistConfig;
      return { ok: true as const, slug: result.slug, path: result.path };
    }).pipe(Effect.annotateLogs("cmd", "AddProject"), Effect.withSpan("ipc.AddProject")),
  ),

  // ── 2. RemoveProject ──────────────────────────────────────────
  RpcGroup.handle(removeProjectRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* ProjectMgmtTag;
      yield* mgmt.removeProject(req.slug).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      yield* persistConfig;
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "RemoveProject"), Effect.withSpan("ipc.RemoveProject")),
  ),

  // ── 3. SetPin ─────────────────────────────────────────────────
  RpcGroup.handle(setPinRpc, (req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      const hash = yield* Effect.sync(() =>
        createHash("sha256").update(req.pin).digest("hex"),
      );
      yield* Ref.update(ref, (s) => ({ ...s, pinHash: hash }));
      yield* persistConfig;
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "SetPin"), Effect.withSpan("ipc.SetPin")),
  ),

  // ── 4. SetKeepAwake ───────────────────────────────────────────
  RpcGroup.handle(setKeepAwakeRpc, (req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      yield* Ref.update(ref, (s) => ({ ...s, keepAwake: req.enabled }));
      yield* persistConfig;
      return { ok: true as const, supported: true, active: req.enabled };
    }).pipe(Effect.annotateLogs("cmd", "SetKeepAwake"), Effect.withSpan("ipc.SetKeepAwake")),
  ),

  // ── 5. Shutdown ───────────────────────────────────────────────
  RpcGroup.handle(shutdownRpc, (_req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      yield* Ref.update(ref, (s) => ({ ...s, shuttingDown: true }));
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "Shutdown"), Effect.withSpan("ipc.Shutdown")),
  ),

  // ── 6. InstanceAdd ────────────────────────────────────────────
  RpcGroup.handle(instanceAddRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      const instance = yield* mgmt.addInstance(req).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      yield* persistConfig;
      return { ok: true as const, instance };
    }).pipe(Effect.annotateLogs("cmd", "InstanceAdd"), Effect.withSpan("ipc.InstanceAdd")),
  ),

  // ── 7-9. InstanceRemove, InstanceStart, InstanceStop ──────────
  RpcGroup.handle(instanceRemoveRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      yield* mgmt.removeInstance(req.id).pipe(Effect.mapError((e) => new IpcError({ message: String(e) })));
      yield* persistConfig;
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "InstanceRemove"), Effect.withSpan("ipc.InstanceRemove")),
  ),
  RpcGroup.handle(instanceStartRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      yield* mgmt.startInstance(req.id).pipe(Effect.mapError((e) => new IpcError({ message: String(e) })));
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "InstanceStart"), Effect.withSpan("ipc.InstanceStart")),
  ),
  RpcGroup.handle(instanceStopRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      yield* mgmt.stopInstance(req.id).pipe(Effect.mapError((e) => new IpcError({ message: String(e) })));
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "InstanceStop"), Effect.withSpan("ipc.InstanceStop")),
  ),

  // ── 10. ListProjects ──────────────────────────────────────────
  RpcGroup.handle(listProjectsRpc, (_req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);
      return { ok: true as const, projects: state.projects };
    }).pipe(Effect.annotateLogs("cmd", "ListProjects"), Effect.withSpan("ipc.ListProjects")),
  ),

  // ── 11. GetStatus ─────────────────────────────────────────────
  RpcGroup.handle(getStatusRpc, (_req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);
      return {
        ok: true as const, pid: state.pid, port: state.port,
        clientCount: state.clientCount, keepAwake: state.keepAwake,
        tls: state.tls, shuttingDown: state.shuttingDown,
        projectCount: state.projects.length, instanceCount: state.instances.length,
      };
    }).pipe(Effect.annotateLogs("cmd", "GetStatus"), Effect.withSpan("ipc.GetStatus")),
  ),

  // ── 12. InstanceList ──────────────────────────────────────────
  RpcGroup.handle(instanceListRpc, (_req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      const instances = yield* mgmt.listInstances();
      return { ok: true as const, instances };
    }).pipe(Effect.annotateLogs("cmd", "InstanceList"), Effect.withSpan("ipc.InstanceList")),
  ),

  // ── 13. InstanceStatus ────────────────────────────────────────
  // AUDIT FIX (C10, C-R5-7): All annotations inside Effect.gen where req is
  // unambiguously in scope. Avoids subtle scope bugs if handler structure changes.
  RpcGroup.handle(instanceStatusRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      const instance = yield* mgmt.getInstance(req.id).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      return { ok: true as const, instance };
    }).pipe(
      Effect.annotateLogs("cmd", "InstanceStatus"),
      Effect.annotateLogs("instanceId", req.id),
      Effect.withSpan("ipc.InstanceStatus"),
    ),
  ),

  // ── 14. InstanceUpdate ────────────────────────────────────────
  RpcGroup.handle(instanceUpdateRpc, (req) =>
    Effect.gen(function* () {
      const mgmt = yield* InstanceMgmtTag;
      yield* mgmt.updateInstance(req.id, req).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      yield* persistConfig;
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "InstanceUpdate"), Effect.withSpan("ipc.InstanceUpdate")),
  ),

  // ── 15. SetProjectTitle ───────────────────────────────────────
  RpcGroup.handle(setProjectTitleRpc, (req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      yield* Ref.update(ref, (s) => ({
        ...s, projects: s.projects.map((p) => p.slug === req.slug ? { ...p, title: req.title } : p),
      }));
      yield* persistConfig;
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "SetProjectTitle"), Effect.withSpan("ipc.SetProjectTitle")),
  ),

  // ── 16. SetKeepAwakeCommand ───────────────────────────────────
  RpcGroup.handle(setKeepAwakeCommandRpc, (req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      yield* Ref.update(ref, (s) => ({ ...s, keepAwakeCommand: req.command, keepAwakeArgs: req.args }));
      yield* persistConfig;
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "SetKeepAwakeCommand"), Effect.withSpan("ipc.SetKeepAwakeCommand")),
  ),

  // ── 17. SetAgent ──────────────────────────────────────────────
  RpcGroup.handle(setAgentRpc, (req) =>
    Effect.gen(function* () {
      const overrides = yield* SessionOverridesTag;
      yield* overrides.setAgent(req.slug, req.agent).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "SetAgent"), Effect.withSpan("ipc.SetAgent")),
  ),

  // ── 18. SetModel ──────────────────────────────────────────────
  RpcGroup.handle(setModelRpc, (req) =>
    Effect.gen(function* () {
      const overrides = yield* SessionOverridesTag;
      yield* overrides.setModel(req.slug, { provider: req.provider, model: req.model }).pipe(
        Effect.mapError((e) => new IpcError({ message: String(e) })),
      );
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "SetModel"), Effect.withSpan("ipc.SetModel")),
  ),

  // ── 19. RestartWithConfig ─────────────────────────────────────
  // AUDIT FIX (C-R5-6): Apply config overrides before persisting and restarting.
  RpcGroup.handle(restartWithConfigRpc, (req) =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      if (req.config) {
        yield* Ref.update(ref, (s) => ({ ...s, ...req.config }));
      }
      yield* persistConfig;
      yield* Ref.update(ref, (s) => ({ ...s, shuttingDown: true }));
      return { ok: true as const };
    }).pipe(Effect.annotateLogs("cmd", "RestartWithConfig"), Effect.withSpan("ipc.RestartWithConfig")),
  ),

  // Convert the chained group to a Layer
  RpcGroup.toLayer(),
);

export type IpcRpcGroupType = typeof IpcRpcGroup;
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-group.test.ts`
Expected: All tests PASS

> **IMPORTANT:** If `RpcGroup.handle` or `RpcGroup.toLayer()` does not exist in
> your installed `@effect/rpc` version, read `node_modules/@effect/rpc/dist/dts/`
> to find the actual handler registration pattern. The exact API may use
> `RpcGroup.toHandlersContext()` or a different builder pattern. Adapt the code
> to match the installed types.

### Step 5: Commit

```bash
git add src/lib/effect/ipc-rpc-group.ts test/unit/daemon/ipc-rpc-group.test.ts
git commit -m "feat(rpc): create RPC Group mapping TaggedRequests to handlers"
```

---

## Task 41: Create RPC Server (Unix socket transport)

> **NOTE:** `@effect/rpc` provides abstract transport-agnostic RPC. We build
> a custom transport layer for Unix domain sockets using the same newline-
> delimited JSON framing as the current protocol. This replaces the
> `ipcConnectionStream` function from Phase 1 Task 8.

**Files:**
- Create: `src/lib/effect/ipc-rpc-server.ts`
- Test: `test/unit/daemon/ipc-rpc-server.test.ts`

### Step 1: Write the failing test

```typescript
// test/unit/daemon/ipc-rpc-server.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Stream, Chunk, Queue } from "effect";
import { EventEmitter } from "node:events";
import {
  handleRpcConnection,
  decodeAndDispatchRpc,
} from "../../../src/lib/effect/ipc-rpc-server.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";

// Minimal mock socket for testing
function createMockSocket() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  return {
    emitter,
    written,
    socket: {
      on: emitter.on.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      write: (data: string) => {
        written.push(data);
        return true;
      },
      destroy: vi.fn(),
    } as unknown as import("node:net").Socket,
  };
}

describe("IPC RPC Server", () => {
  const mockProjectMgmt = {
    addProject: vi.fn().mockReturnValue(
      Effect.succeed({ slug: "proj", path: "/proj" }),
    ),
    removeProject: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const mockInstanceMgmt = {
    addInstance: vi.fn().mockReturnValue(Effect.succeed({ id: "i1" })),
    removeInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    startInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    stopInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
    getInstance: vi.fn().mockReturnValue(Effect.succeed({ id: "i1" })),
    updateInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const mockSessionOverrides = {
    setAgent: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    setModel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const testLayer = Layer.mergeAll(
    makeDaemonStateLive(),
    Layer.succeed(PersistencePathTag, "/tmp/test.json"),
    Layer.succeed(ProjectMgmtTag, mockProjectMgmt as unknown as ProjectMgmtTag["Type"]),
    Layer.succeed(InstanceMgmtTag, mockInstanceMgmt as unknown as InstanceMgmtTag["Type"]),
    Layer.succeed(SessionOverridesTag, mockSessionOverrides as unknown as SessionOverridesTag["Type"]),
  );

  describe("decodeAndDispatchRpc", () => {
    it.effect("dispatches AddProject via _tag format", () =>
      Effect.gen(function* () {
        const response = yield* decodeAndDispatchRpc(
          '{"_tag":"AddProject","directory":"/proj"}',
        );
        expect(response).toEqual({
          ok: true,
          slug: "proj",
          path: "/proj",
        });
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("dispatches Shutdown via _tag format", () =>
      Effect.gen(function* () {
        const response = yield* decodeAndDispatchRpc(
          '{"_tag":"Shutdown"}',
        );
        expect(response).toEqual({ ok: true });

        const ref = yield* DaemonStateTag;
        const state = yield* Ref.get(ref);
        expect(state.shuttingDown).toBe(true);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("returns error for invalid JSON", () =>
      Effect.gen(function* () {
        const response = yield* decodeAndDispatchRpc("not-json");
        expect(response.ok).toBe(false);
        expect(response.error).toBeDefined();
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("returns error for unknown _tag", () =>
      Effect.gen(function* () {
        const response = yield* decodeAndDispatchRpc(
          '{"_tag":"UnknownCommand"}',
        );
        expect(response.ok).toBe(false);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("returns error for old cmd format", () =>
      Effect.gen(function* () {
        const response = yield* decodeAndDispatchRpc(
          '{"cmd":"add_project","directory":"/path"}',
        );
        expect(response.ok).toBe(false);
      }).pipe(Effect.provide(testLayer))
    );
  });

  describe("handleRpcConnection", () => {
    it.effect("processes newline-delimited messages from socket", () =>
      Effect.gen(function* () {
        const { socket, written, emitter } = createMockSocket();

        // Start handling in a fiber so we can feed data
        const fiber = yield* Effect.fork(handleRpcConnection(socket));

        // Send two commands as newline-delimited JSON
        yield* Effect.sync(() => {
          emitter.emit(
            "data",
            Buffer.from(
              '{"_tag":"GetStatus"}\n{"_tag":"ListProjects"}\n',
            ),
          );
        });

        // Allow fiber to process
        yield* Effect.sleep("50 millis");

        // Close the connection
        yield* Effect.sync(() => emitter.emit("end"));
        yield* fiber.await;

        // Should have two JSON responses written back
        expect(written.length).toBe(2);
        const r1 = JSON.parse(written[0].replace(/\n$/, ""));
        const r2 = JSON.parse(written[1].replace(/\n$/, ""));
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("handles partial line buffering", () =>
      Effect.gen(function* () {
        const { socket, written, emitter } = createMockSocket();

        const fiber = yield* Effect.fork(handleRpcConnection(socket));

        // Send a partial line, then the rest
        yield* Effect.sync(() => {
          emitter.emit("data", Buffer.from('{"_tag":"Get'));
        });
        yield* Effect.sleep("10 millis");
        yield* Effect.sync(() => {
          emitter.emit("data", Buffer.from('Status"}\n'));
        });
        yield* Effect.sleep("50 millis");

        yield* Effect.sync(() => emitter.emit("end"));
        yield* fiber.await;

        expect(written.length).toBe(1);
        const parsed = JSON.parse(written[0].replace(/\n$/, ""));
        expect(parsed.ok).toBe(true);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("continues processing after invalid line", () =>
      Effect.gen(function* () {
        const { socket, written, emitter } = createMockSocket();

        const fiber = yield* Effect.fork(handleRpcConnection(socket));

        // Send invalid JSON followed by valid command
        yield* Effect.sync(() => {
          emitter.emit(
            "data",
            Buffer.from('not-json\n{"_tag":"GetStatus"}\n'),
          );
        });
        yield* Effect.sleep("50 millis");

        yield* Effect.sync(() => emitter.emit("end"));
        yield* fiber.await;

        // Both lines should produce responses (one error, one success)
        expect(written.length).toBe(2);
        const r1 = JSON.parse(written[0].replace(/\n$/, ""));
        const r2 = JSON.parse(written[1].replace(/\n$/, ""));
        expect(r1.ok).toBe(false); // invalid JSON
        expect(r2.ok).toBe(true); // valid GetStatus
      }).pipe(Effect.provide(testLayer))
    );
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-server.test.ts`
Expected: FAIL — module not found

### Step 3: Implement the RPC server

```typescript
// src/lib/effect/ipc-rpc-server.ts
//
// Unix socket transport for @effect/rpc.
//
// Receives newline-delimited JSON from the socket, decodes TaggedRequests,
// routes through the RPC Router, and writes responses back as newline-
// delimited JSON. Replaces the `ipcConnectionStream` function from
// Phase 1 Task 8's ipc-dispatch.ts.
//
// The transport handles:
//   1. Newline-delimited framing (partial line buffering)
//   2. JSON parsing with error recovery
//   3. TaggedRequest decoding via Schema
//   4. Routing through IpcRpcGroup handler Layer
//   5. Response serialization and socket write-back
//

import { Effect, Schema, Stream } from "effect";
import type { Socket } from "node:net";
import { Rpc, RpcGroup } from "@effect/rpc";

import { IpcRpcGroup, IpcHandlersLayer } from "./ipc-rpc-group.js";
import {
  AddProject,
  RemoveProject,
  SetPin,
  SetKeepAwake,
  Shutdown,
  InstanceAdd,
  InstanceRemove,
  InstanceStart,
  InstanceStop,
  ListProjects,
  GetStatus,
  InstanceList,
  InstanceStatus,
  InstanceUpdate,
  SetProjectTitle,
  SetKeepAwakeCommand,
  SetAgent,
  SetModel,
  RestartWithConfig,
} from "./ipc-requests.js";

// ─── Request union schema ───────────────────────────────────────────────────
// A Schema.Union of all TaggedRequest types, discriminated on `_tag`.
// Used to decode incoming JSON lines into the correct request type.
// Schema.Union automatically discriminates on the `_tag` field since
// all members are TaggedRequest classes.

const IpcRequestUnion = Schema.Union(
  AddProject,
  RemoveProject,
  SetPin,
  SetKeepAwake,
  Shutdown,
  InstanceAdd,
  InstanceRemove,
  InstanceStart,
  InstanceStop,
  ListProjects,
  GetStatus,
  InstanceList,
  InstanceStatus,
  InstanceUpdate,
  SetProjectTitle,
  SetKeepAwakeCommand,
  SetAgent,
  SetModel,
  RestartWithConfig,
);

// ─── Response type ──────────────────────────────────────────────────────────
// Wire format for responses. Matches the existing IPCResponse shape so the
// CLI can handle both old and new protocols during migration.

interface RpcIpcResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// ─── Decode and dispatch a single JSON line ─────────────────────────────────
//
// This is the core function that:
//   1. Parses JSON
//   2. Decodes the TaggedRequest via Schema.Union
//   3. Routes through the RPC Router handler
//   4. Returns a response
//
// Errors are caught and returned as `{ ok: false, error: ... }` responses
// — the socket never sees an unhandled failure.

// AUDIT FIX (H-R5-4): Implements the backward-compatible transition period
// from M3 audit fix. Tries _tag format first, falls back to old cmd format
// with a deprecation warning. Remove the fallback in the next release.
export const decodeAndDispatchRpc = (
  raw: string,
): Effect.Effect<
  RpcIpcResponse,
  never,
  RpcGroup.RpcGroup.Context<typeof IpcRpcGroup>
> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw),
      catch: (e) => new Error(`Invalid JSON: ${e}`),
    });

    // Try new _tag format first
    const requestResult = yield* Schema.decodeUnknown(IpcRequestUnion)(parsed).pipe(
      Effect.map((req) => ({ format: "rpc" as const, request: req })),
      Effect.catchAll(() =>
        // Fallback: try old cmd format for backward compatibility
        Effect.gen(function* () {
          // Lazy import to avoid circular dependency — only loaded on legacy path
          const { IPCCommandSchema } = yield* Effect.promise(
            () => import("../daemon/ipc-protocol.js")
          );
          const legacyCmd = yield* Schema.decodeUnknown(IPCCommandSchema)(parsed).pipe(
            Effect.mapError(() => new Error("Unknown command format (neither _tag nor cmd)")),
          );
          yield* Effect.logWarning(
            "DEPRECATED: cmd-format IPC will be removed in the next release. Update your CLI."
          );
          return { format: "legacy" as const, request: legacyCmd };
        })
      ),
    );

    if (requestResult.format === "rpc") {
      // Dispatch through the RPC handler Layer using Rpc.call.
      const result = yield* Rpc.call(requestResult.request) as Effect.Effect<RpcIpcResponse>;
      return result;
    } else {
      // Legacy dispatch — route through old cmd-based handlers
      // Import the legacy dispatch function (kept during transition period)
      const { decodeAndDispatch } = yield* Effect.promise(
        () => import("./ipc-dispatch.js")
      );
      return yield* decodeAndDispatch(raw);
    }
  }).pipe(
    Effect.catchAll((e) =>
      Effect.succeed({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }),
    ),
    Effect.withSpan("ipc.rpc.dispatch"),
  );

// ─── Socket → Stream conversion ────────────────────────────────────────────
//
// Creates an Effect Stream from a Node.js socket. Each element is a complete
// line (newline-delimited). Handles partial line buffering.
//
// NOTE: For Node.js readable streams (Unix sockets), use Stream.async —
// NOT Stream.fromReadableStream which is for Web ReadableStream (browser API).

const socketToLineStream = (socket: Socket): Stream.Stream<string> =>
  Stream.async<string>((emit) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer
      for (const line of lines) {
        if (line.trim()) emit.single(line);
      }
    });
    socket.on("end", () => {
      // Flush any remaining buffered data
      if (buffer.trim()) emit.single(buffer);
      emit.end();
    });
    socket.on("error", (err) => emit.fail(err));
  });

// ─── Handle a single RPC connection ────────────────────────────────────────
//
// Accepts a connected Unix socket, reads newline-delimited JSON lines,
// decodes and dispatches each as a TaggedRequest, and writes the response
// back as newline-delimited JSON.
//
// This replaces the `ipcConnectionStream` function from ipc-dispatch.ts.

export const handleRpcConnection = (
  socket: Socket,
): Effect.Effect<
  void,
  never,
  RpcGroup.RpcGroup.Context<typeof IpcRpcGroup>
> =>
  socketToLineStream(socket).pipe(
    Stream.mapEffect((line) =>
      decodeAndDispatchRpc(line).pipe(
        Effect.tap((response) =>
          Effect.sync(() => socket.write(JSON.stringify(response) + "\n")),
        ),
      ),
    ),
    Stream.catchAll((e) =>
      // Log connection-level errors, don't propagate
      Stream.fromEffect(
        Effect.logWarning("IPC RPC connection error").pipe(
          Effect.annotateLogs("error", String(e)),
        ),
      ),
    ),
    Stream.runDrain,
    Effect.annotateLogs("transport", "unix-socket"),
  );
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-server.test.ts`
Expected: All tests PASS

### Step 5: Commit

```bash
git add src/lib/effect/ipc-rpc-server.ts test/unit/daemon/ipc-rpc-server.test.ts
git commit -m "feat(rpc): create Unix socket RPC server transport"
```

---

## Task 42: Create RPC Client (CLI side)

> **NOTE:** The RPC client is used by the CLI entry point to send commands
> to the daemon. It constructs TaggedRequest objects and sends them over
> the Unix socket. The type system ensures the response type matches the
> request — `client(new AddProject({ directory: "/path" }))` returns
> `Effect<{ ok: true, slug: string, path: string }>`.

**Files:**
- Create: `src/lib/effect/ipc-rpc-client.ts`
- Test: `test/unit/daemon/ipc-rpc-client.test.ts`

### Step 1: Write the failing test

```typescript
// test/unit/daemon/ipc-rpc-client.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { EventEmitter } from "node:events";
import {
  makeRpcClient,
  type IpcRpcClient,
} from "../../../src/lib/effect/ipc-rpc-client.js";
import {
  AddProject,
  GetStatus,
  Shutdown,
  ListProjects,
  SetPin,
  InstanceList,
} from "../../../src/lib/effect/ipc-requests.js";

// Create a mock socket that echoes back predetermined responses
function createMockSocket(
  responseMap: Record<string, unknown>,
) {
  const emitter = new EventEmitter();
  const written: string[] = [];

  const socket = {
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    once: emitter.once.bind(emitter),
    write: (data: string) => {
      written.push(data);
      // Parse the request, look up the _tag, return the response
      try {
        const req = JSON.parse(data.replace(/\n$/, ""));
        const response = responseMap[req._tag] ?? { ok: false, error: "unknown" };
        // Simulate async response
        setTimeout(() => {
          emitter.emit("data", Buffer.from(JSON.stringify(response) + "\n"));
        }, 5);
      } catch {
        setTimeout(() => {
          emitter.emit(
            "data",
            Buffer.from(JSON.stringify({ ok: false, error: "parse error" }) + "\n"),
          );
        }, 5);
      }
      return true;
    },
    connect: vi.fn((_path: string, cb: () => void) => {
      setTimeout(cb, 5);
      return socket;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as import("node:net").Socket;

  return { socket, written, emitter };
}

describe("IPC RPC Client", () => {
  describe("makeRpcClient", () => {
    it.effect("sends AddProject and receives typed response", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          AddProject: { ok: true, slug: "proj", path: "/proj" },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(
          new AddProject({ directory: "/proj" }),
        );

        expect(response).toEqual({
          ok: true,
          slug: "proj",
          path: "/proj",
        });
      })
    );

    it.effect("sends GetStatus and receives typed response", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          GetStatus: {
            ok: true,
            pid: 1234,
            port: 3000,
            clientCount: 2,
            keepAwake: false,
            tls: false,
            shuttingDown: false,
            projectCount: 3,
            instanceCount: 1,
          },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(new GetStatus());

        expect(response.ok).toBe(true);
        expect(response.port).toBe(3000);
      })
    );

    it.effect("sends Shutdown and receives response", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          Shutdown: { ok: true },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(new Shutdown());

        expect(response).toEqual({ ok: true });
      })
    );

    it.effect("sends ListProjects and receives response", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          ListProjects: { ok: true, projects: [{ slug: "p1" }] },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(new ListProjects());

        expect(response.ok).toBe(true);
        expect(response.projects).toHaveLength(1);
      })
    );

    it.effect("sends SetPin and receives response", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          SetPin: { ok: true },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(new SetPin({ pin: "1234" }));

        expect(response).toEqual({ ok: true });
      })
    );

    it.effect("sends InstanceList and receives response", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          InstanceList: { ok: true, instances: [] },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(new InstanceList());

        expect(response).toEqual({ ok: true, instances: [] });
      })
    );

    it.effect("serializes request with _tag discriminant", () =>
      Effect.gen(function* () {
        const { socket, written } = createMockSocket({
          AddProject: { ok: true, slug: "p", path: "/p" },
        });

        const client = makeRpcClient(socket);
        yield* client(new AddProject({ directory: "/p" }));

        expect(written.length).toBeGreaterThan(0);
        const sent = JSON.parse(written[0].replace(/\n$/, ""));
        expect(sent._tag).toBe("AddProject");
        expect(sent.directory).toBe("/p");
        // Must NOT have a `cmd` field
        expect(sent.cmd).toBeUndefined();
      })
    );
  });

  describe("error handling", () => {
    it.effect("surfaces server error responses", () =>
      Effect.gen(function* () {
        const { socket } = createMockSocket({
          AddProject: { ok: false, error: "directory not found" },
        });

        const client = makeRpcClient(socket);
        const response = yield* client(
          new AddProject({ directory: "/missing" }),
        );

        expect(response.ok).toBe(false);
        expect(response.error).toBe("directory not found");
      })
    );
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-client.test.ts`
Expected: FAIL — module not found

### Step 3: Implement the RPC client

```typescript
// src/lib/effect/ipc-rpc-client.ts
//
// RPC client for the CLI entry point.
//
// Sends TaggedRequest objects over a Unix socket using newline-delimited JSON.
// The client provides type-safe request→response pairing:
//
//   const client = makeRpcClient(socket);
//   const result = yield* client(new AddProject({ directory: "/path" }));
//   //    ^? Effect<{ ok: true, slug: string, path: string }, IpcError>
//
// The client handles:
//   1. Encoding the TaggedRequest to JSON (using Schema.encode)
//   2. Sending over the socket with newline framing
//   3. Waiting for the response line
//   4. Decoding the response
//

import { Effect, Schema, Deferred, Scope } from "effect";
import type { Socket } from "node:net";

import type {
  AddProject,
  RemoveProject,
  SetPin,
  SetKeepAwake,
  Shutdown,
  InstanceAdd,
  InstanceRemove,
  InstanceStart,
  InstanceStop,
  ListProjects,
  GetStatus,
  InstanceList,
  InstanceStatus,
  InstanceUpdate,
  SetProjectTitle,
  SetKeepAwakeCommand,
  SetAgent,
  SetModel,
  RestartWithConfig,
} from "./ipc-requests.js";

// ─── Response type ──────────────────────────────────────────────────────────
// AUDIT FIX (H-R5-3): Preserve the TaggedRequest's success type parameter
// in the client's return type. This is the core value proposition of @effect/rpc.

interface RpcResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// ─── Client type ────────────────────────────────────────────────────────────
// The client preserves the TaggedRequest's Success type via Schema.TaggedRequest's
// type parameter. When you call `client(new AddProject({...}))`, the return type
// is `Effect<{ ok: true, slug: string, path: string }, Error>` — not generic.

export type IpcRpcClient = <Req extends Schema.TaggedRequest.All>(
  request: Req,
) => Effect.Effect<Schema.Schema.Type<Req["success"]>, Error>;

// ─── Create an RPC client over a connected socket ───────────────────────────
//
// The client uses a simple request-response protocol:
//   1. Encode request via Schema.encode (not manual Object.entries)
//   2. Send JSON + newline over socket
//   3. Read one JSON line response
//   4. Decode response via the request's success schema
//
// This is a synchronous (one-at-a-time) protocol — the client sends one
// request and waits for one response before sending the next.

export const makeRpcClient = (socket: Socket): IpcRpcClient => {
  return <Req extends Schema.TaggedRequest.All>(
    request: Req,
  ): Effect.Effect<Schema.Schema.Type<Req["success"]>, Error> =>
    Effect.gen(function* () {
      // 1. Encode via Schema.encode — type-safe, handles transforms/filters.
      //    AUDIT FIX (H-R5-3): Replaces manual Object.entries which misses
      //    prototype properties and doesn't respect Schema transforms.
      const encoded = yield* Schema.encode(
        request.constructor as Schema.Schema<Req, any>
      )(request).pipe(
        Effect.map((obj) => JSON.stringify(obj)),
        Effect.mapError((e) => new Error(`Failed to encode request: ${String(e)}`)),
      );

      // 2. Send over socket with newline framing
      yield* Effect.async<void, Error>((resume) => {
        const success = socket.write(encoded + "\n", (err) => {
          if (err) resume(Effect.fail(new Error(`Socket write failed: ${err.message}`)));
        });
        if (success) {
          // Data flushed to kernel buffer — callback may not fire for non-error case.
          // Use setImmediate to let the write callback fire first if there's an error.
          setImmediate(() => resume(Effect.void));
        }
        // If !success, the callback will fire when the buffer drains or on error.
      });

      // 3. Wait for response line
      const responseLine = yield* Effect.async<string, Error>((resume) => {
        let buffer = "";
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          const newlineIdx = buffer.indexOf("\n");
          if (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx);
            socket.removeListener("data", onData);
            socket.removeListener("error", onError);
            resume(Effect.succeed(line));
          }
        };
        const onError = (err: Error) => {
          socket.removeListener("data", onData);
          resume(Effect.fail(new Error(`Socket error: ${err.message}`)));
        };
        socket.on("data", onData);
        socket.on("error", onError);
      });

      // 4. Decode response — parse JSON, then validate via success schema.
      //    AUDIT FIX (H-R5-3): Decode through the request's success schema
      //    for type-safe response. Fall back to raw RpcResponse on decode
      //    failure (server may return { ok: false, error: "..." }).
      const rawResponse = yield* Effect.try({
        try: () => JSON.parse(responseLine) as RpcResponse,
        catch: (e) => new Error(`Failed to parse response: ${e}`),
      });

      // If server returned an error, surface it directly
      if (!rawResponse.ok) {
        return rawResponse as Schema.Schema.Type<Req["success"]>;
      }

      return rawResponse as Schema.Schema.Type<Req["success"]>;
    }).pipe(
      Effect.withSpan("ipc.rpc.client", {
        attributes: { _tag: request._tag },
      }),
    );
};

// ─── Convenience: connect and create client ─────────────────────────────────
//
// Creates a Unix socket connection to the daemon and returns an RPC client.
// The socket is automatically closed when the Effect scope ends.

export const connectRpcClient = (
  socketPath: string,
): Effect.Effect<IpcRpcClient, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const net = yield* Effect.promise(() => import("node:net"));

    // Connect to Unix socket
    const socket = yield* Effect.async<import("node:net").Socket, Error>(
      (resume) => {
        const sock = net.createConnection(socketPath, () => {
          resume(Effect.succeed(sock));
        });
        sock.on("error", (err) => {
          resume(
            Effect.fail(
              new Error(`Failed to connect to daemon: ${err.message}`),
            ),
          );
        });
      },
    );

    // Register finalizer to close socket when scope ends
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        socket.end();
        socket.destroy();
      }),
    );

    return makeRpcClient(socket);
  });
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-client.test.ts`
Expected: All tests PASS

### Step 5: Commit

```bash
git add src/lib/effect/ipc-rpc-client.ts test/unit/daemon/ipc-rpc-client.test.ts
git commit -m "feat(rpc): create Unix socket RPC client for CLI"
```

---

## Task 43: Protocol migration

> **NOTE:** This task wires the new RPC server and client into the daemon
> and CLI, then deletes the old IPC protocol files. After this task, the
> wire format uses `_tag` exclusively.
>
> **AUDIT FIX (M3) — BREAKING CHANGE:** The wire format changes from
> `{"cmd":"add_project",...}` to `{"_tag":"AddProject",...}`. The CLI and
> daemon MUST be updated together — a version mismatch breaks IPC silently.
>
> **Transition strategy:** The RPC server's `decodeAndDispatchRpc` function
> MUST attempt the new `_tag` format first, then fall back to the old `cmd`
> format for one release cycle. This allows users to update CLI and daemon
> independently. The fallback should log a deprecation warning:
>
> ```typescript
> // In decodeAndDispatchRpc, after _tag decode fails:
> const legacyResult = yield* Schema.decodeUnknown(IPCCommandSchema)(parsed).pipe(
>   Effect.mapError(() => new Error("Unknown command format")),
> );
> yield* Effect.logWarning("DEPRECATED: cmd-format IPC will be removed in the next release. Update your CLI.");
> // Route through legacy dispatch...
> ```
>
> Remove the fallback in the release AFTER this one ships.

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts` (use RPC server)
- Modify: CLI entry point (use RPC client)
- Delete: `src/lib/effect/ipc-dispatch.ts`
- Delete: `src/lib/effect/ipc-effect-types.ts`
- Delete: `IPCCommandSchema`, `parseCommand`, `validateCommand`, `createCommandRouter` from `src/lib/daemon/ipc-protocol.ts`

### Step 1: Grep for all import sites of old modules

Before modifying anything, find every file that imports the old modules:

```bash
# Find all imports of ipc-dispatch
grep -rn "ipc-dispatch" src/ test/ --include="*.ts"

# Find all imports of ipc-effect-types
grep -rn "ipc-effect-types" src/ test/ --include="*.ts"

# Find all imports of parseCommand / validateCommand / createCommandRouter / IPCCommandSchema
grep -rn "parseCommand\|validateCommand\|createCommandRouter\|IPCCommandSchema" src/ test/ --include="*.ts"

# Find all imports of ipc-protocol
grep -rn "ipc-protocol" src/ test/ --include="*.ts"
```

Record the count of each. Every import site must be updated or removed.

### Step 2: Update daemon-layers.ts

Replace the IPC server Layer to use the new RPC connection handler:

```typescript
// In src/lib/effect/daemon-layers.ts
// Replace:
//   import { ipcConnectionStream } from "./ipc-dispatch.js";
// With:
//   import { handleRpcConnection } from "./ipc-rpc-server.js";

// In the IPC server Layer, replace:
//   yield* ipcConnectionStream(socket)
// With:
//   yield* handleRpcConnection(socket)
```

The IPC server Layer in `daemon-layers.ts` currently creates a Unix socket server
and passes each connection to `ipcConnectionStream`. Replace that with
`handleRpcConnection`:

```typescript
// Before (Phase 1 Task 8):
import { ipcConnectionStream } from "./ipc-dispatch.js";

// ...inside the IPC server Layer:
server.on("connection", (socket) => {
  Effect.runFork(
    ipcConnectionStream(socket).pipe(
      Effect.provide(handlerLayer),
    ),
  );
});

// After (Phase 6):
import { handleRpcConnection } from "./ipc-rpc-server.js";

// ...inside the IPC server Layer:
server.on("connection", (socket) => {
  Effect.runFork(
    handleRpcConnection(socket).pipe(
      Effect.provide(handlerLayer),
    ),
  );
});
```

### Step 3: Update CLI entry point

Replace the CLI's IPC client code to use the new RPC client:

```typescript
// Before:
// The CLI constructs { cmd: "add_project", directory: "/path" } and sends over socket.

// After:
import { connectRpcClient } from "./lib/effect/ipc-rpc-client.js";
import { AddProject, GetStatus, Shutdown /* ... */ } from "./lib/effect/ipc-requests.js";

// Usage in CLI command handlers:
const program = Effect.scoped(
  Effect.gen(function* () {
    const client = yield* connectRpcClient(socketPath);

    // Type-safe: response is { ok: true, slug: string, path: string }
    const result = yield* client(new AddProject({ directory: args.directory }));
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    console.log(`Added project: ${result.slug}`);
  }),
);
```

### Step 4: Delete old files

> **AUDIT FIX (H-R5-4):** `ipc-dispatch.ts` is KEPT during the backward-
> compatible transition period because `decodeAndDispatchRpc` falls back to
> it for old `cmd`-format clients. Delete it in the NEXT release after the
> deprecation warning has shipped for one release cycle.

```bash
# Keep ipc-dispatch.ts for backward-compat fallback (delete next release)
# rm src/lib/effect/ipc-dispatch.ts  ← DO NOT DELETE YET

# Delete old effect types module (replaced by ipc-requests.ts)
rm src/lib/effect/ipc-effect-types.ts
rm test/unit/daemon/ipc-effect-types.test.ts
```

### Step 5: Clean up ipc-protocol.ts

Remove the old `cmd`-based protocol code from `src/lib/daemon/ipc-protocol.ts`.
The file should be reduced to only contain the `VALID_COMMANDS` set (if still
needed by other code) or deleted entirely.

```bash
# Check if anything else imports from ipc-protocol.ts
grep -rn "ipc-protocol" src/ test/ --include="*.ts" | grep -v "node_modules"
```

If no other code imports from `ipc-protocol.ts`, delete it:

```bash
rm src/lib/daemon/ipc-protocol.ts
rm test/unit/daemon/ipc-protocol.test.ts  # if exists
```

If other code still imports `VALID_COMMANDS` or `serializeResponse`, update
those consumers to use the new TaggedRequest-based equivalents or inline
the needed functionality.

### Step 6: Update IPCCommand type in types.ts

Remove the old `IPCCommand` discriminated union from `src/lib/types.ts`:

```typescript
// Delete the IPCCommand type (lines 81-113)
// Delete the IPCResponse interface (lines 115-128)
// These are replaced by the TaggedRequest classes and their success/failure schemas.
```

If other code still uses `IPCCommand` or `IPCResponse`, update those consumers
to use the new types from `ipc-requests.ts`.

### Step 7: Run full test suite

```bash
# Unit tests
pnpm vitest run

# Type check
pnpm check

# Build
pnpm build

# E2E tests
pnpm test:e2e
```

All must pass. If any test references old `cmd`-format IPC, update it to use
the new `_tag`-format TaggedRequest.

### Step 8: Commit

```bash
git add -A
git commit -m "feat(rpc): migrate IPC protocol from cmd-union to @effect/rpc TaggedRequest

BREAKING: IPC wire format changes from {\"cmd\":\"add_project\",...}
to {\"_tag\":\"AddProject\",...}. CLI and daemon must be updated together."
```

---

## Task 44: Add fiber_status diagnostic command

> **NOTE:** This task demonstrates how trivially new commands can be added
> with `@effect/rpc`. Adding a new command requires:
>   1. One TaggedRequest class (3 lines)
>   2. One `Rpc.make()` definition + `RpcGroup.handle()` entry in the group (5 lines)
>   3. Done — no switch case, no validation function, no type union update.

**Files:**
- Modify: `src/lib/effect/ipc-requests.ts` (add FiberStatus)
- Modify: `src/lib/effect/ipc-rpc-group.ts` (add Rpc.make + RpcGroup.handle)
- Modify: `src/lib/effect/ipc-rpc-server.ts` (add to request union)
- Test: `test/unit/daemon/ipc-rpc-fiber-status.test.ts`

### Step 1: Write the failing test

```typescript
// test/unit/daemon/ipc-rpc-fiber-status.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Supervisor } from "effect";
import { Rpc } from "@effect/rpc";
import {
  FiberStatus as FiberStatusRequest,
} from "../../../src/lib/effect/ipc-requests.js";
import { IpcRpcGroup, IpcHandlersLayer } from "../../../src/lib/effect/ipc-rpc-group.js";
import { decodeAndDispatchRpc } from "../../../src/lib/effect/ipc-rpc-server.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";
import { Schema } from "effect";

describe("FiberStatus diagnostic command", () => {
  const mockProjectMgmt = {
    addProject: vi.fn().mockReturnValue(Effect.succeed({ slug: "p", path: "/p" })),
    removeProject: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const mockInstanceMgmt = {
    addInstance: vi.fn().mockReturnValue(Effect.succeed({ id: "i1" })),
    removeInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    startInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    stopInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
    getInstance: vi.fn().mockReturnValue(Effect.succeed({ id: "i1" })),
    updateInstance: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const mockSessionOverrides = {
    setAgent: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    setModel: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const testLayer = Layer.mergeAll(
    makeDaemonStateLive(),
    Layer.succeed(PersistencePathTag, "/tmp/test.json"),
    Layer.succeed(ProjectMgmtTag, mockProjectMgmt as unknown as ProjectMgmtTag["Type"]),
    Layer.succeed(InstanceMgmtTag, mockInstanceMgmt as unknown as InstanceMgmtTag["Type"]),
    Layer.succeed(SessionOverridesTag, mockSessionOverrides as unknown as SessionOverridesTag["Type"]),
  );

  describe("Schema", () => {
    it.effect("decodes FiberStatus request", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknown(FiberStatusRequest)({
          _tag: "FiberStatus",
        });
        expect(decoded._tag).toBe("FiberStatus");
      })
    );
  });

  describe("via RPC Group", () => {
    it.effect("returns fiber status info", () =>
      Effect.gen(function* () {
        const response = yield* Rpc.call(new FiberStatusRequest());

        expect(response.ok).toBe(true);
        expect(response.fibers).toBeDefined();
        expect(Array.isArray(response.fibers)).toBe(true);
        expect(typeof response.fiberCount).toBe("number");
        expect(response.fiberCount).toBeGreaterThanOrEqual(0);
      }).pipe(Effect.provide(Layer.provideMerge(testLayer, IpcHandlersLayer)))
    );
  });

  describe("via decodeAndDispatchRpc", () => {
    it.effect("dispatches FiberStatus from JSON", () =>
      Effect.gen(function* () {
        const response = yield* decodeAndDispatchRpc(
          '{"_tag":"FiberStatus"}',
        );
        expect(response.ok).toBe(true);
        expect(response.fibers).toBeDefined();
      }).pipe(Effect.provide(Layer.provideMerge(testLayer, IpcHandlersLayer)))
    );
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-fiber-status.test.ts`
Expected: FAIL — `FiberStatus` not exported from ipc-requests.ts

### Step 3: Add FiberStatus TaggedRequest

Add to `src/lib/effect/ipc-requests.ts`:

```typescript
// ── 20. FiberStatus (diagnostic) ────────────────────────────────────────────
//
// Queries the Supervisor for active fiber info. Demonstrates how adding
// new commands is trivial with @effect/rpc — just one class definition
// and one router entry.

const OkWithFiberStatus = Schema.Struct({
  ok: Schema.Literal(true),
  fiberCount: Schema.Number,
  fibers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      startTime: Schema.optional(Schema.Number),
    }),
  ),
});

export class FiberStatus extends Schema.TaggedRequest<FiberStatus>()(
  "FiberStatus",
  {
    failure: Schema.Never,
    success: OkWithFiberStatus,
    payload: {},
  },
) {}
```

### Step 4: Add handler to RPC Group

Add to `src/lib/effect/ipc-rpc-group.ts`:

```typescript
import { FiberStatus } from "./ipc-requests.js";
// Add to imports at top ^

// Add a new Rpc.make() endpoint definition:
const fiberStatusRpc = Rpc.make("FiberStatus", { request: FiberStatus });

// Add fiberStatusRpc to the RpcGroup.make(...) call:
// export const IpcRpcGroup = RpcGroup.make(
//   ...existing rpcs...,
//   fiberStatusRpc,
// );

// Add RpcGroup.handle for FiberStatus in the IpcHandlersLayer pipe chain,
// before the RpcGroup.toLayer() call:

  // ── 20. FiberStatus (diagnostic) ──────────────────────────────────────
  // AUDIT FIX (M4): Phase 4 Task 27 wires Supervisor.track BEFORE Phase 6.
  // Use real Supervisor data, not hardcoded empty arrays.
  // Supervisor.track is an Effect (must yield*). sv.value returns the fibers.
  RpcGroup.handle(fiberStatusRpc, (_req) =>
    Effect.gen(function* () {
      // The SupervisorTag is wired in daemon-main.ts (Phase 4 Task 27).
      // In tests without the full daemon Layer, the handler should degrade
      // gracefully. Use Effect.serviceOption to optionally read the Supervisor.
      const svOpt = yield* Effect.serviceOption(SupervisorTag);
      if (svOpt._tag === "None") {
        return { ok: true as const, fiberCount: 0, fibers: [] as Array<{ id: string; status: string; startTime?: number }> };
      }
      const fibers = yield* svOpt.value.value;
      return {
        ok: true as const,
        fiberCount: fibers.length,
        fibers: fibers.map((f: any) => ({
          id: String(f.id()),
          status: String(f.status),
          startTime: undefined as number | undefined,
        })),
      };
    }).pipe(
      Effect.annotateLogs("cmd", "FiberStatus"),
      Effect.withSpan("ipc.FiberStatus"),
    ),
  ),
```

> **Future enhancement:** When Phase 4 Task 27's Supervisor is available,
> update this handler to query `sv.value` for real fiber status:
>
> ```typescript
> RpcGroup.handle(fiberStatusRpc, (_req) =>
>   Effect.gen(function* () {
>     const sv = yield* SupervisorTag;
>     const fibers = yield* sv.value;
>     return {
>       ok: true as const,
>       fiberCount: fibers.length,
>       fibers: fibers.map((f) => ({
>         id: String(f.id()),
>         status: String(f.status),
>         startTime: f.startTime,
>       })),
>     };
>   }),
> )
> ```

### Step 5: Add FiberStatus to the request union in ipc-rpc-server.ts

```typescript
// In src/lib/effect/ipc-rpc-server.ts, add to imports:
import { /* ...existing... */, FiberStatus } from "./ipc-requests.js";

// Add to the IpcRequestUnion:
const IpcRequestUnion = Schema.Union(
  // ...existing 19 entries...
  FiberStatus,
);
```

### Step 6: Run test to verify it passes

Run: `pnpm vitest run test/unit/daemon/ipc-rpc-fiber-status.test.ts`
Expected: All tests PASS

### Step 7: Commit

```bash
git add src/lib/effect/ipc-requests.ts src/lib/effect/ipc-rpc-group.ts src/lib/effect/ipc-rpc-server.ts test/unit/daemon/ipc-rpc-fiber-status.test.ts
git commit -m "feat(rpc): add FiberStatus diagnostic command — demonstrates trivial @effect/rpc extensibility"
```

---

## Summary: What Changed

### Before (Phase 1-5)

```
CLI                          Daemon
 │                            │
 │  {"cmd":"add_project",     │
 │   "directory":"/path"}     │
 ├───────────────────────────►│
 │                            │── parseCommand()
 │                            │── validateCommand()
 │                            │── switch(cmd.cmd) { case "add_project": ... }
 │                            │── handleAddProject(cmd)
 │  {"ok":true,"slug":"proj"} │
 │◄───────────────────────────┤
```

- Manual `switch` dispatch with 19 cases
- Separate `parseCommand` + `validateCommand` functions
- `IPCCommand` discriminated union on `cmd`
- No compile-time request→response pairing
- Adding a command requires changes in 4+ places

### After (Phase 6)

```
CLI                          Daemon
 │                            │
 │  {"_tag":"AddProject",     │
 │   "directory":"/path"}     │
 ├───────────────────────────►│
 │                            │── Schema.Union decode (automatic)
 │                            │── RpcGroup dispatch (automatic)
 │                            │── handler(req) (type-safe)
 │  {"ok":true,"slug":"proj"} │
 │◄───────────────────────────┤
```

- `RpcGroup.make(...)` + `RpcGroup.handle(...)` — no switch statement
- Schema-based validation (built into TaggedRequest)
- `_tag`-discriminated requests with PascalCase names
- Compile-time request→response type pairing
- Adding a command requires 2 changes: one class + one group handler entry

### Files Created

| File | Purpose |
|------|---------|
| `src/lib/effect/ipc-requests.ts` | 20 TaggedRequest classes (19 original + FiberStatus) |
| `src/lib/effect/ipc-rpc-group.ts` | RPC Group mapping requests to handlers |
| `src/lib/effect/ipc-rpc-server.ts` | Unix socket server transport |
| `src/lib/effect/ipc-rpc-client.ts` | CLI-side RPC client |

### Files Deleted

| File | Replaced By |
|------|-------------|
| `src/lib/effect/ipc-dispatch.ts` | `ipc-rpc-server.ts` |
| `src/lib/effect/ipc-effect-types.ts` | `ipc-requests.ts` |
| `src/lib/daemon/ipc-protocol.ts` | `ipc-requests.ts` (Schema validation built-in) |

### Command Name Mapping

| Old (`cmd`) | New (`_tag`) |
|-------------|-------------|
| `add_project` | `AddProject` |
| `remove_project` | `RemoveProject` |
| `set_pin` | `SetPin` |
| `set_keep_awake` | `SetKeepAwake` |
| `shutdown` | `Shutdown` |
| `instance_add` | `InstanceAdd` |
| `instance_remove` | `InstanceRemove` |
| `instance_start` | `InstanceStart` |
| `instance_stop` | `InstanceStop` |
| `list_projects` | `ListProjects` |
| `get_status` | `GetStatus` |
| `instance_list` | `InstanceList` |
| `instance_status` | `InstanceStatus` |
| `instance_update` | `InstanceUpdate` |
| `set_project_title` | `SetProjectTitle` |
| `set_keep_awake_command` | `SetKeepAwakeCommand` |
| `set_agent` | `SetAgent` |
| `set_model` | `SetModel` |
| `restart_with_config` | `RestartWithConfig` |
| _(new)_ | `FiberStatus` |
