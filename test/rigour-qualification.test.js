import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQualification, compareReports, parseJson, protectedPathChanges, removeGeneratedArtifacts, validateReport } from '../scripts/rigour-qualification.js';

const finding = (overrides = {}) => ({ id: 'AST_COMPLEXITY', title: "Function 'example' has cyclomatic complexity of 12", severity: 'medium', provenance: 'traditional', files: ['src/example.js'], ...overrides });
const report = (failures = []) => ({ status: 'FAIL', summary: { 'ast-analysis': 'FAIL' }, failures, stats: { score: failures.length ? 80 : 44, duration_ms: 1, severity_breakdown: {}, provenance_breakdown: {} } });

test('changed protected workflow paths require review even without a raw scanner finding', async () => {
  assert.deepEqual(protectedPathChanges(new Set(['.github/workflows/ci.yml'])), ['.github/workflows/ci.yml']);
  assert.deepEqual(protectedPathChanges(new Set(['AGENTS.md', 'NOT-2-DECISION.md', '.github/CODEOWNERS', 'src/sync.js'])), ['AGENTS.md', 'NOT-2-DECISION.md', '.github/CODEOWNERS']);
  assert.equal((await classifyQualification(report(), report(), new Set(['.github/workflows/ci.yml']))).status, 'ADVISORY');
});

test('protected security and governance findings remain review obligations', async () => {
  for (const provenance of ['security', 'governance']) {
    const protectedReport = report([finding({ id: `${provenance}-finding`, provenance })]);
    const result = await classifyQualification(report(), protectedReport, new Set());
    assert.equal(result.status, 'FAIL');
    assert.ok(result.implementationFindings.length > 0);
    assert.ok(result.reviewObligations.length > 0);
  }
});

test('candidate-owned error-handling aggregate regressions cannot be filtered before comparison', async () => {
  const details = "Inconsistent error handling for 'try-catch': 2 different strategies found across 2 files:\\n  • log (1x): scripts/rigour-qualification.js\\n  • rethrow (1x): src/example.js";
  const baselineAggregate = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', details, provenance: 'ai-drift', line: 33, files: ['src/example.js'] });
  const worsened = { ...baselineAggregate, details: details.replace('2 files', '3 files').replace('log (1x)', 'log (2x)'), files: ['scripts/rigour-qualification.js', 'src/example.js'] };
  const result = await classifyQualification(report([baselineAggregate]), report([worsened]), new Set(['scripts/rigour-qualification.js']));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.implementationFindings.length, 1);
});

test('protected review obligations and candidate regressions remain visible together', async () => {
  const protectedSecurity = finding({ id: 'secret-exposure', title: 'Potential secret exposure', provenance: 'security' });
  const baselineAggregate = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', details: "Inconsistent error handling for 'try-catch': 1 different strategies found across 1 files:\\n  • log (1x): src/example.js", provenance: 'ai-drift', line: 33, files: ['src/example.js'] });
  const worsenedAggregate = { ...baselineAggregate, details: baselineAggregate.details.replace('1x', '2x').replace('1 files', '2 files'), files: ['scripts/rigour-qualification.js', 'src/example.js'] };
  const result = await classifyQualification(report([baselineAggregate]), report([protectedSecurity, worsenedAggregate]), new Set(['scripts/rigour-qualification.js', '.github/workflows/ci.yml']));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.implementationFindings.length, 2);
  assert.ok(result.reviewObligations.some((item) => item.id === 'secret-exposure'));
  assert.ok(result.reviewObligations.some((item) => item.id === 'protected-path-change'));
});

test('unchanged inherited findings qualify without altering raw FAIL', () => {
  const base = report([finding()]);
  const candidate = structuredClone(base);
  assert.equal(validateReport(candidate).status, 'FAIL');
  assert.deepEqual(compareReports(base, candidate), []);
  assert.throws(() => compareReports(base, { ...candidate, status: 'PASS' }), /Raw verdict changed/);
});

test('introduced and worsened findings fail comparison', () => {
  assert.equal(compareReports(report(), report([finding()])).length, 1);
  assert.equal(compareReports(report([finding()]), report([finding(), finding({ title: 'new finding' })])).length, 1);
  assert.equal(compareReports(report([finding()]), report([finding({ severity: 'high' })])).length, 1);
  assert.equal(compareReports(report([finding()]), report([finding({ title: "Function 'example' has cyclomatic complexity of 13 (max: 10)" })])).length, 1);
  assert.equal(compareReports(report([finding({ severity: 'medium' })]), report([finding({ severity: 'high' })])).length, 1);
});

