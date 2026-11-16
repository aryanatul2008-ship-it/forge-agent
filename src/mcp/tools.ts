import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { WorkspaceRetrieval } from '../context/retrieval';
import { DiffReviewEngine } from '../review/diffReview';
import { ContextEngine } from '../context/engine';

export function getEditorTools(): Tool[] {
  return [
    {
      name: 'get_relevant_context',
      description: 'Retrieve ranked workspace code snippets and symbols relevant to a search query with explicit one-line reasons. Bounded by strict token budget.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query or question describing the code, symbol, or feature to find',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of snippets to return (default: 5, max: 10)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_dir',
      description: 'List contents of a directory in the workspace with file types and sizes. Output is capped at ~3,500 tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory path from the workspace root (e.g. "." or "src/flask")',
          },
          depth: {
            type: 'number',
            description: 'Recursion depth (default: 1, max: 3)',
          },
        },
      },
    },
    {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace within an optional 1-indexed line range. Output is capped at ~3,500 tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of the file from the workspace root (e.g. "src/flask/helpers.py")',
          },
          start_line: {
            type: 'number',
            description: 'Optional starting line number (1-indexed)',
          },
          end_line: {
            type: 'number',
            description: 'Optional ending line number (1-indexed)',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_workspace',
      description: 'Search workspace files for text or regex matches. Returns ranked snippets with file paths, line numbers, and context. Output is capped at ~3,500 tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text string or regex pattern to search for across the workspace',
          },
          is_regex: {
            type: 'boolean',
            description: 'Whether query is a regular expression (default: false)',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of ranked matching snippets to return (default: 25, max: 50)',
          },
          file_pattern: {
            type: 'string',
            description: 'Optional substring or extension filter for file paths (e.g. ".py" or "helpers")',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'find_symbol',
      description: 'Search for symbol definitions (functions, classes, methods, variables) across the workspace using VS Code symbol provider with Python regex fallback.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Symbol name to search for (e.g. "get_debug_flag" or "Flask")',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'propose_edit',
      description: 'Propose an edit to a file. Changes are staged in memory and reviewed per-hunk by the user before being applied. Requires approval.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Relative path of the target file to modify (e.g. "src/flask/helpers.py")',
          },
          path: {
            type: 'string',
            description: 'Alias for file',
          },
          explanation: {
            type: 'string',
            description: 'Clear description or explanation of the proposed modifications',
          },
          description: {
            type: 'string',
            description: 'Alias for explanation',
          },
          new_content: {
            type: 'string',
            description: 'Complete new replacement content for the file (hunks are computed automatically)',
          },
          hunks: {
            type: 'array',
            description: 'Optional explicit replacement hunks',
            items: {
              type: 'object',
              properties: {
                old_start: { type: 'number', description: 'Start line in original file (1-indexed)' },
                old_lines: { type: 'number', description: 'Number of lines in original file to replace' },
                new_start: { type: 'number', description: 'Start line in new file' },
                new_lines: { type: 'number', description: 'Number of lines in replacement' },
                old_text: { type: 'string', description: 'Original text being replaced' },
                new_text: { type: 'string', description: 'New replacement text' },
              },
              required: ['old_start', 'old_lines', 'new_start', 'new_lines', 'new_text'],
            },
          },
        },
      },
    },
    {
      name: 'run_command',
      description: 'Run a shell command via PowerShell on Windows. Requires user approval before execution.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'PowerShell command line string to execute',
          },
        },
        required: ['command'],
      },
    },
  ];
}

