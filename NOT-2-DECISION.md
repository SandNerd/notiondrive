# NOT-2 — Rigour qualification decision packet

**Decision:** `DECISION_READY` — policy approved for bootstrap implementation by the user. Qualification remains advisory pending independent exact-head maintainer review and integration; this packet records policy and does not authorize a `rigour.yml` exception.

## Evidence and current state

- Base: `81f4fa4293c3cc0234ed0586bdf945c3f0d00f7a`; Rigour CLI 7.0.2 and `rigour.yml` unchanged.
- The pinned baseline was captured from a clean archive of the exact base revision and is documented in `.not2-evidence/rigour-main-81f4fa4.json.metadata.json`; raw verdict **FAIL, 37 findings, score 44/100**. The scanner config SHA-256 is pinned in that metadata and the runner verifies it against the checkout.
- Exact-head hosted CI run [38187559352](https://github.com/SandNerd/notiondrive/actions/runs/38187559352) completed successfully for PR head `94dabd38ce04d12d91206efd1ebc9a2708f74fe0`, tree `8bb9e378b054491c7e4d56da3d683d82f2b26a49` (hosted synthetic merge revision `1232c4dd42476244865be0cd384a777d034acd53`, same tree). `npm test` and advisory qualification passed. Raw Rigour remains **FAIL, 37 findings, score 44/100**, exit 1; candidate report SHA-256 `fb4cd92949be91511ab11d50c173e7ec9c2c4f36dacb58bf86f67964c406ba8d`, Rigour 7.0.2, Node v24.21.0, config SHA-256 `c40e464c8ff6070f63899a62244cbba5881be0ba218b8ef829ac7f989d7f91b2`. Hosted raw report, metadata, and pinned baseline are retained in run 38187559352. The comparator explicitly emits an independent-review finding for changed `.github/workflows/ci.yml` even when raw Rigour omits a protected-path finding on committed checkouts.
- No mandatory local pre-push Rigour gate was found. Existing `npm test` remains required.

- The initial hosted run at `68d15b9a51deac9a93d058b2b48c57770fec5119` did not produce candidate raw evidence: the shallow checkout lacked the pinned base commit, so the comparator failed before scan; its report artifact was absent. The repair requests full history, uses Node 24, and stores raw candidate output and exact-revision provenance separately. This defect was repaired and verified by hosted CI run 38187559352.

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

The initial comparator and CI workflow are advisory; CI preserves raw Rigour reports and the existing `npm test` gate. At exact PR head `ea9bfc161dfc3976f73875f3f94c38b582604092`, hosted run [38202086131](https://github.com/SandNerd/notiondrive/actions/runs/38202086131) passed `npm test` and advisory qualification. Raw Rigour remains FAIL (37 findings; report SHA-256 `a2e32b0991cd4337ad33cb3255fb85a4bd896b1c3627646b62385047cf87480a`); qualification returned ADVISORY for three protected/review-boundary obligations. CI uploaded exact-head evidence artifacts. This is not operational qualification or approval to merge. The comparator validates pinned report/config hashes and scanner version, requires complete reports and consistent scanner exit status, preserves raw verdicts, and fails closed on ambiguous identities. It never excuses protected findings or introduced/worsened findings. The first hosted run at `68d15b9a51deac9a93d058b2b48c57770fec5119` did not execute a candidate scan because the shallow checkout lacked the pinned base. Hosted CI run 38187559352 verified the initial provenance repair. At exact PR head `86e4ccb1706002e765c3d842053b2c71790d2d0a`, hosted run [38196248707](https://github.com/SandNerd/notiondrive/actions/runs/38196248707) completed: `npm test` passed 166/166, raw Rigour remains FAIL (37 findings; SHA-256 `411b3aaa7a374d431aa32eae76bb52f562ffcd5c5878e77592508477b1af1fc2`), and advisory qualification found one aggregate attribution regression plus three protected/review-boundary obligations. The current local correction compares normalized strategy-to-file attribution, tolerates scanner detail lists that show only a subset of declared aggregate files, and rejects duplicate strategy attribution. Focused qualification tests pass 25/25; full `npm test` passes 167/167. These local results are not hosted exact-head evidence. Baseline metadata pins Rigour 7.0.2 and `rigour.yml` hash `c40e464c8ff6070f63899a62244cbba5881be0ba218b8ef829ac7f989d7f91b2`; the candidate used Node v24.21.0 in the cited run. The raw reports remain FAIL and untouched. Independent review of the protected workflow and qualification implementation remains required.

No source was changed in NOT-9 and `rigour.yml` remains unchanged.
