import AdmZip from 'adm-zip';

const QUALTRICS_DATACENTER = "iad1";
const BASE_URL = `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3`;
const apiToken = process.env.QUALTRICS_API_TOKEN!;
const idpSourceId = process.env.QUALTRICS_SURVEY_ID!;

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim()); current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

async function main() {
  const startResp = await fetch(`${BASE_URL}/imported-data-projects/${idpSourceId}/exports`, {
    method: 'POST',
    headers: { 'X-API-TOKEN': apiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'csv', compress: true, useLabels: true, startDate: '2026-04-21T00:00:00Z' }),
  });
  const startJson: any = await startResp.json();
  const jobId = startJson.result.jobId;

  let fileId: string | undefined;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pResp = await fetch(`${BASE_URL}/imported-data-projects/${idpSourceId}/exports/${jobId}`, {
      headers: { 'X-API-TOKEN': apiToken },
    });
    const pJson: any = await pResp.json();
    if (pJson.result?.status === 'complete') { fileId = pJson.result.fileId; break; }
    if (pJson.result?.status === 'failed') throw new Error('failed');
  }
  if (!fileId) throw new Error('timeout');

  const dlResp = await fetch(`${BASE_URL}/imported-data-projects/${idpSourceId}/exports/${fileId}/file`, {
    headers: { 'X-API-TOKEN': apiToken },
  });
  const buf = Buffer.from(await dlResp.arrayBuffer());
  const zip = new AdmZip(buf);
  const csvEntry = zip.getEntries()[0];
  const csvText = csvEntry.getData().toString('utf-8');

  const lines = csvText.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  const records: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const rec: any = {};
    for (let j = 0; j < headers.length && j < values.length; j++) rec[headers[j]] = values[j];
    records.push(rec);
  }

  const matches = records.filter(r => String(r.s) === '1273' && String(r.d || '').trim() === '4/21/2026');
  console.log('Store 1273 on 4/21/2026 — matching records:', matches.length);
  for (const rec of matches) {
    console.log('--- ALL fields with non-empty values ---');
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        console.log(`  ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
