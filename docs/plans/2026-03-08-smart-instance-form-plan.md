# Smart Instance Creation Form — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the raw env-var-only instance creation form with structured preset buttons, provider fields (API key, base URL), feature flag checkboxes, and CCS auto-detection — while keeping the raw env var editor as a collapsed "Additional" section.

**Architecture:** Purely frontend form refactor — structured fields compile down to the existing `env: Record<string, string>` before sending the unchanged `instance_add` / `instance_update` WS messages. One small backend addition: a `proxy_detect` handler that probes localhost for CCS/CLIProxy. Extract env-compilation logic into a pure, testable utility.

**Tech Stack:** Svelte 5 (runes), Tailwind v4, Vitest (unit), Playwright (E2E)

---

### Task 1: Extract env compilation utility

**Files:**
- Create: `src/lib/frontend/utils/instance-env.ts`
- Create: `test/unit/frontend/instance-env.test.ts`

This is the core logic: structured form fields → flat `env: Record<string, string>`, and the reverse for edit mode. Extracting it makes the form simpler and the logic independently testable.

**Step 1: Write failing tests**

```typescript
// test/unit/frontend/instance-env.test.ts
import { describe, expect, it } from "vitest";
import {
  compileEnv,
  extractStructuredEnv,
  KNOWN_FLAGS,
  type StructuredEnv,
} from "../../../src/lib/frontend/utils/instance-env.js";

describe("compileEnv", () => {
  it("returns empty object when all fields empty", () => {
    const input: StructuredEnv = {
      apiKey: "",
      baseUrl: "",
      flags: {},
      additional: [],
    };
    expect(compileEnv(input)).toEqual({});
  });

  it("maps apiKey to ANTHROPIC_API_KEY", () => {
    const input: StructuredEnv = {
      apiKey: "sk-ant-test",
      baseUrl: "",
      flags: {},
      additional: [],
    };
    expect(compileEnv(input)).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
  });

  it("maps baseUrl to ANTHROPIC_BASE_URL", () => {
    const input: StructuredEnv = {
      apiKey: "",
      baseUrl: "http://127.0.0.1:8317/v1",
      flags: {},
      additional: [],
    };
    expect(compileEnv(input)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317/v1",
    });
  });

  it("maps checked flags to env vars with value '1'", () => {
    const input: StructuredEnv = {
      apiKey: "",
      baseUrl: "",
      flags: {
        OPENCODE_DISABLE_DEFAULT_PLUGINS: true,
        OPENCODE_EXPERIMENTAL_LSP_TOOL: true,
      },
      additional: [],
    };
    expect(compileEnv(input)).toEqual({
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_EXPERIMENTAL_LSP_TOOL: "true",
    });
  });

  it("omits unchecked flags", () => {
    const input: StructuredEnv = {
      apiKey: "",
      baseUrl: "",
      flags: { OPENCODE_DISABLE_DEFAULT_PLUGINS: false },
      additional: [],
    };
    expect(compileEnv(input)).toEqual({});
  });

  it("merges additional env vars", () => {
    const input: StructuredEnv = {
      apiKey: "",
      baseUrl: "",
      flags: {},
      additional: [{ key: "MY_VAR", value: "hello" }],
    };
    expect(compileEnv(input)).toEqual({ MY_VAR: "hello" });
  });

  it("skips additional vars with empty keys", () => {
    const input: StructuredEnv = {
      apiKey: "",
      baseUrl: "",
      flags: {},
      additional: [
        { key: "", value: "orphan" },
        { key: "REAL", value: "val" },
      ],
    };
    expect(compileEnv(input)).toEqual({ REAL: "val" });
  });

  it("combines all fields", () => {
    const input: StructuredEnv = {
      apiKey: "sk-key",
      baseUrl: "http://proxy:8317/v1",
      flags: { OPENCODE_DISABLE_DEFAULT_PLUGINS: true },
      additional: [{ key: "CUSTOM", value: "x" }],
    };
    expect(compileEnv(input)).toEqual({
      ANTHROPIC_API_KEY: "sk-key",
      ANTHROPIC_BASE_URL: "http://proxy:8317/v1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      CUSTOM: "x",
    });
  });
});

describe("extractStructuredEnv", () => {
  it("returns defaults for empty env", () => {
    const result = extractStructuredEnv({});
    expect(result.apiKey).toBe("");
    expect(result.baseUrl).toBe("");
    expect(result.flags).toEqual({});
    expect(result.additional).toEqual([]);
  });

  it("extracts ANTHROPIC_API_KEY to apiKey", () => {
    const result = extractStructuredEnv({ ANTHROPIC_API_KEY: "sk-test" });
    expect(result.apiKey).toBe("sk-test");
    expect(result.additional).toEqual([]);
  });

  it("extracts ANTHROPIC_BASE_URL to baseUrl", () => {
    const result = extractStructuredEnv({
      ANTHROPIC_BASE_URL: "http://proxy/v1",
    });
    expect(result.baseUrl).toBe("http://proxy/v1");
  });

  it("extracts known flags as booleans", () => {
    const result = extractStructuredEnv({
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_EXPERIMENTAL_LSP_TOOL: "true",
    });
    expect(result.flags.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(true);
    expect(result.flags.OPENCODE_EXPERIMENTAL_LSP_TOOL).toBe(true);
  });

  it("puts unknown env vars into additional", () => {
    const result = extractStructuredEnv({
      ANTHROPIC_API_KEY: "sk-x",
      CUSTOM_VAR: "hello",
      ANOTHER: "world",
    });
    expect(result.apiKey).toBe("sk-x");
    expect(result.additional).toEqual([
      { key: "CUSTOM_VAR", value: "hello" },
      { key: "ANOTHER", value: "world" },
    ]);
  });

  it("roundtrips: compile(extract(env)) === env", () => {
    const original = {
      ANTHROPIC_API_KEY: "sk-key",
      ANTHROPIC_BASE_URL: "http://proxy/v1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_EXPERIMENTAL_LSP_TOOL: "true",
      CUSTOM: "val",
    };
    const structured = extractStructuredEnv(original);
    const compiled = compileEnv(structured);
    expect(compiled).toEqual(original);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/frontend/instance-env.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/lib/frontend/utils/instance-env.ts

/**
 * Maps between structured form fields and flat env vars for instance config.
 * This is a pure utility — no Svelte state, no side effects.
 */

/** Known feature flag env vars with their display labels and "enabled" values. */
export const KNOWN_FLAGS: Record<
  string,
  { label: string; enabledValue: string }
> = {
  OPENCODE_DISABLE_DEFAULT_PLUGINS: {
    label: "Disable default plugins",
    enabledValue: "1",
  },
  OPENCODE_EXPERIMENTAL_LSP_TOOL: {
    label: "Enable LSP tool (experimental)",
    enabledValue: "true",
  },
};

/** Env var keys that are surfaced as named form fields (not "additional"). */
const STRUCTURED_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  ...Object.keys(KNOWN_FLAGS),
]);

export interface StructuredEnv {
  apiKey: string;
  baseUrl: string;
  flags: Record<string, boolean>;
  additional: Array<{ key: string; value: string }>;
}

/** Compile structured form fields into a flat env record for the WS message. */
export function compileEnv(s: StructuredEnv): Record<string, string> {
  const env: Record<string, string> = {};

  if (s.apiKey.trim()) env.ANTHROPIC_API_KEY = s.apiKey.trim();
  if (s.baseUrl.trim()) env.ANTHROPIC_BASE_URL = s.baseUrl.trim();

  for (const [key, checked] of Object.entries(s.flags)) {
    if (checked && KNOWN_FLAGS[key]) {
      env[key] = KNOWN_FLAGS[key].enabledValue;
    }
  }

  for (const { key, value } of s.additional) {
    if (key.trim()) env[key.trim()] = value;
  }

  return env;
}

/** Extract structured fields from a flat env record (for edit mode). */
export function extractStructuredEnv(
  env: Record<string, string>,
): StructuredEnv {
  const result: StructuredEnv = {
    apiKey: env.ANTHROPIC_API_KEY ?? "",
    baseUrl: env.ANTHROPIC_BASE_URL ?? "",
    flags: {},
    additional: [],
  };

  for (const key of Object.keys(KNOWN_FLAGS)) {
    if (key in env) {
      result.flags[key] = true;
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (!STRUCTURED_KEYS.has(key)) {
      result.additional.push({ key, value });
    }
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/frontend/instance-env.test.ts`
Expected: All PASS

