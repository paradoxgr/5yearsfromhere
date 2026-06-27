/**
 * google-oauth-callback — Supabase Edge Function
 *
 * Receives Google's authorization code, exchanges it for tokens,
 * and stores them in the oauth_tokens table.
 *
 * GET /functions/v1/google-oauth-callback?code=...
 * 200: { ok: true, email: string }
 *
 * Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
 *           SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  const url  = new URL(req.url);
  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }
  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const clientId     = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri  = Deno.env.get("GOOGLE_REDIRECT_URI");
  const supabaseUrl  = Deno.env.get("SUPABASE_URL");
  const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!clientId || !clientSecret || !redirectUri || !supabaseUrl || !serviceKey) {
    return json({ error: "Missing required environment variables" }, 500);
  }

  // 1) Exchange authorization code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return json({ error: "Token exchange failed", detail: err }, 502);
  }

  const tokens = await tokenRes.json();
  const { access_token, refresh_token, expires_in } = tokens;

  if (!access_token) {
    return json({ error: "No access_token in response", detail: tokens }, 502);
  }

  // 2) Fetch user email to identify the token row
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const profile = await profileRes.json();
  const email = profile.email ?? "unknown";

  // 3) Calculate expiry timestamp
  const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString();

  // 4) Upsert into oauth_tokens table
  const upsertRes = await fetch(`${supabaseUrl}/rest/v1/oauth_tokens`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        serviceKey,
      "Authorization": `Bearer ${serviceKey}`,
      "Prefer":        "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      provider:      "google",
      email,
      access_token,
      refresh_token: refresh_token ?? null,
      expires_at:    expiresAt,
      scope:         tokens.scope ?? null,
      updated_at:    new Date().toISOString(),
    }),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    return json({ error: "Failed to store tokens", detail: err }, 500);
  }

  return json({
    ok:      true,
    email,
    message: "Google Calendar authorized. Tokens stored in oauth_tokens.",
    refresh_token_received: !!refresh_token,
  });
});
