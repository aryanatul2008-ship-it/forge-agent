export interface TrueForgeConfig {
  baseUrl: string;
  models: string[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: any;
  sourceEventId?: string;
}

export interface ToolResponseInfo {
  toolCallId: string;
  content: string;
}

export interface TurnApprovalRequest {
  toolCallId: string;
  threadId?: string;
  status: 'allow' | 'deny';
  reason?: string;
}

export interface StreamEventHandlers {
  onEvent?: (event: any) => void;
  onTurnCreated?: (turnId: string) => void;
  onDelta?: (text: string) => void;
  onToolCall?: (call: ToolCallInfo) => void;
  onToolResponse?: (response: ToolResponseInfo) => void;
  onApprovalRequired?: (toolCalls: ToolCallInfo[]) => void;
  onStatusUpdate?: (status: string, details?: string) => void;
  onDone?: (status: string, reason?: string, metrics?: any) => void;
  onError?: (error: Error) => void;
}
