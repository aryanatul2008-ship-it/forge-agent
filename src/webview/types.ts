export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  | { type: 'approveTool'; toolCallId: string; decision: 'allow' | 'deny'; reason?: string }
  | { type: 'hunkDecision'; toolCallId: string; hunkId: string; decision: 'accepted' | 'rejected' };

export type ExtensionToWebviewMessage =
  | { type: 'status'; text: string }
  | { type: 'messageChunk'; text: string }
  | { type: 'toolApprovalRequired'; toolCallId: string; toolName: string; args: any }
  | { type: 'turnDone'; status: string; reason?: string };
