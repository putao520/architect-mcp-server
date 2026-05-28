import { normalizeSpecRef, stripHtmlExt, resolveFileName } from '../utils/normalize.mjs';
import { findStale } from '../status/tracker.mjs';

export function validateConsistency(index) {
  const errors = [];
  const warnings = [];

  for (const doc of index.docs) {
    for (const xref of doc.xrefs) {
      if (xref.type === 'spec-subfile') {
        const resolved = resolveFileName(xref.href, index.fileMap);
        if (!index.fileMap.has(resolved)) {
          errors.push({
            file: doc.fileName,
            message: `XRef to non-existent subfile: ${xref.href}`,
          });
        }
      }
    }

    }

  // Stale REQs (status=implemented without test)
  const staleReqs = findStale(index).filter(s => s.reason === 'no test link');
  for (const s of staleReqs) {
    warnings.push({ file: s.file, message: `${s.req} status=implemented but no test link` });
  }

  for (const doc of index.docs) {
    if (!doc.meta.file) continue;
    for (const dep of doc.dependencies) {
      const depName = normalizeSpecRef(dep.href);
      if (!index.fileMap.has(depName)) {
        errors.push({
          file: doc.fileName,
          message: `Declared dependency not found: ${dep.href}`,
        });
      }
    }
  }

  if (index.childrenMap) {
    for (const [parent, children] of index.childrenMap.entries()) {
      const parentDoc = index.fileMap.get(parent);
      if (!parentDoc) continue;
      const declaredChildren = (parentDoc.subfileInfo?.children || []).map(c => resolveFileName(c, index.fileMap));
      const actualChildren = children || [];
      const declaredSet = new Set(declaredChildren);
      const actualSet = new Set(actualChildren);
      for (const c of actualChildren) {
        if (!declaredSet.has(c)) {
          warnings.push({
            file: parent,
            message: `Subfile ${c} exists on disk but not declared in parent JSON-LD`,
          });
        }
      }
      for (const c of declaredChildren) {
        if (!actualSet.has(c)) {
          errors.push({
            file: parent,
            message: `Declared child ${c} not found in SPEC directory`,
          });
        }
      }
    }
  }

  return { errors, warnings };
}