import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getToken } from 'next-auth/jwt';
import { authOptions } from '@/lib/auth';
import { createGoogleTokenProvider, GoogleTokenError } from '@/lib/googleToken';
import { checkAllowedStatus, geminiGenerate, PWAccessError } from '@/pw_access.js';

export const maxDuration = 300;

// ─── JEE System Instruction ──────────────────────────────────────────────────
const SYSTEM_INSTRUCTION_JEE = `
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

const BATCH_PROMPT_JEE = (startIndex: number, endIndex: number) => `
Generate variants for questions ${startIndex} to ${endIndex}.

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

// ─── NEET Physics + Chemistry System Instruction ─────────────────────────────
const SYSTEM_INSTRUCTION_NEET_PHYCHEM = `
You are an expert NEET-UG question-writer for PHYSICS and CHEMISTRY, aligned to NCERT and NEET exam style. Your task is to generate FRESH VARIANTS of uploaded questions while preserving the same concept and NEET difficulty.

*** CRITICAL INSTRUCTIONS ***
1. REPHRASE (STRICT): You MUST completely reframe the question language.
   - Do NOT copy the original sentence structure.
   - Change wording, context, and voice significantly while testing the SAME concept.
2. NEET LEVEL (STRICT):
   - Keep difficulty appropriate for NEET.
   - Stay within the topic scope implied by the original question.
3. NUMBERS (SAFE MODIFICATION FOR PHY/CHEM):
   - You SHOULD change numeric values that are scenario/calculation parameters (masses, distances, voltages, concentrations, temperatures, etc.) to new, calculation-friendly values.
   - For Physics numericals: prefer clean values that yield clean answers (e.g., take $g = 10\\ \\text{m/s}^2$ when suitable).
   - DO NOT change identity-defining facts:
       • Chemistry: atomic number, element identity markers, standard valencies where identity depends, fixed constants used as facts (unless the question explicitly allows approximation).
       • Named constants in statement-type questions if they are being tested as facts.
   - If unsure whether a number is a fact vs a parameter, KEEP IT UNCHANGED.
4. LATEX (STRICT & COMPREHENSIVE):
   - You MUST use LaTeX '$...$' for ALL mathematical symbols, variables, Greek letters, units, and numerical quantities.
   - WRONG: "Velocity is 5 m/s."
   - CORRECT: "Velocity is $5 \\text{ m/s}$."
   - Chemical formulas: Use LaTeX subscripts (e.g., $H_2SO_4$).
   - Use '$$...$$' for standalone equations.
   - IMPORTANT: Escape backslashes in JSON (e.g., "\\\\alpha", "\\\\frac").
5. FORMAT & OPTIONS (STRICT):
   - MCQ: **MANDATORY**. If the original question is Multiple Choice (including Assertion-Reason), you MUST generate 4 distinct options matching the original style (A,B,C,D) or (1,2,3,4).
   - **NEVER** skip options for an MCQ. Hallucination of missing options is strictly forbidden.
   - If original is clearly MSQ/NAT, keep that type; otherwise default to MCQ.
6. MATCHING/LISTS (Column Matching) - TOP PRIORITY:
   - You MUST DETECT questions involving "List-I vs List-II" or "Column-I vs Column-II" or "Match the following".
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
   - The 'optionsList' field should contain only the mapping choices (e.g., A: P-2, Q-1...).
7. SOLUTION (CONCISE):
   - Provide a brief derivation using the NEW numbers (only where safe).
   - STRICTLY limit solution to maximum 4-5 sentences.
   - Focus on key formula + final steps.
8. DIAGRAMS (MANDATORY):
   - Visually scan the original question for any figures, graphs, circuits, or diagrams.
   - If a diagram exists, you MUST provide a 'diagramNote' describing exactly how to redraw it with NEW modified values (or retained values if they were factual).
   - DO NOT SKIP THIS if a diagram is present.
9. OUTPUT:
   - Strict JSON only. Follow the original question numbering (originalIndex).
   - For MCQs, you MUST populate the 'optionsList' array.
`;

