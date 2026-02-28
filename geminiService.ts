import { GoogleGenAI, Chat, Type } from "@google/genai";
import { ProcessedQuestion } from '../types';

const MODEL_NAME = 'gemini-2.5-pro';

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// System Instruction based on the user's detailed prompt
const SYSTEM_INSTRUCTION = `
You are an expert JEE-level question-writer. Your task is to generate FRESH VARIANTS of uploaded questions.

*** CRITICAL INSTRUCTIONS ***
1. REPHRASE (STRICT): You MUST completely reframe the question language.
   - Do NOT just copy the original sentence structure. Change the wording, context, and voice significantly.
   - The question should read like a new problem testing the same concept.
   - Change ALL arithmetic values to new, calculation-friendly numbers (e.g., g=10, simple integers).
2. NUMBERS: Ensure new numbers lead to clean answers where possible.
3. LATEX (STRICT & COMPREHENSIVE):
   - You MUST use LaTeX '$...$' for ALL mathematical symbols, variables, Greek letters, and numbers.
   - WRONG: "Let x be angle alpha."
   - CORRECT: "Let $x$ be angle $\\alpha$."
   - WRONG: "Velocity is 5 m/s."
   - CORRECT: "Velocity is $5 \\text{ m/s}$."
   - Chemical formulas: Use LaTeX subscripts (e.g., $H_2SO_4$).
   - Use '$$...$$' for standalone equations.
   - IMPORTANT: Escape backslashes in JSON (e.g., "\\\\alpha", "\\\\frac").
4. FORMAT & OPTIONS (STRICT):
   - MCQ: **MANDATORY**. If the original question is Multiple Choice (MCQ/MSQ), you **MUST** generate 4 distinct options (A,B,C,D) or (1,2,3,4) matching the original style.
   - **NEVER** skip options for an MCQ. Hallucination of missing options is strictly forbidden.
   - NAT: Exact value.
5. MATCHING/LISTS (Column Matching) - **TOP PRIORITY**:
   - You MUST DETECT questions involving "List-I vs List-II" or "Column-I vs Column-II".
   - You MUST REWRITE the content of EVERY entry in BOTH lists inside the 'questionText'.
   - **DO NOT** use LaTeX tables or Markdown tables. Use simple text format with bold headers.
   - **REQUIRED FORMAT inside 'questionText'**:
     "Match the entries of List-I with List-II:
     
     **List-I**
     (P) [Modified Text P]
     (Q) [Modified Text Q]
     (R) [Modified Text R]
     (S) [Modified Text S]
     
     **List-II**
     (1) [Modified Text 1]
     (2) [Modified Text 2]
     (3) [Modified Text 3]
     (4) [Modified Text 4]"
   - **CRITICAL**: If you do not write out these lists in 'questionText', the question is meaningless. DO NOT SKIP THIS.
   - The 'options' field should only contain the choices (e.g., A: P-2, Q-1... use LaTeX if needed).
6. SOLUTION (CONCISE):
   - Provide a brief derivation using the NEW numbers.
   - **STRICTLY LIMIT** the solution to a maximum of 4-5 sentences.
   - Focus on the key formulas and final calculation steps only. Keep it short.
7. DIAGRAMS (MANDATORY):
   - Visually scan the original question for any figures, graphs, circuits, or diagrams.
   - If a diagram exists, you **MUST** provide a 'diagramNote' describing exactly how to redraw it with the NEW modified values.
   - DO NOT SKIP THIS if a diagram is present in the original.
8. OUTPUT: Strict JSON. Follow the original question numbering.

For MCQs, you MUST populate the 'optionsList' array.
`;

// Schema for structured output
const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      originalIndex: { type: Type.INTEGER },
      questionText: { type: Type.STRING, description: "Modified text. Completely rephrased. Use $...$ for math. *CRITICAL*: For Matching questions, you MUST write out the full text content of List-I and List-II here with **Headers**." },
      type: { type: Type.STRING, enum: ["MCQ", "NAT", "MSQ", "Other"] },
      optionsList: {
        type: Type.ARRAY,
        nullable: true,
        description: "MANDATORY for MCQ/MSQ. Must contain all options (A,B,C,D) with modified values.",
        items: {
          type: Type.OBJECT,
          properties: {
            key: { type: Type.STRING },
            value: { type: Type.STRING }
          },
          required: ["key", "value"]
        }
      },
      answer: { type: Type.STRING },
      solution: { type: Type.STRING, description: "Concise solution using new values. STRICTLY Max 4-5 sentences." },
      diagramNote: { type: Type.STRING, nullable: true, description: "MANDATORY if original question has a diagram. Describe how to redraw with new values." }
    },
    required: ["originalIndex", "questionText", "type", "answer", "solution"]
  }
};

