# NOT-2 — Rigour qualification decision packet

**Decision:** `DECISION_READY` — policy approved for bootstrap implementation by the user. Qualification remains advisory pending independent exact-head maintainer review and integration; this packet records policy and does not authorize a `rigour.yml` exception.

## Evidence and current state

- Base: `81f4fa4293c3cc0234ed0586bdf945c3f0d00f7a`; Rigour CLI 7.0.2 and `rigour.yml` unchanged.
- The pinned baseline was captured from a clean archive of the exact base revision and is documented in `.not2-evidence/rigour-main-81f4fa4.json.metadata.json`; raw verdict **FAIL, 37 findings, score 44/100**. The scanner config SHA-256 is pinned in that metadata and the runner verifies it against the checkout.
- The exact-main baseline is raw **FAIL, 37 findings**, score **44/100**. A direct current scan was raw **FAIL, 38 findings**, score **40/100**. It reported the expected HIGH-severity governance finding for `.github/workflows/ci.yml` plus a file-size aggregate whose generated `rigour-fix-packet.json` line count varies at scan time; the error-handling aggregate remains comparator-classified unchanged. Both findings remain present in raw Rigour, and the protected workflow finding is not waived. The advisory runner currently fails closed because workspace-generated scanner artifacts contaminate the candidate input set; this is unresolved and the candidate is not qualification evidence.
- No mandatory local pre-push Rigour gate was found. Existing `npm test` remains required.

## Recommended minimum contract for maintainer approval

> Approve NOT-2 to introduce a bootstrap-only, advisory baseline comparison using an independently verified exact-main Rigour 7.0.2 report and unchanged `rigour.yml`; preserve and publish every raw scanner report with its original verdict. Qualification may identify only unchanged, non-protected inherited findings. New, worsened, relocated/renamed, or ambiguous findings fail closed. Security, secrets, data-loss, governance/protected-path, and behavioral/safety acceptance failures are never automatically excused. The baseline and comparator are maintainer-controlled; no candidate or agent may advance/redefine them. Qualification stays advisory until independent exact-head maintainer review and integration. `npm test` remains mandatory, and NOT-9 safety review remains independent and mandatory.

## Trust and affected surfaces

Trusted authority: repository maintainers; merge authority remains the existing repository process. A maintainer independently reviews the exact candidate head, baseline provenance, raw report, comparator/tests, and policy edits. A candidate-authored comparator cannot certify its own installation. During bootstrap, CI qualification is non-authoritative.

Intended small surface: one baseline evidence/provenance artifact, comparator/runner and tests, package scripts, advisory CI reporting, and applicable `AGENTS.md` policy. The pinned `rigour.yml` protects CI and docs paths. The approved bootstrap allows these policy/CI edits in the same PR, but their raw governance findings remain visible and they require independent exact-head maintainer review; they cannot be automatically excused or self-certified.

## Acceptance matrix

| Case | Trustworthy oracle |
|---|---|
| Unchanged inherited finding | Advisory qualification PASS; raw Rigour remains its original FAIL |
| One new or worsened finding | Qualification FAIL |
| Relocated/renamed finding or ambiguous match | FAIL closed |
| Invalid baseline/hash, scanner/config mismatch, incomplete scan | FAIL closed |
| Comparator/baseline/policy tampering | No qualification authority; independent exact-head review rejects |
| Security/secrets/data-loss/protected-path/safety finding | Never automatically excused; independent review required |
| Existing CI and safety review | `npm test` remains required; NOT-9 safety review remains independent and mandatory |

## Alternatives and cost

- **One-time exact-revision exception:** lowest implementation and maintenance cost, but applies to only one reviewed candidate and establishes no ongoing non-regression contract. Still needs trustworthy raw evidence and explicit maintainer authorization.
- **Reusable baseline qualification (recommended if NOT-2 intends durable policy):** a comparator, evidence validation, acceptance tests, advisory CI, and maintainer ownership of baseline updates/scanner migrations. It adds modest recurring review cost; scanner-format or identity ambiguity must fail closed.

## Implementation gate and decision ownership

Approved scope allows only advisory bootstrap; independent exact-head maintainer review precedes integration and any operational claim. No local mandatory pre-push Rigour gate was found.

## Implemented bootstrap evidence

A clean archive of the exact base revision was scanned with Rigour CLI 7.0.2 using `rigour check --ci --json --no-cache`. It reproduced **FAIL, 37 findings, score 44/100**. Raw report SHA-256 is `3b0f4d7213a7cf2b0ec6f599cff00e40e87a371074c3954194f1fb5b5d11c24c`; `rigour.yml` SHA-256 is `c40e464c8ff6070f63899a62244cbba5881be0ba218b8ef829ac7f989d7f91b2`. Provenance is stored alongside the report under `.not2-evidence/`. The candidate scan covers the current checkout, and the comparator only drops the scanner-generated fix-packet path from its comparison copy; the untouched raw report remains the evidence artifact. The unused CLI dependency finding, AI-drift error-handling finding, and protected-workflow governance finding remain visible and unwaived. The ignored `.serena/` metadata is local-only.

The initial comparator and CI workflow are advisory; CI preserves the raw Rigour report/verdict and existing `npm test`. The comparator validates pinned report/config hashes and scanner version, checks report completeness and exit status, preserves raw verdicts, and fails closed on ambiguous identities. It never excuses security/governance findings or any introduced/worsened finding. Tests cover inherited, introduced, worsened, removed-path, aggregated, malformed, and protected findings. Latest observed candidate result remains raw Rigour FAIL (38 findings) and qualification FAIL (one protected review-boundary finding); this advisory failure is honest evidence, not an operational qualification. Independent exact-head maintainer review remains required before integration.

No source was changed in NOT-9 and `rigour.yml` remains unchanged.
