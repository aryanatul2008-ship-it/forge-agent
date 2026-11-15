import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { WorkspaceRetrieval } from '../context/retrieval';
import { DiffReviewEngine } from '../review/diffReview';

export function getEditorTools(): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace within an optional 1-indexed line range. Output is capped at ~3,500 tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path of the file from the workspace root',
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
      description: 'Search workspace files for text matches. Returns matched files, line numbers, and snippets.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text string to search for across the workspace',
          },
          max_files: {
            type: 'number',
            description: 'Maximum number of matching files to return (default: 20)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'find_symbol',
      description: 'Search for functions, classes, methods, or symbols in the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Symbol name or partial name to search for',
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
          path: {
            type: 'string',
            description: 'Relative path of the target file to modify',
          },
          description: {
            type: 'string',
            description: 'Clear description of the proposed modifications',
          },
          hunks: {
            type: 'array',
            description: 'List of replacement hunks',
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
        required: ['path', 'description', 'hunks'],
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
      case 'read_file': {
        const text = await WorkspaceRetrieval.readFile(
          args.path,
          args.start_line,
          args.end_line
        );
        return { content: [{ type: 'text', text }] };
      }

      case 'search_workspace': {
        const text = await WorkspaceRetrieval.searchWorkspace(args.query, args.max_files);
        return { content: [{ type: 'text', text }] };
      }

      case 'find_symbol': {
        const text = await WorkspaceRetrieval.findSymbol(args.query);
        return { content: [{ type: 'text', text }] };
      }

      case 'propose_edit': {
        // When propose_edit executes, it was already approved (or reviewed) by the user.
        // It applies the accepted hunks to the file via WorkspaceEdit.
        const result = await reviewEngine.applyApprovedEdit(toolCallId);
        return {
          content: [
            {
              type: 'text',
              text: `Propose Edit Result for ${result.filePath}: ${result.summary}`,
            },
          ],
        };
      }

      case 'run_command': {
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
      content: [{ type: 'text', text: `Tool error (${toolName}): ${err.message}` }],
      isError: true,
    };
  }
}
