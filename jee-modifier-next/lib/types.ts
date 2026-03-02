export interface ProcessedQuestion {
    originalIndex: number;
    questionText: string;
    type: 'MCQ' | 'NAT' | 'MSQ' | 'Other';
    options?: Record<string, string>;
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
    subject: string; // 'jee' | 'neet-phychem' | 'neet-bio'
    qFile: File;
    sFile: File;
    // We store base64 string for the backend fetch calls instead of passing raw File objects around
    qFileBase64?: { data: string; mimeType: string };
    sFileBase64?: { data: string; mimeType: string };
    status: 'pending' | 'processing' | 'completed' | 'error';
    questions: ProcessedQuestion[];
    progress: ProcessingStatus;
}
