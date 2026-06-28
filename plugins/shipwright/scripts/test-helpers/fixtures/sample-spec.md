# Example Platform — Widget Analytics Service

> Created: 2026-05-21 | Author: Engineering | Status: PLANNED

## 1. Context & Problem

Operators have no durable record of widget usage over time. Today the only
view is a live count that resets on restart, so questions like "how many
widgets were active last week" cannot be answered. We need a service that
ingests widget events and stores them for later analysis.

## 2. Goals

1. **Durable storage** — persist every widget event so historical queries are possible.
2. **HTTP ingest** — accept events over a simple authenticated HTTP endpoint.
3. **Query API** — expose aggregate counts by day, week, and widget type.

## 3. Non-Goals / Explicitly Out of Scope

- Real-time streaming dashboards.
- Per-user behavioral tracking or PII collection.

## 4. Testing Strategy

Unit-test the aggregation logic against recorded fixtures; integration-test the
ingest endpoint with an in-process server.
