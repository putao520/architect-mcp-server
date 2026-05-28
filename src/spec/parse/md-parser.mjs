import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { globSync } from 'glob';
import { parseMdDocument } from '../utils/md.mjs';
import { extractReqIdsFromText } from '../utils/schemas.mjs';

export function parseMdFile(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseMdDocument(raw);
  const lines = raw.split('\n');

  return {
    filePath,
    fileName: basename(filePath, '.md'),
    headings: parsed.sections.map(s => ({ level: s.level, text: s.text, raw: s.raw })),
    reqs: dedupReqs(parsed.reqs),
    tables: parsed.tables,
    links: parsed.links,
    stateDiagrams: extractStateDiagrams(raw),
    codeBlocks: parsed.codeBlocks,
  };
}

export function parseMdDir(dirPath) {
  const files = globSync('**/*.md', { cwd: dirPath, ignore: ['node_modules/**'] });
  return files.map(f => parseMdFile(join(dirPath, f))).filter(Boolean);
}

function dedupReqs(reqs) {
  const seen = new Set();
  return reqs.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function extractStateDiagrams(raw) {
  const diagrams = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const code = m[1].trim();
    if (code.includes('stateDiagram')) {
      diagrams.push({ type: 'stateDiagram', code, start: m.index });
    }
  }
  return diagrams;
}