export async function executeEditorTool(
  toolName: string,
  args: any,
  toolCallId: string,
  reviewEngine: DiffReviewEngine,
  contextEngine?: ContextEngine
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const realArgs = args?.input || args;
    switch (toolName) {
      case 'get_relevant_context': {
        const query = realArgs?.query;
        if (!query) {
          return {
            content: [{ type: 'text', text: 'Error: "query" argument is required for get_relevant_context' }],
            isError: true,
          };
        }
        const engine = contextEngine ?? new ContextEngine();
        const limit = realArgs?.limit ? Number(realArgs.limit) : 5;
        const res = await engine.retrieveRelevantContext(query, { maxTokens: 3500 });

        if (res.snippets.length === 0) {
          return {
            content: [{ type: 'text', text: `No relevant workspace snippets found for query "${query}".` }],
          };
        }

        const lines: string[] = [
          `Retrieved ${Math.min(res.snippets.length, limit)} ranked context snippets (${res.totalTokens} tokens):\n`,
        ];

        const topSnippets = res.snippets.slice(0, limit);
        for (let i = 0; i < topSnippets.length; i++) {
          const s = topSnippets[i];
          lines.push(`[Snippet ${i + 1}] ${s.filePath}#L${s.startLine}-L${s.endLine} (Score: ${s.score.toFixed(2)}, ~${s.tokens} tokens)`);
          lines.push(`Reason: ${s.reason}`);
          lines.push('```');
          lines.push(s.content);
          lines.push('```');
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      case 'list_dir': {
        const dirPath = typeof realArgs?.path === 'string' ? realArgs.path : '.';
        const depth = realArgs?.depth ? Number(realArgs.depth) : 1;
        const text = await WorkspaceRetrieval.listDir(dirPath, depth);
        return { content: [{ type: 'text', text }] };
      }

      case 'read_file': {
        const filePath = realArgs?.path || realArgs?.file || realArgs?.file_path || realArgs?.filepath;
        if (!filePath) {
          return { content: [{ type: 'text', text: 'Error: "path" argument is required for read_file' }], isError: true };
        }
        const startLine = realArgs.start_line !== undefined ? Number(realArgs.start_line) : undefined;
        const endLine = realArgs.end_line !== undefined ? Number(realArgs.end_line) : undefined;
        const text = await WorkspaceRetrieval.readFile(filePath, startLine, endLine);
        return { content: [{ type: 'text', text }] };
      }

      case 'search_workspace': {
        if (!realArgs?.query) {
          return { content: [{ type: 'text', text: 'Error: "query" argument is required for search_workspace' }], isError: true };
        }
        const text = await WorkspaceRetrieval.searchWorkspace(realArgs.query, {
          isRegex: Boolean(realArgs.is_regex),
          maxResults: realArgs.max_results !== undefined ? Number(realArgs.max_results) : 25,
          filePattern: realArgs.file_pattern,
        });
        return { content: [{ type: 'text', text }] };
      }

      case 'find_symbol': {
        if (!realArgs?.query) {
          return { content: [{ type: 'text', text: 'Error: "query" argument is required for find_symbol' }], isError: true };
        }
        const text = await WorkspaceRetrieval.findSymbol(realArgs.query);
        return { content: [{ type: 'text', text }] };
      }

      case 'propose_edit': {
        const filePath = realArgs?.file || realArgs?.path || realArgs?.file_path;
        if (!filePath) {
          return {
            content: [{ type: 'text', text: 'Error: "file" or "path" argument is required for propose_edit' }],
            isError: true,
          };
        }
        const explanation = realArgs?.explanation || realArgs?.description || 'Proposed code changes';
        const newContent = realArgs?.new_content || realArgs?.newContent || realArgs?.content;
        const hunks = realArgs?.edits || realArgs?.hunks;

        let staged = reviewEngine.getStagedEdit(toolCallId);
        if (!staged) {
          staged = await reviewEngine.stageEdit(toolCallId, filePath, explanation, { newContent, hunks });
        }

        // Check hunk decisions
        const hasAccepted = staged.hunks.some((h) => h.status === 'accepted');
        const hasRejected = staged.hunks.some((h) => h.status === 'rejected');

        // If no explicit decision yet (e.g. approved overall), accept all pending
        if (!hasAccepted && !hasRejected) {
          reviewEngine.setAllHunksDecision(toolCallId, 'accepted');
        }

        const result = await reviewEngine.applyApprovedEdit(toolCallId);
        if (result.isStale) {
          return {
            content: [{ type: 'text', text: `Propose Edit Conflict: ${result.summary}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Propose Edit Result for ${result.filePath}: ${result.summary} (Applied: ${result.appliedCount}, Rejected: ${result.rejectedCount})`,
            },
          ],
        };
      }

      case 'run_command': {
        if (!realArgs?.command) {
          return { content: [{ type: 'text', text: 'Error: "command" argument is required for run_command' }], isError: true };
        }
        const result = await WorkspaceRetrieval.runCommand(realArgs.command);
        const output = `Exit code: ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        return { content: [{ type: 'text', text: output }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Tool error (${toolName}): ${err?.message || err}` }],
      isError: true,
    };
  }
}
