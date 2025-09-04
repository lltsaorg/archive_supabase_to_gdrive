import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { google } from "googleapis";
import fs from "fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SA_JSON_B64 = process.env.GCP_SA_JSON_B64;

const TABLES = [
  {
    table: "Transactions",
    rpc: "move_old_transactions_batch_json",
    stagingTable: "transactions_archive_staging",
    cutoffColumn: "created_at",
    folderEnv: "GDRIVE_FOLDER_ID_TRANSACTIONS",
  },
  {
    table: "ChargeRequests",
    rpc: "move_old_chargerequests_batch_json",
    stagingTable: "charge_requests_archive_staging",
    cutoffColumn: "requested_at",
    folderEnv: "GDRIVE_FOLDER_ID_CHARGEREQUESTS",
  },
];

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 10000);

// 当月1日 ヤンゴン(UTC+6:30) 00:00 → UTC前日17:30
function cutoffDateMinusMonths(months) {
  const now = new Date();
  const ygn = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Yangon" })
  );
  const monthStartUTC = new Date(
    Date.UTC(ygn.getUTCFullYear(), ygn.getUTCMonth(), 1, 17, 30, 0)
  );
  const n = Number(months);
  const m = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
  monthStartUTC.setUTCMonth(monthStartUTC.getUTCMonth() - m);
  return monthStartUTC;
}
// Test support: compute cutoff by days from Yangon midnight
function cutoffDateMinusDays(days) {
  const now = new Date();
  const ygn = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Yangon" })
  );
  const ygnMidnightUTC = new Date(
    Date.UTC(ygn.getUTCFullYear(), ygn.getUTCMonth(), ygn.getUTCDate(), 17, 30, 0)
  );
  const d = Number(days);
  const n = Number.isFinite(d) && d >= 1 ? Math.floor(d) : 3;
  ygnMidnightUTC.setUTCDate(ygnMidnightUTC.getUTCDate() - n);
  return ygnMidnightUTC;
}

function isFirstDayInYGN(nowUtc = new Date()) {
  const ygn = new Date(
    nowUtc.toLocaleString("en-US", { timeZone: "Asia/Yangon" })
  );
  return ygn.getDate() === 1;
}

function escCSV(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Array.from(
    rows.reduce((set, o) => {
      Object.keys(o).forEach((k) => set.add(k));
      return set;
    }, new Set())
  ).sort();
  let csv = keys.map(escCSV).join(",") + "\n";
  for (const obj of rows) {
    csv += keys.map((k) => escCSV(obj[k] ?? null)).join(",") + "\n";
  }
  return csv;
}

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
  const meta = { name, parents: [folderId] };
  const res = await drive.files.create({
    requestBody: meta,
    media,
    fields: "id,name,webViewLink,webContentLink",
  });
  return res.data;
}

async function fetchStagingRows(supabase, staging, runId) {
  let all = [],
    page = 0,
    pageSize = 10000;
  while (true) {
    const { data, error } = await supabase
      .from(staging)
      .select("payload")
      .eq("run_id", runId)
      .order("id", { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data.map((r) => r.payload));
    if (data.length < pageSize) break;
    page++;
  }
  return all;
}

async function processOneTable(supabase, drive, cfg, cutoffISO) {
  const runId = randomUUID();
  const folderId = process.env[cfg.folderEnv];
  if (!folderId) throw new Error(`${cfg.table}: missing env ${cfg.folderEnv}`);

  let movedTotal = 0;
  while (true) {
    const { data, error } = await supabase.rpc(cfg.rpc, {
      cutoff: cutoffISO,
      batch_size: BATCH_SIZE,
      in_run_id: runId,
    });
    if (error) throw new Error(`${cfg.table} RPC error: ${error.message}`);
    const moved = data ?? [];
    movedTotal += moved.length;
    if (moved.length < BATCH_SIZE) break;
  }
  if (movedTotal === 0)
    return { ok: true, table: cfg.table, moved: 0, skipped: true, cutoff: cutoffISO };

  const rows = await fetchStagingRows(supabase, cfg.stagingTable, runId);
  const csv = toCsv(rows);
  const ym = cutoffISO.slice(0, 7);
  const name = `${cfg.table}_archive_until_${ym}_${Date.now()}_${runId}.csv`;

  const file = await uploadCsv(drive, folderId, name, csv);

  const { error: delErr } = await supabase
    .from(cfg.stagingTable)
    .delete()
    .eq("run_id", runId);
  if (delErr)
    throw new Error(`${cfg.table} staging cleanup error: ${delErr.message}`);

  return {
    ok: true,
    table: cfg.table,
    moved: movedTotal,
    cutoff: cutoffISO,
    fileUrl: file.webViewLink,
    folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
  };
}

async function main() {
  // 月初めでないなら「実行していない」ことを明示して終了
if (!isFirstDayInYGN() && String(process.env.ARCHIVE_FORCE_RUN) !== "1" && String(process.env.ARCHIVE_FORCE_RUN).toLowerCase() !== "true") {
    const skipped = { executed: false, reason: "not-first-day-yangon" };
    fs.writeFileSync("result.json", JSON.stringify(skipped));
    console.log(JSON.stringify(skipped));
    return; // 成功終了（メール不要）
  }

  // 期間（月数）は環境変数で制御（Secrets でなくてOK）
  // 優先順: テーブル個別指定 > デフォルト指定 > 6
  const TEST_DAYS = process.env.ARCHIVE_TEST_DAYS;
  const DEFAULT_MONTHS = Number(process.env.CUTOFF_MONTHS_DEFAULT ?? 6);
  const cutoffISOGlobal = (TEST_DAYS
    ? cutoffDateMinusDays(TEST_DAYS)
    : cutoffDateMinusMonths(DEFAULT_MONTHS)
  ).toISOString();
  const PER_TABLE_MONTHS = {
    Transactions: Number(
      process.env.CUTOFF_MONTHS_TRANSACTIONS ?? DEFAULT_MONTHS
    ),
    ChargeRequests: Number(
      process.env.CUTOFF_MONTHS_CHARGEREQUESTS ?? DEFAULT_MONTHS
    ),
  };

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  const drive = driveClient();

  const results = [];
  for (const cfg of TABLES) {
    try {
      const r = await processOneTable(supabase, drive, cfg, cutoffISOGlobal);
      results.push(r);
    } catch (e) {
      results.push({ ok: false, table: cfg.table, error: String(e) });
    }
  }

  const payload = {
    executed: true,
    cutoff: cutoffISOGlobal,
    cutoffMonths: TEST_DAYS ? undefined : DEFAULT_MONTHS,
    cutoffDays: TEST_DAYS ? Number(TEST_DAYS) : undefined,
    forcedRun: !isFirstDayInYGN(),
    results,
  };
  fs.writeFileSync("result.json", JSON.stringify(payload));
  console.log(JSON.stringify(payload));

  if (results.some((r) => !r.ok)) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(99);
});
