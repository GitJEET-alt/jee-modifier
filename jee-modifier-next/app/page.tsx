'use client';

import React, { useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Upload, FileText, Play, AlertCircle, Loader2, CheckCircle2, Plus, Trash2, Layers, Clock, LogOut } from 'lucide-react';
import { PaperJob } from '@/lib/types';
import { fileToGenerativePart, generateQuestionFileContent, generateSolutionFileContent, downloadDocFile } from '@/lib/utils';
import { Preview } from '@/components/Preview';
import LoginScreen from '@/components/Login';

// ─── Exam / Subject config ────────────────────────────────────────────────────
const EXAM_SUBJECTS: Record<string, { label: string; value: string }[]> = {
  jee: [
    { label: 'Physics', value: 'jee' },
    { label: 'Chemistry', value: 'jee' },
    { label: 'Maths', value: 'jee' },
  ],
  neet: [
    { label: 'Physics', value: 'neet-phychem' },
    { label: 'Chemistry', value: 'neet-phychem' },
    { label: 'Biology', value: 'neet-bio' },
  ],
};

// Human-readable badge labels for each subject value
const SUBJECT_BADGE: Record<string, string> = {
  jee: 'JEE',
  'neet-phychem': 'NEET · Phy/Chem',
  'neet-bio': 'NEET · Biology',
};

