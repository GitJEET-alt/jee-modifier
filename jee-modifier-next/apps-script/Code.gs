/**
 * Whitelist + usage + cost tracking for JEE Modifier.
 *
 * SETUP (in-place upgrade of the existing script):
 *   1. Open your existing JEE Modifier sheet (the one currently holding the
 *      Whitelist + Usage tabs).
 *   2. Extensions -> Apps Script.
 *   3. Replace ALL contents of Code.gs with this file.
 *   4. Set SHEET_ID below — copy from the sheet URL:
 *        https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
 *   5. Save (disk icon).
 *   6. Deploy -> Manage deployments -> click the existing JEE Modifier deployment
 *      -> pencil (Edit) -> Version: New version -> Description: "Add cost tracking"
 *      -> Deploy.
 *   7. The /exec URL is unchanged. No Vercel env var change required.
 *
 * SHEET STRUCTURE (Pricing + new Usage columns auto-created on first POST):
 *   "Whitelist" : col A = Email (header in row 1)
 *   "Usage"     : Timestamp | Email | Subject | Filename | Total Questions
 *                 | Tokens Input | Tokens Output | Model | Cost (USD)
 *   "Pricing"   : Model | Input rate (<=200K) | Output rate (<=200K)
 *                 | Input rate (>200K) | Output rate (>200K)
 *
 *   Rates are USD per 1,000,000 tokens. Blank high-tier rate falls back to
 *   the low-tier rate.
 *
 * COST RULE:
 *   Cost is computed at append time using the Pricing tab and written as a
 *   literal number into column I. Editing the Pricing tab later only affects
 *   new rows; historical rows stay at the rate they were billed at.
 *
 * MIGRATION NOTE:
 *   Old rows had column D = "Total Questions". New rows have column D = "Filename"
 *   and column E = "Total Questions". Old data is preserved but will appear
 *   misaligned under the new column headers — this is expected.
 */

const SHEET_ID = '<paste your sheet ID here>';

const SHEET_WHITELIST = 'Whitelist';
const SHEET_USAGE = 'Usage';
const SHEET_PRICING = 'Pricing';
const TIER_THRESHOLD = 200000;

const USAGE_HEADERS = [
  'Timestamp', 'Email', 'Subject', 'Filename', 'Total Questions',
  'Tokens Input', 'Tokens Output', 'Model', 'Cost (USD)'
];

const PRICING_HEADERS = [
  'Model', 'Input rate (<=200K)', 'Output rate (<=200K)',
  'Input rate (>200K)', 'Output rate (>200K)'
];

const PRICING_SEED = [
  ['gemini-2.5-pro',         1.25, 10.00, 2.50, 15.00],
  ['gemini-2.5-flash',       0.30,  2.50, '',   ''   ],
  ['gemini-2.5-flash-lite',  0.10,  0.40, '',   ''   ],
  ['gemini-3.1-pro-preview', 2.00, 12.00, 4.00, 18.00]
];

function doGet(e) {
  try {
    const email = ((e.parameter && e.parameter.email) || '').toLowerCase().trim();
    if (!email) return jsonOut({ allowed: false, error: 'Missing email parameter' });

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSheet(ss, SHEET_WHITELIST, ['Email']);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOut({ allowed: false });

    const emails = sheet.getRange(2, 1, lastRow - 1, 1).getValues()
      .flat()
      .map(function (v) { return String(v).toLowerCase().trim(); })
      .filter(function (v) { return v.length > 0; });

    return jsonOut({ allowed: emails.indexOf(email) !== -1 });
  } catch (err) {
    return jsonOut({ allowed: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const data = JSON.parse((e.postData && e.postData.contents) || '{}');
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSheet(ss, SHEET_USAGE, USAGE_HEADERS);

    const tokensInput = Number(data.tokens_input) || 0;
    const tokensOutput = Number(data.tokens_output) || 0;
    const model = data.model || '';
    const costUsd = computeCost(ss, model, tokensInput, tokensOutput);

    sheet.appendRow([
      new Date(),
      data.email || '',
      data.subject || '',
      data.filename || '',
      data.totalQuestions || '',
      tokensInput,
      tokensOutput,
      model,
      costUsd
    ]);

    if (typeof costUsd === 'number') {
      const row = sheet.getLastRow();
      sheet.getRange(row, USAGE_HEADERS.length).setNumberFormat('$0.0000');
    }

    return jsonOut({ ok: true, cost: costUsd });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function computeCost(ss, model, tokensInput, tokensOutput) {
  if (!model || (tokensInput === 0 && tokensOutput === 0)) return '';
  const pricingSheet = getOrCreatePricingSheet(ss);
  const rows = pricingSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].toString() === model) {
      const inputLow = Number(rows[i][1]) || 0;
      const outputLow = Number(rows[i][2]) || 0;
      const inputHigh = Number(rows[i][3]) || inputLow;
      const outputHigh = Number(rows[i][4]) || outputLow;
      const overTier = tokensInput > TIER_THRESHOLD;
      return (tokensInput * (overTier ? inputHigh : inputLow) +
              tokensOutput * (overTier ? outputHigh : outputLow)) / 1000000;
    }
  }
  return '';
}

function getOrCreateSheet(ss, name, headerRow) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headerRow);
    sheet.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getOrCreatePricingSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_PRICING);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_PRICING);
    sheet.appendRow(PRICING_HEADERS);
    sheet.getRange(1, 1, 1, PRICING_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    PRICING_SEED.forEach(function (row) { sheet.appendRow(row); });
  }
  return sheet;
}

function jsonOut(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
