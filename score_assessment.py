"""
score_assessment.py — Audit / backfill copy of assessment scoring logic.

CANONICAL source of truth:
  supabase/functions/score-assessment/index.ts

This file is a secondary Python port used for:
  - Manual backfills:  python score_assessment.py --all
  - Offline auditing / data validation
  - CI drift-checking against the Edge Function constants

If SCORES, RANGES, or the overall weighting formula change, update the
Edge Function first, then mirror those changes here.
"""

import os
import sys
import json
import math
import requests
from typing import Optional

sys.stdout.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# Scoring constants — must stay in sync with assessment.html
# ---------------------------------------------------------------------------
#
#   JS:  const SCORES = {a:2, b:5, c:8, d:10};
#   JS:  const RANGES = {Relationships:[0,10],"Identity Anchor":[11,15],
#                        Wealth:[16,19],Health:[20,20]};
#   JS:  overall = Math.round(((rS*11+iS*5+wS*4+hS)/21)*10)/10
#
SCORES: dict[str, int] = {"a": 2, "b": 5, "c": 8, "d": 10}

RANGES: dict[str, tuple[int, int]] = {
    "Relationships":   (0,  10),   # 11 questions  q00–q10
    "Identity Anchor": (11, 15),   #  5 questions  q11–q15
    "Wealth":          (16, 19),   #  4 questions  q16–q19
    "Health":          (20, 20),   #  1 question   q20
}

WEIGHTS: dict[str, int] = {
    "Relationships":   11,
    "Identity Anchor":  5,
    "Wealth":           4,
    "Health":           1,
}

TOTAL_QUESTIONS = 21  # sum(WEIGHTS.values())


# ---------------------------------------------------------------------------
# Supabase credentials — prefer env vars; fall back to project defaults
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get(
    "SUPABASE_URL",
    "https://rpygrpvazkhcggfbkbij.supabase.co",
)
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweWdycHZhemtoY2dnZmJrYmlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NzM2MTAsImV4cCI6MjA5NjM0OTYxMH0.WjxShLeIGGXWSXVT-8PBZMsOnpEOAFTLw4rBpjuxWiQ",
)
# Service role key bypasses RLS — required for backfill writes.
# Get from Supabase dashboard → Settings → API → service_role key.
# Set via: $env:SUPABASE_SERVICE_KEY='eyJ...'
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

_READ_HEADERS = {
    "apikey":        SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Content-Type":  "application/json",
}

def _write_headers() -> dict:
    key = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY
    if not SUPABASE_SERVICE_KEY:
        print("WARNING: SUPABASE_SERVICE_KEY not set — falling back to anon key. "
              "PATCH will fail if RLS blocks anonymous updates.", file=sys.stderr)
    return {
        "apikey":        key,
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
    }

# Keep backward-compat alias used by compute_scores (read-only path)
_BASE_HEADERS = _READ_HEADERS


# ---------------------------------------------------------------------------
# Core scoring — ported 1:1 from assessment.html
# ---------------------------------------------------------------------------

def _js_round(x: float) -> float:
    """Mirror JS Math.round(): always rounds 0.5 up (unlike Python's banker's rounding)."""
    return math.floor(x + 0.5)


def pillar_score(answers: list[Optional[str]], pillar: str) -> float:
    """Average numeric score for the answers belonging to one pillar."""
    s, e = RANGES[pillar]
    sl = answers[s : e + 1]
    valid = [v for v in sl if v is not None]
    if not valid:
        return 0.0
    return _js_round((sum(SCORES[v] for v in valid) / len(valid)) * 10) / 10


def label(score: float) -> str:
    """Gap label — mirrors JS lbl() in assessment.html."""
    if score <= 3: return "Critical gap"
    if score <= 6: return "Moderate"
    if score <= 9: return "Strong"
    return "Fully optimized"


