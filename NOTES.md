# TrueForge Research Notes & Verified Facts

> Document generated for the TrueFoundry Forge-a-thon VS Code Agent Extension project.  
> All facts verified against TrueForge documentation (`trueforge.dev`), live local API (`http://localhost:8790`), and the `truefoundry/trueforge` core/SDK codebase.

---

## Executive Summary: The Five Critical Verification Items

### (a) How to cancel a running turn — [VERIFIED]
- **API Call**: `POST /api/v1/sessions/{session_id}/cancel` or SDK `await client.sessions.cancel(sessionId);`.
- **Behavior**:
  - Idempotent and immediate.
  - Aborts the in-flight LLM generation request.
  - Waits for any running MCP tool executions to cleanly finish before closing.
  - Force-stops any sandbox running for the turn.
  - Closes the SSE stream gracefully with a terminal `turn.done` event:
    `{ "type": "turn.done", "state": { "status": "cancelled", "reason": "client-cancelled" } }`.
  - Workspace and session remain intact (no partial or corrupted turn state). Subsequent turns can continue on the session history.
- **Cancel Safety Architecture**:
  - On cancel, the extension invokes `client.sessions.cancel(sessionId)` AND immediately closes open diff review editors, discards in-memory staged hunks, terminates active child processes/commands, and resolves pending MCP promises so the turn concludes without delay. Git status is guaranteed clean.
- **Verification Source**: `scratch/trueforge/docs/api/use-agent.mdx#cancel-a-turn`, `packages/trueforge-sdk/src/api/resources/sessions/client/Client.ts`.

### (b) How a tool requires approval & how client approves/rejects — [VERIFIED]
- **Configuration**:
  In the agent spec `mcp_servers` configuration:
  `"require_approval_for_tools": ["propose_edit", "run_command"]` (or `"@write"`, `"@destructive"`, `"@all"`).
- **Trigger**:
  When the model calls a gated tool, the engine pauses turn execution and emits:
  1. `tool.approval_required`: `{ "type": "tool.approval_required", "tool_calls": [{ "id": "call_123", "source_event_id": "msg_456" }], "thread_id": "main" }`.
  2. `turn.update`: `{ "type": "turn.update", "state": { "status": "paused" } }`.
- **Diff Review Architecture via TrueForge Approval**:
  1. On `tool.approval_required`, read `source_event_id` in the event index to parse `propose_edit` arguments (`path`, `description`, `diff_hunks`).
  2. Display the per-hunk diff in VS Code (using virtual document schemes or custom diff view).
  3. Collect per-hunk user accept/reject decisions in an extension-side map keyed by `tool_call_id`.
  4. Client opens subscription:
     ```typescript
     const resume = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId });
     ```
  5. If at least one hunk is accepted, client sends `approval: { status: 'allow' }`. If all hunks are rejected, client sends `approval: { status: 'deny', reason: 'User rejected all proposed hunks' }`.
  6. When the `propose_edit` tool subsequently executes in the MCP server, it looks up the accepted hunks from the map and applies **ONLY** those hunks via VS Code `WorkspaceEdit`, returning a structured response listing applied vs. skipped hunks. No disk writes ever happen prior to approval!
- **Verification Source**: `scratch/trueforge/docs/api/use-agent.mdx#tool-approvals`, `packages/trueforge-core/src/core/mcp/executeToolCalls.ts`.

### (c) Whether TrueForge has native model fallback — [VERIFIED: NO]
- **Finding**: **TrueForge does NOT have built-in native model fallback.**
- **Details**:
  - The agent spec only accepts a single model: `model: { name: "provider/model" }`.
  - The documentation explicitly states: *"Planned: automatic model selection for different turns or subagents. Today each agent uses the model you configure."*
- **Error Identification & Handling**:
  1. **Unreachable Endpoint**: Node fetch throws `TypeError: fetch failed` / `ECONNREFUSED` / `TrueForgeTimeoutError`.
  2. **Invalid Model Key / Bad Model**: TrueForge streams `turn.done` with `state: { status: "error", message: string }`, or returns HTTP 400/401/422/500 during turn creation.
- **Client-Side Fallback Strategy**:
  - `config.json` specifies an ordered models array:
    ```json
    "models": [
      "google-gemini/gemini-3-1-flash-lite",
      "google-gemini/gemini-3-5-flash-lite"
    ]
    ```
  - For transient failures, retry with exponential backoff (max 2 retries).
  - For permanent model errors or invalid keys, the extension creates a new session with the next model in the list and replays the turn.
- **Verification Source**: `scratch/trueforge/docs/models.mdx`, `packages/trueforge-core/src/core/llm/model.ts`.

### (d) Streaming events & exact shapes — [VERIFIED]
- **Lifecycle Events**:
  - `turn.created`: `{ type: "turn.created", id: string, turn_id: string, previous_turn_id: string | null, input: UserMessage[], state: { status: "running" } }`
  - `turn.update`: `{ type: "turn.update", id: string, thread_id: string | null, state: { status: "paused" | "running", metrics?: TurnMetrics } }`
  - `turn.done`: `{ type: "turn.done", id: string, thread_id: null, state: { status: "done" | "cancelled" | "error", output?: ModelMessage, reason?: string, message?: string, metrics?: TurnMetrics } }`
- **Model Output**:
  - `model.message`: `{ type: "model.message", id: string, thread_id: string, content?: string, tool_calls?: ToolCall[], finish_reason: string | null, usage?: TokenUsage }`
  - `model.message.delta`: `{ type: "model.message.delta", id: string, thread_id: string, content?: string, tool_calls?: ToolCallChunk[] }`
