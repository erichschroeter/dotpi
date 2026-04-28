# Specification: `agent-cost` Extension

## Overview
The `agent-cost` extension provides telemetry and observability for Pi agent sessions. It tracks duration, token usage (if supported by the provider), and agent activity, persisting this data in a structured format for long-term analysis.

## Objectives
- Track task duration per agent.
- Log token usage statistics (prompt/completion/total) per turn.
- Persist data across multiple sessions to allow for cost analysis.

## Event Hooks
The extension implements hooks via the Pi `ExtensionAPI`:
1. `before_agent_start`: Captures `sessionId` and `timestamp`.
2. `after_agent_response`: Calculates duration, extracts `tokenUsage` data, and writes the complete entry to a persistent log.

## Log Format
Data is stored in `.pi/agents/agent-telemetry.jsonl` using JSON Lines format:
```json
{
  "timestamp": "ISO-8601 string",
  "sessionId": "string",
  "agent": "string",
  "duration_ms": number,
  "tokens": {
    "promptTokens": number,
    "completionTokens": number,
    "totalTokens": number
  },
  "status": "success" | "error"
}
```

## Implementation Requirements
- Use `fs.appendFileSync` to ensure atomic appends to the log file.
- Handle concurrent requests by using a `Map` keyed by `sessionId` to track start times.
- Ensure the extension gracefully handles missing `tokenUsage` data if the LLM provider does not return it.
