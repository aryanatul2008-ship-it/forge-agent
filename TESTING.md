# Forge Agent — Comprehensive Testing Guide & Manual Checklists

This document provides complete instructions for executing the automated verification test suites and step-by-step manual checklists for **Task A (Inline Edit)**, **Task B (Agent Mode)**, and **Task C (Resilience & Error Recovery)**.

---

## 1. Environment & Prerequisites

### 1.1 Local TrueForge Server
TrueForge must be running locally with loopback SSRF access permitted so it can communicate with the extension's local MCP server:
```powershell
# In a separate PowerShell window:
$env:PORT="8790"
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
$env:NETWORK_POLICY_ENABLED="false"
npx --yes @truefoundry/trueforge
```
- TrueForge UI: `http://localhost:8790`
- Active model: `google-gemini/gemini-3-1-flash-lite`

### 1.2 Target Flask Workspace
The Flask repository should be located at `C:\dev\flask` with its virtual environment activated:
```powershell
cd C:\dev\flask
.venv\Scripts\Activate.ps1
```

### 1.3 Running the VS Code Extension
Open `c:\dev\forge-agent` in VS Code:
1. Run `npm install` and `npm run compile`.
2. Press **F5** (or open the Run & Debug view and select **"Launch Extension"**).
3. In the new **[Extension Development Host]** window that opens, open the workspace folder `C:\dev\flask`.

---

## 2. Automated Test Suite Reference

All automated tests run via `npm run <script>` in `c:\dev\forge-agent`:

| Command | Purpose | Verification Focus |
| :--- | :--- | :--- |
| `npm test` | Diff Review Engine | Myers hunk computation, partial hunk apply, undo history stack, stale file detection. |
| `npm run test:context` | Context & Retrieval | Okapi BM25 scoring, code tokenization, `@file`/`@symbol` parsing & autocomplete, budget caps. |
| `npm run test:resilience` | Resilience & Fallback | Exponential backoff (max 2 retries), model fallback, human-readable errors (no stack traces). |
| `npm run test:audit` | Full System Audit | Mid-stream cancel, pending review cancel, command kill, undo after accept, large/binary files. |
| `npm run test:task-a` | Task A Verification | Live inline edit on `src/flask/helpers.py`, runtime check (`FLASK_DEBUG=off`), pytest suite. |
| `npm run test:task-b` | Task B Verification | Live autonomous agent mode adding `flask config`, 3+ file edits, pytest suite. |

---

## 3. Manual Checklist: Task A (Inline Edit)

### Goal
Perform an inline edit on `src/flask/helpers.py` (`get_debug_flag`) with no disk writes prior to user approval, verify behavior with python runtime and pytest, and test undo.

- [ ] **Step 1: Open Target File**
  - In the Extension Development Host window, open `src/flask/helpers.py`.
- [ ] **Step 2: Select Target Code**
  - Highlight the `get_debug_flag()` function definition (lines ~28 to 40).
- [ ] **Step 3: Trigger Inline Edit**
  - Press `Ctrl+K` (or `Cmd+K` on macOS), or open the Command Palette (`Ctrl+Shift+P`) and run **"TF Agent: Inline Edit"**.
- [ ] **Step 4: Enter Instruction**
  - Type the following instruction into the prompt input box:
    ```
    Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
    ```
  - Press `Enter`.
- [ ] **Step 5: Inspect Streaming Progress**
  - Observe the status bar in the bottom right:
    - `$(sync~spin) Forge Agent: Streaming edit (~... tokens)...`
    - Changes to `$(tools) Forge Agent: Preparing proposed edit...` when the agent calls `propose_edit`.
- [ ] **Step 6: In-Editor Diff Review**
  - A side-by-side diff editor opens automatically (`Review: src/flask/helpers.py`).
  - A QuickPick appears with review choices:
    - **Accept All Hunks**
    - **Reject All Hunks**
    - **Review Individual Hunks**
  - Choose **Accept All Hunks**.
