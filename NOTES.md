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
- **Verification Source**: `scratch/trueforge/docs/api/use-agent.mdx#cancel-a-turn`, `packages/trueforge-sdk/src/api/resources/sessions/client/Client.ts`.

### (b) How a tool requires approval & how client approves/rejects — [VERIFIED]
- **Configuration**:
  In the agent spec `mcp_servers` configuration:
  `"require_approval_for_tools": ["propose_edit", "run_command"]` (or `"@write"`, `"@destructive"`, `"@all"`).
- **Trigger**:
  When the model calls a gated tool, the engine pauses turn execution and emits:
  1. `tool.approval_required`: `{ "type": "tool.approval_required", "tool_calls": [{ "id": "call_123", "source_event_id": "msg_456" }], "thread_id": "main" }`.
  2. `turn.update`: `{ "type": "turn.update", "state": { "status": "paused" } }`.
- **Resolution**:
  1. Client looks up `source_event_id` in its event index to inspect tool arguments (`path`, `diff`, `command`).
  2. Client opens subscription:
     ```typescript
     const resume = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId });
     ```
  3. Client posts user decision via `createTurnEvents`:
     ```typescript
     await client.sessions.createTurnEvents(sessionId, turnId, {
       events: [
         {
           type: 'user.tool_approval',
           threadId: pending.threadId,
           toolCallId: 'call_123',
           approval: { status: 'allow' } // or { status: 'deny', reason: 'User rejected edit hunk' }
         }
       ]
     });
     ```
  4. Reading `resume` stream receives subsequent turn execution through to `turn.done`.
- **Verification Source**: `scratch/trueforge/docs/api/use-agent.mdx#tool-approvals`, `packages/trueforge-core/src/core/mcp/executeToolCalls.ts`.

### (c) Whether TrueForge has native model fallback — [VERIFIED: NO]
- **Finding**: **TrueForge does NOT have built-in native model fallback.**
- **Details**:
  - The agent spec only accepts a single model: `model: { name: "provider/model" }`.
  - The documentation explicitly states: *"Planned: automatic model selection for different turns or subagents. Today each agent uses the model you configure."*
- **Best Implementation Strategy for Forge Agent**:
  - **Client-Side Fallback**: Extension maintains an ordered model list `[primary, fallback]` in `config.json`. If a turn fails with a provider/model error (`turn.done` with `status: "error"` or HTTP 429/500), the extension creates a new session or updates the inline agent spec to the fallback model and retries.
  - **Gateway Fallback**: Point TrueForge's `custom` provider to an OpenAI-compatible proxy (e.g. LiteLLM) configured with automated provider failover.
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
   - When sandbox is disabled (`config.sandbox.enabled: false`), responses enter context directly up to the LLM's context window limit.
3. **Elevated Tool Cap & Error Truncation**:
   - Meta-tool character cap: min(50,000 characters, 80% remaining context).
   - Failure messages truncated to 500 characters.
- **Verification Source**: `packages/trueforge-core/src/core/mcp/remoteMcpClient.ts` (line 36), `packages/trueforge-core/src/core/capabilities/builtins/LargeToolResponse.ts` (lines 17-23).

---

## 1. Local Startup, Port, and Authentication

- **Command to Start Locally**:
  ```powershell
  npx @truefoundry/trueforge@latest
  ```
  *(Requires Node.js 22.14+. Standalone mode backed by SQLite, zero external services needed).*
- **Default URL & Port**:
  - URL: `http://localhost:8790`
  - Port flag: `--port <port>` or `PORT=<port>`.
  - Database path: OS application data directory (`SQLITE_PATH` overrides).
- **Authentication**:
  - Local standalone mode has **no authentication / no login by default** (`token` omitted). The client connects as the shared local admin.
  - Hosted mode with OIDC enabled requires `Authorization: Bearer <id_token>`.
