#!/usr/bin/env node
import { createHash } from 'node:crypto';
import parseJsonWithoutExceptions from 'json-parse-even-better-errors';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { compareErrorHandlingAggregate, errorHandlingAggregate } from './rigour-error-aggregate.js';

const commandTimeout = 120_000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, '.not2-evidence/rigour-main-81f4fa4.json');
const metadataPath = resolve(root, '.not2-evidence/rigour-main-81f4fa4.json.metadata.json');
const reportPath = resolve(root, 'rigour-report.json');
const qualificationFiles = new Set(['.not2-evidence/rigour-main-81f4fa4.json', '.not2-evidence/rigour-main-81f4fa4.json.metadata.json', '.not2-evidence/rigour-candidate-81f4fa4.json', '.not2-evidence/rigour-candidate-81f4fa4.json.metadata.json', 'rigour-report.json', 'rigour-fix-packet.json']);
const localCandidateEvidence = /^\.not2-evidence\/rigour-candidate(?:-local(?:-check)?)?(?:-[a-f0-9]+)?\.(?:json|stderr)(?:\.metadata\.json)?$/;
const ignoredWorkspacePaths = new Set(['.serena/.gitignore', '.serena/project.yml', '.not2-evidence/rigour-candidate-local.json', '.not2-evidence/rigour-candidate-local.stderr', '.not2-evidence/rigour-candidate-local-check.json', '.not2-evidence/rigour-candidate-local-check.stderr']);
const transientEvidencePath = (path) => /^\.not2-evidence\/hosted-[^/]+\/(?:rigour-qualification-evidence|rigour-report)\/\.not2-evidence\/rigour-(?:main|candidate)-[a-f0-9]+\.json(?:\.metadata\.json)?$/.test(path) || /^\.not2-evidence\/hosted-[^/]+\/rigour-qualification-evidence\/rigour-main-[a-f0-9]+\.json(?:\.metadata\.json)?$/.test(path);
const removedBaselinePaths = new Set(['scripts/check-manifest-collisions.cjs', 'scripts/disable-duplicate-targets.cjs']);
const baselineTrackedPaths = new Set([...removedBaselinePaths, 'scripts/check-manifest-collisions.js', 'scripts/validate-config.js', 'src/cli.js', 'src/download.js', 'src/parser.js', 'src/sync.js', 'test/sync.integration.test.js']);
const configPath = resolve(root, 'rigour.yml');
const baselineRevision = '81f4fa4293c3cc0234ed0586bdf945c3f0d00f7a';
const scannerVersion = '7.0.2';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: commandTimeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  return result.stdout;
}

export function candidateChangedFiles() {
  const paths = [];
  const diffPaths = runCommand('git', ['diff', '--name-only', '--no-renames', '-z', `${baselineRevision}...HEAD`]);
  paths.push(...diffPaths.split('\0').filter(Boolean));
  const statusPaths = runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = statusPaths.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes('R') || status.includes('C')) paths.push(entries[++index] ?? path, path);
    else paths.push(path);
  }
  const stagedPaths = runCommand('git', ['diff', '--cached', '--name-only', '-z']);
  paths.push(...stagedPaths.split('\0').filter(Boolean));
  return [...new Set(paths)];
}

function normalizedPaths(finding) {
  return finding.files.map((file) => file.replace(/ \(\d+ lines\)$/, '')).sort();
}

function validateIdentityShape(finding) {
  if (!finding.id || !finding.title || !Array.isArray(finding.files) || !finding.files.length) throw new Error('Finding identity is incomplete');
  if (finding.files.some((file) => typeof file !== 'string')) throw new Error('Finding identity contains an invalid path');
}

function identity(finding, { allowProtected = false } = {}) {
  validateIdentityShape(finding);
  if (!allowProtected && protectedFinding(finding)) throw new Error('Protected finding cannot be baseline-excused');
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1 || finding.provenance !== 'ai-drift')) throw new Error('Line-specific finding identity is ambiguous');
  return JSON.stringify([finding.id, finding.title, normalizedPaths(finding), finding.line ?? null]);
}

function metric(title) {
  return Number(title.match(/\b(?:complexity of|has)\s+(\d+)/i)?.[1] ?? title.match(/\b(\d+)\s*\(max: \d+\)/)?.[1] ?? 0);
}

