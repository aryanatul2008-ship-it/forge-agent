# TrueForge Research Notes & Verified Facts

> Document generated for the TrueFoundry Forge-a-thon VS Code Agent Extension project.  
> All facts verified against TrueForge documentation (`trueforge.dev`) and the `truefoundry/trueforge` core/SDK codebase.

---

## 1. Local Startup, Default URL/Port, and Authentication

- **Command to Start Locally**:
  ```powershell
  npx @truefoundry/trueforge@latest
  ```
  *(Requires Node.js 22.14 or newer. Runs in standalone/local mode backed by a local SQLite database file without needing Docker, Postgres, or Redis).*
- **Default URL & Port**:
  - UI & API: `http://localhost:8790`
  - Port override: `--port <number>` flag or `PORT` environment variable (e.g., `npx @truefoundry/trueforge --port 8790`).
  - Public base URL: Defaults to `http://localhost:<port>`. Overridable via `PUBLIC_BASE_URL`.
  - Database path: OS application data directory by default; overridable via `SQLITE_PATH`.
- **Authentication**:
  - In local standalone mode, there is **no authentication / no login by default** (`token` is omitted). The client connects as the shared local admin.
  - When hosted or when OIDC login is enabled (`configs.oidc.enabled: true`), requests require an OIDC ID token passed as `Authorization: Bearer <id_token>`.
