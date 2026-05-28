import { Parser, Language } from 'web-tree-sitter';
import { extname, dirname, join } from 'path';
import { fileURLToPath } from 'url';

let parserReady = false;
const languages = new Map();

const GRAMMARS = {
  '.rs':   { pkg: 'tree-sitter-rust',       lang: 'rust' },
  '.ts':   { pkg: 'tree-sitter-typescript',  lang: 'typescript', wasm: 'tree-sitter-typescript.wasm' },
  '.tsx':  { pkg: 'tree-sitter-typescript',  lang: 'tsx',        wasm: 'tree-sitter-tsx.wasm' },
  '.js':   { pkg: 'tree-sitter-javascript',  lang: 'javascript' },
  '.jsx':  { pkg: 'tree-sitter-javascript',  lang: 'javascript' },
  '.mjs':  { pkg: 'tree-sitter-javascript',  lang: 'javascript' },
  '.go':   { pkg: 'tree-sitter-go',          lang: 'go' },
  '.py':   { pkg: 'tree-sitter-python',      lang: 'python' },
  '.java': { pkg: 'tree-sitter-java',        lang: 'java' },
  '.c':    { pkg: 'tree-sitter-c',           lang: 'c' },
  '.h':    { pkg: 'tree-sitter-c',           lang: 'c' },
  '.cpp':  { pkg: 'tree-sitter-cpp',         lang: 'cpp' },
  '.hpp':  { pkg: 'tree-sitter-cpp',         lang: 'cpp' },
  '.md':   { pkg: '__grammars__',            lang: 'markdown',        wasm: 'tree-sitter-markdown.wasm',        inlineWasm: 'tree-sitter-markdown-inline.wasm' },
  '.html': { pkg: 'tree-sitter-html',        lang: 'html' },
};

const GRAMMARS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars');

function wasmPath(pkgName, wasmName) {
  if (pkgName === '__grammars__') return join(GRAMMARS_DIR, wasmName);
  const base = fileURLToPath(import.meta.resolve(pkgName + '/package.json'));
  return join(dirname(base), wasmName || `${pkgName}.wasm`);
}

export async function initTreeSitter() {
  if (parserReady) return;
  await Parser.init();
  parserReady = true;
}

export async function getParser(filePath) {
  const ext = extname(filePath);
  const grammar = GRAMMARS[ext];
  if (!grammar) return null;

  if (!languages.has(ext)) {
    await initTreeSitter();
    const wp = wasmPath(grammar.pkg, grammar.wasm);
    const lang = await Language.load(wp);
    languages.set(ext, lang);
  }

  const parser = new Parser();
  parser.setLanguage(languages.get(ext));
  return parser;
}

export function isTreeSitterSupported(filePath) {
  return GRAMMARS.hasOwnProperty(extname(filePath));
}

// ============================================================
// CST 查询 API — 确定性语法分析
// ============================================================

export class CSTQuery {
  constructor(tree, source) {
    this.rootNode = tree.rootNode;
    this.source = source;
  }

  walk() {
    return this.rootNode.walk();
  }

  // 按类型查询所有后代节点
  findAll(type) {
    const results = [];
    const cursor = this.rootNode.walk();
    const visit = () => {
      if (cursor.nodeType === type) results.push(cursor.currentNode);
      if (cursor.gotoFirstChild()) {
        do { visit(); } while (cursor.gotoNextSibling());
        cursor.gotoParent();
      }
    };
    visit();
    return results;
  }

  // 按 S-expression 查询
  query(pattern) {
    const lang = this.rootNode.tree.language;
    const q = lang.query(pattern);
    const matches = q.matches(this.rootNode);
    q.delete();
    return matches;
  }

  // 提取所有 import/use 语句（跨语言）
  extractImports() {
    const ext = this._detectExt();
    switch (ext) {
      case '.rs': return this._extractRustUses();
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': return this._extractJSImports();
      case '.go': return this._extractGoImports();
      case '.py': return this._extractPyImports();
      case '.java': return this._extractJavaImports();
      case '.c': case '.h': case '.cpp': case '.hpp': return this._extractCIncludes();
      case '.md': return this._extractMdLinks();
      case '.html': return this._extractHtmlLinks();
      default: return [];
    }
  }