const BATCH_PROMPT_NEET_PHYCHEM = (startIndex: number, endIndex: number) => `
Generate variants for questions ${startIndex} to ${endIndex}.

REMINDERS:
- STRICTLY REFRAME the language and context. Do NOT copy original text.
- NEET-UG Physics/Chemistry level (NCERT-aligned). Do NOT increase difficulty beyond NEET.
- Numbers: change scenario/calculation parameters; do NOT change identity-defining facts (e.g., atomic number/element identity, fixed factual constants).
- ENFORCE LATEX: Put ALL math symbols, variables ($x, y, \\\\theta$), units, and numerical quantities ($5, 10^{-2}$) inside '$...$'.
- Matching/List Questions:
  1. Detect "Match the following" or "List-I / List-II".
  2. MODIFY content of ALL list entries (P,Q,R,S vs 1,2,3,4).
  3. Write FULL List-I and List-II inside 'questionText' with **List-I** and **List-II** headers (NO tables).
- Diagrams: If the original question contains ANY diagram/graph, you MUST include a 'diagramNote'.
- MCQ Options: If the original question had options, you MUST generate 4 modified options. Do NOT skip them.
- Solutions: STRICTLY LIMIT solution to 4-5 sentences max.

Return valid JSON only.
`;

// ─── NEET Biology System Instruction ─────────────────────────────────────────
const SYSTEM_INSTRUCTION_NEET_BIO = `
You are an expert NEET-UG BIOLOGY question-writer aligned to NCERT. Your task is to generate FRESH VARIANTS of uploaded Biology questions while preserving the SAME concept and being factually correct.

*** CRITICAL INSTRUCTIONS ***
1. REPHRASE (STRICT): You MUST completely reframe the question language.
   - Do NOT copy the original sentence structure.
   - Change wording and context, but do NOT change the underlying Biology fact being tested.
2. NCERT FACTUAL SAFETY (TOP PRIORITY):
   - You MUST NOT introduce new biological facts not implied by the original question.
   - Do NOT change technical meanings, definitions, or NCERT statements.
   - Do NOT invent new species, pathways, genes, or exceptions.
3. NUMBERS (VERY RESTRICTED FOR BIOLOGY):
   - DO NOT change numbers that represent NCERT facts or fixed biological constants.
     Examples: chromosome numbers, codon counts, standard ratios/values tested as facts, named stages/counts, standard genome/ploidy facts.
   - Only change numbers if they are clearly *experimental or scenario parameters* (e.g., "20 seedlings were observed") AND changing them does not turn the statement into a new fact.
   - If you are unsure whether a number is a fact, KEEP IT UNCHANGED.
4. LATEX (STRICT & COMPREHENSIVE):
   - You MUST use LaTeX '$...$' for ALL mathematical symbols, variables, units, and numerical quantities (when they appear).
   - Chemical formulas must use LaTeX subscripts (e.g., $CO_2$, $H_2O$).
   - Escape backslashes in JSON (e.g., "\\\\alpha", "\\\\frac").
5. FORMAT & OPTIONS (STRICT):
   - MCQ: **MANDATORY**. If the original question is MCQ/Assertion-Reason/Statement-based with options, you MUST output exactly 4 options (A,B,C,D) matching the original style.
   - NEVER skip options for MCQ. Do not hallucinate missing options if they were not present.
   - Keep NEET single-correct style unless the original clearly indicates MSQ/NAT.
6. MATCHING/LISTS (Column Matching) - TOP PRIORITY:
   - Detect "Match the following", "List-I/List-II", "Column-I/Column-II".
   - Rewrite EVERY entry in BOTH lists inside 'questionText' but KEEP BIOLOGY FACTS CORRECT.
   - NO tables. Use simple text with bold headers.
   - REQUIRED format inside 'questionText':
     "Match the entries of List-I with List-II:

     **List-I**
     (P) ...
     (Q) ...
     (R) ...
     (S) ...

     **List-II**
     (1) ...
     (2) ...
     (3) ...
     (4) ..."
   - 'optionsList' contains mapping choices only (e.g., A: P-2, Q-1...).
7. SOLUTION (CONCISE, NCERT-STYLE):
   - Max 4-5 sentences.
   - State the key NCERT reason(s) and the final answer.
   - No extra trivia or out-of-syllabus details.
8. DIAGRAMS (MANDATORY):
   - If the original question contains ANY diagram/labelled figure, you MUST include a 'diagramNote'.
   - For Biology, redraw guidance must preserve anatomical/label correctness. Only modify labels/text if you are certain it remains correct.
9. OUTPUT:
   - Strict JSON only. Follow original numbering (originalIndex).
   - For MCQs, you MUST populate the 'optionsList' array.
`;