**Step 5: Commit**

```
feat: add instance-env utility for structured env ↔ flat env mapping
```

---

### Task 2: Add proxy_detect backend handler

**Files:**
- Modify: `src/lib/handlers/payloads.ts` (add `proxy_detect` payload)
- Modify: `src/lib/shared-types.ts` (add `proxy_detected` to RelayMessage)
- Modify: `src/lib/handlers/instance.ts` (add `handleProxyDetect`)
- Modify: `src/lib/handlers/index.ts` (register in dispatch table)
- Create: `test/unit/handlers/proxy-detect.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/handlers/proxy-detect.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleProxyDetect } from "../../../src/lib/handlers/instance.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleProxyDetect", () => {
  let deps: HandlerDeps;
  let sentMessages: Array<{ clientId: string; msg: unknown }>;

  beforeEach(() => {
    sentMessages = [];
    deps = createMockHandlerDeps({
      wsHandler: {
        broadcast: vi.fn(),
        sendTo: (clientId: string, msg: unknown) =>
          sentMessages.push({ clientId, msg }),
      } as unknown as HandlerDeps["wsHandler"],
    });
  });

  it("responds with proxy_detected found=false when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await handleProxyDetect(deps, "client-1", {});
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.msg).toMatchObject({
      type: "proxy_detected",
      found: false,
    });
    vi.unstubAllGlobals();
  });

  it("responds with proxy_detected found=true when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true }),
    );
    await handleProxyDetect(deps, "client-1", {});
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.msg).toMatchObject({
      type: "proxy_detected",
      found: true,
      port: 8317,
    });
    vi.unstubAllGlobals();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers/proxy-detect.test.ts`