  // 提取所有 export 声明（跨语言）
  extractExports() {
    const ext = this._detectExt();
    switch (ext) {
      case '.rs': return this._extractRustExports();
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': return this._extractJSExports();
      case '.go': return this._extractGoExports();
      case '.py': return this._extractPyExports();
      case '.java': return this._extractJavaExports();
      case '.md': return this._extractMdHeadings();
      case '.html': return this._extractHtmlIds();
      default: return [];
    }
  }

  // 提取函数签名范围
  extractFunctionSignatures() {
    const ext = this._detectExt();
    switch (ext) {
      case '.rs': return this._extractRustFnSigs();
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': return this._extractJSFnSigs();
      case '.go': return this._extractGoFnSigs();
      case '.py': return this._extractPyFnSigs();
      case '.java': return this._extractJavaFnSigs();
      case '.c': case '.h': case '.cpp': case '.hpp': return this._extractCFnSigs();
      case '.md': return this._extractMdCodeBlocks();
      case '.html': return this._extractHtmlEventHandlers();
      default: return [];
    }
  }

  // 提取类/结构体定义
  extractClassDefinitions() {
    const ext = this._detectExt();
    switch (ext) {
      case '.rs': return this._extractRustStructs();
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': return this._extractJSClasses();
      case '.go': return this._extractGoStructs();
      case '.py': return this._extractPyClasses();
      case '.java': return this._extractJavaClasses();
      case '.md': return this._extractMdSections();
      case '.html': return this._extractHtmlSemanticBlocks();
      default: return [];
    }
  }

  // 提取可见性修饰符
  extractVisibility(node) {
    const ext = this._detectExt();
    switch (ext) {
      case '.rs': {
        // Rust grammar: visibility_modifier 是第一个子节点（非 FIELD），不能用 childForFieldName
        const firstChild = node.child(0);
        if (firstChild && firstChild.type === 'visibility_modifier') return firstChild.text;
        return 'private'; // Rust 默认私有
      }
      case '.go': {
        const name = node.childForFieldName('name');
        if (name && name.text[0] === name.text[0].toUpperCase() && name.text[0] !== '_') return 'public';
        return 'private';
      }
      case '.py': {
        const name = node.childForFieldName('name');
        if (name && name.text.startsWith('__') && name.text.endsWith('__')) return 'dunder';
        if (name && name.text.startsWith('_')) return 'protected';
        return 'public';
      }
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': {
        const text = node.text;
        if (/\bprivate\b/.test(text)) return 'private';
        if (/\bprotected\b/.test(text)) return 'protected';
        if (/#\w/.test(text)) return 'private';
        return 'public';
      }
      case '.java': {
        const modifiers = node.childForFieldName('modifiers');
        if (modifiers) {
          const t = modifiers.text;
          if (/\bprivate\b/.test(t)) return 'private';
          if (/\bprotected\b/.test(t)) return 'protected';
        }
        return 'public'; // Java 默认 package-private
      }
      default: return 'unknown';
    }
  }

  // 提取函数参数列表
  extractParams(fnNode) {
    const params = fnNode.childForFieldName('parameters');
    if (!params) return [];
    const result = [];
    for (let i = 0; i < params.childCount; i++) {
      const child = params.child(i);
      if (child.isNamed) {
        result.push({
          text: child.text,
          name: child.childForFieldName('name')?.text || child.text,
          type: child.childForFieldName('type')?.text || null,
          range: { start: child.startPosition, end: child.endPosition },
        });
      }
    }
    return result;
  }

  // 提取函数体范围（不含签名）
  extractBodyRange(fnNode) {
    const body = fnNode.childForFieldName('body');
    if (body) {
      return {
        start: { row: body.startPosition.row, column: body.startPosition.column },
        end: { row: body.endPosition.row, column: body.endPosition.column },
        text: this.source.substring(body.startIndex, body.endIndex),
      };
    }
    return null;
  }