function normalizeTitle(title) {
  return title.replace(/(\b(?:complexity of|has)\s+)\d+/ig, '$1<number>').replace(/\b\d+(?=\s*\(max: \d+\))/g, '<number>').replace(/\s*\(max: \d+\)/g, '');
}

function severity(value) {
  return ({ low: 1, medium: 2, high: 3, critical: 4 })[value] ?? 0;
}

function protectedFinding(finding) {
  return ['security', 'governance'].includes(finding.provenance) || /secret|data.loss|protected.path|safety/i.test(`${finding.id} ${finding.title}`);
}

function reportKey(finding) {
  return JSON.stringify([finding.id, normalizeTitle(finding.title), finding.provenance, finding.line ?? null]);
}

function findingFingerprint(finding) {
  return createHash('sha256').update(JSON.stringify({
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    provenance: finding.provenance,
    files: normalizedPaths(finding),
    line: finding.line ?? null,
    message: finding.message ?? null,
  })).digest('hex');
}

function findingSignature(finding) {
  return JSON.stringify([finding.id, normalizeTitle(finding.title), finding.provenance, finding.line ?? null]);
}

function aggregatedFinding(finding) {
  return finding.id === 'file-size';
}
const lineCount = (finding, path) => Number(finding.files.find((file) => file.startsWith(`${path} (`))?.match(/\((\d+) lines\)$/)?.[1] ?? 0);
function removeGeneratedArtifacts(report) {
  report.failures = report.failures.flatMap((finding) => {
    if (finding.id !== 'file-size') return [finding];
    const files = finding.files.filter((file) => !file.startsWith('rigour-fix-packet.json (') && file !== 'rigour-fix-packet.json');
    return files.length ? [{ ...finding, files }] : [];
  });
  return report;
}

export function candidateOwnsInput(path) {
  return !qualificationFiles.has(path) && !localCandidateEvidence.test(path) && !transientEvidencePath(path);
}

function candidateInputSet(report) {
  return new Set(report.failures.flatMap((finding) => normalizedPaths(finding)).filter(candidateOwnsInput));
}

function baselineInputSet(report) {
  return new Set(report.failures.flatMap((finding) => normalizedPaths(finding)).filter((path) => baselineTrackedPaths.has(path)));
}

function baselinePathsRemovedFromCandidate(baseline) {
  return new Set([...removedBaselinePaths].filter((path) => baselineInputSet(baseline).has(path)));
}

function validateReportShape(report) {
  if (!report || !['PASS', 'FAIL'].includes(report.status) || !Array.isArray(report.failures) || !report.summary || !report.stats) throw new Error('Rigour report is incomplete');
  validateReportStats(report.stats);
  if (Object.values(report.summary).some((status) => !['PASS', 'FAIL'].includes(status))) throw new Error('Rigour gate summary is incomplete');
}

function validateReportStats(stats) {
  if (!Number.isFinite(stats.score) || !Number.isFinite(stats.duration_ms) || !stats.severity_breakdown || !stats.provenance_breakdown) throw new Error('Rigour report statistics are incomplete');
}

function validateFindings(findings, options) {
  for (const finding of findings) {
    identity(finding, options);
    if (!['low', 'medium', 'high', 'critical'].includes(finding.severity)) throw new Error('Finding severity is incomplete');
  }
}

function validateReport(report, options) {
  validateReportShape(report);
  validateFindings(report.failures, options);
  return report;
}

function isWorsened(current, previous) {
  return protectedFinding(current) || !samePaths(current, previous) || severity(current.severity) > severity(previous.severity) || metric(current.title) > metric(previous.title);
}
function findBaselineMatch(current, baseline, unmatched) {
  return baseline.find((finding) => unmatched.has(finding) && reportKey(finding) === reportKey(current));
}

function rejectAmbiguousRename(current, baseline, unmatched) {
  const possible = baseline.some((finding) => unmatched.has(finding) && finding.id === current.id && finding.provenance === current.provenance);
  if (possible && !metric(current.title)) throw new Error('Baseline finding identity is ambiguous; maintainer review is required');
}

