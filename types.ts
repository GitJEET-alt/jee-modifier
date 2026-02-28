export interface ProcessedQuestion {
  originalIndex: number; // 1-based index from the original paper
  questionText: string;
  type: 'MCQ' | 'NAT' | 'MSQ' | 'Other';
  options?: Record<string, string>; // e.g., { A: "...", B: "..." }
  answer: string;
  solution: string;
  diagramNote?: string;
}

export interface ProcessingStatus {
  totalQuestions: number;
  processedCount: number;
  currentAction: string;
  isComplete: boolean;
  error?: string;
}

export interface PaperJob {
  id: string;
  name: string;
  qFile: File;
  sFile: File;
  status: 'pending' | 'processing' | 'completed' | 'error';
  questions: ProcessedQuestion[];
  progress: ProcessingStatus;
}