- **Tool & Approval Events**:
  - `tool.response`: `{ type: "tool.response", id: string, thread_id: string, tool_call_id: string, content: string }`
  - `tool.approval_required`: `{ type: "tool.approval_required", id: string, thread_id: string, tool_calls: [{ id: string, source_event_id: string }] }`
  - `tool.response_required`: `{ type: "tool.response_required", id: string, thread_id: string, tool_calls: [{ id: string, source_event_id: string }] }`
- **Subagents**:
  - `thread.created`: `{ type: "thread.created", thread_id: string, title: string, parent: { thread_id: string, tool_call_id: string }, agent_info: object }`
  - `thread.done`: `{ type: "thread.done", thread_id: string, title: string, state: { status: "done" | "error", output?: ModelMessage } }`
- **Client User Responses**:
  - `user.tool_approval`: `{ type: "user.tool_approval", thread_id: string, tool_call_id: string, approval: { status: "allow" | "deny", reason?: string } }`
  - `user.tool_response`: `{ type: "user.tool_response", thread_id: string, tool_call_id: string, content: string }`
- **Verification Source**: `scratch/trueforge/docs/api/use-agent.mdx#turn-events-reference`, `packages/trueforge-core/src/agent-session/schemas/events.ts`.

### (e) Whether MCP tool results can be large & size limits — [VERIFIED]
1. **Network Transport Limit**:
   - `DEFAULT_MAX_MCP_RESPONSE_BYTES = 50 * 1024 * 1024` (**50 MB**).
   - If an MCP tool returns more than 50 MB over HTTP/SSE, TrueForge aborts the stream with an error (`"MCP response exceeded max 52428800 bytes"`) and records the limit metric `mcp_response_bytes`.
2. **Context Offloading Thresholds**:
   - `DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD = 6000` tokens.
   - `DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD = 10000` tokens.
   - `DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS = 100` characters.
   - When a sandbox is enabled, tool responses exceeding 6k tokens (or 10k combined) are automatically saved to a sandbox file, and only a 100-character preview remains in the LLM's context window.
   - When sandbox is disabled (`config.sandbox.enabled: false`, as on Windows), responses enter context directly up to the LLM's context window limit.
3. **Extension-Side Context Budget**:
   - Because Windows has no local sandbox, our editor MCP tools (`read_file`, `search_workspace`, `find_symbol`, `run_command`) must enforce an output budget of **~3,500 tokens** (~14,000 characters).
   - Results exceeding 3,500 tokens are ranked, truncated, and clearly annotated with a message specifying the cut lines/bytes.
- **Verification Source**: `packages/trueforge-core/src/core/mcp/remoteMcpClient.ts` (line 36), `packages/trueforge-core/src/core/capabilities/builtins/LargeToolResponse.ts` (lines 17-23).

---

## Context-Engineering Feature Selection for Windows

Of TrueForge's context-engineering capabilities:
1. **Code Mode**: Requires Daytona sandbox provider (`config.sandbox.enabled: true`). **Unavailable on Windows** without external Daytona credentials.
2. **Context Compaction**: `config.context_management.compaction.enabled: true` (default on). Triggers only at 80% of model context length or 80,000 tokens (difficult to hit during a short demo turn).
3. **Dynamic Subagents**: `config.dynamic_sub_agents.enabled: true`. Works without a sandbox. Visible in SSE stream as `thread.created` and `thread.done`.
4. **Deferred Tool Loading**: `"preload": false` on MCP servers. Works without a sandbox. **Recommended**: Immediately and visibly demonstrates context savings on every tool call by querying meta-tools (`list_tools`, `get_tool_info`, `call_tool`) rather than dumping all schema definitions into the initial system prompt.

### Recommended Agent Spec Configuration
```json
{
  "model": {
    "name": "google-gemini/gemini-3-1-flash-lite"
  },
  "instructions": "You are an expert coding assistant embedded in VS Code...",
  "mcp_servers": [
    {
      "name": "vscode-ide",
      "enable_tools": ["@all"],
      "require_approval_for_tools": ["propose_edit", "run_command"],
      "preload": false
    }
  ],
  "config": {
    "sandbox": { "enabled": false },
    "dynamic_sub_agents": { "enabled": true }
  }
}
```

---

## Local Extension & MCP Server Specifications

- **Port Strategy**:
  - Default port: `8795` (setting: `forgeAgent.mcpPort`).
  - Auto-fallback: If port 8795 is busy, automatically bind to a free ephemeral port (`portfinder` or `net.createServer({ port: 0 })`).
  - Security: Bind exclusively to `127.0.0.1`. Generate a 32-byte cryptographic bearer token on extension startup and require it on every MCP HTTP request.
- **TrueForge MCP Registration**:
  - Register/upsert via `PUT /api/v1/settings/mcp-servers`:
    ```json
    {
      "manifest": {
        "type": "remote",
        "name": "vscode-ide",
        "url": "http://127.0.0.1:8795/mcp",
        "description": "VS Code editor capabilities",
        "auth": {
          "type": "header",
          "headers": {
            "Authorization": "Bearer <generated-token>"
          }
        }
      }
    }
    ```
- **Inline Spec Session Creation**:
  - `agent/agent.config.json` stores the base agent spec.
  - Extension reads `agent/agent.config.json`, attaches the dynamic MCP server reference, and calls `client.sessions.create({ agent: { spec: agentSpec } })`.
  - Verified on live instance: Sessions appear in TrueForge UI (`http://localhost:8790/sessions`) with full turn transcripts and tool call logs.