function compareAggregatedFinding(current, previous, changedPaths) {
  const candidatePaths = normalizedPaths(current);
  const previousPaths = normalizedPaths(previous);
  const baselinePaths = baselineInputSet({ failures: [previous] });
  const introducedPaths = candidatePaths.filter((path) => !previousPaths.includes(path) || (candidateOwnsInput(path) && !baselinePaths.has(path)));
  const worsenedPaths = candidatePaths.filter((path) => candidateOwnsInput(path) && changedPaths.has(path) && lineCount(current, path) > lineCount(previous, path));
  const affectedPaths = [...new Set([...introducedPaths, ...worsenedPaths])];
  return affectedPaths.length ? { ...current, files: affectedPaths } : null;
}

function processFinding(current, baseline, unmatched, changedPaths) {
  if (errorHandlingAggregate(current)) {
    const previous = baseline.failures.find(errorHandlingAggregate);
    if (!previous) return current;
    unmatched.delete(previous);
    return compareErrorHandlingAggregate(current, baseline, changedPaths, normalizedPaths);
  }
  const previous = aggregatedFinding(current)
    ? baseline.failures.find((finding) => aggregatedFinding(finding) && findingSignature(finding) === findingSignature(current))
    : findBaselineMatch(current, baseline.failures, unmatched);
  if (!previous) {
    if (!aggregatedFinding(current)) rejectAmbiguousRename(current, baseline.failures, unmatched);
    return current;
  }
  unmatched.delete(previous);
  if (!aggregatedFinding(current)) return isWorsened(current, previous) ? current : null;
  return compareAggregatedFinding(current, previous, changedPaths);
}

function aggregatedPathsChanged(current, previous) {
  return aggregatedFinding(current) && normalizedPaths(current).some((path) => !normalizedPaths(previous).includes(path));
}

function validateUnmatchedFindings(unmatched, baseline, candidate) {
  const candidateAggregates = candidate.failures.filter(errorHandlingAggregate);
  if ([...unmatched].some(errorHandlingAggregate) && candidateAggregates.length) {
    throw new Error('Baseline error-handling aggregate changed; comparison is ambiguous and requires maintainer review');
  }
  const baselinePaths = baselineInputSet(baseline);
  const candidatePaths = candidateInputSet(candidate);
  const removedPaths = baselinePathsRemovedFromCandidate(baseline);
  const missing = [...unmatched].filter((finding) => {
    const paths = normalizedPaths(finding);
    if (aggregatedFinding(finding)) return paths.some((path) => candidatePaths.has(path) && !removedPaths.has(path));
    if (paths.length && paths.every((path) => removedPaths.has(path))) return false;
    return paths.some((path) => candidatePaths.has(path) && !removedPaths.has(path)) || paths.some((path) => !baselinePaths.has(path) && !removedPaths.has(path));
  });
  if (missing.length) throw new Error('Baseline findings disappeared; comparison is ambiguous and requires maintainer review');
}

function compareReports(baseline, candidate, changedPaths = new Set()) {
  if (baseline.status !== candidate.status) throw new Error('Raw verdict changed; comparison requires maintainer review');
  if (baseline.summary?.['ast-analysis'] !== candidate.summary?.['ast-analysis']) throw new Error('Raw AST gate changed; comparison requires maintainer review');
  const unmatched = new Set(baseline.failures);
  const added = candidate.failures.map((current) => processFinding(current, baseline, unmatched, changedPaths)).filter(Boolean);
  validateUnmatchedFindings(unmatched, baseline, candidate);
  return added;
}

function hasExactMatch(candidate, baseline, unmatched) {
  return baseline.some((finding) => unmatched.has(finding) && reportKey(finding) === reportKey(candidate));
}

function samePaths(first, second) {
  return JSON.stringify(normalizedPaths(first)) === JSON.stringify(normalizedPaths(second));
}

function parseJson(bytes, label = 'JSON evidence') {
  const parsed = parseJsonWithoutExceptions.noExceptions(bytes);
  if (parsed === undefined) throw new Error(`Invalid ${label}`);
  return parsed;
}

async function readJson(path) {
  return parseJson(await readFile(path, 'utf8'));
}

