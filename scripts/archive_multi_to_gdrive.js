import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { google } from "googleapis";

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SERVICE_ROLE   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SA_JSON_B64    = process.env.GCP_SA_JSON_B64;

const TABLES = [
  {
    table: "Transactions",
    rpc:   "move_old_transactions_batch_json",
    stagingTable: "transactions_archive_staging",
    cutoffColumn: "created_at",
    folderEnv: "GDRIVE_FOLDER_ID_TRANSACTIONS",
  },
  {
    table: "ChargeRequests",
    rpc:   "move_old_chargerequests_batch_json",
    stagingTable: "charge_requests_archive_staging",
    cutoffColumn: "requested_at",
    folderEnv: "GDRIVE_FOLDER_ID_CHARGEREQUESTS",
  },
];

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 10000);

// === Cutoff: 当月1日 ヤンゴン時間 - 6ヶ月 ===
function cutoffDateMinus6Months() {
  const now = new Date();
  const ygn = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
  const monthStartUTC = new Date(Date.UTC(
    ygn.getUTCFullYear(), ygn.getUTCMonth(), 1, 17, 30, 0 // ヤンゴンUTC+6:30 → 00:00 YGN = 前日17:30 UTC
  ));
  monthStartUTC.setUTCMonth(monthStartUTC.getUTCMonth() - 6);
  return monthStartUTC;
}

// === 判定: ヤンゴンで1日か？ ===
function isFirstDayInYGN(nowUtc = new Date()) {
  const ygn = new Date(nowUtc.toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
  return ygn.getDate() === 1;
}

// === CSVユーティリティ ===
function escCSV(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Array.from(rows.reduce((set, o) => {
    Object.keys(o).forEach((k) => set.add(k));
    return set;
  }, new Set())).sort();
  let csv = keys.map(escCSV).join(",") + "\n";
  for (const obj of rows) {
    csv += keys.map((k) => escCSV(obj[k] ?? null)).join(",") + "\n";
  }
  return csv;
}

// === Google Drive client ===
function driveClient() {
  const creds = JSON.parse(Buffer.from(SA_JSON_B64, "base64").toString("utf8"));
  const jwt = new google.auth.JWT(
    creds.client_email,
    undefined,
    creds.private_key,
    ["https://www.googleapis.com/auth/drive.file"]
  );
  return google.drive({ version: "v3", auth: jwt });
}
async function uploadCsv(drive, folderId, name, csv) {
  const media = { mimeType: "text/csv", body: Buffer.from(csv, "utf8") };
  const meta  = { name, parents: [folderId] };
  const res = await drive.files.create({
    requestBody: meta, media, fields: "id,name,webViewLink,webContentLink",
  });
  return res.data;
}

// === Supabase staging rows fetch ===
async function fetchStagingRows(supabase, staging, runId) {
  let all = [], page = 0, pageSize = 10000;
  while (true) {
    const { data, error } = await supabase
      .from(staging).select("payload")
      .eq("run_id", runId).order("id", { ascending: true })
      .range(page*pageSize, (page+1)*pageSize-1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data.map(r => r.payload));
    if (data.length < pageSize) break;
    page++;
  }
  return all;
}

// === 1テーブル処理 ===
async function processOneTable(supabase, drive, cfg, cutoffISO) {
  const runId = randomUUID();
  const folderId = process.env[cfg.folderEnv];
  if (!folderId) throw new Error(`${cfg.table}: missing env ${cfg.folderEnv}`);

  let movedTotal = 0;
  while (true) {
    const { data, error } = await supabase.rpc(cfg.rpc, {
      cutoff: cutoffISO, batch_size: BATCH_SIZE, in_run_id: runId,
    });
    if (error) throw new Error(`${cfg.table} RPC error: ${error.message}`);
    const moved = data ?? [];
    movedTotal += moved.length;
    if (moved.length < BATCH_SIZE) break;
  }
  if (movedTotal === 0) return { ok:true, table:cfg.table, moved:0, skipped:true };

  const rows = await fetchStagingRows(supabase, cfg.stagingTable, runId);
  const csv  = toCsv(rows);
  const ym   = cutoffISO.slice(0,7);
  const name = `${cfg.table}_archive_until_${ym}_${Date.now()}_${runId}.csv`;

  const file = await uploadCsv(drive, folderId, name, csv);

  await supabase.from(cfg.stagingTable).delete().eq("run_id", runId);

  return { ok:true, table:cfg.table, moved:movedTotal, fileUrl:file.webViewLink, folderUrl:`https://drive.google.com/drive/folders/${folderId}` };
}

// === main ===
async function main() {
  if (!isFirstDayInYGN()) {
    console.log("Not the 1st day (Yangon). Exit.");
    return;
  }
  const cutoff = cutoffDateMinus6Months();
  const cutoffISO = cutoff.toISOString();

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth:{ persistSession:false }});
  const drive    = driveClient();

  const results = [];
  for (const cfg of TABLES) {
    try {
      const r = await processOneTable(supabase, drive, cfg, cutoffISO);
      results.push(r);
    } catch (e) {
      results.push({ ok:false, table:cfg.table, error:String(e) });
    }
  }
  console.log(JSON.stringify({ cutoff:cutoffISO, results }));
  if (results.some(r=>!r.ok)) process.exit(1);
}
main().catch(e=>{ console.error(e); process.exit(99); });