Expected: FAIL — handleProxyDetect not exported

**Step 3: Add payload type**

In `src/lib/handlers/payloads.ts`, add to `PayloadMap`:

```typescript
  proxy_detect: Record<string, never>;
```

**Step 4: Add RelayMessage variant**

In `src/lib/shared-types.ts`, add to the `RelayMessage` union (in the Instance Management section):

```typescript
  | { type: "proxy_detected"; found: boolean; port: number }
```

**Step 5: Implement handler**

In `src/lib/handlers/instance.ts`, add after `handleSetProjectInstance`:

```typescript
// ─── proxy_detect ───────────────────────────────────────────────────────────

const CCS_DEFAULT_PORT = 8317;

export async function handleProxyDetect(
  deps: HandlerDeps,
  clientId: string,
  _payload: PayloadMap["proxy_detect"],
): Promise<void> {
  let found = false;
  try {
    await fetch(`http://127.0.0.1:${CCS_DEFAULT_PORT}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    found = true; // Any response = reachable
  } catch {
    // Not reachable
  }
  deps.wsHandler.sendTo(clientId, {
    type: "proxy_detected",
    found,
    port: CCS_DEFAULT_PORT,
  });
}
```

**Step 6: Register in dispatch table**

In `src/lib/handlers/index.ts`:
- Add `handleProxyDetect` to the import from `./instance.js` and the re-export
- Add to `MESSAGE_HANDLERS`: `proxy_detect: handleProxyDetect as MessageHandler,`

**Step 7: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/proxy-detect.test.ts`
Expected: All PASS

**Step 8: Type check**

Run: `pnpm tsc --noEmit`
Expected: Clean

**Step 9: Commit**

```
feat: add proxy_detect handler for CCS auto-detection
```

---

### Task 3: Refactor SettingsPanel create form with structured sections

**Files:**
- Modify: `src/lib/frontend/components/overlays/SettingsPanel.svelte`

This is the main UI task. Replace the flat form with preset bar + structured sections.

**Step 1: Add imports and preset definitions**

In the `<script>` block of `SettingsPanel.svelte`, add:

