/**
 * generate-gap-report — Supabase Edge Function
 *
 * Calls Anthropic API with caller-supplied prompts and returns a prose report.
 * Requires ANTHROPIC_API_KEY set as a Supabase project secret.
 *
 * POST /functions/v1/generate-gap-report
 * Body:  { firstName, scores, systemPrompt, userPrompt }
 * 200:   { report: string }
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

  let body: { firstName?: string; scores?: unknown; systemPrompt?: string; userPrompt?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { systemPrompt, userPrompt } = body;
  if (!systemPrompt || !userPrompt) {
    return json({ error: "systemPrompt and userPrompt are required" }, 400);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: 600,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: `Anthropic API error: ${res.status}`, detail: err }, 502);
  }

  const data = await res.json();
  const report = data.content?.[0]?.text ?? "";
  return json({ report });
});
