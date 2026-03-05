#!/bin/bash
# Open Brain API smoke test
# Usage: ./scripts/test-api.sh [base_url]

BASE="${1:-http://localhost:3100}"
PASS=0
FAIL=0
TOTAL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red() { printf "\033[31m%s\033[0m\n" "$1"; }
gray() { printf "\033[90m%s\033[0m\n" "$1"; }

check() {
  local name="$1" expect="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -qF "$expect"; then
    PASS=$((PASS + 1))
    green "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    red "  ✗ $name"
    gray "    expected: $expect"
    gray "    got: $actual"
  fi
}

echo "═══ Open Brain API Tests ═══"
echo "Base: $BASE"
echo ""

# --- GET endpoints ---
echo "── Read endpoints ──"

R=$(curl -sf "$BASE/api/stats")
check "GET /api/stats" '"total"' "$R"
TOTAL_COUNT=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])" 2>/dev/null)
gray "    → $TOTAL_COUNT thoughts in DB"

R=$(curl -sf "$BASE/api/recent?limit=2")
check "GET /api/recent" '"thoughts"' "$R"
FIRST_ID=$(echo "$R" | python3 -c "import json,sys; t=json.load(sys.stdin)['thoughts']; print(t[0]['id'] if t else '')" 2>/dev/null)
gray "    → first ID: ${FIRST_ID:0:8}..."

R=$(curl -sf "$BASE/api/tags")
check "GET /api/tags" '"total_unique"' "$R"

R=$(curl -sf "$BASE/api/tags/orphans")
check "GET /api/tags/orphans" '"orphans"' "$R"

R=$(curl -sf "$BASE/api/compost")
check "GET /api/compost" '"thoughts"' "$R"

R=$(curl -sf "$BASE/api/questions")
check "GET /api/questions" '"thoughts"' "$R"

R=$(curl -sf "$BASE/api/review?days_ago=7")
check "GET /api/review" '"period"' "$R"

# --- Search (requires OpenAI) ---
echo ""
echo "── Search endpoints ──"

R=$(curl -sf "$BASE/api/search?q=test&limit=2")
check "GET /api/search" '"results"' "$R"

R=$(curl -sf "$BASE/api/timeline?q=test&limit=2")
check "GET /api/timeline" '"results"' "$R"

# --- Write endpoints (only if we have an ID) ---
if [ -n "$FIRST_ID" ]; then
  echo ""
  echo "── Write endpoints (using $FIRST_ID) ──"

  # Weight
  R=$(curl -sf -X PATCH "$BASE/api/thoughts/$FIRST_ID/weight" \
    -H 'Content-Type: application/json' -d '{"direction":"fade"}')
  check "PATCH weight (fade)" '"weight"' "$R"
  WEIGHT=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['weight'])" 2>/dev/null)
  gray "    → weight: $WEIGHT"

  # Restore weight
  curl -sf -X PATCH "$BASE/api/thoughts/$FIRST_ID/weight" \
    -H 'Content-Type: application/json' -d '{"direction":"amplify"}' > /dev/null

  # Epistemic status
  R=$(curl -sf -X PATCH "$BASE/api/thoughts/$FIRST_ID/status" \
    -H 'Content-Type: application/json' -d '{"status":"hypothesis"}')
  check "PATCH status (hypothesis)" '"hypothesis"' "$R"

  # Clear status
  curl -sf -X PATCH "$BASE/api/thoughts/$FIRST_ID/status" \
    -H 'Content-Type: application/json' -d '{"status":null}' > /dev/null

  # Update (title only, no re-embed)
  R=$(curl -sf -X PUT "$BASE/api/thoughts/$FIRST_ID" \
    -H 'Content-Type: application/json' -d '{"title":"API Test Title"}')
  check "PUT update (title)" '"re_embedded":false' "$R"

  # Restore title
  ORIG_TITLE=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('title',''))" 2>/dev/null)
  curl -sf -X PUT "$BASE/api/thoughts/$FIRST_ID" \
    -H 'Content-Type: application/json' -d "{\"title\":\"$ORIG_TITLE\"}" > /dev/null 2>&1

  # Compost + restore
  R=$(curl -sf -X POST "$BASE/api/thoughts/$FIRST_ID/compost")
  check "POST compost" '"composted_at"' "$R"

  R=$(curl -sf -X POST "$BASE/api/thoughts/$FIRST_ID/restore")
  check "POST restore" '"restored":true' "$R"

  # Batch: add tag + remove tag
  R=$(curl -sf -X POST "$BASE/api/thoughts/batch" \
    -H 'Content-Type: application/json' -d "{\"ids\":[\"$FIRST_ID\"],\"action\":\"add_tag\",\"params\":{\"tag\":\"_test_\"}}")
  check "POST batch add_tag" '"affected":1' "$R"

  R=$(curl -sf -X POST "$BASE/api/thoughts/batch" \
    -H 'Content-Type: application/json' -d "{\"ids\":[\"$FIRST_ID\"],\"action\":\"remove_tag\",\"params\":{\"tag\":\"_test_\"}}")
  check "POST batch remove_tag" '"affected":1' "$R"