```typescript
import {
  compileEnv,
  extractStructuredEnv,
  KNOWN_FLAGS,
  type StructuredEnv,
} from "../../utils/instance-env.js";

// ─── Presets ────────────────────────────────────────────────────────────
type PresetId = "anthropic" | "ccs" | "custom";

interface Preset {
  id: PresetId;
  label: string;
  description: string;
  defaults: {
    name: string;
    managed: boolean;
    flags: Record<string, boolean>;
  };
}

const PRESETS: Preset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Direct API key",
    defaults: {
      name: "anthropic",
      managed: true,
      flags: {
        OPENCODE_DISABLE_DEFAULT_PLUGINS: true,
        OPENCODE_EXPERIMENTAL_LSP_TOOL: true,
      },
    },
  },
  {
    id: "ccs",
    label: "CCS Proxy",
    description: "Via CLIProxyAPI",
    defaults: {
      name: "ccs",
      managed: true,
      flags: {
        OPENCODE_DISABLE_DEFAULT_PLUGINS: true,
        OPENCODE_EXPERIMENTAL_LSP_TOOL: true,
      },
    },
  },
  {
    id: "custom",
    label: "Custom",
    description: "Manual config",
    defaults: {
      name: "",
      managed: false,
      flags: {},
    },
  },
];
```

**Step 2: Replace flat form state with structured state**

Replace the existing create-form state variables with:

```typescript
// Form fields (create) — structured
let formName = $state("");
let formPort = $state("");
let formManaged = $state(false);
let formUrl = $state("");
let formApiKey = $state("");
let formBaseUrl = $state("");
let formFlags = $state<Record<string, boolean>>({});
let formAdditionalEnv = $state<Array<{ key: string; value: string }>>([]);
let selectedPreset = $state<PresetId | null>(null);

// CCS detection
let ccsDetected = $state(false);
let ccsPort = $state(8317);
let showAdditionalEnv = $state(false);
```

Update `resetForm()`:

```typescript
function resetForm() {
  formName = "";
  formPort = "";
  formManaged = false;
  formUrl = "";
  formApiKey = "";
  formBaseUrl = "";
  formFlags = {};
  formAdditionalEnv = [];
  selectedPreset = null;
  showAdditionalEnv = false;
}
```

**Step 3: Add preset application and CCS detection**

```typescript
function applyPreset(preset: Preset) {
  selectedPreset = preset.id;
  formName = preset.defaults.name;
  formManaged = preset.defaults.managed;
  formFlags = { ...preset.defaults.flags };
  formApiKey = "";
  formBaseUrl = "";
  formAdditionalEnv = [];
  formPort = "";
  formUrl = "";

  if (preset.id === "ccs" && ccsDetected) {
    formBaseUrl = `http://127.0.0.1:${ccsPort}/v1`;
  }
}
```

Add CCS detection trigger when form opens — in the `$effect` for `showAddForm`:

```typescript
$effect(() => {
  if (showAddForm) {
    // Probe for CCS
    wsSend({ type: "proxy_detect" });
  }
});
```

Add a WS listener effect for `proxy_detected`:

```typescript
// This will need to hook into the ws-dispatch system.
// The simplest approach: add an onClientMessage callback or
// use a store-level handler. See ws-listeners.ts for patterns.
```

*Note: The exact mechanism depends on how `proxy_detected` messages are dispatched. The simplest approach is to add a handler in `ws-dispatch.ts` that sets a module-level state, or use `onClientMessage` from the WS mock. Check `stores/ws-dispatch.ts` for the existing pattern.*

**Step 4: Update `handleCreate` to use `compileEnv`**

```typescript
function handleCreate() {
  const hasUrl = formUrl.trim().length > 0;
  const msg: Record<string, unknown> = {
    type: "instance_add",
    name: formName,
    managed: hasUrl ? false : formManaged,
  };
  if (!hasUrl && formPort) {
    msg.port = Number(formPort);
  }
  if (hasUrl) {
    msg.url = formUrl;
  }

  const env = compileEnv({
    apiKey: formApiKey,
    baseUrl: formBaseUrl,
    flags: formFlags,
    additional: formAdditionalEnv,
  });
  if (Object.keys(env).length > 0) {
    msg.env = env;
  }

  wsSend(msg);
  showAddForm = false;
  resetForm();
}
```

**Step 5: Replace the form HTML**

Replace the `#instance-form` div (lines 374-454) with the structured layout:

