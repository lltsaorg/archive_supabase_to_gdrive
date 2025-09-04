import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

function buildDriveClient() {
  const scopes = ["https://www.googleapis.com/auth/drive.file"];
  if (process.env.GCP_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GCP_OAUTH_CLIENT_ID,
      process.env.GCP_OAUTH_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    return google.drive({ version: "v3", auth: oauth2 });
  }
  const key = (process.env.GCP_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (process.env.GCP_SERVICE_ACCOUNT_EMAIL && key) {
    const jwt = new google.auth.JWT({
      email: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
      key,
      scopes,
      subject: process.env.GCP_DELEGATED_USER_EMAIL || undefined,
    });
    return google.drive({ version: "v3", auth: jwt });
  }
  throw new Error("Drive auth not configured");
}

async function main() {
  const drive = buildDriveClient();
  const about = await drive.about.get({ fields: "user,kind,storageQuota" });
  const user = about.data.user;
  console.log(`👤 Acting as: ${user?.emailAddress || "unknown"}`);
  console.log(`🤝 Delegated user: ${process.env.GCP_DELEGATED_USER_EMAIL || "(none)"}`);

  const tx = process.env.GDRIVE_FOLDER_ID_TRANSACTIONS;
  const cr = process.env.GDRIVE_FOLDER_ID_CHARGEREQUESTS;
  for (const [label, id] of [["Transactions", tx], ["ChargeRequests", cr]]) {
    if (!id) { console.log(`📁 ${label} folder: (missing id)`); continue; }
    try {
      const f = await drive.files.get({ fileId: id, fields: "id,name,driveId,mimeType,parents", supportsAllDrives: true });
      const shared = Boolean(f.data.driveId);
      console.log(`📁 ${label} folder: ${f.data.name} (${f.data.id}) sharedDrive=${shared}`);
    } catch (e) {
      console.log(`📁 ${label} folder: error - ${e?.message || e}`);
    }
  }
  console.log("✅ チェック完了");
}

main().catch(e => { console.error(e); process.exit(1); });

