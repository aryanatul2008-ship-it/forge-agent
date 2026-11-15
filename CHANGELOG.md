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
- Implemented read-only editor MCP tools in `src/mcp/` and `src/context/`:
  - `list_dir`: workspace directory listing with recursive depth, file types, and size annotations.
  - `read_file`: targeted 1-indexed line-range reading (`start_line`, `end_line`), path alias resilience, and context budgeting.
  - `search_workspace`: text and regex search with relevance-ranked snippets, file paths, line numbers, and surrounding context.
  - `find_symbol`: workspace symbol lookup using VS Code symbol provider with Python regex definition fallback for functions, classes, and variables.
  - Verified live agent test against Flask repository (`scripts/test-flask-agent.ts`): agent located `get_debug_flag` in `src/flask/helpers.py:28` using deferred tool loading (`list_tools`, `get_tool_info`, `find_symbol`, `read_file`).
- Implemented in-memory diff review engine and staging store in `src/review/`:
  - `src/review/diff.ts`: Line-level Myers/LCS diff algorithm computing structured `DiffHunk` records, plus reverse-order `applyPartialHunks` engine.
  - `src/review/diffReview.ts`: In-memory staging store holding proposed edits per file (never written to disk before confirmation); handles multiple files in one run, repeated edits to the same file, and stale file conflict detection.
  - `src/review/history.ts`: `UndoHistoryStack` tracking prior file snapshots for clean reverts.
  - Contributed commands `"TF Agent: Undo Last Applied Change"` (`forgeAgent.undoLastChange`, `tfAgent.undoLastChange`) to revert applied agent edits.
  - `src/review/virtualDocProvider.ts`: `forge-proposed:` TextDocumentContentProvider enabling native side-by-side diff review via `vscode.diff`.
  - Enhanced Webview UI (`src/webview/agentPanel.ts`) with interactive Diff Review Cards featuring per-hunk Accept/Reject toggles, Accept All, Reject All, Open Diff View, and approval submission driven by TrueForge tool gating.
  - Unit test suite (`scripts/test-review.ts`, `npm test`): Verified single/multiple hunks, insertions, deletions, identical text, partial apply combinations, multi-file staging, repeated edits, stale conflict detection, and undo stack.
- Implemented Inline Edit feature in `src/editor/inlineEdit.ts`:
  - Contributed `Ctrl+K` (Windows/Linux) / `Cmd+K` (macOS) keybinding for `forgeAgent.inlineEdit` when `editorTextFocus`.
  - Captures selected text, line ranges, and surrounding context, presenting a focused input prompt for instructions.
  - Streams token deltas and tool execution progress in the VS Code status bar with immediate `Esc` / click cancellation.
  - Side-by-side in-editor diff view (`vscode.diff`) with quick-action review options (Accept All, Reject All, Individual Hunk Review) driven by TrueForge tool approvals.
- Executed and verified Task A on Flask repository (`scripts/test-task-a.ts`, `npm run test:task-a`):
  - Performed inline edit on `src/flask/helpers.py` (`get_debug_flag`) with instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."
  - Agent called `propose_edit` with updated condition and docstring.
  - Verified with Python runtime: `FLASK_DEBUG=off` returned `False`, `FLASK_DEBUG=n` returned `False`, `FLASK_DEBUG=1` returned `True`.
  - Ran Flask test suite: all 5 pytest tests in `tests/test_helpers.py -k test_get_debug_flag` passed cleanly.
  - Verified clean revert via `"TF Agent: Undo Last Applied Change"`, restoring working tree to clean state.