```svelte
<div id="instance-form" class="border border-border rounded-lg p-3 space-y-4">
  <!-- Preset bar -->
  <div>
    <span class="text-xs text-text-muted mb-1.5 block">Quick Setup</span>
    <div class="flex gap-2">
      {#each PRESETS as preset}
        <button
          type="button"
          class="flex-1 px-3 py-2 text-xs rounded-lg border transition-colors cursor-pointer
            {selectedPreset === preset.id
              ? 'border-accent bg-accent/10 text-text'
              : 'border-border text-text-muted hover:border-accent/50 hover:text-text'}"
          data-testid="preset-{preset.id}"
          onclick={() => applyPreset(preset)}
        >
          <div class="font-medium">{preset.label}</div>
          <div class="text-[10px] mt-0.5 opacity-70">{preset.description}</div>
          {#if preset.id === "ccs" && ccsDetected}
            <div class="flex items-center gap-1 mt-1">
              <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
              <span class="text-[10px] text-green-600 dark:text-green-400">Detected</span>
            </div>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <!-- Instance section -->
  <div class="space-y-2">
    <span class="text-xs text-text-muted font-medium">Instance</span>
    <div class="grid grid-cols-2 gap-2">
      <div>
        <label for="instance-name" class="block text-xs text-text-muted mb-1">Name</label>
        <input
          id="instance-name" name="instance-name" type="text"
          class="w-full px-2 py-1 text-sm border border-border rounded bg-bg text-text"
          placeholder="e.g. personal"
          bind:value={formName}
        />
      </div>
      <div>
        <label for="instance-port" class="block text-xs text-text-muted mb-1">Port</label>
        <input
          id="instance-port" name="instance-port" type="text"
          class="w-full px-2 py-1 text-sm border border-border rounded bg-bg text-text"
          placeholder="auto"
          bind:value={formPort}
        />
      </div>
    </div>
    <div>
      <label for="instance-url" class="block text-xs text-text-muted mb-1">URL (external instances)</label>
      <input
        id="instance-url" name="instance-url" type="text"
        class="w-full px-2 py-1 text-sm border border-border rounded bg-bg text-text"
        placeholder="http://remote.example.com:4096"
        bind:value={formUrl}
      />
    </div>
    <div class="flex items-center gap-2">
      <input id="managed-checkbox" name="managed" type="checkbox" bind:checked={formManaged} />
      <label for="managed-checkbox" class="text-sm text-text">Managed</label>
    </div>
  </div>

  <!-- Provider section -->
  <div class="space-y-2">
    <span class="text-xs text-text-muted font-medium">Provider</span>
    <div>
      <label for="api-key" class="block text-xs text-text-muted mb-1">API Key</label>
      <input
        id="api-key" type="password"
        class="w-full px-2 py-1 text-sm border border-border rounded bg-bg text-text font-mono"
        placeholder="sk-ant-..."
        autocomplete="off"
        data-testid="api-key-input"
        bind:value={formApiKey}
      />
    </div>
    <div>
      <label for="base-url" class="block text-xs text-text-muted mb-1">Base URL (optional)</label>
      <input
        id="base-url" type="text"
        class="w-full px-2 py-1 text-sm border border-border rounded bg-bg text-text font-mono"
        placeholder="http://127.0.0.1:8317/v1"
        data-testid="base-url-input"
        bind:value={formBaseUrl}
      />
    </div>
  </div>

  <!-- Feature flags section -->
  <div class="space-y-2">
    <span class="text-xs text-text-muted font-medium">Features</span>
    {#each Object.entries(KNOWN_FLAGS) as [key, flag]}
      <div class="flex items-center gap-2">
        <input
          id="flag-{key}" type="checkbox"
          checked={formFlags[key] ?? false}
          onchange={(e) => {
            formFlags = { ...formFlags, [key]: (e.target as HTMLInputElement).checked };
          }}
          data-testid="flag-{key}"
        />
        <label for="flag-{key}" class="text-sm text-text">{flag.label}</label>
      </div>
    {/each}
  </div>

  <!-- Additional env vars (collapsed) -->
  <div>
    <button
      type="button"
      class="text-xs text-text-muted hover:text-text flex items-center gap-1 cursor-pointer"
      data-testid="toggle-additional-env"
      onclick={() => { showAdditionalEnv = !showAdditionalEnv; }}
    >
      <Icon name={showAdditionalEnv ? "chevron-down" : "chevron-right"} size={12} />
      Additional Environment Variables
      {#if formAdditionalEnv.length > 0}
        <span class="text-accent">({formAdditionalEnv.length})</span>
      {/if}
    </button>
    {#if showAdditionalEnv}
      <div class="mt-2">
        {@render envEditor(formAdditionalEnv, (vars) => { formAdditionalEnv = vars; })}
      </div>
    {/if}
  </div>

  <!-- Actions -->
  <div class="flex gap-2">
    <button
      class="px-3 py-1 text-sm rounded bg-accent text-bg font-medium hover:bg-accent-hover"
      onclick={handleCreate}
    >
      Create
    </button>
    <button
      class="px-3 py-1 text-sm rounded border border-border text-text-muted hover:bg-black/[0.05]"
      onclick={() => { showAddForm = false; resetForm(); }}
    >
      Cancel
    </button>
  </div>
</div>
```

