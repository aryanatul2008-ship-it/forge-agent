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
  createdAt: number;
}

export interface EditApplicationResult {
  filePath: string;
  appliedCount: number;
  rejectedCount: number;
  summary: string;
}