test('new aggregate findings fail when the baseline has none', () => {
  const base = report();
  const candidate = report([{ id: 'file-size', title: 'File Size Limit', severity: 'low', provenance: 'traditional', files: ['scripts/new.js (401 lines)'] }]);
  assert.equal(compareReports(base, candidate).length, 1);
});

test('aggregated findings with new candidate paths are rejected', () => {
  const base = report([finding({ id: 'file-size', title: 'File Size Limit', files: ['src/large.js (500 lines)'] })]);
  const unchanged = report([finding({ id: 'file-size', title: 'File Size Limit', files: ['src/large.js (500 lines)', 'scripts/new.js (600 lines)'] })]);
  assert.equal(compareReports(base, unchanged).length, 1);
});

test('aggregate comparison rejects candidate-only or worsened implicated paths', () => {
  const baseline = report([finding({ id: 'file-size', files: ['src/cli.js (300 lines)'] })]);
  const introduced = compareReports(baseline, report([finding({ id: 'file-size', files: ['src/cli.js (300 lines)', 'scripts/new.js (300 lines)'] })]));
  assert.deepEqual(introduced[0].files, ['scripts/new.js']);
  const worsened = compareReports(baseline, report([finding({ id: 'file-size', files: ['src/cli.js (300 lines)', 'scripts/rigour-qualification.js (403 lines)'] })]), new Set(['scripts/rigour-qualification.js']));
  assert.deepEqual(worsened[0].files, ['scripts/rigour-qualification.js']);
});

test('baseline aggregate count increases fail even when candidate-owned paths are absent from the finding file list', () => {
  const baseline = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', provenance: 'ai-drift', line: 33, details: `Inconsistent error handling: 1 strategy\n  • other (169x): scripts/a.js`, files: ['scripts/a.js'] });
  const candidate = { ...baseline, details: baseline.details.replace('169x', '170x'), files: ['src/a.js'] };
  assert.equal(compareReports(report([baseline]), report([candidate]), new Set(['scripts/a.js'])).length, 1);
});

test('unattributable aggregate increases fail closed against changed candidate inputs', () => {
  const baseline = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', provenance: 'ai-drift', line: 33, details: `Inconsistent error handling: 1 strategy\\n  • other (169x): scripts/a.js`, files: ['scripts/a.js'] });
  const candidate = { ...baseline, details: baseline.details.replace('169x', '170x'), files: ['src/a.js'] };
  assert.deepEqual(compareReports(report([baseline]), report([candidate]), new Set(['scripts/a.js'])), [candidate]);
});

test('same-count error-handling file relocation is a regression through qualification', async () => {
  const previous = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', severity: 'high', provenance: 'ai-drift', line: 33, files: ['src/old.js'], details: "Inconsistent error handling for 'try-catch': 1 different strategies found across 1 files:\\n  • rethrow (5x): src/old.js" });
  const relocated = { ...previous, files: ['src/new.js'], details: previous.details.replaceAll('src/old.js', 'src/new.js') };
  const result = await classifyQualification(report([previous]), report([relocated]), new Set(['src/old.js', 'src/new.js']));
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.implementationFindings.map((item) => item.files), [['src/new.js']]);
});

test('error-handling aggregate strategy counts are mapped by name rather than report order', () => {
  const baseline = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', provenance: 'ai-drift', line: 33, details: "Inconsistent error handling for try-catch: 2 different strategies found across 2 files\n  • other (169x): scripts/a.js\n  • log (1x): scripts/b.js", files: ['scripts/a.js', 'scripts/b.js'] });
  const reordered = { ...baseline, details: `Inconsistent error handling for try-catch: 2 different strategies found across 2 files\n  • log (1x): scripts/b.js\n  • other (169x): scripts/a.js` };
  assert.deepEqual(compareReports(report([baseline]), report([reordered])), []);
});

test('error-handling attribution changes fail closed with unchanged strategy counts', () => {
  const details = "Inconsistent error handling for 'try-catch': 2 different strategies found across 2 files:\n  • log (1x): src/a.js\n  • rethrow (1x): src/b.js";
  const baseline = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', provenance: 'ai-drift', line: 33, details, files: ['src/a.js', 'src/b.js'] });
  const movedMembership = { ...baseline, details: details.replace('src/b.js', 'src/c.js'), files: ['src/a.js', 'src/c.js'] };
  assert.deepEqual(compareReports(report([baseline]), report([movedMembership])), [movedMembership]);
});

test('malformed or incomplete error-handling attribution fails closed', () => {
  const baseline = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', provenance: 'ai-drift', line: 33, details: 'Inconsistent error handling for try-catch: 1 different strategies found across 1 files\n  • log (1x): src/a.js', files: ['src/a.js'] });
  const malformed = { ...baseline, details: 'Inconsistent error handling for try-catch: 1 different strategies found across 1 files\n  • log (1x):' };
  const missingCandidateStrategy = { ...baseline, details: 'Inconsistent error handling: 1 strategy' };
  assert.deepEqual(compareReports(report([baseline]), report([malformed])), [malformed]);
  assert.deepEqual(compareReports(report([baseline]), report([missingCandidateStrategy])), [missingCandidateStrategy]);
});

