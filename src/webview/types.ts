import { MentionItem } from '../context/types';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  | { type: 'approveTool'; toolCallId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'hunkDecision'; toolCallId: string; hunkId: string; decision: 'accepted' | 'rejected' }
  | { type: 'allHunksDecision'; toolCallId: string; decision: 'accepted' | 'rejected' }
  | { type: 'openDiff'; toolCallId: string; filePath: string }
  | { type: 'openFile'; filePath: string; line?: number }
  | { type: 'queryMentions'; query: string };

export interface ContextUsedItem {
  file: string;
  range?: string;
  reason: string;
  tokens: number;
  snippetPreview: string;
  line?: number;
}

export type ExtensionToWebviewMessage =
  | { type: 'status'; status: string; details?: string }
  | { type: 'userMessage'; text: string }
  | { type: 'assistantStart'; turnId: string }
  | { type: 'token'; content: string }
  | { type: 'toolCall'; id: string; name: string; arguments: any }
  | { type: 'toolResponse'; toolCallId: string; content: string }
  | { type: 'toolApprovalRequired'; toolCallId: string; name: string; arguments: any; edit?: any }
  | { type: 'stagedEdit'; edit: any }
  | { type: 'turnDone'; status: string; reason?: string; metrics?: any }
  | { type: 'error'; message: string }
  | { type: 'mentionSuggestions'; suggestions: MentionItem[] }
  | {
      type: 'contextUsed';
      items: ContextUsedItem[];
      totalTokens: number;
      budgetTokens: number;
      summary: string;
    };