function validateBaselineMetadata(baselineBytes) {
  const metadata = parseJson(readFileSync(metadataPath, 'utf8'));
  if (metadata.revision !== baselineRevision || metadata.scannerVersion !== scannerVersion || metadata.baselineSha256 !== hash(baselineBytes)) throw new Error('Pinned baseline provenance validation failed');
  if (metadata.configSha256 !== hash(readFileSync(configPath))) throw new Error('Scanner configuration differs from pinned baseline');
}

function validateScannerVersion() {
  const result = spawnSync('npm', ['run', 'rigour', '--', '--version'], { cwd: root, encoding: 'utf8', timeout: commandTimeout });
  if (result.error || result.status !== 0 || !result.stdout.trim().endsWith(scannerVersion)) throw new Error('Rigour scanner version mismatch');
}

async function validateScannerDependencyUse() {
  const packageJson = await readJson(resolve(root, 'package.json'));
  if (packageJson.scripts.rigour !== 'rigour' || !packageJson.devDependencies?.['@rigour-labs/cli']) {
    throw new Error('Pinned Rigour CLI must be installed as a development dependency and invoked by the rigour script');
  }
}

function validatePinnedEvidence() {
  const baselineBytes = readFileSync(baselinePath);
  validateBaselineMetadata(baselineBytes);
  validateScannerVersion();
  return validateReport(parseJson(baselineBytes, 'pinned baseline report'), { allowProtected: true });
}

