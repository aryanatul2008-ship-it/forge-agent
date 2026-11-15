export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  | { type: 'approveTool'; toolCallId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'hunkDecision'; toolCallId: string; hunkId: string; decision: 'accepted' | 'rejected' };

export type ExtensionToWebviewMessage =
  | { type: 'status'; status: string; details?: string }
  | { type: 'userMessage'; text: string }
  | { type: 'assistantStart'; turnId: string }
  | { type: 'token'; content: string }
  | { type: 'toolCall'; id: string; name: string; arguments: any }
  | { type: 'toolResponse'; toolCallId: string; content: string }
  | { type: 'toolApprovalRequired'; toolCallId: string; name: string; arguments: any }
  | { type: 'turnDone'; status: string; reason?: string; metrics?: any }
  | { type: 'error'; message: string };
