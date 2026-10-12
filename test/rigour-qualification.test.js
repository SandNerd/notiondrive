import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, parseJson, protectedPathChanges, removeGeneratedArtifacts, validateReport } from '../scripts/rigour-qualification.js';

const finding = (overrides = {}) => ({ id: 'AST_COMPLEXITY', title: "Function 'example' has cyclomatic complexity of 12", severity: 'medium', provenance: 'traditional', files: ['src/example.js'], ...overrides });
const report = (failures = []) => ({ status: 'FAIL', summary: { 'ast-analysis': 'FAIL' }, failures, stats: { score: failures.length ? 80 : 44, duration_ms: 1, severity_breakdown: {}, provenance_breakdown: {} } });

test('changed protected workflow paths require review even without a raw scanner finding', () => {
  assert.deepEqual(protectedPathChanges(new Set(['.github/workflows/ci.yml'])), ['.github/workflows/ci.yml']);
  assert.deepEqual(protectedPathChanges(new Set(['src/sync.js'])), []);
  assert.equal(compareReports(report(), report()).length, 0);
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

test('error-handling aggregate count shifts qualify but strategy changes remain findings', () => {
  const details = "Inconsistent error handling for 'try-catch': 4 different strategies found across 16 files:\n  • other (169x): scripts/a.js\n  • log (1x): scripts/b.js\n  • rethrow (5x): src/a.js\n  • return-error (7x): src/b.js";
  const baselineFinding = finding({ id: 'inconsistent-error-handling', title: 'Inconsistent Error Handling', details, provenance: 'ai-drift', line: 33, files: ['scripts/a.js', 'scripts/b.js', 'src/a.js', 'src/b.js'] });
  const changed = { ...baselineFinding, details: details.replace('16 files', '17 files').replace('(169x)', '(176x)') };
  assert.deepEqual(compareReports(report([baselineFinding]), report([changed])), []);
  const changedStrategy = { ...changed, details: changed.details.replace('other', 'log') };
  assert.deepEqual(compareReports(report([baselineFinding]), report([changedStrategy])), [changedStrategy]);
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
