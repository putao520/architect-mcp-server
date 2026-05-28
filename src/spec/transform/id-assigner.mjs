import { slugify, pathToId, extractSectionNumber } from '../utils/normalize.mjs';
import { extractReqId } from '../utils/schemas.mjs';

export function assignIds(sections, fileName) {
  const ids = new Set();
  const result = [];

  for (const section of sections) {
    let id = inferId(section, fileName);
    id = deduplicate(id, ids);
    ids.add(id);
    result.push({ ...section, id });
  }

  return result;
}

function inferId(section, fileName) {
  if (section.reqId) {
    return `req-${section.reqId.domain.toLowerCase()}-${section.reqId.number}`;
  }

  if (section.entityName) {
    return `data-${section.entityName.toLowerCase()}`;
  }

  if (section.apiDef) {
    return `api-${section.apiDef.method.toLowerCase()}-${pathToId(section.apiDef.path)}`;
  }

  if (section.stateMachine) {
    return `sm-${section.stateMachine}`;
  }

  if (section.testId) {
    return `test-${section.testId.domain.toLowerCase()}-${section.testId.number}`;
  }

  if (section.artifactType) {
    return `artifact-${section.artifactType}`;
  }

  const num = extractSectionNumber(section.text || '');
  if (num) return `s${num}`;

  const s = slugify(section.text || section.title || 'section');
  return `s-${s}`;
}

function deduplicate(id, existing) {
  if (!existing.has(id)) return id;
  let i = 2;
  while (existing.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

export function inferIdFromContext(text, fileName) {
  const reqId = extractReqId(text);
  if (reqId) {
    const parts = reqId.match(/^REQ-([A-Z]+)-(\d+)$/);
    if (parts) return `req-${parts[1].toLowerCase()}-${parts[2]}`;
  }

  const smMatch = text.match(/(\w+)\s*状态机/);
  if (smMatch) return `sm-${smMatch[1].toLowerCase()}`;

  const num = extractSectionNumber(text);
  if (num) return `s${num}`;

  return `s-${slugify(text)}`;
}
