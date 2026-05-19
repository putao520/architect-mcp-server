import { existsSync, readFileSync } from 'fs';
import { resolve, extname } from 'path';

let tsParsers = null;
const GRAMMAR_DIR = resolve(`${import.meta.dirname}`, 'grammars');

const LANG_MAP = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.rs': 'rust', '.py': 'python', '.go': 'go',
  '.java': 'java', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.ts': 'typescript', '.tsx': 'typescript',
};

const MAX_DEPTH = 100;

export async function initTreeSitter() {
  if (tsParsers) return;
  try {
    const Parser = (await import('web-tree-sitter')).default;
    await Parser.init();
    tsParsers = { Parser, languages: {} };
  } catch { tsParsers = null; }
}

async function getParser(ext) {
  if (!tsParsers) return null;
  const langName = LANG_MAP[ext];
  if (!langName) return null;
  if (tsParsers.languages[langName]) return tsParsers.languages[langName];
  const wasmPath = resolve(GRAMMAR_DIR, `tree-sitter-${langName}.wasm`);
  if (!existsSync(wasmPath)) return null;
  try {
    const lang = await tsParsers.Parser.Language.load(wasmPath);
    tsParsers.languages[langName] = lang;
    return lang;
  } catch { return null; }
}

function extractMdStructure(content) {
  const sections = [];
  const reqIds = [];
  const codeBlocks = [];
  const tables = [];

  const lines = content.split('\n');
  let inCodeBlock = false;
  let inTable = false;
  let codeBlockLang = '';
  let codeBlockStart = 0;
  let tableRows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      if (inTable) { tables.push({ start: i - tableRows.length, rows: tableRows }); tableRows = []; inTable = false; }
      sections.push({ level: heading[1].length, title: heading[2], line: i + 1 });
      continue;
    }

    const req = line.match(/\bREQ[-_](\d+(?:\.\d+)*)\b/);
    if (req) reqIds.push({ id: `REQ-${req[1]}`, line: i + 1, text: line.trim() });

    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockStart = i + 1;
      } else {
        codeBlocks.push({ lang: codeBlockLang || 'text', start: codeBlockStart, end: i + 1 });
        inCodeBlock = false;
      }
      continue;
    }

    if (line.includes('|') && line.trim().startsWith('|')) {
      if (!inTable) { inTable = true; tableRows = []; }
      tableRows.push(line);
    } else if (inTable) {
      tables.push({ start: i - tableRows.length + 1, rows: tableRows });
      tableRows = [];
      inTable = false;
    }
  }
  if (inTable && tableRows.length) tables.push({ start: lines.length - tableRows.length + 1, rows: tableRows });

  return { sections, reqIds, codeBlocks, tables };
}

function countNodes(node, depth = 0) {
  if (depth > MAX_DEPTH) return 0;
  let count = 0;
  for (let i = 0; i < node.childCount; i++) count += countNodes(node.child(i), depth + 1);
  return 1 + count;
}

function walkTree(node, fn, depth = 0) {
  if (depth > MAX_DEPTH) return;
  fn(node);
  for (let i = 0; i < node.childCount; i++) walkTree(node.child(i), fn, depth + 1);
}

function isFunctionNode(node) {
  const t = node.type;
  return t === 'function_declaration' || t === 'function_item' || t === 'function_definition'
    || t === 'method_declaration' || t === 'arrow_function' || t === 'generator_function_declaration';
}

function isTypeNode(node) {
  const t = node.type;
  return t === 'interface_declaration' || t === 'type_alias_declaration' || t === 'struct_item'
    || t === 'enum_declaration' || t === 'class_declaration' || t === 'type_definition';
}

function isImportNode(node) {
  const t = node.type;
  return t === 'import_statement' || t === 'import_declaration' || t === 'use_declaration'
    || t === 'extern_crate_item' || t === 'include_directive';
}

function getNodeName(node, content) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier' || child.type === 'name' || child.type === 'type_identifier') {
      return content.slice(child.startIndex, child.endIndex);
    }
  }
  return '';
}

function parseSourceFile(filePath, ext, content) {
  const functions = [];
  const types = [];
  const imports = [];
  for (const line of content.split('\n')) {
    const fn = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|fn|def|pub\s+fn|pub\s+async\s+fn)\s+(\w+)/);
    if (fn) functions.push(fn[1]);

    const tp = line.match(/^\s*(?:export\s+)?(?:interface|type|struct|enum|class)\s+(\w+)/);
    if (tp) types.push(tp[1]);

    const imp = line.match(/^\s*(?:import|use|#include|require)\s+.*?(\w+)/);
    if (imp) imports.push(imp[1]);
  }
  return { type: 'source', ext, functions, types, imports };
}

export async function parseFileStructure(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf8');

  if (ext === '.md') {
    const lang = await getParser(ext);
    if (lang && tsParsers) {
      const parser = new tsParsers.Parser();
      try {
        parser.setLanguage(lang);
        const tree = parser.parse(content);
        try {
          return { type: 'markdown', ...extractMdStructure(content), astNodeCount: countNodes(tree.rootNode) };
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    }
    return { type: 'markdown', ...extractMdStructure(content) };
  }

  const lang = await getParser(ext);
  if (lang && tsParsers) {
    const parser = new tsParsers.Parser();
    try {
      parser.setLanguage(lang);
      const tree = parser.parse(content);
      try {
        const functions = [];
        const types = [];
        const imports = [];
        walkTree(tree.rootNode, (node) => {
          if (isFunctionNode(node)) functions.push({ name: getNodeName(node, content), line: node.startPosition.row + 1 });
          if (isTypeNode(node)) types.push({ name: getNodeName(node, content), line: node.startPosition.row + 1 });
          if (isImportNode(node)) imports.push({ text: node.text.slice(0, 80), line: node.startPosition.row + 1 });
        });
        return { type: 'source', ext, functions, types, imports };
      } finally {
        tree.delete();
      }
    } catch { /* fallback */ } finally {
      try { parser.delete(); } catch { /* already deleted */ }
    }
  }

  return parseSourceFile(filePath, ext, content);
}

export async function buildStructuredContext(files) {
  if (!files?.length) return '';
  const parts = [];
  for (const f of files) {
    const resolved = resolve(f);
    const parsed = await parseFileStructure(resolved);
    if (parsed) parts.push(`File: ${resolved}\n${JSON.stringify(parsed, null, 2)}`);
  }
  return parts.length ? `\n\nStructured file context:\n${parts.join('\n\n')}` : '';
}
