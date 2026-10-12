export const errorHandlingAggregate = (finding) => finding.id === 'inconsistent-error-handling';

function strategyCounts(details) {
  const strategies = [...details.matchAll(/^\s*•\s+([^\s]+)\s+\((\d+)x\):\s*(.+)$/gm)]
    .map((match) => ({ strategy: match[1], count: Number(match[2]), files: match[3].split(', ').map((path) => path.trim()) }));
  const declaredFiles = Number(details.match(/across\s+(\d+)\s+files?/i)?.[1]);
  const attributedFiles = new Set(strategies.flatMap(({ files }) => files)).size;
  return { strategies, counts: new Map(strategies.map(({ strategy, count }) => [strategy, count])), attributionComplete: Number.isInteger(declaredFiles) && declaredFiles === attributedFiles };
}

function attributionChanged(baseline, candidate) {
  if (!baseline.strategies.length || !candidate.strategies.length || !baseline.attributionComplete || !candidate.attributionComplete || baseline.strategies.some(({ files }) => !files.length) || candidate.strategies.some(({ files }) => !files.length)) return true;
  const previous = new Map(baseline.strategies.map(({ strategy, files }) => [strategy, files.join('\\0')]));
  return candidate.strategies.some(({ strategy, files }) => previous.get(strategy) !== files.join('\\0'));
}

function aggregateShapeChanged(previous, current, baseline, candidate) {
  if (previous.severity !== current.severity || baseline.strategies.length === 0) return true;
  if (baseline.counts.size !== baseline.strategies.length || candidate.counts.size !== candidate.strategies.length) return true;
  if (baseline.counts.size !== candidate.counts.size) return true;
  return [...baseline.counts.keys()].some((strategy) => !candidate.counts.has(strategy));
}

export function compareErrorHandlingAggregate(current, baseline, changedPaths, normalizedPaths) {
  const previous = baseline.failures.find(errorHandlingAggregate);
  if (!previous) return current;
  const oldCounts = strategyCounts(previous.details);
  const newCounts = strategyCounts(current.details);
  if (aggregateShapeChanged(previous, current, oldCounts, newCounts) || attributionChanged(oldCounts, newCounts)) return current;
  const candidatePaths = normalizedPaths(current);
  const affectedPaths = candidatePaths.filter((path) => changedPaths.has(path));
  const baselinePaths = new Set(normalizedPaths(previous));
  const implicatedChangedPaths = candidatePaths.filter((path) => !baselinePaths.has(path) && changedPaths.has(path));
  const addedCount = [...newCounts.counts].reduce((total, [strategy, count]) => total + Math.max(0, count - (oldCounts.counts.get(strategy) ?? 0)), 0);
  if (implicatedChangedPaths.length) return { ...current, files: implicatedChangedPaths };
  if (!addedCount) return null;
  const changedFilesInDetails = [...current.details.matchAll(/(?:^|,\s*)([^,\n]+\.(?:js|cjs|mjs|ts|tsx|jsx))/g)].map((match) => match[1].trim()).filter((path) => changedPaths.has(path));
  if (changedFilesInDetails.length) return { ...current, files: changedFilesInDetails };
  if (affectedPaths.length) return { ...current, files: affectedPaths };
  const detailPaths = [...current.details.matchAll(/(?:^|,\s*)([^,\n]+\.(?:js|cjs|mjs|ts|tsx|jsx))/g)].map((match) => match[1].trim());
  const newlyListedChangedPaths = detailPaths.filter((path) => changedPaths.has(path) && !baselinePaths.has(path));
  if (newlyListedChangedPaths.length) return { ...current, files: newlyListedChangedPaths };
  if ([...changedPaths].some((path) => !baselinePaths.has(path))) {
    return { ...current, files: [...changedPaths].filter((path) => !baselinePaths.has(path)) };
  }
  return { ...current, files: [...changedPaths] };
}