test('duplicate error-handling strategies fail closed instead of overwriting counts', () => {
  const details = "Inconsistent error handling for 'try-catch': 2 different strategies found across 2 files:\n  • log (1x): src/example.js\n  • rethrow (1x): src/other.js";
  const baseline = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', details, provenance: 'ai-drift', line: 33, files: ['src/example.js', 'src/other.js'] });
  const ambiguous = { ...baseline, details: details.replace('rethrow', 'log').replace('1x', '2x') };
  assert.deepEqual(compareReports(report([baseline]), report([ambiguous])), [ambiguous]);
});

test('error-handling aggregate increases fail closed and strategy changes remain findings', () => {
  const details = "Inconsistent error handling for 'try-catch': 4 different strategies found across 16 files:\n  • other (169x): scripts/a.js\n  • log (1x): scripts/b.js\n  • rethrow (5x): src/a.js\n  • return-error (7x): src/b.js";
  const baselineFinding = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', details, provenance: 'ai-drift', line: 33, files: ['scripts/a.js', 'scripts/b.js', 'src/a.js', 'src/b.js'] });
  const changed = { ...baselineFinding, details: details.replace('16 files', '17 files').replace('(169x)', '(176x)') };
  assert.equal(compareReports(report([baselineFinding]), report([changed]))[0].id, changed.id);
  const changedStrategy = { ...changed, details: changed.details.replace('other', 'log') };
  assert.equal(compareReports(report([baselineFinding]), report([changedStrategy]))[0].id, changedStrategy.id);
  assert.throws(() => compareReports(report([baselineFinding]), report()), /ambiguous/);
});

test('AST gate changes fail closed even when raw verdict and findings match', () => {
  const baseline = report([finding()]);
  assert.throws(() => compareReports(baseline, { ...structuredClone(baseline), summary: { 'ast-analysis': 'PASS' } }), /Raw AST gate changed/);
});

test('candidate comparison excludes only the generated fix-packet artifact', () => {
  const raw = report([finding({ id: 'file-size', title: 'File Size Limit', files: ['rigour-fix-packet.json (880 lines)', 'src/large.js (500 lines)'] })]);
  const comparable = removeGeneratedArtifacts(structuredClone(raw));
  assert.deepEqual(raw.failures[0].files, ['rigour-fix-packet.json (880 lines)', 'src/large.js (500 lines)']);
  assert.equal(comparable.failures.length, 1);
  assert.deepEqual(comparable.failures[0].files, ['src/large.js (500 lines)']);
  assert.deepEqual(removeGeneratedArtifacts(report([finding({ id: 'file-size', title: 'File Size Limit', files: ['rigour-fix-packet.json (880 lines)'] })])).failures, []);
});

test('baseline findings from explicitly removed candidate-owned scripts are not treated as missing', () => {
  const base = report([finding({ files: ['scripts/check-manifest-collisions.cjs'] })]);
  const candidate = report();
  assert.deepEqual(compareReports(base, candidate), []);
});

test('missing baseline finding on a retained input fails closed despite another removed baseline path', () => {
  const base = report([finding({ files: ['scripts/check-manifest-collisions.cjs'] }), finding({ title: 'another inherited issue', files: ['src/retained.js'] })]);
  assert.throws(() => compareReports(base, report()), /disappeared/);
});

test('disappeared, relocated, renamed and protected findings fail closed', () => {
  const baseline = report([finding()]);
  assert.throws(() => compareReports(baseline, report()), /disappeared/);
  assert.throws(() => compareReports(baseline, { ...report(), status: 'PASS' }), /Raw verdict changed/);
  assert.equal(compareReports(baseline, report([finding({ files: ['src/renamed.js'] })])).length, 1);
  assert.throws(() => compareReports(baseline, report([finding({ title: 'renamed finding' })])), /ambiguous/);
  assert.throws(() => validateReport(report([finding({ provenance: 'security' })])), /Protected/);
});

test('malformed JSON evidence fails closed', () => {
  assert.throws(() => parseJson('{'), /Invalid JSON evidence/);
});

test('incomplete reports and findings are rejected', () => {
  assert.throws(() => validateReport({ status: 'FAIL', failures: [] }), /incomplete/);
  assert.throws(() => validateReport(report([finding({ files: undefined })])), /identity/);
  assert.throws(() => validateReport(report([finding({ line: 12 })])), /ambiguous/);
});
