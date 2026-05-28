import MarkdownIt from 'markdown-it';
import { extractReqIdsFromText as extractReqIdsFromSchemas } from './schemas.mjs';

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

export function createMdParser() {
  return new MarkdownIt({ html: true, linkify: true, typographer: false });
}

export function renderInline(text) {
  return md.renderInline(text);
}

export function parseMdDocument(raw) {
  const tokens = md.parse(raw, {});
  const rawLines = raw.split('\n');
  const sections = [];
  const tables = [];
  const links = [];
  const codeBlocks = [];
  const reqs = [];

  let currentTableRows = null;
  let tableStartLine = 0;
  let currentSection = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lineNum = token.map ? token.map[0] : 0;
    const lineEnd = token.map ? token.map[1] : lineNum;

    if (token.type === 'heading_open') {
      const level = parseInt(token.tag.slice(1), 10);
      const next = tokens[i + 1];
      if (next && next.type === 'inline') {
        const text = next.content;
        currentSection = { level, text, raw: `${'#'.repeat(level)} ${text}`, content: [], tables: [], links: [], codeBlocks: [] };
        sections.push(currentSection);

        const reqMatches = text.match(/\bREQ-[A-Z]+(?:-[A-Z]+)*-\d+/g);
        if (reqMatches) {
          for (const r of reqMatches) {
            const parts = r.match(/^REQ-([A-Z]+(?:-[A-Z]+)?)-(\d+)$/);
            if (parts) reqs.push({ id: r, domain: parts[1], number: parseInt(parts[2], 10) });
          }
        }
      }
      i++;
      continue;
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const block = {
        lang: token.info || '',
        startLine: token.map ? token.map[0] : lineNum,
        content: token.content,
      };
      codeBlocks.push(block);
      if (currentSection) currentSection.codeBlocks.push(block);
      // Add raw lines to section content (skip code block markers)
      if (token.map && currentSection) {
        for (let l = token.map[0]; l < token.map[1]; l++) {
          if (rawLines[l]) currentSection.content.push(rawLines[l]);
        }
      }
      continue;
    }

    if (token.type === 'table_open') {
      currentTableRows = [];
      tableStartLine = token.map ? token.map[0] : lineNum;
      continue;
    }

    if (token.type === 'table_close' && currentTableRows) {
      const tbl = {
        startLine: tableStartLine,
        endLine: token.map ? token.map[1] : lineNum,
        rows: currentTableRows,
      };
      tables.push(tbl);
      if (currentSection) currentSection.tables.push(tbl);
      currentTableRows = null;
      continue;
    }

    if (currentTableRows && token.type === 'inline') {
      const row = extractTableCells(token);
      if (row.length > 0) currentTableRows.push(row);
      continue;
    }

    if (token.type === 'inline') {
      extractLinks(token, links);
      if (currentSection) {
        // Add original source lines for this inline token
        if (token.map) {
          for (let l = token.map[0]; l < token.map[1]; l++) {
            if (rawLines[l]) currentSection.content.push(rawLines[l]);
          }
        }
      }
    }

    // paragraph_close: add paragraph source lines to section
    if (token.type === 'paragraph_close' && currentSection && token.map) {
      // lines already added via inline tokens above
    }
  }

  return { sections, tables, links, codeBlocks, reqs };
}

function extractTableCells(inlineToken) {
  const cells = [];
  for (const child of inlineToken.children) {
    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'softbreak') {
      cells.push(child.content);
    }
  }
  return cells;
}

function extractLinks(inlineToken, links) {
  for (const child of inlineToken.children) {
    if (child.type === 'link_open' && child.attrGet) {
      const href = child.attrGet('href');
      let text = '';
      const openIdx = inlineToken.children.indexOf(child);
      for (let j = openIdx + 1; j < inlineToken.children.length; j++) {
        const sibling = inlineToken.children[j];
        if (sibling.type === 'link_close') break;
        text += sibling.content || '';
      }
      if (href) links.push({ text, href });
    }
  }
}

export { extractReqIdsFromSchemas as extractReqIdsFromText };
