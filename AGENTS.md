# AGENTS.md — Permanent Rules & Project Guidelines

Project: VS Code Coding Agent Extension for TrueFoundry Forge-a-thon

---

## 1. Goal

Build a VS Code coding agent extension (TypeScript).
- The agent loop **MUST run on TrueForge** ([github.com/truefoundry/trueforge](https://github.com/truefoundry/trueforge)) in local mode.
- The extension is **only a CLIENT** of a TrueForge agent: it creates sessions, sends turns, and renders streamed events via the TrueForge TypeScript SDK or HTTP API.
- TrueForge UI: `http://localhost:8790`

---

## 2. Hard Rules

1. **No Direct Model Provider Calls**: The extension must NEVER call a model provider directly. Models are configured only in TrueForge.
2. **MCP Tool Architecture**: Editor capabilities (`read_file`, `search_workspace`, `find_symbol`, `propose_edit`, `run_command`) are exposed to the agent as MCP tools from a local MCP server started by the extension. The agent decides what to read and change.
3. **Safe Propose-Edit Workflow**: `propose_edit` NEVER writes directly to disk. It stages changes in memory; the user reviews and accepts/rejects each hunk; only upon confirmation is it applied via VS Code `WorkspaceEdit`, and it must be fully undoable.
4. **Clean Cancellation**: Cancelling a run must leave the workspace untouched (no partial or half-applied edits).
5. **No Secrets in Repo**: No API keys or secrets in the repo. Always ship `config.example.json`.
6. **Provider Agnostic**: Must work seamlessly with any model configured in TrueForge. Never hard-code a provider.
7. **Original Architecture**: Do not fork or copy another project's agent loop.
8. **Documentation First**: Before writing integration code, read the real TrueForge docs. Never guess API names or schemas.

---

## 3. Test Tasks

- **Task A (Inline Edit)**: Inline edit on `src/flask/helpers.py` (`get_debug_flag`).
- **Task B (Agent Mode)**: Agent mode adding a `flask config` CLI command touching 3+ files, none named by the user.
- **Task C (Resilience)**: Resilience verification with a bad endpoint/key, ensuring workspace remains completely unchanged.

---

## 4. Development Workflow & Change Tracking

- **Changelog**: Maintain `CHANGELOG.md` with a short, descriptive entry per step.
- **Git Commits**: Commit with clear, conventional messages after each step.

---

## 5. Environment & Platform Rules

- **Platform**: Developer is on Windows using PowerShell (not bash).
- **Shell Execution**: `run_command` must execute via PowerShell. Never assume `&&`, Unix shell builtins, or Linux-style paths.
- **File Paths**: Always use `path.join` and `vscode.Uri` for cross-platform path handling.
- **Python / Virtual Environment**: The Flask venv is activated with `.venv\Scripts\Activate.ps1`.

---

## 6. Architecture & Design Decisions

1. **Diff Review via TrueForge Approval**:
   - The agent spec configures `require_approval_for_tools: ["propose_edit", "run_command"]`.
   - On `tool.approval_required`, read the call arguments from the referenced `model.message`.
   - Show the per-hunk diff (or command) in the editor UI.
   - Collect per-hunk user decisions in an extension-side map keyed by `tool_call_id`.
   - Send `user.tool_approval` with `allow` (if at least one hunk was accepted) or `deny` with a descriptive reason.
   - When the `propose_edit` MCP tool subsequently executes, it applies ONLY the accepted hunks via VS Code `WorkspaceEdit` and returns a result summarizing applied vs. rejected hunks. No writes happen before approval.
2. **Cancel Safety**:
   - On cancel, immediately invoke `client.sessions.cancel(sessionId)` AND close open diff views, discard staged edits in memory, kill running child processes/commands, and resolve pending MCP tool calls so the turn concludes cleanly.
   - Ensure git status remains pristine after any cancellation.
3. **Client-Side Fallback**:
   - Maintain an ordered list of models in `config.json`.
   - On transient failure, retry with exponential backoff (max 2 retries).
   - If a model fails permanently or endpoint/key is invalid (handling both HTTP errors and `turn.done` status `"error"`), recreate the session with the next fallback model in the list and replay the request.
4. **Context Budgeting**:
   - Editor MCP tools (`read_file`, `search_workspace`, `find_symbol`, `run_command`) must strictly cap output at ~3,500 tokens (well below TrueForge's 6,000-token offloading threshold), because local sandboxes are unavailable on Windows.
   - Results exceeding the budget must be ranked and truncated with clear notice of what was cut.
5. **Context-Engineering Feature Selection**:
   - Of TrueForge's features, **Deferred Tool Loading** (`preload: false` on MCP servers) and **Dynamic Subagents** (`config.dynamic_sub_agents.enabled: true`) function without requiring an external sandbox on Windows.
   - Recommended for visible session demo: **Deferred Tool Loading** (clearly visible in turn events via meta-tools `list_tools`, `get_tool_info`, `call_tool`) and **Dynamic Subagents** (visible via `thread.created` / `thread.done` parallel threads).
6. **Model FQN Format**:
   - All models configured in `config.json` and agent specs must use Fully Qualified Names (FQNs), e.g. `google-gemini/gemini-3-1-flash-lite`.
