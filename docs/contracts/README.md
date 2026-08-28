# NOVA Event Contracts

This directory contains event-driven communication contracts for the NOVA platform.

## Schema Registry

All events follow this base schema:

| Field | Type | Description |
|-------|------|-------------|
| eventId | string (UUID) | Unique identifier for this event |
| eventType | string | Fully qualified event type name |
| timestamp | string (ISO 8601) | When the event occurred |
| source | string | Service that produced the event |
| correlationId | string (UUID, optional) | Links related events together |
| payload | object | Event-specific data |

## Event Categories

| Category | Purpose | Producers | Consumers |
|----------|---------|-----------|-----------|
| Voice Processing | Audio input/output lifecycle | API, Workers | Analytics, Billing |
| User Activity | User action tracking | API | Analytics, Recommendations |
| System | Infrastructure events | Infrastructure | Monitoring, Alerting |
| Billing | Usage metering events | API, Workers | Billing service |

## Contract Evolution

- Events are versioned via the event type name (e.g., `VoiceSessionStarted.v1`)
- New versions must be backward compatible for at least 2 release cycles
- Deprecated events are announced via the API changelog
- Consumers must handle unknown event types gracefully
