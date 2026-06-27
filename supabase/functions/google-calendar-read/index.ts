/**
 * google-calendar-read — Supabase Edge Function
 *
 * Reads today's events from the authorized user's primary Google Calendar.
 * Automatically refreshes the access token if expired.
 *
 * POST /functions/v1/google-calendar-read
 * Body:  { email: string }          — identifies which oauth_tokens row to use
 * 200:   { events: CalendarEvent[], date: string, count: number }
 *
 * Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *           SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

interface TokenRow {
  id:            string;
  access_token:  string;
  refresh_token: string | null;
  expires_at:    string | null;
}

async function getTokens(supabaseUrl: string, serviceKey: string, email: string): Promise<TokenRow | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/oauth_tokens?provider=eq.google&email=eq.${encodeURIComponent(email)}&select=id,access_token,refresh_token,expires_at&limit=1`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  return res.json();
}

async function updateTokens(
  supabaseUrl: string,
  serviceKey: string,
  id: string,
  accessToken: string,
  expiresAt: string
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/oauth_tokens?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type":  "application/json",
      apikey:          serviceKey,
      Authorization:   `Bearer ${serviceKey}`,
      Prefer:          "return=minimal",
    },
    body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt, updated_at: new Date().toISOString() }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

  let body: { email?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const email = body.email?.trim();
  if (!email) return json({ error: "email is required" }, 400);

  const clientId     = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const supabaseUrl  = Deno.env.get("SUPABASE_URL");
  const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!clientId || !clientSecret || !supabaseUrl || !serviceKey) {
    return json({ error: "Missing required environment variables" }, 500);
  }

  // 1) Load stored tokens
  const row = await getTokens(supabaseUrl, serviceKey, email);
  if (!row) return json({ error: `No token found for ${email}` }, 404);

  let accessToken = row.access_token;

  // 2) Refresh if expired or expiring within 5 minutes
  const expiresAt  = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const bufferMs   = 5 * 60 * 1000;
  if (Date.now() + bufferMs >= expiresAt) {
    if (!row.refresh_token) return json({ error: "Token expired and no refresh_token available" }, 401);
    const refreshed  = await refreshAccessToken(clientId, clientSecret, row.refresh_token);
    accessToken      = refreshed.access_token;
    const newExpiry  = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await updateTokens(supabaseUrl, serviceKey, row.id, accessToken, newExpiry);
  }

  // 3) Build today's time window (UTC)
  const today     = new Date();
  const dateStr   = today.toISOString().slice(0, 10);
  const timeMin   = `${dateStr}T00:00:00Z`;
  const timeMax   = `${dateStr}T23:59:59Z`;

  // 4) Fetch events from Google Calendar API
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy:      "startTime",
    maxResults:   "50",
  });

  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!calRes.ok) {
    const err = await calRes.text();
    return json({ error: `Calendar API error: ${calRes.status}`, detail: err }, 502);
  }

  const calData = await calRes.json();
  const events  = (calData.items ?? []).map((e: Record<string, unknown>) => ({
    id:       e.id,
    summary:  e.summary ?? "(no title)",
    start:    (e.start as Record<string, string>)?.dateTime ?? (e.start as Record<string, string>)?.date,
    end:      (e.end   as Record<string, string>)?.dateTime ?? (e.end   as Record<string, string>)?.date,
    location: e.location ?? null,
    status:   e.status,
  }));

  return json({ date: dateStr, count: events.length, events });
});
