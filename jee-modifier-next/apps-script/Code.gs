/**
 * Whitelist + usage logging for JEE Modifier.
 *
 * SETUP (one-time):
 *   1. Open (or create) the Google Sheet you want to use for access + usage.
 *   2. Extensions -> Apps Script. Replace Code.gs with this file. Save.
 *   3. Deploy -> New deployment -> Web app
 *        - Description : "JEE Modifier access"
 *        - Execute as  : Me
 *        - Who has access : Anyone
 *      (You'll be asked to authorize. Approve the Sheets scope.)
 *   4. Copy the deployment URL (ends with /exec).
 *   5. Add it to Vercel + .env.local as:
 *        SHEETS_WEBAPP_URL=<the /exec URL>
 *
 * SHEET STRUCTURE (auto-created on first request):
 *   "Whitelist" : col A = Email (row 1 = header, one address per row from row 2)
 *   "Usage"     : Timestamp | Email | Subject | Total Questions
 *
 * REDEPLOYING:
 *   Changes to this script don't take effect until you redeploy:
 *   Deploy -> Manage deployments -> Edit (pencil) -> Version: New version -> Deploy.
 *   The /exec URL stays the same across new versions of the same deployment.
 */

const WHITELIST_SHEET = 'Whitelist';
const USAGE_SHEET = 'Usage';

function doGet(e) {
  try {
    const email = ((e.parameter && e.parameter.email) || '').toLowerCase().trim();
    if (!email) {
      return jsonOut({ allowed: false, error: 'Missing email parameter' });
    }
    const sheet = getOrCreateSheet(WHITELIST_SHEET, ['Email']);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return jsonOut({ allowed: false });
    }
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
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const sheet = getOrCreateSheet(USAGE_SHEET, [
      'Timestamp', 'Email', 'Subject', 'Total Questions'
    ]);
    sheet.appendRow([
      new Date(),
      body.email || '',
      body.subject || '',
      body.totalQuestions || ''
    ]);
    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function getOrCreateSheet(name, headerRow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headerRow);
    sheet.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonOut(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
