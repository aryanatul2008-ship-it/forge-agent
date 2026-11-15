export interface DiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  oldText: string;
  newText: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface StagedEdit {
  toolCallId: string;
  filePath: string;
  description: string;
  hunks: DiffHunk[];
  baseContent: string;
  baseContentHash: string;
  proposedContent?: string;
  createdAt: number;
}

export interface EditApplicationResult {
  filePath: string;
  appliedCount: number;
  rejectedCount: number;
  summary: string;
  isStale?: boolean;
}

export interface UndoHistoryEntry {
  id: string;
  filePath: string;
  timestamp: number;
  previousContent: string;
  appliedHunksCount: number;
}
