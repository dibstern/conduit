# Conduit

Conduit is a browser-facing orchestrator for AI coding assistants. It keeps durable conversation state in its own event store while provider runtimes execute stateless turns.

## Language

**Provider Runtime**:
An execution engine that runs assistant turns and streams events back into Conduit.
_Avoid_: backend, model server

**Provider Contract**:
The externally documented and locally installed request, response, and event shapes that a provider runtime exposes to Conduit.
_Avoid_: guessed SDK shape, TypeScript-only guarantee

**Provider Envelope**:
The discriminants and fields Conduit reads in order to route, translate, persist, or display a provider message.
_Avoid_: arbitrary provider JSON payload

**Provider-Owned Payload**:
Nested JSON whose structure belongs to the provider or model/tool protocol and is not interpreted by Conduit.
_Avoid_: Conduit contract field

**Provider Runtime Event**:
A pre-storage event envelope emitted by a Provider Runtime inside Conduit. It names the Conduit session/turn, provider refs, and raw-source metadata needed for translation. It is not a stored event and not a browser message.
_Avoid_: CanonicalEvent, RelayMessage, raw SDK payload

**Provider-Scoped Agent Selector**:
A UI control for selecting an agent from the current session's provider runtime only.
_Avoid_: cross-provider agent picker, mixed agent dropdown

**Automatic Session Title**:
A Conduit-owned session label generated from the first user message's domain and intent. It is capped at six words; overlong generated titles are truncated after the sixth word.
If title generation fails, Conduit falls back to `Claude Session YYYY-MM-DD HH:mm` in the relay's local timezone.
_Avoid_: provider session name, assistant summary, turn result

**Session Approval**:
A user decision that allows a provider runtime to continue using a requested tool without creating a file-backed permission rule.
_Avoid_: persisted permission, config rule

**Durable Permission Rule**:
A permission rule stored in a provider-owned settings file and reused outside the current provider session.
_Avoid_: session approval

**Approve And Remember**:
A user decision that approves a requested tool and asks the provider runtime to persist a matching permission rule.
_Avoid_: always allow, if the persistence scope is unclear

**Provider Permission Suggestion**:
A provider runtime's proposed permission update, including the destination it is able to persist to.
_Avoid_: Conduit-invented permission scope

## Relationships

- A **Provider Runtime** may request a **Session Approval** during a turn.
- A **Provider Contract** defines what Conduit accepts from and sends to a **Provider Runtime**.
- A **Provider Envelope** should be runtime-decoded before adapter translation.
- A **Provider-Owned Payload** may remain opaque when Conduit does not read its internal fields.
- A **Provider Runtime Event** may be translated into a stored canonical event, but must not itself become the event store contract.
- A **Provider-Scoped Agent Selector** shows agents from exactly one **Provider Runtime**.
- A **Provider-Scoped Agent Selector** follows the current session's provider runtime; provider switching belongs to model selection.
- A **Provider-Scoped Agent Selector** should name its current provider scope when opened.
- A **Provider-Scoped Agent Selector** row shows agent identity and compact metadata; long agent descriptions belong in tooltips, not row bodies.
- A **Provider-Scoped Agent Selector** preserves the provider runtime's agent order.
- An **Automatic Session Title** is derived from the first user message after Conduit accepts it, not from provider turn completion.
- An **Automatic Session Title** is generated only when the first accepted user message is sent while the session is bound to Claude.
- Existing sessions are not backfilled with an **Automatic Session Title**.
- An **Automatic Session Title** must not overwrite a user-provided session title.
- A **Session Approval** does not create a **Durable Permission Rule**.
- **Approve And Remember** creates a **Durable Permission Rule** only through the provider runtime that owns the rule destination.
- A **Durable Permission Rule** belongs to the provider runtime that owns the settings file.
- Claude **Approve And Remember** options come from Claude SDK **Provider Permission Suggestions**. Conduit should show only the destinations Claude offered and should return the user-selected destination's suggestion set, not every suggestion.
- OpenCode approvals keep Conduit's existing OpenCode behavior. Claude destination selection does not change OpenCode's tool/pattern persistence model.

## Example Dialogue

> **Dev:** "When Claude asks for Always Allow, should Conduit edit OpenCode config?"
> **Domain expert:** "No. Conduit should answer through Claude's provider runtime. If the user chose **Approve And Remember**, Claude owns the resulting **Durable Permission Rule**; OpenCode config is never involved."

## Flagged Ambiguities

- "Always allow" can mean either **Session Approval** or **Approve And Remember**. The UI must name the scope instead of using ambiguous provider-neutral wording.