const BATCH_PROMPT_NEET_BIO = (startIndex: number, endIndex: number) => `
Generate variants for questions ${startIndex} to ${endIndex}.

REMINDERS (BIOLOGY):
- STRICTLY REFRAME the language and context. Do NOT copy original text.
- NCERT factual correctness is the highest priority. Do NOT add new facts.
- Numbers: DO NOT change factual/NCERT numbers (chromosomes, codons, standard counts). Only change clearly experimental sample sizes if safe; if unsure, keep unchanged.
- ENFORCE LATEX: Put ALL variables, units, and numerical quantities inside '$...$' when they appear. Use chemical formula subscripts (e.g., $CO_2$).
- Matching/List Questions:
  1. Detect "Match the following" or "List-I / List-II".
  2. MODIFY content of ALL list entries but keep them biologically correct.
  3. Write FULL List-I and List-II inside 'questionText' with **List-I** and **List-II** headers (NO tables).
- Diagrams: If the original contains ANY diagram/labelled figure, include a 'diagramNote' with redraw instructions that preserve correct labels.
- MCQ Options: If original had options, MUST generate 4 options. Do NOT skip.
- Solutions: STRICTLY LIMIT solution to 4-5 sentences max, NCERT style.

Return valid JSON only.
`;

// ─── Helpers to pick instruction/prompt by subject ───────────────────────────
function getSystemInstruction(subject: string): string {
  if (subject === 'neet-phychem') return SYSTEM_INSTRUCTION_NEET_PHYCHEM;
  if (subject === 'neet-bio') return SYSTEM_INSTRUCTION_NEET_BIO;
  return SYSTEM_INSTRUCTION_JEE; // default: jee
}

function getBatchPrompt(subject: string, startIndex: number, endIndex: number): string {
  if (subject === 'neet-phychem') return BATCH_PROMPT_NEET_PHYCHEM(startIndex, endIndex);
  if (subject === 'neet-bio') return BATCH_PROMPT_NEET_BIO(startIndex, endIndex);
  return BATCH_PROMPT_JEE(startIndex, endIndex);
}

// ─── Shared Response Schema ───────────────────────────────────────────────────
const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      originalIndex: { type: "INTEGER" },
      questionText: { type: "STRING", description: "Modified text. Completely rephrased. Use $...$ for math. *CRITICAL*: For Matching questions, you MUST write out the full text content of List-I and List-II here with **Headers**." },
      type: { type: "STRING", enum: ["MCQ", "NAT", "MSQ", "Other"] },
      optionsList: {
        type: "ARRAY",
        nullable: true,
        description: "MANDATORY for MCQ/MSQ. Must contain all options (A,B,C,D) with modified values.",
        items: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING" },
            value: { type: "STRING" }
          },
          required: ["key", "value"]
        }
      },
      answer: { type: "STRING" },
      solution: { type: "STRING", description: "Concise solution using new values. STRICTLY Max 4-5 sentences." },
      diagramNote: { type: "STRING", nullable: true, description: "MANDATORY if original question has a diagram. Describe how to redraw with new values." }
    },
    required: ["originalIndex", "questionText", "type", "answer", "solution"]
  }
};

