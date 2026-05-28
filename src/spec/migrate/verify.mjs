import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseSpecDir, parseSpecFile } from '../parse/html-parser.mjs';
import { parseMdFile, parseMdDir } from '../parse/md-parser.mjs';
import { validateLinks } from '../validate/links.mjs';
import { parseHTML } from 'linkedom';

/**
 * 验证迁移等价性
 */
export function verifyMigration(mdDir, htmlDir) {
  const mdDocs = parseMdDir(mdDir);
  const htmlIndex = parseSpecDir(htmlDir);

  const lostReqs = [];
  const addedReqs = [];
  const brokenLinks = [];
  const lostEntities = [];
  const missingFiles = [];

  const mdReqs = new Set();
  for (const doc of mdDocs) {
    for (const req of doc.reqs) mdReqs.add(req.id);
  }

  const htmlReqs = new Set();
  for (const doc of htmlIndex.docs) {
    for (const req of doc.reqs) htmlReqs.add(req.id);
  }

  for (const req of mdReqs) {
    if (!htmlReqs.has(req)) lostReqs.push(req);
  }
  for (const req of htmlReqs) {
    if (!mdReqs.has(req)) addedReqs.push(req);
  }

  for (const doc of mdDocs) {
    const htmlPath = join(htmlDir, `${doc.fileName}.html`);
    if (!existsSync(htmlPath)) missingFiles.push(doc.fileName);
  }

  const linkResult = validateLinks(htmlIndex);
  for (const err of linkResult.errors) {
    if (err.message.includes('Broken link')) {
      brokenLinks.push({ source: err.file, target: err.message });
    }
  }

  const passed = lostReqs.length === 0 && missingFiles.length === 0 && brokenLinks.length === 0;

  return {
    passed,
    lostReqs,
    addedReqs,
    brokenLinks,
    lostEntities,
    missingFiles,
    summary: `${mdReqs.size} REQs in MD, ${htmlReqs.size} in HTML. ${lostReqs.length} lost, ${addedReqs.length} added. ${brokenLinks.length} broken links.`,
  };
}

/**
 * 单文件验证
 */
export function verifySingleFile(mdDoc, htmlContent, context) {
  const { document } = parseHTML(htmlContent);

  const lostIds = [];
  const addedIds = [];
  const brokenXrefs = [];

  const mdReqIds = new Set(mdDoc.reqs.map(r => r.id));
  const htmlReqEls = document.querySelectorAll('[data-req]');
  const htmlReqIds = new Set();
  for (const el of htmlReqEls) {
    htmlReqIds.add(el.getAttribute('data-req'));
  }

  for (const id of mdReqIds) {
    if (!htmlReqIds.has(id)) lostIds.push(id);
  }

  const xrefEls = document.querySelectorAll('[data-xref-id]');
  for (const el of xrefEls) {
    const xrefId = el.getAttribute('data-xref-id');
    if (context.index && !context.index.idMap?.has(xrefId) && !context.index.reqMap?.has(xrefId)) {
      brokenXrefs.push(xrefId);
    }
  }

  return {
    passed: lostIds.length === 0 && brokenXrefs.length === 0,
    lostIds,
    addedIds,
    brokenXrefs,
  };
}

export function run(args) {
  const mdDir = args[0];
  const htmlDir = args[1] || mdDir;
  const result = verifyMigration(mdDir, htmlDir);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
