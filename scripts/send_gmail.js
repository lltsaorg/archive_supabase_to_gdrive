// 使い方: node scripts/send_gmail.js result.json
// ENV: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER, NOTIFY_EMAIL

import fs from "fs";
import path from "path";
import { google } from "googleapis";

function buildBodyText(parsed) {
  const lines = [];
  lines.push(`Supabase Archive Result (Yangon)`);
  lines.push(`Cutoff(UTC): ${parsed.cutoff}`);
  lines.push("");

  for (const r of parsed.results || []) {
    if (r.ok) {
      if (r.skipped) {
        lines.push(`[${r.table}] moved=0 (対象なし)`);
      } else {
        lines.push(`[${r.table}] moved=${r.moved}`);
        if (r.fileUrl)   lines.push(`  File:   ${r.fileUrl}`);
        if (r.folderUrl) lines.push(`  Folder: ${r.folderUrl}`);
      }
    } else {
      lines.push(`[${r.table}] FAILED: ${r.error}`);
    }
  }
  return lines.join("\n");
}

function buildMimeMessage({ from, to, subject, body }) {
  const message =
`From: ${from}
To: ${to}
Subject: ${subject}
Content-Type: text/plain; charset="UTF-8"

${body}
`;
  return Buffer.from(message).toString("base64url");
}

async function main() {
  const [,, resultPath] = process.argv;
  if (!resultPath) {
    console.error("Usage: node scripts/send_gmail.js result.json");
    process.exit(1);
  }

  const clientId     = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const from         = process.env.GMAIL_SENDER;
  const to           = process.env.NOTIFY_EMAIL;

  if (!clientId || !clientSecret || !refreshToken || !from || !to) {
    console.error("Missing Gmail OAuth envs (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN, GMAIL_SENDER, NOTIFY_EMAIL)");
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(resultPath), "utf8");
  const parsed = JSON.parse(raw);

  const subject = (parsed.results || []).some(r => r.ok === false)
    ? "❌ Supabase Archive FAILED (Yangon)"
    : "✅ Supabase Archive SUCCESS (Yangon)";
  const body = buildBodyText(parsed);

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const rawMsg = buildMimeMessage({ from, to, subject, body });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: rawMsg },
  });

  console.log("Email sent.");
}

main().catch(e => { console.error(e); process.exit(99); });
