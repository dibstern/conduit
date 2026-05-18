# ADR: Provider Runtime Events Are Durable Provider Events

## Status

Accepted

## Context

Conduit originally used `CanonicalEvent` as the provider-to-store vocabulary. The `ProviderRuntimeEvent` contract was introduced as a provider-neutral boundary envelope, but `CONTEXT.md` still described it as pre-storage only.

Plan 3 changes that boundary. New provider-generated events should enter storage as decoded `ProviderRuntimeEvent` envelopes. Historical `CanonicalEvent` rows must continue to replay and project without data migration.

## Decision

Use `ProviderRuntimeEvent` as the durable vocabulary for new provider-originated events. Store provider refs under `providerRefs`, keep raw provider payloads out of SQLite, and retain compatibility translation to the legacy canonical projector/read-model shape while projector migration proceeds.

`CanonicalEvent` remains a legacy compatibility type and upcaster target. It is not the vocabulary new provider runtime paths should construct directly.

## Consequences

- Ingestion/storage may import `src/lib/contracts/providers/provider-runtime-event.ts` by design.
- Provider adapters and relay sinks should accept runtime events and use a compatibility translator only at legacy boundaries.
- Raw source metadata is stored as bounded metadata; raw SDK/provider payloads belong in trace artifacts, not event rows.
