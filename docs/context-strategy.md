# Context Retrieval, Mentions & Budgeting Strategy

This document outlines the context retrieval, mention autocomplete, indexing, and budget enforcement architecture in the **Forge Agent** VS Code extension.

---

## 1. Architectural Principles & Goals

Modern LLM-based coding agents often fail due to **context window pollution**: dumping entire files or unbounded search results exhausts token budgets, drives up latency, and dilutes model attention.

Forge Agent adopts a **targeted, bounded context engineering architecture**:
1. **Never Whole-File Concatenation**: Context is injected strictly as bounded line-range snippets extracted via AST symbols or windowed chunking.
2. **Explicit User Mentions First**: Explicit `@file` and `@symbol` mentions take absolute precedence in the context budget.
3. **Dual-Tier Token Budgeting**:
   - **Workspace Prompt Context Budget**: Configurable via `forgeAgent.contextBudgetTokens` (default: **6,000 tokens**). Injected into the initial user prompt turn.
   - **Editor MCP Tool Output Budget**: Capped strictly at **~3,500 tokens** (~14,000 characters). Well below TrueForge's 6,000-token server offloading threshold, ensuring reliable execution on platforms without local sandboxes (such as Windows).
4. **Transparent User Visibility**: The extension panel displays an interactive **"Context used"** collapsible summary showing file links, one-line reasons, and token usage progress.

---

## 2. Explicit Mentions & Interactive Autocomplete

### 2.1 Syntax Support
Users can reference files and code symbols directly within the panel chat input:
- `@file:src/flask/helpers.py` or `@file:cli.py` (explicit file target).
- `@symbol:get_debug_flag` or `@symbol:FlaskGroup` (explicit symbol target).
- `@helpers.py` or `@get_debug_flag` (bare `@` mentions automatically resolved against the index).

### 2.2 Interactive Autocomplete Dropdown
- As the user types `@...` in the panel chat input, the webview dynamically queries the extension host via `queryMentions`.
- The `ContextEngine` returns matching files and symbol definitions.
- A floating `#mentionDropdown` appears directly above the input box:
  - Supports keyboard navigation: `ArrowUp`, `ArrowDown`, `Enter`, `Tab`, and `Escape`.
  - Supports mouse click selection.
  - Automatically inserts the formatted mention token (e.g., `@file:src/flask/helpers.py `) and refocuses the cursor.

### 2.3 Bounded Mention Resolution
Mentions are resolved into `ContextSnippet` records with highest priority scores:
- **File Mentions (`@file:`)**: Scored at **1000**. Capped to the first 60 lines of the file to preserve budget while providing essential imports, declarations, and module structure.
- **Symbol Mentions (`@symbol:`)**: Scored at **950**. Extracts a focused window around the symbol definition: **3 lines before** (decorators/comments) and **30 lines after** (implementation).

---

## 3. Lightweight Workspace Indexer

The `WorkspaceIndexer` (`src/context/indexer.ts`) maintains an in-memory representation of the project without heavy external database dependencies:

```
Workspace Directory
   ├── File Tree Index (tracked relative paths, ignored directory pruning)
   ├── Windowed Chunks (35-line windows, 10-line overlap)
   ├── Symbol Table (Python AST/regex, TS/JS function & class declarations)
   └── Okapi BM25 Index (inverted index with term frequencies & IDF)
```