async function validateInputSet() {
  const touched = (await candidateChangedFiles()).filter((file) => !ignoredWorkspacePaths.has(file));
  const evidenceChanged = touched.some((file) => qualificationFiles.has(file) && !localCandidateEvidence.test(file) && !transientEvidencePath(file) && !file.startsWith('.not2-evidence/rigour-main-'));
  if (evidenceChanged) throw new Error('Candidate scanner inputs overlap qualification evidence; independent review is required');
  if (touched.includes('rigour.yml')) throw new Error('Scanner configuration changed; independent review is required');
  const candidateTracked = new Set(runCommand('git', ['ls-files', '-z']).split('\0').filter(Boolean));
  const baselineTracked = new Set(runCommand('git', ['ls-tree', '-r', '--name-only', '-z', baselineRevision]).split('\0').filter(Boolean));
  const candidateInputs = touched.filter((file) => !qualificationFiles.has(file) && !transientEvidencePath(file) && !localCandidateEvidence.test(file));
  const untrackedWorkspace = runCommand('git', ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (candidateInputs.some((file) => untrackedWorkspace.includes(file) || (!candidateTracked.has(file) && !baselineTracked.has(file)))) throw new Error('Candidate scanner inputs include an untracked path');
  const head = runCommand('git', ['rev-parse', 'HEAD']).trim();
  const baselineInHistory = spawnSync('git', ['merge-base', '--is-ancestor', baselineRevision, head], { cwd: root }).status === 0;
  const workflowPath = resolve(root, '.github/workflows/ci.yml');
  const workflowContent = await readFile(workflowPath, 'utf8');
  if (!workflowContent.includes('fetch-depth: 0') || !workflowContent.includes('node-version: "24"')) throw new Error('CI must fetch full history and use the pinned scanner-supported Node runtime');
  if (!baselineInHistory) throw new Error('Pinned baseline revision is not an ancestor of candidate HEAD');
}

async function removePreviousReport() {
  await Promise.all([reportPath, resolve(root, 'rigour-fix-packet.json')].map((path) => rm(path, { force: true })));
}

async function preserveCandidateReport(rawBytes, report, exitCode) {
  const candidatePath = resolve(root, '.not2-evidence/rigour-candidate-81f4fa4.json');
  const provenancePath = `${candidatePath}.metadata.json`;
  const head = runCommand('git', ['rev-parse', 'HEAD']).trim();
  const metadata = {
    revision: head,
    tree: runCommand('git', ['rev-parse', 'HEAD^{tree}']).trim(),
    scannerVersion,
    node: process.version,
    rawVerdict: report.status,
    findings: report.failures.length,
    score: report.stats.score,
    exitCode,
    reportSha256: hash(rawBytes),
    configSha256: hash(readFileSync(configPath)),
  };
  await Promise.all([
    writeFile(candidatePath, rawBytes),
    writeFile(provenancePath, `${JSON.stringify(metadata, null, 2)}\n`),
  ]);
  return metadata;
}

async function runScan() {
  await removePreviousReport();
  const result = spawnSync('npm', ['run', 'rigour', '--', 'check', '--ci', '--json', '--no-cache'], {
    cwd: root,
    encoding: 'utf8',
    timeout: commandTimeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Rigour scanner could not run: ${result.error.message}`);
  return result.status;
}

function verifyScanExit(report, exitCode) {
  if ((report.status === 'PASS' && exitCode !== 0) || (report.status === 'FAIL' && exitCode === 0)) throw new Error('Raw Rigour report and exit status disagree');
}

export function protectedPathChanges(paths) {
  return [...paths].filter((path) => path === '.github/workflows/ci.yml' || path === 'AGENTS.md' || path === 'NOT-2-DECISION.md' || path.startsWith('.github/'));
}
export function classifyQualification(baseline, report, changedPaths) {
  const implementationFindings = compareReports(baseline, report, changedPaths);
  const protectedChanges = protectedPathChanges(changedPaths);
  const reviewFindings = report.failures.filter(protectedFinding);
  const reviewObligations = [...reviewFindings, ...protectedChanges.map((path) => ({ id: 'protected-path-change', title: 'Protected path requires independent review', severity: 'high', provenance: 'governance', files: [path] }))];
  if (implementationFindings.length) return { status: 'FAIL', implementationFindings, reviewObligations };
  return { status: reviewObligations.length ? 'ADVISORY' : 'PASS', implementationFindings, reviewObligations };
}
async function reportOutcome(baseline, report, changedPaths) {
  const outcome = await classifyQualification(baseline, report, changedPaths);
  if (outcome.implementationFindings.length) {
    process.stderr.write(`Qualification findings: ${outcome.implementationFindings.length} new or worsened; ${outcome.reviewObligations.length} protected or review-boundary obligations remain: ${JSON.stringify(outcome.implementationFindings.map(({ id, title, files }) => ({ id, title, files })))}\n`);
    process.stderr.write('Qualification: FAIL (new or worsened findings require repair)\n');
    process.exitCode = 1;
    return;
  }
  if (outcome.reviewObligations.length) {
    process.stdout.write(`Qualification: ADVISORY (${outcome.reviewObligations.length} protected or review-boundary findings require independent review; raw Rigour remains ${report.status})\n`);
    return;
  }
  process.stdout.write(`Qualification: PASS (no new or worsened findings; raw Rigour remains ${report.status})\n`);
}

async function runQualification() {
  await validateScannerDependencyUse();
  const baseline = validatePinnedEvidence();
  await validateInputSet();
  const exitCode = await runScan();
  const rawBytes = await readFile(reportPath);
  const rawReport = validateReport(parseJson(rawBytes), { allowProtected: true });
  verifyScanExit(rawReport, exitCode);
  const candidateMetadata = await preserveCandidateReport(rawBytes, rawReport, exitCode);
  if (candidateMetadata.revision !== runCommand('git', ['rev-parse', 'HEAD']).trim()) throw new Error('Candidate revision changed during scan')
  process.stdout.write(`Raw Rigour: ${rawReport.status} (${rawReport.failures.length} findings)\n`);
  process.stdout.write(`Raw report SHA-256: ${hash(rawBytes)}\n`);
  process.stdout.write(`Finding fingerprints SHA-256: ${hash(rawReport.failures.map(findingFingerprint).join('\n'))}\n`);
  process.stdout.write(`Candidate report: .not2-evidence/rigour-candidate-81f4fa4.json (${candidateMetadata.reportSha256})\n`);
  const changedPaths = new Set((await candidateChangedFiles()).filter(candidateOwnsInput));
  await reportOutcome(baseline, removeGeneratedArtifacts(structuredClone(rawReport)), changedPaths);
}
function main() {
  runQualification().catch(reportQualificationFailure);
}

function reportQualificationFailure(error) {
  process.stderr.write(`Qualification: FAIL closed (${error.message})\n`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { compareReports, parseJson, removeGeneratedArtifacts, validateReport };
