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

