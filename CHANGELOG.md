# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Created `AGENTS.md` specifying permanent project rules, architecture requirements, test tasks, and environment constraints for the TrueForge VS Code agent extension.
- Finalized architecture and design decisions in `AGENTS.md` and `NOTES.md` covering diff review via TrueForge approval, cancel safety, client-side fallback, context budgeting, and Windows-compatible context engineering.
- Verified live local TrueForge instance (`http://localhost:8790`), confirmed active model `google-gemini/gemini-3-1-flash-lite`, and verified that inline-spec sessions appear in TrueForge's Sessions UI.
- Scaffolding of extension project:
  - `package.json` with `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, esbuild bundling, and ts-node/typescript tooling.
  - `tsconfig.json` configured for Node ES2022.
  - `config.example.json` with `trueforgeUrl`, `mcpPort`, and ordered FQN models list (`google-gemini/gemini-3-1-flash-lite`).
  - `agent/agent.config.json` containing base agent spec with `vscode-ide` MCP server, Windows-compatible context compaction, and `require_approval_for_tools: ["propose_edit", "run_command"]`.
  - Minimal entry point `src/extension.ts` verified to bundle cleanly into `dist/extension.js`.
  - Agent registry script `scripts/register-agent.ts` with placeholder MCP registration and automatic update handling (`npm run register-agent`).
- End-to-end smoke test `scripts/smoke-test.ts` (`npm run smoke-test`):
  - Verified local in-memory MCP server with bearer authentication and SSE transport.
  - Verified dynamic registration of remote MCP server in TrueForge settings via SDK `client.settings.mcpServers.createOrUpdate`.
  - Verified inline-spec session creation with tool gating via `require_approval_for_tools`.
  - Verified live interception of `tool.approval_required`, tool call inspection, and dispatch of `user.tool_approval` (allow) via `client.sessions.createTurnEvents`, followed by tool execution and successful `turn.done`.
  - Verified turn cancellation via `client.sessions.cancel`, confirmed by `turn.done` with `status: "cancelled"` and `reason: "client-cancelled"`.
- Documented TrueForge SSRF policy requirement (`OUTBOUND_URL_ALLOWED_HOSTS` or `NETWORK_POLICY_ENABLED=false`) in `NOTES.md` for local loopback MCP servers.
- Full architectural scaffolding across modular subdirectories:
  - `src/trueforge/`: `TrueForgeClient` wrapper implementing session creation, turn streaming, cancellation, and tool approvals via `@truefoundry/trueforge-sdk`.
  - `src/mcp/`: `LocalMcpServer` and `executeEditorTool` exposing editor capabilities (`read_file`, `search_workspace`, `find_symbol`, `propose_edit`, `run_command`) with bearer authentication and dynamic port fallback.
  - `src/review/`: `DiffReviewEngine` providing in-memory staging for proposed edits, per-hunk user decisions, and safe atomic `WorkspaceEdit` application.
  - `src/context/`: `WorkspaceRetrieval` and `enforceContextBudget` enforcing a strict ~3,500 token limit with truncation annotations on Windows.
  - `src/webview/`: `AgentPanelProvider` implementing a VS Code WebviewViewProvider showing initial state `ready`.
  - Added command `"TF Agent: Open Panel"` (`forgeAgent.openPanel`) and contributed TrueForge URL/port/models settings.
  - Added `.vscode/launch.json` and `.vscode/tasks.json` supporting F5 Extension Development Host launching with preLaunch `npm: build` task.
  - Updated `README.md` with full architecture documentation, setup instructions, and command reference.
- Implemented full `TrueForgeClient` in `src/trueforge/client.ts` using `@truefoundry/trueforge-sdk`:
  - Session lifecycle management (`createSession`, `getOrCreateSession`, `resetSession`) with inline agent spec.
  - Asynchronous event streaming (`streamTurn`) forwarding token deltas, tool calls, tool results, approvals, and terminal state (`turn.done`).
  - Integrated `AbortController` and instant backend cancellation (`cancelTurn`).
  - Tool approval dispatch (`sendToolApproval`) supporting allow/deny decisions.
- Enhanced Webview Chat UI in `src/webview/agentPanel.ts` and `src/webview/types.ts`:
  - Real-time status badge and indicator (`Ready`, `Streaming...`, `Tool Call`, `Cancelled`, `Error`).
  - Message stream supporting user chat bubbles, incremental assistant markdown rendering, collapsible tool call cards with JSON arguments, tool results, and error banners.
  - Interactive multiline input box with Enter to send / Shift+Enter for newlines, Send button, and an immediate Cancel button that toggles during turn execution.
- Connected extension host in `src/extension.ts` ensuring non-blocking asynchronous execution between VS Code, webview panel, and TrueForge client.
- Added live automated verification scripts:
  - `scripts/test-plain-turn.ts`: Validated plain question ("What is 15 * 4? Answer in one sentence.") streaming response ("15 * 4 equals 60.") through TrueForge on `http://localhost:8791`.
  - `scripts/test-client-cancel.ts`: Validated immediate turn cancellation during token generation, receiving `turn.done` with `status: "cancelled"` and `reason: "client-cancelled"`.