export class GeminiProcessor {
  private chat: Chat | null = null;

  async startSession(questionPart: any, solutionPart: any) {
    this.chat = ai.chats.create({
      model: MODEL_NAME,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
      }
    });

    const response = await this.chat.sendMessage({
      message: [
        questionPart.inlineData ? questionPart : { inlineData: questionPart },
        solutionPart.inlineData ? solutionPart : { inlineData: solutionPart },
        { text: "Analyze the uploaded Question Paper and Solution Paper. How many distinct questions are there? Return ONLY the integer number." }
      ]
    });

    const text = response.text || "0";
    console.log("Count response:", text);
    const count = parseInt(text.match(/\d+/)?.[0] || "0", 10);
    return count;
  }

  async processBatch(startIndex: number, batchSize: number): Promise<ProcessedQuestion[]> {
    if (!this.chat) throw new Error("Session not started");

    const prompt = `
      Generate variants for questions ${startIndex} to ${startIndex + batchSize - 1}.
      
      REMINDERS:
      - STRICTLY REFRAME the language and context. Do NOT copy original text.
      - Change ALL numbers.
      - ENFORCE LATEX: Put ALL math, variables ($x, y, \\theta$), and numbers ($5, 10^{-2}$) inside '$...$'.
      - **Matching/List Questions**: 
          1. Detect "Match the following" or "List-I / List-II".
          2. MODIFY the content of ALL list entries (P,Q,R,S vs 1,2,3,4).
          3. **CRITICAL**: You MUST write out the FULL CONTENT of List-I and List-II inside 'questionText'. Use **List-I** and **List-II** headers. Do NOT omit them.
      - **Diagrams**: If the original question contains ANY diagram/graph, you **MUST** include a 'diagramNote'.
      - **MCQ Options**: MANDATORY. If the original question had options, you MUST generate modified options. Do NOT skip them.
      - **Solutions**: STRICTLY LIMIT solution to 4-5 sentences max. Be concise.
      
      Return valid JSON.
    `;

    try {
      const response = await this.chat.sendMessage({
        message: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA
        }
      });

      const jsonText = response.text || "[]";

      let cleanJson = jsonText;
      const firstBracket = jsonText.indexOf('[');
      const lastBracket = jsonText.lastIndexOf(']');

      if (firstBracket !== -1 && lastBracket !== -1) {
        cleanJson = jsonText.substring(firstBracket, lastBracket + 1);
      }

      let rawData;
      try {
        rawData = JSON.parse(cleanJson);
      } catch (parseError) {
        console.error("JSON Parse Error:", parseError, "Raw Text:", jsonText);
        throw new Error("Failed to parse AI response.");
      }

      return rawData.map((q: any) => {
        const optionsMap: Record<string, string> = {};

        // Handle optionsList (Schema preferred)
        if (q.optionsList && Array.isArray(q.optionsList)) {
          q.optionsList.forEach((opt: any) => {
            if (opt.key && opt.value) optionsMap[opt.key] = opt.value;
          });
        }
        // Fallback: Handle if model returns 'options' object directly
        else if (q.options && typeof q.options === 'object') {
          Object.entries(q.options).forEach(([k, v]) => {
            optionsMap[k] = v as string;
          });
        }

        return {
          originalIndex: q.originalIndex,
          questionText: q.questionText,
          type: q.type,
          options: Object.keys(optionsMap).length > 0 ? optionsMap : undefined,
          answer: q.answer,
          solution: q.solution,
          diagramNote: q.diagramNote
        } as ProcessedQuestion;
      });

    } catch (e) {
      console.error("Error processing batch:", e);
      throw e;
    }
  }
}