# Variant Persistence & Flow Fixes Design

## Problem

1. Model variant (thinking level) selections are lost on relay restart — purely in-memory
2. Several gaps in variant flow: stale UI on model switch, client-init reads global instead of per-session, no validation against available variants

## Design Decisions

- **Per-model variant map** in `settings.jsonc` (Approach A — flat map alongside existing `defaultModel`)
- **Fix all 5 identified gaps** plus 3 additional gaps found during edge-case analysis
- **Persistence is global preference, not per-session** — "when I use this model, default to this variant"

## Settings Format

```jsonc
{
  "defaultModel": "anthropic/claude-opus-4-6",
  "defaultVariants": {
    "anthropic/claude-opus-4-6": "high",
    "anthropic/claude-sonnet-4-20250514": "medium"
  }
}
```

## Changes

### A. Persistence layer (`relay-settings.ts`)

- Add `defaultVariants?: Record<string, string>` to `RelaySettings`
- Add `parseDefaultVariant(settings, modelKey): string` helper
- Existing `loadRelaySettings` / `saveRelaySettings` work as-is (they serialize the full object)

### B. Startup wiring

- When loading default model from settings, also load its variant from `defaultVariants`
- Set `SessionOverrides.defaultVariant` to the loaded value

### C. `handleSwitchVariant` (`model.ts`)

- After storing per-session variant, also persist to `defaultVariants[modelKey]` in settings
- Use `deps.overrides.getModel(sessionId)` instead of `deps.overrides.model` (global getter) for looking up available variants (Gap #5)

### D. `handleSwitchModel` (`model.ts`)

- After switching model, fetch available variants for the new model
- Look up persisted variant from `defaultVariants[newModelKey]`
- Validate persisted variant against available list; fall back to `""` if invalid
- Call `setVariant(sessionId, restoredVariant)`
- Send `variant_info` to session viewers

### E. `handleSetDefaultModel` (`model.ts`)

- After setting default, fetch available variants for the new default model
- Look up/restore persisted variant from `defaultVariants`
- Send `variant_info` to all clients

### F. `handleGetModels` (`model.ts`)

- After sending `model_list`, also send `variant_info` for the current model so clients get refreshed variant state

### G. `client-init.ts`

- Change `overrides.getVariant?.()` → `overrides.getVariant(activeId)` when `activeId` is known (Gap #1)
- Remove unnecessary `?.` optional chaining (Gap #3)

### H. `prompt.ts`

- Remove unnecessary `?.` from `deps.overrides.getVariant?.(activeId)` (Gap #3)

### I. Variant validation

- On restore (load from settings or model switch), check `availableVariants.includes(variant)` before applying
- If invalid, fall back to `""` and don't persist the invalid value

## Data Flows

### Model switch with variant restore

```
User switches model to "anthropic/claude-sonnet-4"
  -> handleSwitchModel stores model override
  -> fetches available variants for new model: ["low","medium","high","max"]
  -> reads defaultVariants["anthropic/claude-sonnet-4"] = "medium"
  -> validates: "medium" in ["low","medium","high","max"] -> valid
  -> calls setVariant(sessionId, "medium")
  -> sends variant_info { variant: "medium", variants: ["low","medium","high","max"] }
  -> frontend updates badge + dropdown
```

### Variant switch with persistence

```
User switches variant to "high"
  -> handleSwitchVariant stores per-session: setVariant(sessionId, "high")
  -> persists: defaultVariants["anthropic/claude-sonnet-4"] = "high" in settings.jsonc
  -> broadcasts variant_info to session viewers
```

### Relay restart

```
Loads settings: defaultModel = "anthropic/claude-sonnet-4",
                defaultVariants = { "anthropic/claude-sonnet-4": "high" }
  -> sets model override
  -> sets defaultVariant = "high"
  -> client connects, client-init sends variant_info { variant: "high", variants: [...] }
```

### Invalid persisted variant (upstream change)

```
Settings has defaultVariants["anthropic/claude-sonnet-4"] = "max"
But upstream model now only has ["low","medium","high"]
  -> on restore, "max" not in available list
  -> fall back to ""
  -> do NOT persist the invalid value back (leave it — model may be updated again)
```

## Test Plan

- Unit tests for `handleSwitchVariant` handler (currently 0 coverage)
- Unit tests for variant persistence round-trip in relay-settings
- Unit tests for `handleSwitchModel` variant restore behavior
- Unit tests for variant validation (invalid variant fallback)
- Update exhaustiveness lists if any new message types added