  // 在指定行范围内查找自由变量
  findFreeVariables(startLine, endLine) {
    const used = new Set();
    const declared = new Set();

    const declTypes = [
      'let_declaration', 'let_expression', 'const_declaration', 'static_declaration',
      'variable_declarator', 'lexical_declaration', 'variable_declaration',
      'short_var_declaration', 'var_declaration', 'var_spec',
      'assignment', 'augmented_assignment',
      'parameter', 'for_statement',
    ];
    const identTypes = ['identifier', 'type_identifier', 'field_identifier', 'shorthand_field_identifier'];

    const visit = (node) => {
      const row = node.startPosition.row;

      // 范围内的节点才收集声明和引用
      if (row >= startLine && row <= endLine) {
        if (declTypes.includes(node.type)) {
          const name = node.childForFieldName('name');
          if (name) declared.add(name.text);
        }
        if (identTypes.includes(node.type) && !node.parent?.type.endsWith('declaration')) {
          used.add(node.text);
        }
      }

      // 总是递归子节点（父节点可能在范围外，子节点可能在范围内）
      for (let i = 0; i < node.childCount; i++) visit(node.child(i));
    };

    visit(this.rootNode);
    return [...used].filter(v => !declared.has(v));
  }

  // ---- 语言特定 import 提取 ----