// Two-model split: a fast flash model counts the questions (perception, no
// deep reasoning), the pro model does the actual modification (recomputing
// answers must not be economized). Env-overridable so a bad preview rollout
// can be reverted from Vercel settings without a code change.
const COUNT_MODEL = process.env.COUNT_MODEL || 'gemini-3.5-flash';
const BATCH_MODEL = process.env.BATCH_MODEL || 'gemini-3.1-pro-preview';
// Gemini 3.x thinking control (thinkingLevel replaces 2.5's thinkingBudget).
const COUNT_THINKING_LEVEL = process.env.COUNT_THINKING_LEVEL || 'low';
const BATCH_THINKING_LEVEL = process.env.BATCH_THINKING_LEVEL || 'high';

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

const COUNT_PROMPT = "Analyze the uploaded Question Paper and Solution Paper. How many distinct questions are there? Return ONLY the integer number.";

function geminiSystemInstruction(text: string) {
  return { parts: [{ text }] };
}

function getGeminiText(response: any): string {
  if (typeof response?.text === 'string') return response.text;
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((part: any) => part?.text || '').join('');
  }
  return '';
}

// Retry transient network-level failures (socket resets, DNS blips — seen in
// production as a bare "fetch failed" that killed whole papers). HTTP-level
// errors arrive as PWAccessError (the proxy already retried what's
// retryable) and auth failures as GoogleTokenError — both are final. Our own
// timeouts (AbortError) are also final: retrying a 300s timeout would blow
// the function deadline.
const NETWORK_RETRIES = 2;
async function withNetworkRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const isFinal = e instanceof PWAccessError
        || e instanceof GoogleTokenError
        || e?.name === 'AbortError'
        || attempt >= NETWORK_RETRIES;
      if (isFinal) throw e;
      await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
    }
  }
}

function processBatchResults(rawData: any[]) {
  return rawData.map((q: any) => {
    const optionsMap: Record<string, string> = {};
    if (q.optionsList && Array.isArray(q.optionsList)) {
      q.optionsList.forEach((opt: any) => {
        if (opt.key && opt.value) optionsMap[opt.key] = opt.value;
      });
    } else if (q.options && typeof q.options === 'object') {
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
    };
  });
}

