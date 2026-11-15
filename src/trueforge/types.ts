export interface TrueForgeConfig {
  baseUrl: string;
  models: string[];
}

export interface TurnApprovalRequest {
  toolCallId: string;
  threadId?: string;
  status: 'allow' | 'deny';
  reason?: string;
}

export interface StreamEventHandlers {
  onEvent?: (event: any) => void;
  onDelta?: (text: string) => void;
  onApprovalRequired?: (toolCalls: Array<{ id: string; sourceEventId?: string; name?: string; args?: any }>) => void;
  onDone?: (status: string, reason?: string) => void;
  onError?: (error: Error) => void;
}