**Step 6: Build and verify**

Run: `pnpm build:frontend`
Expected: Clean build

**Step 7: Commit**

```
feat: structured instance creation form with presets and feature flags
```

---

### Task 4: Wire proxy_detected into frontend state

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (handle `proxy_detected`)
- Modify: `src/lib/frontend/components/overlays/SettingsPanel.svelte` (consume state)

**Step 1: Check ws-dispatch pattern**

Read `src/lib/frontend/stores/ws-dispatch.ts` to understand how incoming messages are dispatched to stores. Follow the existing pattern (e.g. how `instance_list` dispatches to `handleInstanceList`).

**Step 2: Add proxy_detected state**

The simplest approach: add module-level state that the SettingsPanel reads.

In `src/lib/frontend/stores/instance.svelte.ts` (or a new proxy store), add:

```typescript
// Proxy detection state (set by ws-dispatch, read by SettingsPanel)
let proxyDetection = $state<{ found: boolean; port: number } | null>(null);

export function handleProxyDetected(msg: { found: boolean; port: number }) {
  proxyDetection = msg;
}

export function getProxyDetection() {
  return proxyDetection;
}
```

In `ws-dispatch.ts`, add the handler:

```typescript
case "proxy_detected":
  handleProxyDetected(msg as { found: boolean; port: number });
  break;
```

**Step 3: Consume in SettingsPanel**

Import `getProxyDetection` and use a `$derived` to read the detection state:

```typescript
import { getProxyDetection } from "../../stores/instance.svelte.js";

const proxyResult = $derived(getProxyDetection());

$effect(() => {
  if (proxyResult) {
    ccsDetected = proxyResult.found;
    ccsPort = proxyResult.port;
  }
});
```

**Step 4: Build and verify**

Run: `pnpm build:frontend`
Expected: Clean build

**Step 5: Commit**

```
feat: wire proxy_detected into frontend state for CCS auto-detection
```

---

### Task 5: Refactor edit form with structured fields

**Files:**
- Modify: `src/lib/frontend/components/overlays/SettingsPanel.svelte`

**Step 1: Replace edit state with structured state**

Replace the edit form state:

```typescript
let editingInstanceId = $state<string | null>(null);
let editName = $state("");
let editPort = $state("");
let editApiKey = $state("");
let editBaseUrl = $state("");
let editFlags = $state<Record<string, boolean>>({});
let editAdditionalEnv = $state<Array<{ key: string; value: string }>>([]);
let showEditAdditionalEnv = $state(false);
```

**Step 2: Update `handleEdit` to use `extractStructuredEnv`**