- [ ] **Step 7: Verify Python Runtime Behavior**
  - In the terminal:
    ```powershell
    cd C:\dev\flask
    $env:FLASK_DEBUG="off"; .venv\Scripts\python.exe -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
    # Expected: False

    $env:FLASK_DEBUG="n"; .venv\Scripts\python.exe -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
    # Expected: False

    $env:FLASK_DEBUG="1"; .venv\Scripts\python.exe -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
    # Expected: True
    ```
- [ ] **Step 8: Run Pytest**
  - In the terminal:
    ```powershell
    .venv\Scripts\pytest tests/test_helpers.py -k test_get_debug_flag -q
    # Expected: 5 passed
    ```
- [ ] **Step 9: Test Undo**
  - Open Command Palette (`Ctrl+Shift+P`) and run **"TF Agent: Undo Last Applied Change"**.
  - Notification appears: `Successfully reverted change to src/flask/helpers.py (1 hunks undone)`.
  - Run `git status`: working tree returns to 100% clean.

---

## 4. Manual Checklist: Task B (Agent Mode)

### Goal
Drive the agent through a multi-step autonomous loop touching 3+ files with NO file names specified in the prompt, test approval gating for `run_command`, and verify tests pass.

- [ ] **Step 1: Open Agent Chat Panel**
  - Click the **Forge Agent** icon in the Activity Bar, or run **"TF Agent: Open Panel"**.
- [ ] **Step 2: Submit Prompt Without File Names**
  - In the chat input, submit:
    ```
    Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
    ```
- [ ] **Step 3: Observe Context & Exploration Steps**
  - "Context used" card shows ranked workspace snippets used for bounded context.
  - Notice status pill: `⚡ Deferred Tools Active`.
  - Agent calls `call_tool(mcp_server="vscode-ide", tool_name="search_workspace", ...)`.
  - Agent inspects CLI architecture and existing commands.
- [ ] **Step 4: Review Multi-File Edits**
  - Proposed edits are staged in memory (not written to disk yet).
  - Webview renders Diff Review Cards for each modified file:
    1. `src/flask/cli.py` (adds `config` command with secret masking)
    2. `tests/test_cli.py` (adds test case verifying masking of sensitive keys)
    3. `docs/cli.rst` (adds documentation)
  - Click **Accept All** on the review cards.
- [ ] **Step 5: Review Command Approval Card**
  - Agent calls `run_command` with `pytest tests/test_cli.py -q`.
  - Webview displays an amber **Command Approval Required** card showing the command string.
  - Click **Approve Command**.
- [ ] **Step 6: Verify CLI Command & Test**
  - In the terminal:
    ```powershell
    cd C:\dev\flask
    .venv\Scripts\flask --help
    # Verify 'config' is listed under Commands
    .venv\Scripts\pytest tests/test_cli.py -q
    # Verify test suite passes
    ```

---

## 5. Manual Checklist: Task C (Resilience & Error Recovery)

### Goal
Verify that turn failures (unreachable endpoint, bad key, timeouts) trigger exponential backoff retries, switch to fallback models with visible notices, and leave the workspace completely untouched without stack traces.

- [ ] **Scenario 1: Unreachable Endpoint**
  1. Open VS Code Settings (`Ctrl+,`) and set `forgeAgent.trueforgeUrl` to `http://localhost:59999` (non-existent port).
  2. In Agent Chat, send `Hello`.
  3. Observe status updates and notices:
     - Retries with exponential backoff (attempt 1, attempt 2, attempt 3).
     - Error banner appears in chat:
       `⚠️ Cannot connect to TrueForge at http://localhost:59999. Please verify that the TrueForge server is running.`
     - **Verify**: No raw stack traces (`at Object...` or `node:...`) are visible anywhere.
     - **Verify**: Editor stays responsive and input box is re-enabled.
     - **Verify**: `git status` in workspace is 100% clean.
  4. Restore `forgeAgent.trueforgeUrl` to `http://localhost:8790`.

