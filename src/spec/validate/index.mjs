import { parseSpecDir } from '../parse/html-parser.mjs';
import { validateLinks } from './links.mjs';
import { validateCompleteness } from './completeness.mjs';
import { validateConsistency } from './consistency.mjs';
import { validateFormat } from './format.mjs';
import { validateReferences } from './references.mjs';
import { validateSpecDirApis, validatePathParamConsistency } from '../openapi/validator.mjs';

function validateOpenApi(index) {
  const errors = [];
  const warnings = [];
  const apiResults = validateSpecDirApis(index);
  for (const r of apiResults) {
    for (const e of r.errors) {
      errors.push({ file: r.file, message: `${r.api}: ${e.field} — ${e.message}` });
    }
  }
  for (const doc of index.docs) {
    for (const api of doc.apis) {
      const pathErrors = validatePathParamConsistency(api);
      for (const e of pathErrors) {
        warnings.push({ file: doc.fileName, message: `${api.method} ${api.path}: ${e.message}` });
      }
    }
  }
  return { errors, warnings };
}

export async function run(args) {
  const dir = args[0] || '.';
  const dimension = args[1] || 'all';
  const index = parseSpecDir(dir);

  const results = { files: index.docs.length, errors: [], warnings: [] };

  const validators = {
    links: validateLinks,
    completeness: validateCompleteness,
    consistency: validateConsistency,
    format: validateFormat,
    references: validateReferences,
    openapi: validateOpenApi,
  };

  const dims = dimension === 'all'
    ? Object.keys(validators)
    : [dimension].filter(d => d in validators);

  for (const d of dims) {
    const r = validators[d](index);
    results.errors.push(...r.errors);
    results.warnings.push(...r.warnings);
  }

  console.log(`\nSPEC Validate: ${results.files} files`);
  console.log(`  Errors:   ${results.errors.length}`);
  console.log(`  Warnings: ${results.warnings.length}`);

  for (const e of results.errors) console.log(`  ERROR   ${e.file || ''} ${e.message}`);
  for (const w of results.warnings) console.log(`  WARNING ${w.file || ''} ${w.message}`);

  process.exit(results.errors.length > 0 ? 1 : 0);
}

export function validateAll(index) {
  const results = { errors: [], warnings: [] };
  for (const validator of [validateLinks, validateCompleteness, validateConsistency, validateFormat, validateReferences, validateOpenApi]) {
    const r = validator(index);
    results.errors.push(...r.errors);
    results.warnings.push(...r.warnings);
  }
  return results;
}