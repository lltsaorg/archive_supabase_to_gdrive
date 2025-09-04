import http from "node:http";
import { google } from "googleapis";

const scopes = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];
const redirectUri = "http://127.0.0.1:53682/oauth2callback";
const clientId = process.env.GCP_OAUTH_CLIENT_ID;
const clientSecret = process.env.GCP_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GCP_OAUTH_CLIENT_ID / GCP_OAUTH_CLIENT_SECRET first");
  process.exit(1);
}

const oAuth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oAuth2.generateAuthUrl({
  access_type: "offline",
  scope: scopes,
  prompt: "consent",
});

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith("/oauth2callback")) return;
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get("code");
    if (!code) return;
    const { tokens } = await oAuth2.getToken(code);
    res.end("OK! You can close this tab.");
    console.log("GOOGLE_OAUTH_REFRESH_TOKEN=", tokens.refresh_token);
    server.close();
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end("Error");
  }
});
server.listen(53682, () => {
  console.log("Open this URL in your browser:\n", authUrl);
});