- [ ] **Scenario 2: Automatic Model Fallback**
  1. In Settings, configure:
     - `forgeAgent.primaryModel`: `google-gemini/invalid-model-name`
     - `forgeAgent.fallbackModel`: `google-gemini/gemini-3-1-flash-lite`
  2. Send a question in chat: `What is 2 + 2?`.
  3. Observe:
     - Notice appears: `⚠️ Attempt failed on model "google-gemini/invalid-model-name". Retrying...`
     - Warning banner appears: `⚠️ Switching to fallback model "google-gemini/gemini-3-1-flash-lite" after failures with prior model ("google-gemini/invalid-model-name").`
     - Turn completes successfully on fallback model: `ℹ️ Turn completed successfully using model "google-gemini/gemini-3-1-flash-lite".`
     - Assistant response is displayed.

- [ ] **Scenario 3: Task A with Invalid Key / Bad Model**
  1. Set `forgeAgent.primaryModel` to `google-gemini/invalid-key-model` (with no valid fallback).
  2. Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+K`.
  3. Submit: `Treat off as false`.
  4. Observe:
     - Status bar shows error: `$(error) Forge Agent: Error`.
     - VS Code error notification appears: `Inline edit failed: Model "google-gemini/invalid-key-model" is not available or not configured in TrueForge.`
     - **Verify**: Side-by-side diff editor does not show unapplied junk.
     - **Verify**: Run `git status` in `C:\dev\flask` — working tree is 100% clean, zero modified files.

---

## 6. Manual Checklist: Cancellation at Every Stage

- [ ] **Stage 1: Mid-Streaming Cancellation**
  1. Ask the agent to write a 1,000-word essay on database indexing.
  2. While text is streaming in the panel, click the red **Cancel** button (or press `Esc` in inline edit).
  3. **Verify**:
     - Stream stops immediately.
     - Status badge updates to `cancelled`.
     - Send/Cancel button reverts to Send.
     - No half-written files exist on disk.

- [ ] **Stage 2: Pending Review Cancellation**
  1. Ask the agent to make a code change.
  2. Wait until `propose_edit` triggers and the Diff Review Card appears with Accept/Reject buttons.
  3. **Do NOT click Accept**. Click the red **Cancel** button in the chat header.
  4. **Verify**:
     - Review card buttons are disabled.
     - Banner appears: `⚠️ Staged review cancelled: all proposed edits discarded.`
     - Any open diff editor tab (`forge-proposed:`) closes automatically.
     - Disk files remain completely untouched (`git status` clean).

- [ ] **Stage 3: Running Command Cancellation**
  1. Trigger a turn that runs a long command (e.g. `pytest`).
  2. When the command approval card appears, approve it.
  3. While the command is running, click **Cancel**.
  4. **Verify**:
     - PowerShell child process tree is forcefully terminated via `taskkill /pid ... /T /F`.
     - Turn terminates with status `cancelled`.
     - No lingering `powershell.exe` or background test processes remain.

---

## 7. Manual Checklist: Edge Cases (Large & Binary Files)

- [ ] **Large Files (>5,000 lines)**
  1. In chat, type `@massive_file.py` (or ask the agent to inspect a 6,000-line file).
  2. **Verify**:
     - Does not run out of memory or freeze the editor.
     - Content output is windowed or capped with `[TRUNCATED: Output capped at ~3500 tokens...]`.
- [ ] **Binary Files**
  1. In chat, type `@image.png` or ask agent to read a `.bin` / `.png` / `.exe` file.
  2. **Verify**:
     - Returns `[Binary file cannot be displayed: "<file>" (<size> KB)]`.
     - No binary garbage or corruption is dumped into the context window.
     - Search and indexing skip binary files cleanly.