- **Doc Link**: [TrueForge Quickstart](https://trueforge.dev/quickstart)

---

## 2. Agent Definition, Inline Specs & UI Verification

### Definition Architecture
- **Repo Definition File**: `agent/agent.config.json` containing the complete `AgentSpec`.
- **Inline Session Creation**:
  ```typescript
  const agentSpec = JSON.parse(fs.readFileSync(path.join(extPath, 'agent/agent.config.json'), 'utf-8'));
  // Dynamically attach MCP server
  agentSpec.mcp_servers = [{ name: 'vscode-ide', enable_tools: ['@all'], require_approval_for_tools: ['propose_edit', 'run_command'], preload: false }];

  const { data: session } = await client.sessions.create({
    agent: { spec: agentSpec }
  });
  ```
- **Registration Script**: `npm run register-agent` will call `client.agents.create` or `PUT /api/v1/agents` to save `"forge-agent"` in TrueForge's persistent registry.

### Live UI Verification — [VERIFIED]
- Tested on local server (`http://localhost:8790`):
  - Created session `01m7f0g14hv3cc7hcdp2npt6kt` with inline agent spec.
  - Sent turn with user message `"Say hello in one word."`.
  - Received streamed tokens: `"Hello."`.
  - Checked `GET /api/v1/sessions` and `GET /api/v1/sessions/{id}/turns`: Session and turns were recorded, metrics tracked (1,185 tokens, 1 turn, 11.8s duration), and the session appears in the TrueForge Sessions list.

---

## 3. Extension Local MCP Server Architecture

- **Port Strategy**:
  - Default port: `8795` (configurable via `forgeAgent.mcpPort`).
  - Automatic fallback: If port `8795` is busy, automatically find and bind to a free ephemeral port (`portfinder` or `net.createServer({ port: 0 })`).
  - Security: Bind exclusively to `127.0.0.1`. Generate a cryptographically secure random bearer token at extension activation (`crypto.randomBytes(32).toString('hex')`). Reject any request lacking this token.
- **Registration with TrueForge**:
  - TrueForge connects to MCP servers over HTTP/SSE.
  - Extension registers/updates the MCP server via `PUT /api/v1/settings/mcp-servers`:
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
- **Tools Exposed**:
  1. `read_file(path, start_line?, end_line?)`
  2. `search_workspace(query)`
  3. `find_symbol(name)`
  4. `propose_edit(path, description, diff_hunks)` — stages in-memory; gated by tool approval.
  5. `run_command(command)` — runs via PowerShell; gated by tool approval.

---

## 4. Models & Exact Model ID Format

- **Active Configured Models (Queried from live server `http://localhost:8790/api/v1/models`)**:
  - **Primary Model**:
    - Full Name / FQN: `google-gemini/gemini-3-1-flash-lite`
    - Provider: `google-gemini`
    - Model ID: `gemini-3.1-flash-lite`
  - Other available models on instance:
    - `google-gemini/gemini-3-5-flash`
    - `google-gemini/gemini-3-5-flash-lite`
    - `google-gemini/gemini-3-8-flash`
    - `google-gemini/gemini-flash-latest`
- **Config Pattern (`config.example.json`)**:
  ```json
  {
    "trueforgeUrl": "http://localhost:8790",
    "mcpPort": 8795,
    "models": [
      "google-gemini/gemini-3-1-flash-lite",
      "google-gemini/gemini-3-5-flash-lite"
    ]
  }
  ```
  *(Zero API keys or secrets in the extension config).*

---

## 5. Subagents & Deferred Tool Loading Demonstration

- **Deferred Tool Loading**:
  - `preload: false` on MCP server.
  - When the agent receives a coding task, it invokes meta-tools (`list_tools`, `get_tool_info`) before calling `call_tool`. This keeps context small and can be inspected in turn events.
- **Dynamic Subagents**:
  - `config.dynamic_sub_agents.enabled: true`.
  - Asking the agent: `"Inspect src/flask/helpers.py and tests/test_helpers.py in parallel to assess debug flag usage"` causes the agent to invoke `create_sub_agent`.
  - The turn stream produces distinct `thread.created` and `thread.done` events visible as separate execution lanes in the Sessions UI.
