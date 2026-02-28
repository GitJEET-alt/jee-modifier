import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileText, Play, AlertCircle, Loader2, CheckCircle2, Plus, Trash2, Layers, Clock } from 'lucide-react';
import { GeminiProcessor } from './services/geminiService';
import { ProcessedQuestion, PaperJob } from './types';
import { fileToGenerativePart, generateQuestionFileContent, generateSolutionFileContent, downloadDocFile } from './utils';
import { Preview } from './components/Preview';

export default function App() {
  // --- State ---
  const [jobs, setJobs] = useState<PaperJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // Staging Inputs (for adding new pair)
  const [stageQ, setStageQ] = useState<File | null>(null);
  const [stageS, setStageS] = useState<File | null>(null);

  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const processorRef = useRef<GeminiProcessor | null>(null);

  // --- Initialization ---
  useEffect(() => {
    processorRef.current = new GeminiProcessor();
  }, []);

  // --- Job Management ---
  const handleStageFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'q' | 's') => {
    if (e.target.files && e.target.files[0]) {
      if (type === 'q') setStageQ(e.target.files[0]);
      else setStageS(e.target.files[0]);
    }
  };

  const addJob = () => {
    if (!stageQ || !stageS) return;

    const newJob: PaperJob = {
      id: Date.now().toString() + Math.random().toString().slice(2),
      name: `${stageQ.name.replace('.pdf', '')}`,
      qFile: stageQ,
      sFile: stageS,
      status: 'pending',
      questions: [],
      progress: {
        totalQuestions: 0,
        processedCount: 0,
        currentAction: 'Waiting in queue...',
        isComplete: false
      }
    };

    setJobs(prev => [...prev, newJob]);
    setStageQ(null);
    setStageS(null);

    // Auto-select if it's the first one
    if (!selectedJobId) setSelectedJobId(newJob.id);
  };

  const removeJob = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setJobs(prev => prev.filter(j => j.id !== id));
    if (selectedJobId === id) setSelectedJobId(null);
  };

  // --- Processing Logic ---

  // Update a specific job in state safely
  const updateJob = (id: string, updates: Partial<PaperJob> | ((j: PaperJob) => Partial<PaperJob>)) => {
    setJobs(prev => prev.map(job => {
      if (job.id !== id) return job;
      const newValues = typeof updates === 'function' ? updates(job) : updates;
      return { ...job, ...newValues };
    }));
  };

  const processSingleJob = async (job: PaperJob) => {
    if (!processorRef.current) return;

    updateJob(job.id, {
      status: 'processing',
      progress: { ...job.progress, currentAction: 'Initializing Gemini & Analyzing PDFs...' }
    });

    try {
      const qPart = await fileToGenerativePart(job.qFile);
      const sPart = await fileToGenerativePart(job.sFile);

      // Start Session & Get Count
      const totalQ = await processorRef.current.startSession(qPart, sPart);

      if (totalQ === 0) {
        throw new Error("Could not detect any questions. Please ensure the PDF is clear.");
      }

      updateJob(job.id, {
        progress: {
          ...job.progress,
          totalQuestions: totalQ,
          processedCount: 0,
          currentAction: `Found ${totalQ} questions. Starting batch processing...`
        }
      });

      // Process in batches
      const BATCH_SIZE = 5;
      let currentIdx = 1;

      while (currentIdx <= totalQ) {
        // Update status for current batch
        updateJob(job.id, (j) => ({
          progress: {
            ...j.progress,
            currentAction: `Processing questions ${currentIdx} to ${Math.min(currentIdx + BATCH_SIZE - 1, totalQ)}...`
          }
        }));

        // Fetch batch
        const batchResults = await processorRef.current.processBatch(currentIdx, BATCH_SIZE);

        // Update results
        updateJob(job.id, (j) => ({
          questions: [...j.questions, ...batchResults],
          progress: {
            ...j.progress,
            processedCount: Math.min(j.progress.processedCount + batchResults.length, totalQ)
          }
        }));

        currentIdx += BATCH_SIZE;

        // Rate limit delay
        await new Promise(r => setTimeout(r, 1000));
      }

      updateJob(job.id, {
        status: 'completed',
        progress: {
          totalQuestions: totalQ,
          processedCount: totalQ,
          currentAction: 'Processing Complete!',
          isComplete: true
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

    // Find all pending jobs. We iterate by index to ensure we re-check state if needed,
    // but a simple loop over the initial list is safer to avoid infinite loops if state changes.
    // However, we want to process them strictly sequentially.

    // We get the list of IDs that are pending at start
    const pendingIds = jobs.filter(j => j.status === 'pending').map(j => j.id);

    for (const id of pendingIds) {
      // Get fresh state
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

  // --- Derived State for UI ---
  const selectedJob = jobs.find(j => j.id === selectedJobId);
  const pendingCount = jobs.filter(j => j.status === 'pending').length;

  return (
    <div className="flex h-screen bg-slate-50">
      {/* Sidebar / Control Panel */}
      <div className="w-96 bg-white border-r border-slate-200 flex flex-col shadow-lg z-10">
        <div className="p-6 border-b border-slate-100">
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <span className="text-primary text-3xl">∑</span> JEE Modifier
          </h1>
          <p className="text-xs text-slate-500 mt-1">Multi-Paper Variant Generator</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">

          {/* Add New Pair Section */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add Paper Pair
            </h2>

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
              disabled={!stageQ || !stageS || isQueueRunning}
              className="w-full bg-slate-800 hover:bg-slate-700 disabled:bg-slate-300 text-white py-2 rounded text-xs font-bold flex items-center justify-center gap-2"
            >
              Add to Queue
            </button>
          </div>

          {/* Jobs List */}
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
                    {/* Remove Button (only if not running) */}
                    {!isQueueRunning && (
                      <button
                        onClick={(e) => removeJob(job.id, e)}
                        className="absolute top-2 right-2 text-slate-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}

                    <div className="flex items-center gap-2 mb-2 pr-4">
                      {job.status === 'pending' && <Clock className="w-4 h-4 text-slate-400" />}
                      {job.status === 'processing' && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
                      {job.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                      {job.status === 'error' && <AlertCircle className="w-4 h-4 text-red-500" />}

                      <span className="font-semibold text-sm text-slate-700 truncate block w-full">
                        {job.name}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    {(job.status === 'processing' || (job.status === 'completed' && job.progress.totalQuestions > 0)) && (
                      <div className="w-full bg-slate-200 rounded-full h-1.5 mb-2 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-500 ${job.status === 'completed' ? 'bg-green-500' : 'bg-primary'}`}
                          style={{ width: `${(job.progress.processedCount / (job.progress.totalQuestions || 1)) * 100}%` }}
                        />
                      </div>
                    )}

                    {/* Status Text */}
                    <div className="text-xs text-slate-500 truncate">
                      {job.progress.error ? <span className="text-red-500">{job.progress.error}</span> : job.progress.currentAction}
                    </div>

                    {/* Downloads for this specific card */}
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

        {/* Global Action Button */}
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
      </div>

      {/* Main Content / Preview Area */}
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
          <div className="text-xs text-slate-400">
            Generates variants with LaTeX support
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-8 bg-slate-50">
          {selectedJob ? (
            <Preview
              questions={selectedJob.questions}
              emptyMessage={
                selectedJob.status === 'pending' ? <><Clock className="w-8 h-8 mb-2 opacity-50" /> <p>Waiting in queue...</p></> :
                  selectedJob.status === 'processing' ? <><Loader2 className="w-8 h-8 mb-2 animate-spin text-primary" /> <p>Processing... Check sidebar for progress.</p></> :
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
    </div>
  );
}