def compute_scores(answers: list[Optional[str]]) -> dict:
    """
    Compute all pillar and overall scores from a 21-element answers list.

    Args:
        answers: list of 21 option strings ('a'|'b'|'c'|'d'|None).
                 None means the question was skipped; it is excluded from
                 that pillar's average (matches JS filter(v=>v!==null)).

    Returns:
        {
            "relationships_score": float,
            "identity_score":      float,
            "wealth_score":        float,
            "health_score":        float,
            "overall_score":       float,
        }
    """
    rS = pillar_score(answers, "Relationships")
    iS = pillar_score(answers, "Identity Anchor")
    wS = pillar_score(answers, "Wealth")
    hS = pillar_score(answers, "Health")

    overall = _js_round(
        (
            rS * WEIGHTS["Relationships"]
            + iS * WEIGHTS["Identity Anchor"]
            + wS * WEIGHTS["Wealth"]
            + hS * WEIGHTS["Health"]
        )
        / TOTAL_QUESTIONS
        * 10
    ) / 10

    return {
        "relationships_score": rS,
        "identity_score":      iS,
        "wealth_score":        wS,
        "health_score":        hS,
        "overall_score":       overall,
    }


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

_SCORE_COLS = [
    "relationships_score",
    "identity_score",
    "wealth_score",
    "health_score",
    "overall_score",
]


def _get_response(response_id: str) -> dict:
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/assessment_responses",
        headers=_BASE_HEADERS,
        params={"id": f"eq.{response_id}", "select": "*"},
        timeout=10,
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise ValueError(f"No row found for response_id={response_id}")
    return rows[0]


def _patch_response(response_id: str, payload: dict) -> dict:
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/assessment_responses",
        headers=_write_headers(),
        params={"id": f"eq.{response_id}"},
        json=payload,
        timeout=10,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else {}


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------

def backfill_response(response_id: str) -> dict:
    """
    Pull the answers[] array for response_id, recompute scores, patch
    assessment_responses, and print a before/after comparison.

    Returns {"before": {...}, "computed": {...}, "after": {...}}.
    """
    row      = _get_response(response_id)
    answers  = row.get("answers") or []
    before   = {col: row.get(col) for col in _SCORE_COLS}
    computed = compute_scores(answers)

    updated = _patch_response(response_id, computed)
    after   = {col: updated.get(col) for col in _SCORE_COLS}

    # --- pretty print ---
    print(f"\n{'─'*64}")
    print(f"response_id  {response_id}")
    print(f"name/email   {row.get('name')} / {row.get('email')}")
    print(f"answers      {answers}")
    print()
    print(f"{'Pillar':<20} {'Before':>7}  {'Computed':>9}  {'After':>7}  {'Label':<16}  Note")
    print("─" * 90)

    pillar_map = [
        ("Relationships",   "relationships_score"),
        ("Identity Anchor", "identity_score"),
        ("Wealth",          "wealth_score"),
        ("Health",          "health_score"),
        ("Overall",         "overall_score"),
    ]
    for name, col in pillar_map:
        b   = before[col]
        c   = computed[col]
        a   = after[col]
        lbl = label(c)
        note = "← corrected" if b != c else ""
        print(f"{name:<20} {str(b):>7}  {str(c):>9}  {str(a):>7}  {lbl:<16}  {note}")

    return {"before": before, "computed": computed, "after": after}


def backfill_all() -> list[dict]:
    """Recompute and patch every row in assessment_responses."""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/assessment_responses",
        headers=_BASE_HEADERS,
        params={"select": "id"},
        timeout=10,
    )
    r.raise_for_status()
    ids = [row["id"] for row in r.json()]
    print(f"Backfilling {len(ids)} response(s)...")
    results = [backfill_response(rid) for rid in ids]
    print(f"\n{'─'*64}")
    print(f"Done — {len(ids)} row(s) updated.")
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Recompute and backfill assessment scores from the answers[] array."
    )
    ap.add_argument("--all", action="store_true", help="Backfill every row")
    ap.add_argument("--response-id", metavar="UUID", help="Backfill a single response")
    args = ap.parse_args()

    if args.all:
        backfill_all()
    elif args.response_id:
        backfill_response(args.response_id)
    else:
        ap.print_help()