### 3.1 Pruned Collection
Excludes non-source directories and binary assets:
- Directories: `.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `.pytest_cache`, `dist`, `build`, etc.
- File extensions: `.pyc`, `.so`, `.dll`, `.exe`, `.png`, `.zip`, `.lock`, etc.

### 3.2 Windowed Chunking
Source files are split into overlapping chunks:
- `CHUNK_SIZE_LINES = 35`
- `CHUNK_OVERLAP_LINES = 10`
Overlapping windows ensure that functions or blocks spanning chunk boundaries are not split abruptly without context.

### 3.3 Symbol Extraction
Extracts code symbols across languages:
- **Python**: `def function_name(...)`, `class ClassName(...)`, top-level variable declarations.
- **TypeScript / JavaScript**: `function name()`, `class Name`, `interface Name`, `type Name`, `export const/let/var`.

### 3.4 File Watcher & Incremental Updates
A VS Code file watcher (`vscode.workspace.createFileSystemWatcher('**/*')`) tracks workspace events:
- **Create**: Automatically indexes the new file.
- **Change**: Debounces edits (300ms) and atomically re-indexes chunks and symbols for the modified file.
- **Delete**: Cleans up all chunks, symbol entries, and inverted index entries associated with the deleted path.

---

## 4. Okapi BM25 Ranking Engine

Automatic retrieval uses the standard **Okapi BM25** algorithm (`src/context/bm25.ts`):

$$\text{Score}(D, Q) = \sum_{t \in Q} \text{IDF}(t) \cdot \frac{f(t, D) \cdot (k_1 + 1)}{f(t, D) + k_1 \cdot \left(1 - b + b \cdot \frac{|D|}{\text{avgdl}}\right)}$$

- Parameters: $k_1 = 1.2$, $b = 0.75$.
- **Robertson-Spärck Jones Smoothed IDF**:
  $$\text{IDF}(t) = \ln\left(1 + \frac{N - n(t) + 0.5}{n(t) + 0.5}\right)$$
- **Code-Aware Tokenizer**:
  - Preserves casing during raw scanning to split both `snake_case` (`get_debug_flag` $\to$ `get`, `debug`, `flag`) and `camelCase` (`FlaskGroup` $\to$ `flask`, `group`).
  - Filters common English and programming stop words (`the`, `from`, `with`, `that`, etc.).
- **Path Matching Boost**:
  - Chunks whose relative file paths match query terms receive a $+1.5$ score boost, prioritizing files clearly targeted by the prompt.

---

## 5. Strict Budgeting, Ranking & Deduplication

### 5.1 Candidate Ranking Pipeline
1. **Explicit Mentions** (Scores: 950–1000)
2. **Matching Symbols** (Score: 150)
3. **BM25 Chunk Matches** (Ranked by BM25 relevance score descending)

### 5.2 Deduplication & Overlap Merging
When multiple candidate chunks originate from the same file:
- Snippets within **5 lines of adjacency or overlap** are merged into a unified snippet.
- Line bounds (`startLine` to `endLine`) are recalculated and content is re-extracted from source.
- Reasons are combined (e.g. `BM25 match (Score: 2.1) + Symbol match "get_debug_flag"`).
- Eliminates duplicate code and minimizes token overhead.

### 5.3 Strict Budget Accumulation
The engine iterates over ranked candidates:
- Accumulates snippets while `currentTokens + snippetTokens <= budgetTokens`.
- If a candidate partially exceeds the remaining budget:
  - If at least **80 tokens** remain, it performs line-level truncation, retaining as many complete lines as fit within the margin and appending a `[Capped to fit remaining budget]` note.
  - Stops further accumulation.
- Output text is passed through `enforceContextBudget()`, ensuring hard boundaries with informative `[TRUNCATED: ...]` banners if safety caps are hit.

---

## 6. MCP Tool: `get_relevant_context(query, limit)`

The local MCP server exposes `get_relevant_context` to the TrueForge agent:

### 6.1 Tool Definition
```json
{
  "name": "get_relevant_context",
  "description": "Retrieve ranked, bounded code snippets and symbol definitions from the workspace relevant to a query. Returns line ranges, relevance scores, and human-readable reasons within a strict token budget.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language query or code terms to search for (e.g. 'debug flag helper' or 'CLI config masking')"
      },
      "limit": {
        "type": "number",
        "description": "Maximum number of ranked snippets to return (default: 5)"
      }
    },
    "required": ["query"]
  }
}
```

### 6.2 Output Format
Each returned snippet includes exact line locations and a one-line reason:
```
Retrieved 2 ranked context snippets (185 tokens):

[Snippet 1] src/flask/helpers.py#L1-L15 (Score: 3.12, ~85 tokens)
Reason: BM25 match (Score: 3.12, terms: debug, flag)
```python
def get_debug_flag():
    ...
```

[Snippet 2] src/flask/cli.py#L320-L355 (Score: 1.45, ~100 tokens)
Reason: Matches symbol definition "show_server_banner" (function in src/flask/cli.py:322)
```python
...
```
```

---

## 7. Webview "Context Used" UI & TrueForge Feature Visibility

### 7.1 "Context Used" Panel Component
When context is retrieved for a prompt, the webview panel renders a dedicated card:
- **Progress Bar & Metrics**: Displays tokens used vs. configured budget (e.g. `1,240 / 6,000 tokens (21%)`).
- **Clickable File Links**: Clicking a snippet title sends an `openFile` message to the extension, opening the file at the target line in the active VS Code editor.
- **One-Line Reason Pills**: Shows why each snippet was included (e.g. `Explicit mention @file`, `BM25 match`, `Symbol match`).
- **Snippet Previews**: Collapsible code block showing the exact snippet lines injected into the prompt.

### 7.2 TrueForge Context-Engineering Feature: Deferred Tool Loading
Per `NOTES.md` and `AGENTS.md`, local sandboxes are unavailable on Windows. To optimize context efficiency without requiring a sandbox, Forge Agent enables **Deferred Tool Loading** (`preload: false` on MCP servers in `agent/agent.config.json`):
- Instead of polluting the initial prompt with full JSON schemas for all editor tools, TrueForge provides meta-tools (`list_tools`, `get_tool_info`, `call_tool`).
- The agent discovers and inspects schemas on demand.
- **UI Visibility**:
  - Webview status header displays a live `⚡ Deferred Tools Active` badge.
  - When the agent invokes tools via `call_tool`, the panel displays a distinctive `⚡ TrueForge Deferred Tool` tag on the tool call card, making the feature immediately apparent during evaluation.
