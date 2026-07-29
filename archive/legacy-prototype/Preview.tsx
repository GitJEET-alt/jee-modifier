import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ProcessedQuestion } from '../types';

interface PreviewProps {
  questions: ProcessedQuestion[];
  emptyMessage?: React.ReactNode;
}

export const Preview: React.FC<PreviewProps> = ({ questions, emptyMessage }) => {
  if (questions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
        {emptyMessage || (
          <>
            <p>No questions processed yet.</p>
            <p className="text-sm">Upload files and start generation.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20">
      {questions.map((q, idx) => (
        <div key={idx} className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
          <div className="flex justify-between items-start mb-4 border-b border-slate-100 pb-2">
            <h3 className="font-bold text-slate-700">Modified Q{idx + 1} (Orig: {q.originalIndex})</h3>
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-1 rounded">{q.type}</span>
          </div>

          {/* Question Text */}
          <div className="prose prose-slate max-w-none mb-4 text-sm">
            <ReactMarkdown 
              remarkPlugins={[remarkMath]} 
              rehypePlugins={[rehypeKatex]}
            >
              {q.questionText}
            </ReactMarkdown>
          </div>

          {/* Diagram Note (Neutral Style) */}
          {q.diagramNote && (
            <div className="bg-slate-50 border border-slate-200 p-3 mb-4 text-sm rounded flex flex-col sm:flex-row sm:items-start gap-2">
               <strong className="text-slate-700 font-semibold whitespace-nowrap">Diagram Note:</strong>
               <div className="text-slate-600 italic">
                   <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {q.diagramNote}
                   </ReactMarkdown>
               </div>
            </div>
          )}

          {/* Options */}
          {q.options && Object.keys(q.options).length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4 bg-slate-50 p-4 rounded border border-slate-100">
              {Object.entries(q.options).map(([key, val]) => (
                <div key={key} className="flex items-start text-sm p-1">
                   <span className="font-bold mr-2 text-slate-600 min-w-[1.5rem]">{key}.</span>
                   <div className="prose prose-sm max-w-none">
                     <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {val}
                     </ReactMarkdown>
                   </div>
                </div>
              ))}
            </div>
          )}

          {/* Answer & Solution Toggle */}
          <details className="group">
            <summary className="cursor-pointer text-sm font-semibold text-primary hover:text-blue-700 select-none">
              View Solution & Answer
            </summary>
            <div className="mt-3 bg-blue-50 p-4 rounded text-sm space-y-2 border border-blue-100">
              <p className="flex items-center gap-2">
                <span className="font-bold text-blue-900">Answer:</span> 
                <span className="font-mono bg-white px-2 py-0.5 rounded border border-blue-200">{q.answer}</span>
              </p>
              <div>
                <span className="font-bold text-blue-900">Solution:</span>
                <div className="prose prose-sm max-w-none mt-1 text-slate-700">
                  <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                    {q.solution}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          </details>
        </div>
      ))}
    </div>
  );
};