export default function Home() {
  const { data: session, status } = useSession();

  const [jobs, setJobs] = useState<PaperJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [stageQ, setStageQ] = useState<File | null>(null);
  const [stageS, setStageS] = useState<File | null>(null);
  const [isQueueRunning, setIsQueueRunning] = useState(false);

  // Exam + Subject selection state
  const [selectedExam, setSelectedExam] = useState<'jee' | 'neet' | null>(null);
  // Track which subject label is selected (unique per exam row, e.g. "Physics", "Chemistry", "Biology")
  // We derive the API subject value from the label at job-creation time.
  const [selectedSubjectLabel, setSelectedSubjectLabel] = useState<string | null>(null);

  // Still loading the session from NextAuth
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // If no valid session, show the Google Sign in button screen
  if (!session) {
    return <LoginScreen />;
  }

  // --- Main App Logic ---
  const handleStageFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'q' | 's') => {
    if (e.target.files && e.target.files[0]) {
      if (type === 'q') setStageQ(e.target.files[0]);
      else setStageS(e.target.files[0]);
    }
  };

  const handleExamChange = (exam: 'jee' | 'neet') => {
    setSelectedExam(exam);
    setSelectedSubjectLabel(null); // reset subject when exam changes
  };

  const addJob = async () => {
    if (!stageQ || !stageS || !selectedSubjectLabel || !selectedExam) return;
    // Derive the backend subject value from the selected label
    const subjectEntry = EXAM_SUBJECTS[selectedExam].find(s => s.label === selectedSubjectLabel);
    if (!subjectEntry) return;
    const selectedSubjectValue = subjectEntry.value;

    // We do base64 conversion here so we don't pass raw Files into state that needs to go to API
    const qBase64 = await fileToGenerativePart(stageQ);
    const sBase64 = await fileToGenerativePart(stageS);

    const newJob: PaperJob = {
      id: Date.now().toString() + Math.random().toString().slice(2),
      name: `${stageQ.name.replace('.pdf', '')}`,
      subject: selectedSubjectValue,
      qFile: stageQ,
      sFile: stageS,
      qFileBase64: qBase64,
      sFileBase64: sBase64,
      status: 'pending',
      questions: [],
      progress: { totalQuestions: 0, processedCount: 0, currentAction: 'Waiting in queue...', isComplete: false }
    };

    setJobs(prev => [...prev, newJob]);
    setStageQ(null);
    setStageS(null);
    if (!selectedJobId) setSelectedJobId(newJob.id);
  };

  const removeJob = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setJobs(prev => prev.filter(j => j.id !== id));
    if (selectedJobId === id) setSelectedJobId(null);
  };

  const updateJob = (id: string, updates: Partial<PaperJob> | ((j: PaperJob) => Partial<PaperJob>)) => {
    setJobs(prev => prev.map(job => {
      if (job.id !== id) return job;
      const newValues = typeof updates === 'function' ? updates(job) : updates;
      return { ...job, ...newValues };
    }));
  };

  // Helper: safely call the API and parse the JSON response.
  // Vercel Hobby plan returns plain-text errors (e.g. "Request Entity Too Large") when
  // the body exceeds 4.5 MB. This helper converts those into readable errors.
  const safeApiFetch = async (payload: object): Promise<any> => {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Try to read as text first so we never lose the body
    const text = await res.text();

    if (!res.ok) {
      // Detect Vercel body-size limit
      if (res.status === 413 || text.toLowerCase().includes('request entity too large') || text.toLowerCase().includes('payload too large')) {
        throw new Error('PDFs are too large for the server (4.5 MB limit). Please use smaller / compressed PDFs.');
      }
      // Try to extract a JSON error message
      try {
        const json = JSON.parse(text);
        throw new Error(json.error || `API Error ${res.status}`);
      } catch (parseErr: any) {
        if (parseErr.message.startsWith('PDFs are too large') || parseErr.message.startsWith('API Error')) throw parseErr;
        throw new Error(`Server Error ${res.status}: ${text.substring(0, 200)}`);
      }
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid response from server: ${text.substring(0, 200)}`);
    }
  };

  const processSingleJob = async (job: PaperJob) => {
    updateJob(job.id, {
      status: 'processing',
      progress: { ...job.progress, currentAction: 'Calling Secure API: Analyzing PDFs...' }
    });

    try {
      // 1. Get Count via Next.js Backend API
      const countData = await safeApiFetch({
        action: 'count',
        subject: job.subject,
        qPart: { inlineData: job.qFileBase64 },
        sPart: { inlineData: job.sFileBase64 }
      });

      const totalQ = countData.count;

      if (!totalQ || totalQ === 0) {
        throw new Error("Could not detect any questions. Please ensure the PDF is clear.");
      }

      updateJob(job.id, {
        progress: {
          ...job.progress, totalQuestions: totalQ, processedCount: 0,
          currentAction: `Found ${totalQ} questions. Starting batch processing...`
        }
      });

      // 2. Process Batches via Next.js Backend API
      const BATCH_SIZE = 5;
      let currentIdx = 1;

      while (currentIdx <= totalQ) {
        updateJob(job.id, (j) => ({
          progress: {
            ...j.progress,
            currentAction: `Processing questions ${currentIdx} to ${Math.min(currentIdx + BATCH_SIZE - 1, totalQ)} via API...`
          }
        }));

        const batchData = await safeApiFetch({
          action: 'batch',
          subject: job.subject,
          startIndex: currentIdx,
          batchSize: BATCH_SIZE,
          qPart: { inlineData: job.qFileBase64 },
          sPart: { inlineData: job.sFileBase64 }
        });

        if (!batchData.results) throw new Error('Batch failed: no results returned');

        const batchResults = batchData.results || [];

        updateJob(job.id, (j) => ({
          questions: [...j.questions, ...batchResults],
          progress: {
            ...j.progress,
            processedCount: Math.min(j.progress.processedCount + batchResults.length, totalQ)
          }
        }));

        currentIdx += BATCH_SIZE;
        // Rate limit delay to prevent Vercel hobby limits
        await new Promise(r => setTimeout(r, 1000));
      }

      updateJob(job.id, {
        status: 'completed',
        progress: {
          totalQuestions: totalQ, processedCount: totalQ, currentAction: 'Processing Complete!', isComplete: true
        }
      });

    } catch (error: any) {
      console.error(error);
      updateJob(job.id, {
        status: 'error',
        progress: { ...job.progress, error: error.message || "An unexpected error occurred." }
      });
    }
  };

  const startQueue = async () => {
    setIsQueueRunning(true);
    const pendingIds = jobs.filter(j => j.status === 'pending').map(j => j.id);

    for (const id of pendingIds) {
      const currentJob = jobs.find(j => j.id === id);
      if (currentJob && currentJob.status === 'pending') {
        await processSingleJob(currentJob);
      }
    }
    setIsQueueRunning(false);
  };

  const handleDownload = (jobId: string, type: 'questions' | 'solutions') => {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    if (type === 'questions') {
      const content = generateQuestionFileContent(job.questions);
      downloadDocFile(`${job.name}_MODIFIED_QUESTIONS.doc`, content);
    } else {
      const content = generateSolutionFileContent(job.questions);
      downloadDocFile(`${job.name}_MODIFIED_SOLUTIONS.doc`, content);
    }
  };

  const selectedJob = jobs.find(j => j.id === selectedJobId);
  const pendingCount = jobs.filter(j => j.status === 'pending').length;

  // Subjects for the currently selected exam
  const currentSubjects = selectedExam ? EXAM_SUBJECTS[selectedExam] : [];
  const canAddJob = !!stageQ && !!stageS && !!selectedSubjectLabel && !isQueueRunning;

  return (
    <div className="flex h-screen bg-slate-50">
      <div className="w-96 bg-white border-r border-slate-200 flex flex-col shadow-lg z-10">
        <div className="p-6 border-b border-slate-100 flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <span className="text-primary text-3xl">∑</span> Exam Modifier
            </h1>
            <p className="text-xs text-slate-500 mt-1">Next.js Secure Variant Generator</p>
          </div>
          <button
            onClick={() => signOut()}
            className="text-xs text-slate-400 hover:text-slate-700 flex flex-col items-center gap-1 transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
            <span className="text-[10px]">Sign out</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-4">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add Paper Pair
            </h2>

            {/* ── Exam selection ── */}
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-2">Exam</p>
              <div className="flex gap-3">
                {(['jee', 'neet'] as const).map((exam) => (
                  <label
                    key={exam}
                    className={`flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border text-xs font-semibold transition-all select-none ${selectedExam === exam
                      ? 'border-primary bg-blue-50 text-primary'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'
                      }`}
                  >
                    <input
                      type="radio"
                      name="exam"
                      value={exam}
                      checked={selectedExam === exam}
                      onChange={() => handleExamChange(exam)}
                      disabled={isQueueRunning}
                      className="accent-blue-600"
                    />
                    {exam.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>

            {/* ── Subject selection (shown only after exam is picked) ── */}
            {selectedExam && (
              <div>
                <p className="text-xs font-semibold text-slate-600 mb-2">Subject</p>
                <div className="flex flex-col gap-2">
                  {currentSubjects.map((s) => (
                    <label
                      key={s.label}
                      className={`flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border text-xs font-semibold transition-all select-none ${selectedSubjectLabel === s.label
                        ? 'border-primary bg-blue-50 text-primary'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'
                        }`}
                    >
                      <input
                        type="radio"
                        name="subject"
                        value={s.label}
                        checked={selectedSubjectLabel === s.label}
                        onChange={() => setSelectedSubjectLabel(s.label)}
                        disabled={isQueueRunning}
                        className="accent-blue-600"
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* ── File uploads ── */}
            <div className="grid grid-cols-2 gap-2">
              <div className={`border border-dashed rounded p-2 text-center transition-colors ${stageQ ? 'bg-green-50 border-green-400' : 'bg-white border-slate-300 hover:border-primary'}`}>
                <input type="file" accept="application/pdf" onChange={(e) => handleStageFileChange(e, 'q')} className="hidden" id="stage-q" disabled={isQueueRunning} />
                <label htmlFor="stage-q" className="cursor-pointer text-xs text-slate-600 block truncate">
                  {stageQ ? stageQ.name : "Question PDF"}
                </label>
              </div>
              <div className={`border border-dashed rounded p-2 text-center transition-colors ${stageS ? 'bg-green-50 border-green-400' : 'bg-white border-slate-300 hover:border-primary'}`}>
                <input type="file" accept="application/pdf" onChange={(e) => handleStageFileChange(e, 's')} className="hidden" id="stage-s" disabled={isQueueRunning} />
                <label htmlFor="stage-s" className="cursor-pointer text-xs text-slate-600 block truncate">
                  {stageS ? stageS.name : "Solution PDF"}
                </label>
              </div>
            </div>

            <button
              onClick={addJob}
              disabled={!canAddJob}
              className="w-full bg-slate-800 hover:bg-slate-700 disabled:bg-slate-300 text-white py-2 rounded text-xs font-bold flex items-center justify-center gap-2"
            >
              Add to Queue
            </button>
          </div>

          <div>
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
              <Layers className="w-4 h-4" /> Queue ({jobs.length})
            </h2>

            {jobs.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm italic">
                No papers added yet.
              </div>
            ) : (
              <div className="space-y-3">
                {jobs.map(job => (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={`relative p-3 rounded-lg border cursor-pointer transition-all ${selectedJobId === job.id ? 'border-primary bg-blue-50 ring-1 ring-primary' : 'border-slate-200 bg-white hover:border-blue-300'}`}
                  >
                    {!isQueueRunning && (
                      <button
                        onClick={(e) => removeJob(job.id, e)}
                        className="absolute top-2 right-2 text-slate-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}

                    <div className="flex items-center gap-2 mb-1 pr-4">
                      {job.status === 'pending' && <Clock className="w-4 h-4 text-slate-400" />}
                      {job.status === 'processing' && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
                      {job.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                      {job.status === 'error' && <AlertCircle className="w-4 h-4 text-red-500" />}
                      <span className="font-semibold text-sm text-slate-700 truncate block w-full">{job.name}</span>
                    </div>

                    {/* Subject badge */}
                    <div className="mb-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                        {SUBJECT_BADGE[job.subject] ?? job.subject}
                      </span>
                    </div>

                    {(job.status === 'processing' || (job.status === 'completed' && job.progress.totalQuestions > 0)) && (
                      <div className="w-full bg-slate-200 rounded-full h-1.5 mb-2 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-500 ${job.status === 'completed' ? 'bg-green-500' : 'bg-primary'}`}
                          style={{ width: `${(job.progress.processedCount / (job.progress.totalQuestions || 1)) * 100}%` }}
                        />
                      </div>
                    )}

                    <div className="text-xs text-slate-500 whitespace-pre-wrap">
                      {job.progress.error ? <span className="text-red-500">{job.progress.error}</span> : job.progress.currentAction}
                    </div>

                    {job.status === 'completed' && (
                      <div className="flex gap-2 mt-3 pt-2 border-t border-slate-100">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDownload(job.id, 'questions'); }}
                          className="flex-1 py-1 text-[10px] font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded flex items-center justify-center gap-1"
                        >
                          <FileText className="w-3 h-3" /> Q
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDownload(job.id, 'solutions'); }}
                          className="flex-1 py-1 text-[10px] font-bold bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded flex items-center justify-center gap-1"
                        >
                          <FileText className="w-3 h-3" /> Sol
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50">
          <button
            onClick={startQueue}
            disabled={isQueueRunning || pendingCount === 0}
            className="w-full bg-primary hover:bg-blue-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white py-3 rounded-lg font-bold shadow-md transition-all flex items-center justify-center gap-2"
          >
            {isQueueRunning ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Processing Queue...</>
            ) : (
              <><Play className="w-4 h-4" /> Start Processing ({pendingCount})</>
            )}
          </button>
        </div>
      </div >

      <div className="flex-1 h-full overflow-hidden flex flex-col">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center px-8 justify-between">
          <h2 className="font-semibold text-slate-700 flex items-center gap-2">
            {selectedJob ? (
              <>
                <FileText className="w-4 h-4 text-slate-400" />
                {selectedJob.name}
                <span className={`text-xs px-2 py-0.5 rounded-full ${selectedJob.status === 'completed' ? 'bg-green-100 text-green-700' :
                  selectedJob.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                    selectedJob.status === 'error' ? 'bg-red-100 text-red-700' :
                      'bg-slate-100 text-slate-600'
                  }`}>
                  {selectedJob.status}
                </span>
              </>
            ) : "Preview Area"}
          </h2>
          <div className="text-xs flex items-center gap-4">
            <span className="text-slate-500 font-medium">{session?.user?.email}</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-8 bg-slate-50 relative">
          {selectedJob ? (
            <Preview
              questions={selectedJob.questions}
              emptyMessage={
                selectedJob.status === 'pending' ? <><Clock className="w-8 h-8 mb-2 opacity-50" /> <p>Waiting in queue...</p></> :
                  selectedJob.status === 'processing' ? <><Loader2 className="w-8 h-8 mb-2 animate-spin text-primary" /> <p>Executing secure API calls...</p></> :
                    selectedJob.status === 'error' ? <><AlertCircle className="w-8 h-8 mb-2 text-red-500" /> <p className="text-red-500">Processing failed.</p></> :
                      undefined
              }
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <Layers className="w-12 h-12 mb-4 opacity-20" />
              <p>Select a paper from the queue to view details.</p>
            </div>
          )}
        </main>
      </div>
    </div >
  );
}
