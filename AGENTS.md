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