const BATCH_SIZE = 5;

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const nextAuthToken = await getToken({ req: req as any, secret: process.env.NEXTAUTH_SECRET });
    // Token provider, not a string: pw_access calls it whenever it needs a
    // live Google token, and it refreshes via the stored refresh token — so
    // requests hours after sign-in (or on cold instances) still work.
    const googleToken = createGoogleTokenProvider((nextAuthToken as any) || {});

    try {
      await googleToken();
    } catch {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    const allowStatus = await checkAllowedStatus(googleToken);
    if (allowStatus === 'denied') {
      return NextResponse.json(
        { error: 'Not authorized for this app. Ask the admin to add your email to the Question Modifier column of the whitelist sheet.' },
        { status: 403 }
      );
    }
    if (allowStatus !== 'allowed') {
      // Fail closed, but say what actually happened: the allowlist check
      // errored (proxy unreachable or credential rejected), not a real "no".
      return NextResponse.json(
        { error: 'Could not verify access — please retry; if it persists, sign out and sign in again.' },
        { status: 503 }
      );
    }

    const body = await req.json();
    const { action, subject = 'jee', filename = '' } = body;
    const { qPdfBase64, qMime, sPdfBase64, sMime } = body;
    if (!qPdfBase64 || !sPdfBase64) {
      return NextResponse.json({ error: 'Missing PDF data' }, { status: 400 });
    }

    const systemInstruction = getSystemInstruction(subject);
    const inputUnit = 'No. of questions';

    // One paper is processed across MANY short requests — one 'count', then
    // one 'batch' per 5 questions — driven by the browser, so no single
    // request has to outlive Vercel's function time cap. Without a
    // UsageSession, each call self-logs to Usage Cost as it happens, so even
    // an abandoned run accounts for what it spent.
    const initialUserTurn = {
      role: 'user',
      parts: [
        { inlineData: { data: qPdfBase64, mimeType: qMime || 'application/pdf' } },
        { inlineData: { data: sPdfBase64, mimeType: sMime || 'application/pdf' } },
        { text: COUNT_PROMPT }
      ]
    };

    if (action === 'count') {
      const countProxyResponse = await withNetworkRetry(() => geminiGenerate(googleToken, {
        model: COUNT_MODEL,
        request: {
          contents: [initialUserTurn],
          systemInstruction: geminiSystemInstruction(systemInstruction),
          safetySettings: SAFETY_SETTINGS,
          generationConfig: {
            thinkingConfig: { thinkingLevel: COUNT_THINKING_LEVEL },
          },
        },
        filename,
        input_unit: inputUnit,
      }));

      const countText = getGeminiText(countProxyResponse.result);
      console.log("Count Response string:", countText);
      const totalQuestions = parseInt(countText.replace(/["']/g, '').match(/\d+/)?.[0] || "0", 10);
      if (totalQuestions === 0) {
        throw new Error(`Failed to parse an integer from Gemini response. Raw Response String was: "${countText.slice(0, 200)}"`);
      }
      return NextResponse.json({ totalQuestions, countText });
    }

    if (action === 'batch') {
      const totalQuestions = Number(body.totalQuestions);
      const startIndex = Number(body.startIndex);
      if (!Number.isInteger(totalQuestions) || totalQuestions < 1 || totalQuestions > 1000
        || !Number.isInteger(startIndex) || startIndex < 1 || startIndex > totalQuestions) {
        return NextResponse.json({ error: 'Invalid batch range' }, { status: 400 });
      }
      const endIndex = Math.min(startIndex + BATCH_SIZE - 1, totalQuestions);
      const countText = typeof body.countText === 'string' && body.countText
        ? body.countText
        : String(totalQuestions);

      // Rebuild the conversation: PDFs + count exchange, then the prior
      // batches the client echoes back (so the model still sees its earlier
      // output — the same context the old single-request loop accumulated),
      // then this batch's instruction. Malformed history entries are skipped.
      const contents: any[] = [
        initialUserTurn,
        { role: 'model', parts: [{ text: countText }] },
      ];
      const history = Array.isArray(body.history) ? body.history : [];
      for (const h of history) {
        const hs = Number(h?.start);
        const he = Number(h?.end);
        if (!Number.isInteger(hs) || !Number.isInteger(he) || typeof h?.jsonText !== 'string') continue;
        contents.push({ role: 'user', parts: [{ text: getBatchPrompt(subject, hs, he) }] });
        contents.push({ role: 'model', parts: [{ text: h.jsonText }] });
      }
      contents.push({ role: 'user', parts: [{ text: getBatchPrompt(subject, startIndex, endIndex) }] });

      const batchProxyResponse = await withNetworkRetry(() => geminiGenerate(googleToken, {
        model: BATCH_MODEL,
        request: {
          contents,
          systemInstruction: geminiSystemInstruction(systemInstruction),
          safetySettings: SAFETY_SETTINGS,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            thinkingConfig: { thinkingLevel: BATCH_THINKING_LEVEL },
          }
        },
        filename,
        input_unit: inputUnit,
        count: totalQuestions as any,
      }));

      const jsonText = getGeminiText(batchProxyResponse.result) || '[]';
      let cleanJson = jsonText;
      const firstBracket = jsonText.indexOf('[');
      const lastBracket = jsonText.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket !== -1) {
        cleanJson = jsonText.substring(firstBracket, lastBracket + 1);
      }
      const results = processBatchResults(JSON.parse(cleanJson));
      return NextResponse.json({ results, jsonText });
    }

    // Unknown action — includes the old single-request 'process' from tabs
    // opened before this deploy.
    return NextResponse.json({ error: 'Please refresh the page — the app was updated.' }, { status: 400 });
  } catch (error: any) {
    console.error("API Generate Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
