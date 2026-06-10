/**
 * score-assessment — Supabase Edge Function
 *
 * CANONICAL scoring logic for 5 Years From Here.
 * This file owns SCORES, RANGES, and the overall formula.
 *
 * Dependents that must stay in sync:
 *   - assessment.html  → submitForm() calls this function; resultsH() has a
 *                        client-side display copy (scoreFor) that should mirror
 *                        these constants but does NOT affect what is stored.
 *   - score_assessment.py → audit/backfill copy; update alongside this file.
 *
 * POST /functions/v1/score-assessment
 * Body:  { "answers": ["a","b","c","d",...] }   // 21 elements, each a|b|c|d|null
 * 200:   { "relationships_score": 5.9, "identity_score": 7.0,
 *           "wealth_score": 6.2, "health_score": 2.0, "overall_score": 6.0 }
 * 400:   { "error": "..." }
 */

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const SCORES: Record<string, number> = { a: 2, b: 5, c: 8, d: 10 };

const RANGES: Record<string, [number, number]> = {
  "Relationships":    [0,  10],   // 11 questions  q00–q10
  "Identity Anchor":  [11, 15],   //  5 questions  q11–q15
  "Wealth":           [16, 19],   //  4 questions  q16–q19
  "Health":           [20, 20],   //  1 question   q20
};

const WEIGHTS: Record<string, number> = {
  "Relationships":    11,
  "Identity Anchor":   5,
  "Wealth":            4,
  "Health":            1,
};

const TOTAL_QUESTIONS = 21; // must equal sum(WEIGHTS)

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

function pillarScore(answers: (string | null)[], pillar: string): number {
  const [s, e] = RANGES[pillar];
  const slice = answers.slice(s, e + 1);
  const valid = slice.filter((v): v is string => v !== null && v in SCORES);
  if (!valid.length) return 0;
  const sum = valid.reduce((acc, v) => acc + SCORES[v], 0);
  return Math.round((sum / valid.length) * 10) / 10;
}

function computeScores(answers: (string | null)[]): Record<string, number> {
  const rS = pillarScore(answers, "Relationships");
  const iS = pillarScore(answers, "Identity Anchor");
  const wS = pillarScore(answers, "Wealth");
  const hS = pillarScore(answers, "Health");
  const overall = Math.round(
    ((rS * WEIGHTS["Relationships"]
      + iS * WEIGHTS["Identity Anchor"]
      + wS * WEIGHTS["Wealth"]
      + hS * WEIGHTS["Health"]) / TOTAL_QUESTIONS) * 10,
  ) / 10;

  return {
    relationships_score: rS,
    identity_score:      iS,
    wealth_score:        wS,
    health_score:        hS,
    overall_score:       overall,
  };
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

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

  let body: { answers?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const answers = body.answers;

  if (!Array.isArray(answers) || answers.length !== TOTAL_QUESTIONS) {
    return json(
      { error: `answers must be an array of exactly ${TOTAL_QUESTIONS} elements` },
      400,
    );
  }

  const valid = new Set<string | null>(["a", "b", "c", "d", null]);
  for (let i = 0; i < answers.length; i++) {
    if (!valid.has(answers[i] as string | null)) {
      return json({ error: `Invalid answer "${answers[i]}" at index ${i}` }, 400);
    }
  }

  return json(computeScores(answers as (string | null)[]));
});