```typescript
function handleEdit(inst: OpenCodeInstance) {
  editingInstanceId = inst.id;
  editName = inst.name;
  editPort = String(inst.port);
  const structured = extractStructuredEnv(inst.env ?? {});
  editApiKey = structured.apiKey;
  editBaseUrl = structured.baseUrl;
  editFlags = structured.flags;
  editAdditionalEnv = structured.additional;
  showEditAdditionalEnv = structured.additional.length > 0;
}
```

**Step 3: Update `handleSaveEdit` to use `compileEnv`**

```typescript
function handleSaveEdit() {
  if (!editingInstanceId) return;
  const env = compileEnv({
    apiKey: editApiKey,
    baseUrl: editBaseUrl,
    flags: editFlags,
    additional: editAdditionalEnv,
  });
  wsSend({
    type: "instance_update",
    instanceId: editingInstanceId,
    name: editName,
    port: Number(editPort) || undefined,
    env,
  });
  editingInstanceId = null;
}
```

**Step 4: Replace edit form HTML**

Replace the edit form template (inside `{#if editingInstanceId === inst.id}`) with the same structured layout as the create form, but using `edit*` state variables. Reuse the same section pattern (provider, flags, additional).

Consider extracting a `{#snippet instanceFormFields(...)}` snippet to DRY up the create and edit forms — both have the same structure with different bindings.

**Step 5: Build and verify**

Run: `pnpm build:frontend`
Expected: Clean build

**Step 6: Commit**

```
feat: structured edit form with env extraction and feature flag checkboxes
```

---

### Task 6: Update existing E2E tests

**Files:**
- Modify: `test/e2e/specs/multi-instance.spec.ts`

The existing env editor tests use `[data-testid='add-env-var']` and raw key/value inputs. These need updating since the env editor is now collapsed under "Additional Environment Variables."

**Step 1: Update "add instance form includes env var editor" test**

The test should now:
1. Click "Add Instance"
2. Click the "Anthropic" preset
3. Fill in an API key via the structured field
4. Verify the `instance_add` message includes `ANTHROPIC_API_KEY` in env
5. Also test the additional env section (expand it, add a var)

**Step 2: Update "edit instance sends instance_update with env" test**

The test should verify that editing an instance with existing env vars shows them in the structured fields.

**Step 3: Add new tests for presets**

```typescript
test("preset buttons pre-fill form fields", async ({ page, baseURL }) => {
  const control = await setupMultiInstance(page, baseURL);
  // Open settings → Add Instance
  // Click "Anthropic" preset
  // Verify name field = "anthropic"
  // Verify managed checkbox is checked
  // Verify feature flag checkboxes are checked
});

test("CCS preset fills base URL when detected", async ({ page, baseURL }) => {
  const control = await setupMultiInstance(page, baseURL);
  // Open settings → Add Instance
  // Simulate proxy_detected message with found=true
  // Click "CCS Proxy" preset
  // Verify base URL field contains proxy URL
});

test("feature flag checkboxes compile to env vars", async ({ page, baseURL }) => {
  const control = await setupMultiInstance(page, baseURL);
  // Open settings → Add Instance
  // Check both feature flag checkboxes
  // Fill name and create
  // Verify instance_add message env has OPENCODE_DISABLE_DEFAULT_PLUGINS and OPENCODE_EXPERIMENTAL_LSP_TOOL
});
```

**Step 4: Run E2E tests**

Run: `pnpm build:frontend && pnpm test:multi-instance`
Expected: All PASS

**Step 5: Commit**

```
test: update E2E tests for structured instance form with presets
```

---

### Task 7: Final verification

**Step 1: Type check**

Run: `pnpm tsc --noEmit`
Expected: Clean

**Step 2: Unit tests**

Run: `pnpm test:unit`
Expected: All PASS

**Step 3: Multi-instance E2E tests**

Run: `pnpm build:frontend && pnpm test:multi-instance`
Expected: All PASS

**Step 4: Full unit test suite**

Run: `pnpm test`
Expected: All PASS

**Step 5: Commit (if any fixes needed)**

```
chore: final verification — all tests green
```