- **Documentation Links**:
  - [TrueForge Quickstart](https://trueforge.dev/quickstart)
  - [SDK Quickstart](https://trueforge.dev/api/quickstart)

---

## 2. Defining an Agent & Loading from Repo

### Agent Definition Formats
An agent is defined by an **Agent Spec** (`manifest`):
1. **Saved Agent (Persistent)**: Registered in the TrueForge catalog via:
   - UI: **Build Agent** page (`http://localhost:8790/build-agent`) -> **Save Agent**.
   - API: `POST /api/v1/agents` or SDK `client.agents.create({ name, description, manifest })`.
2. **Inline Agent Spec (Session-scoped)**: Passed directly when creating a session without saving to the registry:
   - `client.sessions.create({ agent: { spec: agentSpec } })`.

### Full Agent Spec Schema
```json
{
  "model": {
    "name": "anthropic/claude-sonnet-4-6",
    "params": {
      "temperature": 0.2,
      "max_tokens": 4096
    }
  },
  "instructions": "You are an expert coding assistant in VS Code...",
  "mcp_servers": [
    {
      "name": "vscode-ide",
      "enable_tools": ["@all"],
      "require_approval_for_tools": ["propose_edit", "run_command"],
      "preload": false,
      "preload_tools": []
    }
  ],
  "skills": [],
  "config": {
    "sandbox": { "enabled": false },
    "web_search": { "enabled": false },
    "generative_ui": { "enabled": false },
    "ask_user_questions": { "enabled": true },
    "dynamic_sub_agents": { "enabled": true },
    "context_management": {
      "compaction": {
        "enabled": true,
        "trigger": { "type": "input_tokens", "value": 80000 }
      },
      "large_tool_response": { "enabled": true }
    },
    "iteration_limit": 100
  }
}
```

### Loading from a File in the Extension Repo
1. Keep `agent.config.json` in the extension repository root or assets.
2. At runtime, the extension reads and parses `agent.config.json`:
   ```typescript
   import * as fs from 'node:fs';
   import * as path from 'node:path';

   const configPath = path.join(extensionContext.extensionPath, 'agent.config.json');
   const agentSpec = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
   ```
3. Pass `agentSpec` either:
   - **Inline (Recommended)**: Pass directly to `client.sessions.create({ agent: { spec: agentSpec } })`. This avoids collisions in the shared registry and requires zero prior manual agent creation.
   - **Registered**: Upsert using `client.agents.create` or `PUT /api/v1/agents/{id}` if persistent catalog visibility in the UI is desired.
- **Documentation Links**:
  - [Create an Agent](https://trueforge.dev/create-agent/overview)
  - [Agent Spec Reference](https://trueforge.dev/create-agent/overview#the-full-agent-spec)

---

## 3. Session Creation, Turns, Streaming, and Event Shapes

### Client Installation
```bash
npm install @truefoundry/trueforge-sdk
```

### Complete Code Sample
```typescript
import {
  TrueForge,
  TrueForgeApi,
  isEventDelta,
  mergeEventDelta,
} from '@truefoundry/trueforge-sdk';

const client = new TrueForge({
  baseUrl: 'http://localhost:8790',
  timeoutInSeconds: 600,
});

// 1. Create Session
const { data: session } = await client.sessions.create({
  agent: { spec: agentSpec }, // or { name: 'saved-agent-name' }
});

// 2. Stream Turn
const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
let turnId: string | undefined;
let lastEventId: string | undefined;

const stream = await client.sessions.createTurnStream(session.id, {
  input: [
    {
      type: 'user.message',
      content: 'Refactor helper function get_debug_flag in helpers.py',
    },
  ],
});

for await (const event of stream) {
  lastEventId = event.id;

  if (event.type === 'turn.created') {
    turnId = event.turnId;
  }

  // Model output arrives as a base model.message followed by model.message.delta fragments
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) mergeEventDelta(base, event);
    if (event.type === 'model.message.delta') {
      // Stream token to VS Code UI
      process.stdout.write(event.content ?? '');
    }
  } else {
    events.set(event.id, event);
  }

  if (event.type === 'tool.approval_required') {
    // Handle human-in-the-loop tool approval
  }

  if (event.type === 'turn.update' && event.state.status === 'paused') {
    // Turn paused waiting for user input / approval / question
    break;
  }

  if (event.type === 'turn.done') {
    console.log('Turn completed with status:', event.state.status);
    // event.state: TurnStateDone | TurnStateCancelled | TurnStateError
  }
}
```

### Event Names and Shapes
- **Lifecycle Events**:
  - `turn.created`: `{ turnId, previousTurnId, input, state: { status: 'running' } }`
  - `turn.update`: `{ state: { status: 'paused' | 'running', metrics?: { total_tokens, total_cost_in_usd } } }`
  - `turn.done`: `{ state: { status: 'done' | 'cancelled' | 'error', output?, completed_at?, reason?, message?, metrics? } }`
- **Model Messages & Deltas**:
  - `model.message`: Assistant message containing `content`, `toolCalls`, `usage`, `finishReason`.
  - `model.message.delta`: Incremental content or tool argument chunks sharing the same `id`.
- **Tool Events**:
  - `tool.response`: Result of executed tool, linked by `toolCallId`.
  - `tool.approval_required`: Contains `toolCalls: [{ id, sourceEventId }]` where `sourceEventId` references the triggering `model.message`.
  - `tool.response_required`: Emitted for client-side tools like `ask_user_question`.
- **Subagent Events**:
  - `thread.created`: Subagent thread spawned (`threadId`, `title`, `agentInfo`, `parent`).
  - `thread.done`: Subagent completed (`state: { status: 'done' | 'error' }`).
- **Environment Events**:
  - `mcp.initialize`: Active MCP server connections.
  - `mcp.auth_required`: Outbound OAuth needed (`mcpServers: [{ id, name, authUrl }]`).
  - `sandbox.created`: Emitted when an isolated sandbox is provisioned.
- **Documentation Links**:
  - [Use an Agent](https://trueforge.dev/api/use-agent)
  - [Turn Events Reference](https://trueforge.dev/api/use-agent#turn-events-reference)

---

## 4. Cancelling / Interrupting a Running Turn

- **API / SDK Method**:
  ```typescript
  await client.sessions.cancel(sessionId);
  ```
- **Behavior & Guarantees**:
  - Idempotent and immediate.
  - Works whether the turn is actively `running` or `paused` waiting for approval/input.
  - Aborts the in-flight model generation request.
  - Waits for any in-flight MCP tool executions to cleanly finish before closing.
  - Closes the SSE stream gracefully: emits a terminal `turn.done` with `state: { status: 'cancelled', reason: 'client-cancelled' }`.
  - Does NOT delete the session; subsequent turns can be chained on the history up to the cancellation.
- **Documentation Links**:
  - [Cancel a Turn](https://trueforge.dev/api/use-agent#cancel-a-turn)

---

## 5. Registering an MCP Server for Extension Tools

- **Supported Transports**:
  - **Supported**: Remote HTTP transports — **Streamable HTTP** (`streamable-http`) and **Server-Sent Events** (`sse`). Probing order in TrueForge is `streamable-http` first, fallback to `sse`.
  - **NOT Supported**: `stdio` is **not supported** by the TrueForge server for local agents. The TrueForge server expects a network URL endpoint (`http://...` or `https://...`).
- **Architecture for VS Code Extension**:
  1. The VS Code extension starts a local lightweight HTTP/SSE MCP server (e.g., using `@modelcontextprotocol/sdk/server/streamableHttp.js` or `sse.js` on `http://127.0.0.1:<port>/mcp`).
  2. The extension registers this endpoint with TrueForge.
- **How to Register the MCP Server**:
  - **Via Settings API / SDK**:
    ```typescript
    await client.settings.mcpServers.create({
      manifest: {
        type: 'remote',
        name: 'vscode-ide',
        url: `http://127.0.0.1:${port}/mcp`,
        description: 'VS Code editor tools for reading files, proposing edits, and running commands',
      },
    });
    ```
    *(Or `PUT /api/v1/settings/mcp-servers` to upsert without conflict).*
  - **Via UI**: Settings -> Connectors -> **Add MCP Server** (`http://localhost:8790/settings/connectors`).
- **Attaching to the Agent**:
  In the agent spec:
  ```json
  "mcp_servers": [
    {
      "name": "vscode-ide",
      "enable_tools": ["@all"],
      "preload": false
    }
  ]
  ```
- **Documentation Links**:
  - [Setup MCP Servers](https://trueforge.dev/mcp-servers)
  - [MCP Server Schema](https://trueforge.dev/create-agent/overview#mcp_servers)

---

## 6. Tool Approval Workflow (Human-in-the-Loop)

- **Requiring Approval**:
  - An agent can gate tools in `require_approval_for_tools`. Options:
    - `@write`: Tools labeled write.
    - `@destructive`: Tools labeled destructive.
    - `@all`: Every tool call requires approval.
    - Literal tool names: e.g. `["propose_edit", "run_command"]`.
- **Approval Flow & Events**:
  1. When the agent attempts to invoke a gated tool, the engine emits `tool.approval_required`:
     ```json
     {
       "type": "tool.approval_required",
       "id": "event-ulid",
       "thread_id": "main",
       "tool_calls": [
         { "id": "call_123", "source_event_id": "msg_456" }
       ]
     }
     ```
  2. The turn stream emits `turn.update` with `state: { status: "paused" }`.
  3. The client inspects the source event (`msg_456`) in its event index to find tool name and arguments.
  4. The client presents the diff/action to the user.
  5. The client subscribes to the turn and posts the user's decision via `createTurnEvents`:
     ```typescript
     // 1. Subscribe before sending
     const resume = await client.sessions.subscribeToTurn(
       sessionId,
       turnId,
       { afterEventId: lastEventId },
       { timeoutInSeconds: 600 }
     );

     // 2. Post approval or denial
     await client.sessions.createTurnEvents(sessionId, turnId, {
       events: [
         {
           type: 'user.tool_approval',
           threadId: pending.threadId,
           toolCallId: 'call_123',
           approval: { status: 'allow' }, // or { status: 'deny', reason: 'User rejected the hunk' }
         },
       ],
     });

     // 3. Continue reading the resume stream
     for await (const event of resume) {
       // Turn continues execution
     }
     ```
- **Documentation Links**:
  - [Tool Approvals Guide](https://trueforge.dev/api/use-agent#tool-approvals)
  - [Tool Approval Concepts](https://trueforge.dev/create-agent/overview#tool-approval)

---

## 7. Model Providers & Multi-Model / Fallback Strategy

- **Configuring Providers in TrueForge**:
  - Configured once in TrueForge under **Settings → Models** (`http://localhost:8790/settings/models`) or via `POST /api/v1/settings/model-providers`.
  - Supported providers: `openai`, `anthropic`, `google-gemini`, `fireworks`, `together`, `moonshot`, `zai`, `alibaba`, and `custom` (any OpenAI-compatible endpoint).
- **Built-in Fallback Status**:
  - **There is NO built-in automatic model fallback in TrueForge today.** Each agent definition accepts a single model (`model: { name: "provider/model" }`). Automatic multi-model fallback is documented as planned for future releases.
- **Best Ways to Implement Fallback**:
  1. **Client-Side Fallback (Extension Level)**:
     - The extension maintains a prioritized list of model FQNs (e.g. `[config.primaryModel, config.secondaryModel]`).
     - If turn creation or execution fails with a model/provider error (`turn.done` with `status: 'error'`, or HTTP 429/500), the extension creates a new session or updates the inline agent spec to the fallback model and retries the prompt.
  2. **Upstream Gateway Fallback**:
     - Configure TrueForge's `custom` provider to point to an OpenAI-compatible model proxy (e.g. LiteLLM, TrueFoundry AI Gateway, or OpenRouter) that manages multi-provider routing and automatic failover transparently behind a single endpoint.
- **Documentation Links**:
  - [Setup Models](https://trueforge.dev/models)

---

## 8. Subagents, Deferred Tool Loading, Code Mode, and Compaction

### How Each is Enabled
| Feature | How to Enable in Agent Spec | Prerequisites |
| :--- | :--- | :--- |
| **Subagents** | `"config": { "dynamic_sub_agents": { "enabled": true } }` *(on by default)* | None |
| **Deferred Tool Loading** | In `mcp_servers`: `"preload": false` *(default is false)* | None |
| **Code Mode** | `"config": { "sandbox": { "enabled": true } }` | Requires Daytona sandbox provider configured in Settings |
| **Context Compaction** | `"config": { "context_management": { "compaction": { "enabled": true, "trigger": { "type": "input_tokens", "value": 80000 } } } }` *(on by default)* | None |

### Which is Easiest to Demonstrate in a Session?
1. **Deferred Tool Loading (Easiest & Most Reliable)**:
   - Requires zero external credentials or sandboxes.
   - When an MCP server is attached with `preload: false`, the model only receives meta-tools (`list_tools`, `get_tool_info`, `call_tool`).
   - In any turn invoking a tool, the inspector/UI shows the meta-tool discovery sequence before the final invocation.
2. **Subagents (Most Visually Compelling)**:
   - Requires zero external infrastructure.
   - When given a prompt like `"Inspect file A and file B in parallel, then summarize"`, the agent calls `create_sub_agent`, and the SSE stream produces separate `thread.created` and `thread.done` events visible as separate sub-threads in the UI timeline.
3. *Note on Code Mode*: Requires an active Daytona sandbox provider API key in TrueForge Settings.
- **Documentation Links**:
  - [Subagents](https://trueforge.dev/key-features/subagents)
  - [Deferred Tool Loading](https://trueforge.dev/key-features/deferred-tool-loading)
  - [Code Mode](https://trueforge.dev/key-features/code-mode)
  - [Context Compaction](https://trueforge.dev/key-features/overview#context-compaction)

---

## 9. Session Inspection (UI & API) for Demonstrations

### Inspecting via TrueForge UI
- Open `http://localhost:8790` and click **Sessions** in the sidebar (`http://localhost:8790/sessions`).
- Features available in the UI:
  - **Sessions List**: Filter by agent and time window; displays status, duration, and turn count.
  - **Summary Metrics**: Totals for Turns, Duration, Total Tokens, Context Size, Tool Calls, Sub-agents, and Errors.
  - **Event Timeline**: Color-coded timeline distinguishing System, User, Model, Tool call, and Sub-agent threads.
  - **Turn-by-Turn Transcript**: Full input/output with expandable **Agent steps** showing raw tool arguments, tool results, and execution time.

### Inspecting via API / SDK
- **List Sessions**:
  ```typescript
  for await (const session of await client.sessions.list()) {
    console.log(session.id, session.createdAt);
  }
  ```
- **List Turns in Session**:
  ```typescript
  for await (const turn of await client.sessions.listTurns(sessionId)) {
    console.log(turn.id, turn.state.status, turn.state.output?.content);
  }
  ```
- **Replay / Inspect Detailed Turn Events (with pre-merged tool calls)**:
  ```typescript
  for await (const event of await client.sessions.listTurnEvents(sessionId, turnId, { order: 'asc' })) {
    if (event.type === 'model.message') {
      console.log('Tool calls made:', event.toolCalls);
    }
    if (event.type === 'tool.response') {
      console.log('Tool result:', event.content);
    }
  }
  ```
- **Documentation Links**:
  - [Sessions UI Guide](https://trueforge.dev/sessions)
  - [Replay a Turn via SDK](https://trueforge.dev/api/use-agent#replay-a-turn)

---

## Open Questions for User

1. **Local MCP Server Port & Transport**:
   - Would you prefer our extension's local MCP server to listen on a fixed port (e.g., `8795`) or dynamically select an open ephemeral port and register itself with TrueForge on extension activation?
   - We will implement Streamable HTTP / SSE as required by TrueForge's MCP client.
2. **TrueForge Agent Configuration Model**:
   - Should the extension define its agent using an **inline spec** on each session create (clean, self-contained, no state pollution), or register a named agent (`"forge-agent"`) into TrueForge's persistent registry so it appears in the TrueForge UI Agents library?
3. **Model Choice & Fallback Defaults**:
   - Which model(s) do you currently have configured in your local TrueForge instance (`http://localhost:8790/settings/models`) to set as the default in `config.example.json`?
