#!/usr/bin/env bash
# Run one custody export through the verifier and print a per-payment summary.
#
#   run-check.sh <export.xlsx> [--sheet NAME] [screenshot.png ...]
#
# Env: VERIFIER_URL (default http://localhost:8080), DASHBOARD_PASSWORD (required).
# The full JSON result is written next to the export as <export>.result.json.
set -euo pipefail

usage() { echo "usage: run-check.sh <export.xlsx> [--sheet NAME] [screenshot ...]" >&2; exit 2; }

[[ $# -ge 1 ]] || usage
export_file=$1; shift
[[ -f $export_file ]] || { echo "export not found: $export_file" >&2; exit 2; }
: "${DASHBOARD_PASSWORD:?set DASHBOARD_PASSWORD}"
url=${VERIFIER_URL:-http://localhost:8080}

form=(-F "file=@${export_file}")
while [[ $# -gt 0 ]]; do
  case $1 in
    --sheet) [[ $# -ge 2 ]] || usage; form+=(-F "sheetName=$2"); shift 2 ;;
    *) [[ -f $1 ]] || { echo "screenshot not found: $1" >&2; exit 2; }
       form+=(-F "screenshots=@$1"); shift ;;
  esac
done

jar=$(mktemp); trap 'rm -f "$jar"' EXIT
out="${export_file%.*}.result.json"

# Password goes in via stdin so it never appears in the process list.
printf '{"password":%s}' "$(node -e 'process.stdout.write(JSON.stringify(process.env.DASHBOARD_PASSWORD))')" |
  curl -sf -c "$jar" -H 'content-type: application/json' --data-binary @- "$url/api/auth" >/dev/null \
  || { echo "login failed at $url" >&2; exit 1; }

code=$(curl -s -b "$jar" "${form[@]}" -o "$out" -w '%{http_code}' "$url/api/verify")
[[ $code == 200 ]] || { echo "verify failed (HTTP $code): $(cat "$out")" >&2; exit 1; }

node - "$out" <<'EOF'
const r = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const s = r.summary;
console.log(`run ${r.provenance.runId}  sheet ${r.selectedSheet}  periods ${r.provenance.periodsLoaded.join(', ')}`);
console.log(`${s.total} payments: ${s.passed} pass, ${s.failed} fail, ${s.needsReview} review, ${s.excluded} excluded`);
console.log(`all required checks passed: ${s.allRequiredChecksPassed}\n`);
for (const p of r.results) {
  console.log(`${p.outcome.padEnd(12)} ${p.grantId.padEnd(8)} ${p.recipient.padEnd(22)} ${p.amountFormatted.padStart(14)}  ${p.walletAddress ?? ''}`);
  for (const c of p.checkDetails.filter((c) => c.outcome !== 'PASS')) {
    console.log(`             - ${c.id}: ${c.detail}`);
  }
}
if (r.queueFindings.length) {
  console.log('\ncustody queue:');
  for (const q of r.queueFindings) console.log(`  ${q.outcome}: ${q.detail}`);
}
if (r.provenance.degradations.length) {
  console.log('\ndegraded sources:');
  for (const d of r.provenance.degradations) console.log(`  ${typeof d === 'string' ? d : JSON.stringify(d)}`);
}
console.log(`\nfull result: ${process.argv[2]}`);
EOF