  _extractRustUses() {
    const nodes = this.findAll('use_declaration');
    return nodes.map(n => ({
      text: n.text,
      path: n.childForFieldName('argument')?.text || n.text,
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractJSImports() {
    const nodes = this.findAll('import_statement');
    return nodes.map(n => ({
      text: n.text,
      path: n.childForFieldName('source')?.text?.replace(/['"]/g, '') || '',
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractGoImports() {
    const nodes = this.findAll('import_declaration');
    return nodes.flatMap(n => {
      const specs = n.childForFieldName('imports') || n;
      const result = [];
      for (let i = 0; i < specs.childCount; i++) {
        const child = specs.child(i);
        if (child.type === 'import_spec' || child.type === 'import_spec_list') {
          const path = child.childForFieldName('path')?.text?.replace(/"/g, '') || '';
          if (path) result.push({ text: child.text, path, range: { start: child.startPosition, end: child.endPosition } });
        }
      }
      return result.length ? result : [{ text: n.text, path: n.text.replace(/.*"([^"]+)".*/, '$1'), range: { start: n.startPosition, end: n.endPosition } }];
    });
  }

  _extractPyImports() {
    const imports = this.findAll('import_statement');
    const fromImports = this.findAll('import_from_statement');
    const result = imports.map(n => ({
      text: n.text,
      path: n.childForFieldName('name')?.text || n.text,
      range: { start: n.startPosition, end: n.endPosition },
    }));
    result.push(...fromImports.map(n => ({
      text: n.text,
      path: n.childForFieldName('module_name')?.text || n.text,
      range: { start: n.startPosition, end: n.endPosition },
    })));
    return result;
  }

  _extractJavaImports() {
    const nodes = this.findAll('import_declaration');
    return nodes.map(n => ({
      text: n.text,
      path: n.childForFieldName('name')?.text || '',
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractCIncludes() {
    const nodes = this.findAll('preproc_include');
    return nodes.map(n => ({
      text: n.text,
      path: n.childForFieldName('path')?.text?.replace(/[<>"\n]/g, '') || '',
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  // ---- 语言特定 export 提取 ----

  _extractRustExports() {
    const items = [];
    // pub fn, pub struct, pub enum, pub trait, pub const, pub static, pub mod
    const pubItems = this.findAll('visibility_modifier');
    for (const vis of pubItems) {
      const parent = vis.parent;
      if (parent) {
        items.push({
          text: parent.text.split('\n')[0],
          name: parent.childForFieldName('name')?.text || '',
          visibility: vis.text,
          range: { start: parent.startPosition, end: parent.endPosition },
        });
      }
    }
    return items;
  }

  _extractJSExports() {
    const items = [];
    const exports = this.findAll('export_statement');
    for (const n of exports) {
      const decl = n.childForFieldName('declaration');
      items.push({
        text: n.text.split('\n')[0],
        name: decl?.childForFieldName('name')?.text || '',
        range: { start: n.startPosition, end: n.endPosition },
      });
    }
    return items;
  }

  _extractGoExports() {
    // Go: 大写首字母 = 导出
    const items = [];
    const funcDecls = this.findAll('function_declaration');
    const methodDecls = this.findAll('method_declaration');
    const typeDecls = this.findAll('type_declaration');
    for (const n of [...funcDecls, ...methodDecls, ...typeDecls]) {
      const name = n.childForFieldName('name')?.text || '';
      if (name && name[0] === name[0].toUpperCase() && name[0] !== '_') {
        items.push({ text: n.text.split('\n')[0], name, visibility: 'exported', range: { start: n.startPosition, end: n.endPosition } });
      }
    }
    return items;
  }

  _extractPyExports() {
    // Python: __all__ 或无下划线前缀
    const items = [];
    const assignments = this.findAll('assignment');
    for (const a of assignments) {
      const left = a.childForFieldName('left');
      if (left?.text === '__all__') {
        const right = a.childForFieldName('right');
        if (right) {
          items.push({ text: a.text.split('\n')[0], name: '__all__', range: { start: a.startPosition, end: a.endPosition } });
        }
      }
    }
    return items;
  }

  _extractJavaExports() {
    // Java: public 类/方法
    const items = [];
    const classes = this.findAll('class_declaration');
    const methods = this.findAll('method_declaration');
    for (const n of [...classes, ...methods]) {
      const mods = n.childForFieldName('modifiers');
      if (mods && /\bpublic\b/.test(mods.text)) {
        items.push({ text: n.text.split('\n')[0], name: n.childForFieldName('name')?.text || '', visibility: 'public', range: { start: n.startPosition, end: n.endPosition } });
      }
    }
    return items;
  }

  // ---- 语言特定函数签名提取 ----

  _extractRustFnSigs() {
    return this.findAll('function_item').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      params: this.extractParams(n),
      returnType: n.childForFieldName('return_type')?.text || null,
      visibility: this.extractVisibility(n),
      bodyRange: this.extractBodyRange(n),
      signatureRange: { start: n.startPosition, end: n.childForFieldName('body')?.startPosition || n.endPosition },
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractJSFnSigs() {
    const fns = [...this.findAll('function_declaration'), ...this.findAll('arrow_function'), ...this.findAll('method_definition')];
    return fns.map(n => ({
      name: n.childForFieldName('name')?.text || '',
      params: this.extractParams(n),
      returnType: null,
      visibility: this.extractVisibility(n),
      bodyRange: this.extractBodyRange(n),
      signatureRange: { start: n.startPosition, end: n.childForFieldName('body')?.startPosition || n.endPosition },
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractGoFnSigs() {
    return [...this.findAll('function_declaration'), ...this.findAll('method_declaration')].map(n => ({
      name: n.childForFieldName('name')?.text || '',
      params: this.extractParams(n),
      returnType: n.childForFieldName('result')?.text || null,
      visibility: this.extractVisibility(n),
      bodyRange: this.extractBodyRange(n),
      signatureRange: { start: n.startPosition, end: n.childForFieldName('body')?.startPosition || n.endPosition },
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractPyFnSigs() {
    return this.findAll('function_definition').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      params: this.extractParams(n),
      returnType: n.childForFieldName('return_type')?.text || null,
      visibility: this.extractVisibility(n),
      bodyRange: this.extractBodyRange(n),
      signatureRange: { start: n.startPosition, end: n.childForFieldName('body')?.startPosition || n.endPosition },
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractJavaFnSigs() {
    return this.findAll('method_declaration').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      params: this.extractParams(n),
      returnType: n.childForFieldName('type')?.text || null,
      visibility: this.extractVisibility(n),
      bodyRange: this.extractBodyRange(n),
      signatureRange: { start: n.startPosition, end: n.childForFieldName('body')?.startPosition || n.endPosition },
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  _extractCFnSigs() {
    return this.findAll('function_definition').map(n => ({
      name: n.childForFieldName('declarator')?.text || '',
      params: this.extractParams(n),
      returnType: n.childForFieldName('type')?.text || null,
      visibility: 'public',
      bodyRange: this.extractBodyRange(n),
      signatureRange: { start: n.startPosition, end: n.childForFieldName('body')?.startPosition || n.endPosition },
      range: { start: n.startPosition, end: n.endPosition },
    }));
  }

  // ---- 语言特定类/结构体提取 ----

  _extractRustStructs() {
    return this.findAll('struct_item').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      visibility: this.extractVisibility(n),
      range: { start: n.startPosition, end: n.endPosition },
      members: this._extractRustStructMembers(n),
    }));
  }

  _extractRustStructMembers(structNode) {
    const members = [];
    const body = structNode.childForFieldName('body');
    if (!body) return members;
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.type === 'field_declaration') {
        const vis = child.childForFieldName('visibility');
        members.push({
          name: child.childForFieldName('name')?.text || '',
          type: child.childForFieldName('type')?.text || '',
          visibility: vis?.text || 'private',
          range: { start: child.startPosition, end: child.endPosition },
        });
      }
    }
    return members;
  }

  _extractJSClasses() {
    return this.findAll('class_declaration').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      visibility: this.extractVisibility(n),
      range: { start: n.startPosition, end: n.endPosition },
      members: this._extractJSClassMembers(n),
    }));
  }

  _extractJSClassMembers(classNode) {
    const members = [];
    const body = classNode.childForFieldName('body');
    if (!body) return members;
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.isNamed) {
        members.push({
          name: child.childForFieldName('name')?.text || child.text.split('(')[0],
          kind: child.type,
          visibility: this.extractVisibility(child),
          range: { start: child.startPosition, end: child.endPosition },
        });
      }
    }
    return members;
  }

  _extractGoStructs() {
    return this.findAll('type_declaration').map(n => {
      const typeNode = n.childForFieldName('type');
      return {
        name: typeNode?.childForFieldName('name')?.text || '',
        visibility: this.extractVisibility(n),
        range: { start: n.startPosition, end: n.endPosition },
        members: [],
      };
    }).filter(n => n.name);
  }

  _extractPyClasses() {
    return this.findAll('class_definition').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      visibility: this.extractVisibility(n),
      range: { start: n.startPosition, end: n.endPosition },
      members: [],
    }));
  }

  _extractJavaClasses() {
    return this.findAll('class_declaration').map(n => ({
      name: n.childForFieldName('name')?.text || '',
      visibility: this.extractVisibility(n),
      range: { start: n.startPosition, end: n.endPosition },
      members: [],
    }));
  }

  _detectExt() {
    return this._ext || '';
  }

  // ---- Markdown 特定提取 ----

  _extractMdLinks() {
    const results = [];
    // 引用式链接定义：[ref]: url（块级，Tree-sitter 可解析）
    const linkRefs = this.findAll('link_reference_definition');
    for (const n of linkRefs) {
      const dest = n.childForFieldName('destination');
      results.push({
        text: n.text,
        path: dest?.text?.replace(/[<>]/g, '') || '',
        kind: 'reference_definition',
        range: { start: n.startPosition, end: n.endPosition },
      });
    }
    // 行内链接：[text](url) 和 ![alt](url)（inline 级，需从段落文本提取）
    const paragraphs = this.findAll('paragraph');
    for (const p of paragraphs) {
      const text = this.source.substring(p.startIndex, p.endIndex);
      // [text](url) 格式
      const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
      let m;
      while ((m = linkPattern.exec(text)) !== null) {
        const offset = p.startIndex + m.index;
        const line = this.source.substring(0, offset).split('\n').length - 1;
        results.push({
          text: m[0],
          path: m[2],
          name: m[1],
          kind: 'inline_link',
          range: { start: { row: line, column: 0 }, end: { row: line, column: m[0].length } },
        });
      }
      // ![alt](url) 图片
      const imgPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
      while ((m = imgPattern.exec(text)) !== null) {
        const offset = p.startIndex + m.index;
        const line = this.source.substring(0, offset).split('\n').length - 1;
        results.push({
          text: m[0],
          path: m[2],
          name: m[1],
          kind: 'image',
          range: { start: { row: line, column: 0 }, end: { row: line, column: m[0].length } },
        });
      }
    }
    return results;
  }

  _extractMdHeadings() {
    const results = [];
    const headings = this.findAll('atx_heading');
    for (const n of headings) {
      const level = n.child(0)?.text?.length || 1; // ### = level 3
      results.push({
        text: n.text.trim(),
        name: n.text.replace(/^#+\s+/, '').trim(),
        level,
        range: { start: n.startPosition, end: n.endPosition },
      });
    }
    return results;
  }

  // 提取 MD 文档结构（标题层级 + 代码块 + 链接 + 表格）
  extractMdStructure() {
    const structure = { headings: [], codeBlocks: [], links: [], tables: [] };
    const headings = this.findAll('atx_heading');
    for (const n of headings) {
      structure.headings.push({
        text: n.text.replace(/^#+\s+/, '').trim(),
        level: n.child(0)?.text?.length || 1,
        range: { start: n.startPosition, end: n.endPosition },
      });
    }
    const fenced = this.findAll('fenced_code_block');
    for (const n of fenced) {
      const info = n.childForFieldName('info_string')?.text || '';
      structure.codeBlocks.push({
        language: info,
        range: { start: n.startPosition, end: n.endPosition },
      });
    }
    structure.links = this._extractMdLinks();
    const tables = this.findAll('pipe_table');
    for (const n of tables) {
      structure.tables.push({
        range: { start: n.startPosition, end: n.endPosition },
        rows: n.childCount,
      });
    }
    return structure;
  }

  // ---- HTML 特定提取 ----

  _extractHtmlLinks() {
    const results = [];
    const linkTags = new Set(['a', 'link', 'script', 'img', 'source', 'iframe']);
    const elements = this.findAll('element');
    for (const el of elements) {
      const tagName = this._getHtmlTagName(el);
      if (!linkTags.has(tagName)) continue;
      const startTag = el.child(0);
      if (!startTag) continue;
      const attrs = this._extractHtmlAttrs(startTag);
      const href = attrs.href || attrs.src;
      if (href) {
        results.push({
          text: el.text.split('\n')[0].substring(0, 80),
          path: href,
          tag: tagName,
          range: { start: el.startPosition, end: el.endPosition },
        });
      }
    }
    return results;
  }

  _extractHtmlIds() {
    const results = [];
    const elements = this.findAll('element');
    for (const el of elements) {
      const startTag = el.child(0);
      if (!startTag) continue;
      const attrs = this._extractHtmlAttrs(startTag);
      if (attrs.id) {
        results.push({
          text: el.text.split('\n')[0].substring(0, 80),
          name: attrs.id,
          tag: this._getHtmlTagName(el),
          range: { start: el.startPosition, end: el.endPosition },
        });
      }
      if (attrs.class) {
        results.push({
          text: el.text.split('\n')[0].substring(0, 80),
          name: attrs.class,
          tag: this._getHtmlTagName(el),
          kind: 'class',
          range: { start: el.startPosition, end: el.endPosition },
        });
      }
    }
    return results;
  }

  _getHtmlTagName(elementNode) {
    const startTag = elementNode.child(0);
    if (!startTag) return '';
    // start_tag 的第一个子节点通常是 tag_name
    for (let i = 0; i < startTag.childCount; i++) {
      const c = startTag.child(i);
      if (c.type === 'tag_name') return c.text;
    }
    // fallback: 从文本提取
    const match = startTag.text.match(/^<(\w+)/);
    return match ? match[1] : '';
  }

  _extractHtmlAttrs(startTagNode) {
    const attrs = {};
    for (let i = 0; i < startTagNode.childCount; i++) {
      const c = startTagNode.child(i);
      if (c.type === 'attribute') {
        const name = c.child(0)?.text;
        // child(0)=attribute_name, child(1)="=", child(2)=attribute_value
        const value = c.childCount >= 3 ? c.child(2)?.text?.replace(/^["']|["']$/g, '') : '';
        if (name) attrs[name] = value || '';
      }
    }
    return attrs;
  }

  _extractMdCodeBlocks() {
    const results = [];
    const fenced = this.findAll('fenced_code_block');
    for (const n of fenced) {
      const info = n.childForFieldName('info_string')?.text || '';
      const code = n.childForFieldName('code_fence_content')?.text || '';
      results.push({
        name: info || 'code',
        params: [],
        returnType: null,
        visibility: 'public',
        language: info,
        bodyRange: {
          start: { row: n.startPosition.row, column: n.startPosition.column },
          end: { row: n.endPosition.row, column: n.endPosition.column },
          text: code,
        },
        range: { start: n.startPosition, end: n.endPosition },
      });
    }
    return results;
  }

  _extractMdSections() {
    const results = [];
    const headings = this.findAll('atx_heading');
    for (const n of headings) {
      const level = n.child(0)?.text?.length || 1;
      const name = n.text.replace(/^#+\s+/, '').trim();
      results.push({
        name,
        visibility: 'public',
        level,
        range: { start: n.startPosition, end: n.endPosition },
        members: [],
      });
    }
    return results;
  }

  _extractHtmlEventHandlers() {
    const results = [];
    const elements = this.findAll('element');
    const eventAttrs = ['onclick', 'onload', 'onerror', 'onsubmit', 'onchange', 'oninput', 'onkeydown', 'onmouseover'];
    for (const el of elements) {
      const startTag = el.child(0);
      if (!startTag) continue;
      const attrs = this._extractHtmlAttrs(startTag);
      for (const [key, value] of Object.entries(attrs)) {
        if (eventAttrs.includes(key) || key.startsWith('on')) {
          results.push({
            name: key,
            params: [],
            returnType: null,
            visibility: 'public',
            handler: value,
            tag: this._getHtmlTagName(el),
            range: { start: el.startPosition, end: el.endPosition },
          });
        }
      }
    }
    return results;
  }

  _extractHtmlSemanticBlocks() {
    const results = [];
    const semanticTags = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form', 'dialog'];
    const elements = this.findAll('element');
    for (const el of elements) {
      const tagName = this._getHtmlTagName(el);
      if (semanticTags.includes(tagName)) {
        const startTag = el.child(0);
        const attrs = startTag ? this._extractHtmlAttrs(startTag) : {};
        results.push({
          name: attrs.id || tagName,
          visibility: attrs.id ? 'public' : 'private',
          tag: tagName,
          id: attrs.id || '',
          class: attrs.class || '',
          range: { start: el.startPosition, end: el.endPosition },
          members: [],
        });
      }
    }
    return results;
  }

  // 提取 HTML 文档结构（标签 + id + class + 层级）
  extractHtmlStructure() {
    const structure = { ids: [], classes: [], links: [], scripts: [], styles: [] };
    const elements = this.findAll('element');
    for (const el of elements) {
      const startTag = el.child(0);
      if (!startTag) continue;
      const tagName = this._getHtmlTagName(el);
      const attrs = this._extractHtmlAttrs(startTag);
      if (attrs.id) structure.ids.push({ id: attrs.id, tag: tagName, range: { start: el.startPosition, end: el.endPosition } });
      if (attrs.class) {
        for (const cls of attrs.class.split(/\s+/)) {
          if (cls) structure.classes.push({ class: cls, tag: tagName, range: { start: el.startPosition, end: el.endPosition } });
        }
      }
      if (tagName === 'a' && attrs.href) structure.links.push({ href: attrs.href, text: el.text.replace(/<[^>]+>/g, '').trim(), range: { start: el.startPosition, end: el.endPosition } });
      if (tagName === 'script' && attrs.src) structure.scripts.push({ src: attrs.src, range: { start: el.startPosition, end: el.endPosition } });
      if (tagName === 'link' && attrs.href) structure.styles.push({ href: attrs.href, rel: attrs.rel || '', range: { start: el.startPosition, end: el.endPosition } });
    }
    return structure;
  }
}

// Parse a file with tree-sitter and return CSTQuery
export async function parseFile(filePath, content) {
  const parser = await getParser(filePath);
  if (!parser) return null;
  const tree = parser.parse(content);
  const q = new CSTQuery(tree, content);
  q._ext = extname(filePath);
  return q;
}
