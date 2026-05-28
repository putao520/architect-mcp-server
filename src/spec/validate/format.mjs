import { parseHTML } from 'linkedom';
import { HtmlIdSchema } from '../utils/schemas.mjs';
import { specTypeToJsonSchema, isKnownSpecType } from '../schema/type-system.mjs';
const ATTR_ORDER = ['id', 'data-req', 'data-req-status', 'data-req-domain', 'data-req-priority',
  'data-entity', 'data-field', 'data-type', 'data-constraints', 'data-required',
  'data-api', 'data-test', 'data-req-ref', 'data-test-categories',
  'data-state-machine', 'data-artifact-type', 'data-section',
  'data-algorithm', 'data-algorithm-type', 'data-algorithm-complexity', 'data-algorithm-space',
  'data-pipeline', 'data-pipeline-type',
  'data-integration', 'data-integration-protocol', 'data-integration-auth',
  'data-timing', 'data-timing-constraint',
  'data-nfr', 'data-nfr-category',
  'data-xref-type', 'data-xref-id', 'data-criterion', 'data-criterion-id',
  'data-role', 'data-access', 'data-status',
  'class', 'href', 'src', 'type', 'rel', 'name', 'content', 'charset', 'lang'];

export function validateFormat(index) {
  const errors = [];
  const warnings = [];

  for (const doc of index.docs) {
    const raw = doc.raw;
    const lines = raw.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineno = i + 1;

      if (line.includes('\t')) {
        warnings.push({ file: doc.fileName, message: `Line ${lineno}: tab character (use spaces)` });
      }
      if (line.length > 200) {
        warnings.push({ file: doc.fileName, message: `Line ${lineno}: line >200 chars` });
      }
    }

    if (raw.endsWith('\n\n')) {
      warnings.push({ file: doc.fileName, message: 'Trailing blank line at EOF' });
    } else if (!raw.endsWith('\n')) {
      warnings.push({ file: doc.fileName, message: 'Missing trailing newline' });
    }

    for (const section of doc.sections) {
      if (section.id && !HtmlIdSchema.safeParse(section.id).success) {
        errors.push({ file: doc.fileName, message: `Invalid ID: ${section.id}` });
      }
    }
    for (const req of doc.reqs) {
      if (req.htmlId && !HtmlIdSchema.safeParse(req.htmlId).success) {
        errors.push({ file: doc.fileName, message: `Invalid REQ ID: ${req.htmlId}` });
      }
    }

    const { document } = parseHTML(raw);
    for (const el of document.querySelectorAll('*')) {
      const attrs = el.getAttributeNames();
      if (attrs.length < 2) continue;

      for (let i = 1; i < attrs.length; i++) {
        const pi = ATTR_ORDER.indexOf(attrs[i - 1]);
        const ci = ATTR_ORDER.indexOf(attrs[i]);
        if (pi >= 0 && ci >= 0 && pi > ci) {
          warnings.push({
            file: doc.fileName,
            message: `Attr order: ${attrs[i - 1]} before ${attrs[i]} (expected: id → data-* → class → href)`,
          });
        }
      }

      const dataType = el.getAttribute('data-type');
      if (dataType && !isKnownSpecType(dataType)) {
        warnings.push({ file: doc.fileName, message: `Unknown data-type "${dataType}" on <${el.tagName}>` });
      }
    }
  }

  return { errors, warnings };
}