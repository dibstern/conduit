# Default Model Setting + Per-Tab Session Selection

**Date:** 2026-03-04  
**Status:** Approved

## Problem

1. **No persistent default model.** The relay auto-detects a model from OpenCode providers on connect, but there's no way for users to set a persistent default that survives relay restarts.

2. **Session selection is globally synchronized.** When one device switches sessions, all connected devices switch too. The active session is server-authoritative (one per project relay). Users want independent session selection per browser tab, while keeping chat content (messages, streaming) properly synced.

3. **Input text sync is infrastructure-ready but not functional.** The server relays `input_sync` messages between clients, but the frontend doesn't act on received messages. This should be re-enabled and scoped to clients viewing the same session.

## Feature 1: Default Model Setting

### Config

File: `~/.opencode-relay/settings.jsonc` (new, alongside `daemon.json`, `recent.json`)

```jsonc
{
  // Default model for new sessions (provider/model format)
  "defaultModel": "anthropic/claude-sonnet-4-20250514"
}
```

Uses the existing `DEFAULT_CONFIG_DIR` from `env.ts` (respects `XDG_CONFIG_HOME`).

### Server

**New `relay-settings.ts`:**
- `loadRelaySettings(configDir?)` — reads and parses `settings.jsonc`, strips comments
- `saveRelaySettings(settings, configDir?)` — atomic write (tmp + rename)
- Type: `RelaySettings { defaultModel?: string }`

**`SessionOverrides` changes:**
- New `defaultModel: ModelOverride | undefined` property, set from settings on startup
- `clear()` restores model to `defaultModel` instead of `undefined`
- New `setDefaultModel(model)` — updates in-memory default AND persists to settings file

**`client-init.ts` priority chain:**
1. Relay settings default model
2. Session's own model (from OpenCode)
3. Auto-detect from connected providers (existing fallback)

**New handler `handleSetDefaultModel` in `handlers/model.ts`:**
- Validates provider/model exist in available providers
- Persists to `settings.jsonc`
- Updates `overrides.defaultModel`
- Broadcasts `model_info` + `default_model_info` to all clients

**New WS message types:**
- Incoming: `set_default_model { provider, model }`
- Outgoing: `default_model_info { model, provider }` (sent on connect)

### Frontend

- `discovery.svelte.ts`: Add `defaultModelId`/`defaultProviderId` state. Handle `default_model_info`.
- `ModelSelector.svelte`: Add "Set as default" action (star/pin icon or dropdown option). Sends `set_default_model` WS message.

## Feature 2: Per-Tab Session Selection

### URL Format

```
/p/:slug/            → chat page, server sends most recent session
/p/:slug/s/:sessionId → chat page, specific session
```

New route type: `{ page: "chat"; slug: string; sessionId?: string }`

### Server: Per-Client Session Tracking

**`WsHandler` additions:**
- `clientSessions: Map<clientId, sessionId>` — tracks which session each client is viewing
- `setClientSession(clientId, sessionId)` — update the mapping
- `getClientSession(clientId): string | undefined`
- `getClientsForSession(sessionId): string[]` — find all clients viewing a session
- `sendToSession(sessionId, msg)` — send to all clients viewing that session
- `broadcast()` unchanged — for session_list, client_count, status updates

**New message type: `view_session { sessionId }`**
- Client sends on initial connect (if URL has sessionId) and when switching sessions
- Server registers client→session mapping
- Server replies with session history to that client only (same cache/REST logic as current `handleSwitchSession`, but scoped to requesting client via `sendTo`)

**`handleSwitchSession` refactored to `handleViewSession`:**
- Only sends `session_switched` + history to the requesting client
- Updates that client's session mapping via `setClientSession()`
- Does NOT broadcast to other clients
- `switch_session` kept as alias for backwards compatibility

**`handleNewSession` scoped:**
- Creates session, sends `session_switched` only to requesting client
- Broadcasts updated `session_list` to all (so sidebars update)

### SSE Event Routing

**`sse-wiring.ts` changes:**
- Remove `isActiveSession` check (no single global active session)
- For each translated message, determine which clients should receive it:
  - Use `getClientsForSession(eventSessionId)` → send to those clients
  - If no clients viewing that session, still cache the event (for later switch)
- `session_list` and `status` updates: continue to `broadcast()` to all clients
- Permission/question events: broadcast to all (they're session-independent from the UI perspective)

**Processing timeout:**
- Per-session, not per-client
- `SessionOverrides` manages a timeout per session (or the timeout tracks which session it's for)
- `done` event from SSE clears the timeout for that session

### Input Sync

**Server (`handleInputSync`):**
- Get sender's session from `clientSessions` map
- Only relay to other clients viewing the same session
- Use `getClientsForSession(senderSession)` minus the sender

**Frontend (`InputArea.svelte`):**
- Handle received `input_sync` messages — update textarea text
- Debounce outgoing `input_sync` (300ms while typing)
- Only act on `input_sync` when viewing the same session (server handles filtering)

### Session Manager

- `getActiveSessionId()` meaning changes — becomes "the session with most recent activity" or "last session viewed by any client"
- Still used for SSE caching decisions: cache events for any session
- For the message poller: poll the session with most recent user message activity

### Frontend Changes

**Router (`router.svelte.ts`):**
- Parse `/p/:slug/s/:sessionId` URL pattern
- `navigate()` called when user switches sessions (updates URL + history)

**Session store (`session.svelte.ts`):**
- `setCurrentSession(id)` triggers URL navigation + `view_session` WS message
- On initial connect: if URL has sessionId, send `view_session`; otherwise server sends most recent

**WS store (`ws.svelte.ts`):**
- On connect, send `view_session` if URL has session
- Add `input_sync` to the message dispatch switch — route to InputArea

### Backwards Compatibility

- `switch_session` message treated as `view_session` (only affects sender)
- URLs without session ID (`/p/:slug/`) work — server sends most recent session
- Old clients work unchanged (they just can't have per-tab independence)
