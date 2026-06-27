/**
 * google-oauth-start — Supabase Edge Function
 *
 * Redirects the user to Google's OAuth 2.0 consent screen.
 * GET /functions/v1/google-oauth-start
 * 302 → Google consent URL
 */

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

Deno.serve(async (_req: Request) => {
  const clientId    = Deno.env.get("GOOGLE_CLIENT_ID");
  const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI");

  if (!clientId || !redirectUri) {
    return new Response("Missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI", { status: 500 });
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",   // get refresh_token
    prompt:        "consent",   // force consent screen so refresh_token is always returned
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return Response.redirect(url, 302);
});
