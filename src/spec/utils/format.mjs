export function formatValidationResult(name, result, prefix = '') {
  const { errors = [], warnings = [] } = result;
  if (errors.length === 0 && warnings.length === 0) {
    return prefix ? `${prefix}${name} ---\nAll checks passed` : `${name}: All checks passed`;
  }
  const lines = prefix ? [`${prefix}${name} ---`] : [];
  if (errors.length > 0) {
    lines.push(`${name}: ${errors.length} error(s)`);
    for (const e of errors) lines.push(`  ERROR [${e.file}] ${e.message}`);
  }
  if (warnings.length > 0) {
    lines.push(`${name}: ${warnings.length} warning(s)`);
    for (const w of warnings) lines.push(`  WARN  [${w.file}] ${w.message}`);
  }
  return lines.join('\n');
}
