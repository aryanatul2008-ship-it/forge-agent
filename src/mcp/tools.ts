import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { WorkspaceRetrieval } from '../context/retrieval';
import { DiffReviewEngine } from '../review/diffReview';

export function getEditorTools(): Tool[] {
  return [
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
  reviewEngine: DiffReviewEngine
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    switch (toolName) {
      case 'list_dir': {
        const dirPath = typeof args?.path === 'string' ? args.path : '.';
        const depth = args?.depth ? Number(args.depth) : 1;
        const text = await WorkspaceRetrieval.listDir(dirPath, depth);
        return { content: [{ type: 'text', text }] };
      }

      case 'read_file': {
        const filePath = args?.path || args?.file || args?.file_path || args?.filepath;
        if (!filePath) {
          return { content: [{ type: 'text', text: 'Error: "path" argument is required for read_file' }], isError: true };
        }
        const startLine = args.start_line !== undefined ? Number(args.start_line) : undefined;
        const endLine = args.end_line !== undefined ? Number(args.end_line) : undefined;
        const text = await WorkspaceRetrieval.readFile(filePath, startLine, endLine);
        return { content: [{ type: 'text', text }] };
      }

      case 'search_workspace': {
        if (!args?.query) {
          return { content: [{ type: 'text', text: 'Error: "query" argument is required for search_workspace' }], isError: true };
        }
        const text = await WorkspaceRetrieval.searchWorkspace(args.query, {
          isRegex: Boolean(args.is_regex),
          maxResults: args.max_results !== undefined ? Number(args.max_results) : 25,
          filePattern: args.file_pattern,
        });
        return { content: [{ type: 'text', text }] };
      }

      case 'find_symbol': {
        if (!args?.query) {
          return { content: [{ type: 'text', text: 'Error: "query" argument is required for find_symbol' }], isError: true };
        }
        const text = await WorkspaceRetrieval.findSymbol(args.query);
        return { content: [{ type: 'text', text }] };
      }

      case 'propose_edit': {
        const filePath = args?.file || args?.path || args?.file_path;
        if (!filePath) {
          return {
            content: [{ type: 'text', text: 'Error: "file" or "path" argument is required for propose_edit' }],
            isError: true,
          };
        }
        const explanation = args?.explanation || args?.description || 'Proposed code changes';
        const newContent = args?.new_content || args?.newContent || args?.content;
        const hunks = args?.edits || args?.hunks;

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
        if (!args?.command) {
          return { content: [{ type: 'text', text: 'Error: "command" argument is required for run_command' }], isError: true };
        }
        const result = await WorkspaceRetrieval.runCommand(args.command);
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
