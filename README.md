# Forge Agent: VS Code Coding Agent Extension

Forge Agent is a VS Code extension that connects the developer directly to an autonomous agent loop running in **[TrueForge](https://github.com/truefoundry/trueforge)** (local mode).

The extension functions purely as a **CLIENT** of TrueForge: it creates sessions, streams turns over Server-Sent Events (SSE), and renders streamed updates in an integrated sidebar panel.

---

## Architecture & Principles

1. **Client-Only Architecture**: The extension never contacts model providers directly. All model configurations, provider credentials, and agent orchestration loops reside within TrueForge.
2. **Local MCP Tool Server**: The extension hosts a local in-memory Model Context Protocol (MCP) server bound to `127.0.0.1` with a dynamic bearer token, exposing editor capabilities (`read_file`, `search_workspace`, `find_symbol`, `propose_edit`, `run_command`) via SSE transport.
3. **Safe Propose-Edit Review Workflow**: The `propose_edit` tool never touches disk prior to explicit user confirmation. Diff hunks are staged in memory; users accept or reject each hunk; only accepted hunks are applied via VS Code `WorkspaceEdit` with full undo support.
4. **Clean Cancellation**: Cancelling a turn immediately cancels the session turn in TrueForge (`sessions.cancel`), discards all in-memory staged hunks, terminates active child processes, and leaves git status pristine.
5. **Context Budgeting**: Output from editor retrieval tools is strictly capped at ~3,500 tokens with transparent truncation notices to preserve the model context window on Windows environments.
6. **Provider & Model Agnostic**: Supports any model configured in TrueForge using Fully Qualified Names (FQNs) like `google-gemini/gemini-3-1-flash-lite`, with configurable client-side fallback.

---

## Directory Structure

```text
forge-agent/
├── .vscode/
│   ├── launch.json              # F5 Launch configuration (Extension Host)
│   └── tasks.json               # Pre-launch build task
├── agent/
│   └── agent.config.json        # Base TrueForge agent specification (inline spec)
├── scripts/
│   ├── register-agent.ts        # Script to register agent in TrueForge registry
│   └── smoke-test.ts            # End-to-end approval & cancellation smoke test
├── src/
│   ├── context/                 # Retrieval & context token budgeting (~3,500 cap)
│   │   ├── budget.ts
│   │   └── retrieval.ts
│   ├── mcp/                     # Local in-memory MCP server with Bearer auth
│   │   ├── server.ts
│   │   └── tools.ts
│   ├── review/                  # Safe diff review & per-hunk staging engine
│   │   ├── diffReview.ts
│   │   └── types.ts
│   ├── trueforge/               # TrueForge SDK client wrapper & fallback logic
│   │   ├── client.ts
│   │   └── types.ts
│   ├── webview/                 # Agent chat panel UI provider
│   │   ├── agentPanel.ts
│   │   └── types.ts
│   └── extension.ts             # VS Code extension activation entry point
├── config.example.json          # Template configuration
├── NOTES.md                     # Verified TrueForge API & SDK reference facts
├── AGENTS.md                    # Permanent project rules & architecture guidelines
└── package.json                 # Extension manifest & scripts
```

---

## Prerequisites & Setup

### 1. Start TrueForge Locally

TrueForge runs by default at `http://localhost:8790`.

> [!IMPORTANT]
> **Local MCP Loopback Setting**: By default, TrueForge includes an outbound SSRF guard that restricts private IP access (`127.0.0.1`). When starting TrueForge to work with local MCP servers, allow loopback hosts or disable network policy:
>
> In PowerShell:
> ```powershell
> $env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'; npx @truefoundry/trueforge
> ```
> Or:
> ```powershell
> $env:NETWORK_POLICY_ENABLED = "false"; npx @truefoundry/trueforge
> ```

### 2. Configure Model

Ensure your preferred model provider (e.g. Google Gemini) is configured in TrueForge at `http://localhost:8790/settings/model-providers`.

---

## Development & Running (F5)

1. Open this repository in VS Code:
   ```powershell
   code c:\dev\forge-agent
   ```
2. Install dependencies:
   ```powershell
   npm install
   ```
3. Press **`F5`** (or select **Run Extension** in the Run & Debug view).
   - This runs the pre-launch `npm: build` task via `esbuild`.
   - A new Extension Development Host window will launch with Forge Agent loaded.
4. In the Extension Development Host window:
   - Click the **Forge Agent** icon in the Activity Bar, or run the Command Palette command:
     `TF Agent: Open Panel` (`Ctrl+Shift+P` -> `TF Agent: Open Panel`).
   - The panel displays status `ready`.

---

## Available Commands & Scripts

- **`TF Agent: Open Panel`** (`forgeAgent.openPanel`): Opens and focuses the Forge Agent sidebar chat panel.
- **`Forge Agent: Cancel Turn`** (`forgeAgent.cancelTurn`): Immediately halts any running turn and purges in-memory staged diff hunks.
- **`npm run build`**: Bundles `src/extension.ts` with `esbuild` into `dist/extension.js`.
- **`npm run compile`**: Runs TypeScript type checking via `tsc`.
- **`npm run register-agent`**: Registers `forge-agent` into TrueForge's permanent agent registry.
- **`npm run smoke-test`**: Runs the live end-to-end verification test (MCP tool approval + turn cancellation) against TrueForge.

---

## Configuration Settings

Available under VS Code Settings (`Ctrl+,` -> search `Forge Agent`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `forgeAgent.trueforgeUrl` | `http://localhost:8790` | URL of the local TrueForge instance. |
| `forgeAgent.mcpPort` | `8795` | Desired port for the local MCP server (auto-falls back if busy). |
| `forgeAgent.models` | `["google-gemini/gemini-3-1-flash-lite", ...]` | Ordered list of model FQNs for client-side fallback. |
