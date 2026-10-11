# NOT-2 — Rigour qualification decision packet

**Decision:** `DECISION_READY` — policy approved for bootstrap implementation by the user. Qualification remains advisory pending independent exact-head maintainer review and integration; this packet records policy and does not authorize a `rigour.yml` exception.

## Evidence and current state

- Base: `81f4fa4293c3cc0234ed0586bdf945c3f0d00f7a`; Rigour CLI 7.0.2 and `rigour.yml` unchanged.
- The pinned baseline was captured from a clean archive of the exact base revision and is documented in `.not2-evidence/rigour-main-81f4fa4.json.metadata.json`; raw verdict **FAIL, 37 findings, score 44/100**. The scanner config SHA-256 is pinned in that metadata and the runner verifies it against the checkout.
- The exact-main baseline is raw **FAIL, 37 findings**, score **44/100**. A local scan of the initial candidate was raw **FAIL, 38 findings**, score **40/100**; the qualification runner detected new candidate-owned findings and one protected workflow review-boundary finding. After fixing the introduced script-size and error-handling aggregates, the current working-tree scan is raw **FAIL, 38 findings** and reports **0 new or worsened, 1 protected workflow finding**. Qualification evidence is provisional because the revision is uncommitted and a fresh exact-head hosted scan has not run.
- No mandatory local pre-push Rigour gate was found. Existing `npm test` remains required.

- The initial hosted run at `68d15b9a51deac9a93d058b2b48c57770fec5119` did not produce candidate raw evidence: the shallow checkout lacked the pinned base commit, so the comparator failed before scan; its report artifact was absent. The repair now requests full history, runs Node 24, and stores raw candidate output and exact-revision provenance separately. This candidate revision still requires a fresh hosted run.

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

The initial comparator and CI workflow are advisory; CI preserves raw Rigour reports and the existing `npm test` gate. The comparator validates pinned report/config hashes and scanner version, requires complete reports and consistent scanner exit status, preserves raw verdicts, and fails closed on ambiguous identities. It never excuses protected findings or introduced/worsened findings. The first hosted run at `68d15b9a51deac9a93d058b2b48c57770fec5119` did not execute a candidate scan: the shallow checkout lacked the pinned base commit, so the baseline diff failed before report generation. The local repair now requests full history, uses Node 24, and stores raw candidate output with exact revision/tree/runtime/config and report hash after a successful scan. After repairing candidate-owned comparator defects, the latest local working-tree scan is raw Rigour FAIL (38 findings; score 40/100; report SHA-256 `16c273af61bf4ce8b3fc9e2c46351f694dae2bafaff56bf32d0bf62dd31d8608`) with zero new/worsened findings and one protected `.github/workflows/ci.yml` review-boundary finding. This is not exact-revision evidence: the metadata binds the raw report to committed revision `68d15b9a51deac9a93d058b2b48c57770fec5119`, while source edits remain uncommitted. No exact-head hosted rerun of the repair exists. Independent exact-head maintainer review remains required before integration.

No source was changed in NOT-9 and `rigour.yml` remains unchanged.