fi

# --- Duplicates ---
echo ""
echo "── Duplicates ──"

R=$(curl -sf "$BASE/api/duplicates?min_similarity=0.92&limit=5")
check "GET /api/duplicates" '"pairs"' "$R"
DUP_COUNT=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])" 2>/dev/null)
gray "    → $DUP_COUNT duplicate pairs found"

R=$(curl -sf -X POST "$BASE/api/duplicates/dismiss" \
  -H 'Content-Type: application/json' -d '{"id_a":"00000000-0000-0000-0000-000000000001","id_b":"00000000-0000-0000-0000-000000000002"}')
check "POST /api/duplicates/dismiss" '"dismissed":true' "$R"

R=$(curl -s -X POST "$BASE/api/duplicates/merge" \
  -H 'Content-Type: application/json' -d '{"keep_id":"00000000-0000-0000-0000-000000000001","remove_id":"00000000-0000-0000-0000-000000000002"}')
check "POST /api/duplicates/merge (not found)" '"error"' "$R"

# --- Activity ---
echo ""
echo "── Activity ──"

R=$(curl -sf "$BASE/api/activity?limit=5")
check "GET /api/activity" '"entries"' "$R"

R=$(curl -sf "$BASE/api/activity/stats")
check "GET /api/activity/stats" '"total_calls"' "$R"
CALLS=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin)['total_calls'])" 2>/dev/null)
gray "    → $CALLS total calls logged"

# --- Import ---
echo ""
echo "── Import ──"

R=$(curl -sf "$BASE/api/import/status")
check "GET /api/import/status" '"running"' "$R"

R=$(curl -sf -X POST "$BASE/api/import/files" \
  -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"test.md","content":"# Test Import\\nThis is a test thought from API smoke test."}],"source":"test"}')
check "POST /api/import/files" '"started":true' "$R"

# Wait for import to complete (embed call takes ~5s)
sleep 8

R=$(curl -sf "$BASE/api/import/status")
check "Import completed" '"running":false' "$R"
IMPORTED=$(echo "$R" | python3 -c "import json,sys; p=json.load(sys.stdin); print('processed:', p['processed'], 'skipped:', p['skipped'])" 2>/dev/null)
gray "    → $IMPORTED"

R=$(curl -s -X POST "$BASE/api/import/obsidian/scan" \
  -H 'Content-Type: application/json' -d '{"path":"/nonexistent/path"}')
check "Obsidian scan bad path → error" '"error"' "$R"

# --- Validation ---
echo ""
echo "── Validation ──"

R=$(curl -s -X DELETE "$BASE/api/thoughts/not-a-uuid")
check "Invalid UUID → 400" '"Invalid thought ID"' "$R"

R=$(curl -s -X PATCH "$BASE/api/thoughts/00000000-0000-0000-0000-000000000000/weight" \
  -H 'Content-Type: application/json' -d '{"direction":"invalid"}')
check "Invalid weight direction → error" '"error"' "$R"

R=$(curl -s -X POST "$BASE/api/thoughts/batch" \
  -H 'Content-Type: application/json' -d '{"ids":["bad"],"action":"delete"}')
check "Batch invalid UUID → 400" '"Validation failed"' "$R"

R=$(curl -s "$BASE/api/search")
check "Search missing q → 400" 'Missing query' "$R"

# --- CORS ---
echo ""
echo "── CORS ──"
R=$(curl -sf -X OPTIONS "$BASE/api/thoughts/test" -I 2>&1)
check "OPTIONS preflight" 'PATCH' "$R"

# --- Summary ---
echo ""
echo "═══════════════════════════"
if [ $FAIL -eq 0 ]; then
  green "All $TOTAL tests passed ✓"
else
  red "$FAIL/$TOTAL tests failed"
  green "$PASS/$TOTAL tests passed"
fi
exit $FAIL
