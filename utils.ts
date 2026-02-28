import { ProcessedQuestion } from './types';
import katex from 'katex';

// Convert File to Base64
export const fileToGenerativePart = async (file: File): Promise<{ inlineData: { data: string; mimeType: string } }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve({
        inlineData: {
          data: base64String,
          mimeType: file.type,
        },
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Processes text for Word Document export:
 * 1. Identifies LaTeX ($...$ or $$...$$) and converts to MathML for Word support.
 * 2. Converts Markdown bold/italic to HTML tags.
 * 3. Handles newlines.
 */
const processTextForWord = (text: string): string => {
  if (!text) return "";

  // Regex to split by LaTeX delimiters: $$...$$ (Display) or $...$ (Inline)
  // Capturing groups are included in the result array
  const parts = text.split(/(\$\$[\s\S]+?\$\$|\$[\s\S]+?\$)/g);

  return parts.map(part => {
    // Handle Display Math $$...$$
    if (part.startsWith('$$') && part.endsWith('$$')) {
      const tex = part.slice(2, -2).trim();
      try {
        // output: 'mathml' generates <math> tags which Word understands
        return katex.renderToString(tex, { 
          output: 'mathml', 
          displayMode: true, 
          throwOnError: false 
        });
      } catch (e) {
        return part; // Fallback to raw text on error
      }
    } 
    // Handle Inline Math $...$
    else if (part.startsWith('$') && part.endsWith('$')) {
      const tex = part.slice(1, -1).trim();
      try {
        return katex.renderToString(tex, { 
          output: 'mathml', 
          displayMode: false, 
          throwOnError: false 
        });
      } catch (e) {
        return part;
      }
    } 
    // Handle Regular Text
    else {
      let clean = part
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // Convert Markdown Bold **text** -> <strong>text</strong>
      clean = clean.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      
      // Convert Markdown Italic *text* -> <em>text</em>
      clean = clean.replace(/\*(.*?)\*/g, "<em>$1</em>");
      
      // Convert Newlines -> <br/>
      clean = clean.replace(/\n/g, "<br/>");
      
      return clean;
    }
  }).join('');
};

// Generate the Question File Content (HTML format for .doc)
export const generateQuestionFileContent = (questions: ProcessedQuestion[]): string => {
  const header = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><title>Modified Questions</title>
    <style>
      body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.2; }
      p { margin: 0 0 10px 0; }
      .q-container { margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
      .opt-container { margin-left: 20px; margin-top: 5px; }
      .note { color: #444; font-style: italic; background-color: #f9f9f9; padding: 5px; border: 1px dashed #ccc; margin-top: 10px; }
    </style>
    </head><body>
  `;

  const body = questions.map((q, idx) => {
    let html = `<div class="q-container">`;
    html += `<p><strong>Q${idx + 1}.</strong> ${processTextForWord(q.questionText)}</p>`;
    
    if (q.options && Object.keys(q.options).length > 0) {
      html += `<div class="opt-container">`;
      Object.entries(q.options).forEach(([key, val]) => {
        html += `<p><strong>${key}.</strong> ${processTextForWord(val)}</p>`;
      });
      html += `</div>`;
    }

    if (q.diagramNote) {
      html += `<p class="note"><strong>Note to create diagram:</strong> ${processTextForWord(q.diagramNote)}</p>`;
    }
    
    html += `</div>`;
    return html;
  }).join('');

  return header + body + "</body></html>";
};

// Generate the Solution File Content (HTML format for .doc)
export const generateSolutionFileContent = (questions: ProcessedQuestion[]): string => {
  const header = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><title>Modified Solutions</title>
    <style>
      body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.2; }
      p { margin: 0 0 10px 0; }
      .s-container { margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
    </style>
    </head><body>
    <h1>Solutions</h1>
  `;

  const body = questions.map((q, idx) => {
    return `<div class="s-container">` +
      `<p><strong>Q${idx + 1} Solution</strong></p>` +
      `<p><strong>Answer:</strong> ${processTextForWord(q.answer)}</p>` +
      `<p><strong>Explanation:</strong> ${processTextForWord(q.solution)}</p>` +
      `</div>`;
  }).join('');

  return header + body + "</body></html>";
};

export const downloadDocFile = (filename: string, content: string) => {
  const blob = new Blob(['\ufeff', content], { type: 'application/msword' });
  const element = document.createElement("a");
  element.href = URL.createObjectURL(blob);
  element.download = filename;
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
};
