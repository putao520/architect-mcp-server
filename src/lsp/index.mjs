#!/usr/bin/env node
/**
 * LSP MCP Server — CC 原生 MCP 工具（LSP Client）
 *
 * MCP Server 本身就是 LSP Client，通过 Unix socket 直连 per-CWD LSP Daemon
 * 每个 (language, CWD) 对应独立 Daemon 实例，由 MCP Server lazy spawn
 *
 * CC → MCP 协议 → 本文件 (LSP Client) → LSP 协议/Unix Socket → LSP Server Daemon
 */

import { z } from 'zod';
import { connect } from 'net';
import { spawn as childSpawn } from 'child_process';
import { resolve as pathResolve, extname, basename, dirname } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import {
  detectLspServer, fileToUri, uriToPath, findProjectRoot, socketPath,
  parseLspMessages, encodeLspMessage, trimBuffer, CLIENT_CAPABILITIES, LSP_SERVERS,
  buildOpenDocNotification, syncDocument, syncSiblingFiles,
  getFileFingerprint, fingerprintEqual,
  applyWorkspaceEdit, applyTextEdit,
  getDaemonPath, isSocketAlive,
} from './shared.mjs';
import { getTreeProvider, isTreeSupported } from './tree-lsp-provider.mjs';
import { parseFile as tsParseFile } from './tree-sitter-engine.mjs';

// === findProjectRoot 缓存 ===

const projectRootCache = new Map();
const PROJECT_ROOT_CACHE_MAX = 500;

function cachedFindProjectRoot(filePath) {
  const absPath = pathResolve(filePath);
  const dir = absPath.substring(0, absPath.lastIndexOf('/'));
  if (projectRootCache.has(dir)) return projectRootCache.get(dir);
  if (projectRootCache.size >= PROJECT_ROOT_CACHE_MAX) {
    const firstKey = projectRootCache.keys().next().value;
    projectRootCache.delete(firstKey);
  }
  const root = findProjectRoot(filePath);
  projectRootCache.set(dir, root);
  return root;
}

// === LSP Client（通过 Unix Socket 连接 LSP Server Daemon）===

// 将扁平格式 documentSymbol（location + containerName）转换为嵌套格式（range + children）
// typescript-language-server / pyright 返回扁平格式，clangd / rust-analyzer 返回嵌套格式
function normalizeFlatSymbols(flatSymbols) {
  const nodes = flatSymbols.map(s => ({
    name: s.name,
    kind: s.kind,
    range: s.location.range,
    children: [],
    _containerName: s.containerName || null,
  }));
  const root = [];
  const byName = new Map();
  for (const n of nodes) {
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(n);
  }
  for (const n of nodes) {
    if (!n._containerName) { root.push(n); continue; }
    const parents = byName.get(n._containerName);
    if (parents?.length) parents[0].children.push(n);
    else root.push(n);
  }
  function clean(arr) { for (const n of arr) { delete n._containerName; if (!n.children.length) delete n.children; else clean(n.children); } }
  clean(root);
  return root;
}

class LspClient {
  constructor(language, projectRoot) {
    this.language = language;
    this.projectRoot = projectRoot;
    this.sockPath = socketPath(language, projectRoot);
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.serverCapabilities = {};
    this.openedDocs = new Map(); // uri → { version, fingerprint }
    this.initialized = false;
    this.socket = null;
    this._connectPromise = null;
    this.projectFirstOpenDone = new Map(); // projectRoot → boolean（按项目跟踪 sibling sync）
    this.diagnosticCache = new Map(); // uri → Diagnostic[]
    this.notificationHandlers = new Map(); // method → callback
  }

  async connect() {
    // 如果之前的连接失败，清除旧 Promise 允许重试
    if (this._connectPromise && !this.socket) {
      this._connectPromise = null;
    }
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const sock = connect(this.sockPath);
      sock.on('connect', () => {
        this.socket = sock;
        sock.on('data', (chunk) => {
          this.buffer = trimBuffer(Buffer.concat([this.buffer, chunk]));
          const { messages, remaining } = parseLspMessages(this.buffer);
          this.buffer = remaining;
          for (const { msg } of messages) {
            if (msg.id != null && this.pending.has(msg.id)) {
              this.pending.get(msg.id)(msg);
              this.pending.delete(msg.id);
            } else if (msg.method) {
              if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
                this.diagnosticCache.set(msg.params.uri, msg.params.diagnostics || []);
              }
              if (msg.method === 'workspace/applyEdit' && msg.id != null) {
                const r = applyWorkspaceEdit(msg.params.edit || {});
                this.send({ jsonrpc: '2.0', id: msg.id, result: { applied: r.ok, failureReason: r.ok ? undefined : r.text } });
                for (const f of (r.files || [])) {
                  try {
                    const fp = f.path;
                    if (!fp) continue;
                    const uri = fileToUri(fp);
                    const existing = this.openedDocs.get(uri);
                    if (existing) {
                      existing.version++;
                      const content = readFileSync(fp, 'utf8');
                      this.sendNotification('textDocument/didChange', { textDocument: { uri, version: existing.version }, contentChanges: [{ text: content }] });
                    }
                  } catch { }
                }
              }
              const handler = this.notificationHandlers.get(msg.method);
              if (handler) handler(msg.params);
            }
          }
        });
        sock.on('close', () => {
          this.socket = null;
          this._connectPromise = null;
        });
        sock.on('error', () => {
          this.socket = null;
          this._connectPromise = null;
        });
        resolve();
      });
      sock.on('error', (err) => {
        this._connectPromise = null;
        reject(err);
      });
    });
    return this._connectPromise;
  }

  send(req) {
    if (!this.socket) throw new Error('Socket not connected');
    this.socket.write(encodeLspMessage(req));
  }

  sendRequest(method, params, timeout = 900000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method} (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  sendNotification(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async initialize(projectRoot) {
    await this.connect();
    const initParams = {
      processId: null,
      capabilities: CLIENT_CAPABILITIES,
    };
    if (projectRoot) {
      initParams.rootUri = `file://${projectRoot}`;
      initParams.workspaceFolders = [{ uri: `file://${projectRoot}`, name: basename(projectRoot) }];
    }
    const resp = await this.sendRequest('initialize', initParams);
    if (!resp?.result) throw new Error('LSP initialization failed');
    this.serverCapabilities = resp.result.capabilities || {};
    this.sendNotification('initialized', {});
    await new Promise((r) => setTimeout(r, 500));
    this.initialized = true;
  }

  async openDocument(filePath) {
    const absPath = pathResolve(filePath);
    const uri = fileToUri(absPath);
    const fingerprint = getFileFingerprint(absPath);
    const existing = this.openedDocs.get(uri);
    if (existing && fingerprintEqual(existing.fingerprint, fingerprint)) return;

    const { uri: docUri, content, fingerprint: fp, langId } = buildOpenDocNotification(absPath);
    syncDocument(this, docUri, content, fp, langId, this.openedDocs);

    // 文档数过多时 FIFO 驱逐
    if (this.openedDocs.size > 200) {
      const excess = this.openedDocs.size - 150;
      let count = 0;
      for (const key of this.openedDocs.keys()) {
        if (count >= excess) break;
        this.openedDocs.delete(key);
        count++;
      }
    }

    // 按项目做 sibling sync：每个项目首次 open 时同步同目录文件
    const projectRoot = cachedFindProjectRoot(filePath);
    if (!this.projectFirstOpenDone.get(projectRoot)) {
      syncSiblingFiles(this, absPath, this.openedDocs);
      await new Promise((r) => setTimeout(r, 2000));
      this.projectFirstOpenDone.set(projectRoot, true);
    }
  }

  // === 修改类操作 ===

  async rename(filePath, line, character, newName) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/rename', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
      newName,
    });
  }

  async codeAction(filePath, line, character, diagnostics = []) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/codeAction', {
      textDocument: { uri: fileToUri(filePath) },
      range: { start: { line: line - 1, character: character - 1 }, end: { line: line - 1, character: character - 1 } },
      context: { diagnostics, triggerKind: 1 },
    });
  }

  async organizeImports(filePath) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/codeAction', {
      textDocument: { uri: fileToUri(filePath) },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { only: ['source.organizeImports'], triggerKind: 1 },
    });
  }

  async format(filePath) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/formatting', {
      textDocument: { uri: fileToUri(filePath) },
      options: { tabSize: 2, insertSpaces: true },
    });
  }

  async formatRange(filePath, startLine, endLine) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/rangeFormatting', {
      textDocument: { uri: fileToUri(filePath) },
      range: { start: { line: startLine - 1, character: 0 }, end: { line: endLine - 1, character: 0 } },
      options: { tabSize: 2, insertSpaces: true },
    });
  }

  // === 查询类操作 ===

  async references(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/references', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
      context: { includeDeclaration: true },
    });
  }

  async implementations(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/implementation', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
    });
  }

  async typeDefinition(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/typeDefinition', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
    });
  }

  async hover(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/hover', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
    });
  }

  async documentSymbol(filePath) {
    await this.openDocument(filePath);
    const resp = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: fileToUri(filePath) },
    });
    // 统一规范为嵌套格式（range + children），兼容扁平格式（location + containerName）
    if (resp?.result?.length > 0 && resp.result[0].location && !resp.result[0].range) {
      resp.result = normalizeFlatSymbols(resp.result);
    }
    return resp;
  }

  async documentHighlight(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/documentHighlight', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
    });
  }

  async foldingRange(filePath) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/foldingRange', {
      textDocument: { uri: fileToUri(filePath) },
    });
  }

  async prepareRename(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/prepareRename', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
    });
  }

  async diagnostic(filePath) {
    await this.openDocument(filePath);
    const uri = fileToUri(pathResolve(filePath));
    // Try pull diagnostics first
    if (this.serverCapabilities.diagnosticProvider) {
      return this.sendRequest('textDocument/diagnostic', {
        textDocument: { uri },
      }, 60000);
    }
    // Fallback to push diagnostics cache
    const cached = this.diagnosticCache.get(uri);
    if (cached) return { result: { items: cached, kind: 'push' } };
    return { result: { items: [], kind: 'none' } };
  }

  async workspaceSymbol(query) {
    return this.sendRequest('workspace/symbol', { query });
  }

  async prepareCallHierarchy(filePath, line, character) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/prepareCallHierarchy', {
      textDocument: { uri: fileToUri(filePath) },
      position: { line: line - 1, character: character - 1 },
    });
  }

  async incomingCalls(item) {
    return this.sendRequest('callHierarchy/incomingCalls', { item });
  }

  async codeActionRange(filePath, startLine, startCharacter, endLine, endCharacter, diagnostics = []) {
    await this.openDocument(filePath);
    return this.sendRequest('textDocument/codeAction', {
      textDocument: { uri: fileToUri(filePath) },
      range: { start: { line: startLine - 1, character: startCharacter - 1 }, end: { line: endLine - 1, character: endCharacter - 1 } },
      context: { diagnostics, triggerKind: 1 },
    });
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.end(); } catch { }
      this.socket = null;
      this._connectPromise = null;
    }
  }
}

// === LSP Client 池（每个 language:CWD 对应独立 LspClient）===

const clientPool = new Map(); // `${language}:${projectRoot}` → LspClient

async function ensureDaemon(language, projectRoot) {
  const sock = socketPath(language, projectRoot);
  if (await isSocketAlive(sock)) return;

  const daemonPath = getDaemonPath();
  const stderrChunks = [];
  let daemonExited = false;
  let daemonExitCode = null;

  const proc = childSpawn(process.execPath, [daemonPath, language, projectRoot, String(process.pid)], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  proc.stderr.on('data', (chunk) => { stderrChunks.push(chunk); });
  proc.stderr.on('error', () => {});
  proc.on('exit', (code) => { daemonExited = true; daemonExitCode = code; });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isSocketAlive(sock)) return;
    if (daemonExited && daemonExitCode === 2) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
      throw new Error(`Daemon [${language}:${projectRoot}] permanent failure (exit=2). ${stderr}`.trim());
    }
  }
  const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
  throw new Error(`Daemon [${language}:${projectRoot}] failed to start within 15s. ${stderr}`.trim());
}

export async function getOrCreateClient(language, projectRoot) {
  const key = `${language}:${projectRoot}`;
  const existing = clientPool.get(key);
  if (existing?.socket && !existing.socket.destroyed) return existing;

  if (existing) {
    existing.disconnect();
    clientPool.delete(key);
  }

  await ensureDaemon(language, projectRoot);

  const client = new LspClient(language, projectRoot);
  try {
    await client.connect();
  } catch {
    throw new Error(`Cannot connect to LSP Daemon [${language}:${projectRoot}] at ${client.sockPath}. Is the daemon running?`);
  }
  await client.initialize(projectRoot);
  clientPool.set(key, client);
  return client;
}

// === 位置格式化 ===

function formatLocations(locs, label) {
  if (!locs.length) return { content: [{ type: 'text', text: `No ${label} found` }] };
  const lines = locs.map(loc => {
    const fp = uriToPath(loc.uri || '');
    return `${fp}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
  });
  return { content: [{ type: 'text', text: `${locs.length} ${label}:\n${lines.join('\n')}` }] };
}

// === 数据层工具辅助函数 ===

const DATA_FILE_EXTS = new Set(['.yaml', '.yml', '.json', '.json5', '.jsonc', '.toml', '.conf', '.config', '.ini', '.env', '.properties']);
const MAX_DATA_FILE_SIZE = 200 * 1024; // 200KB

function scanDirRecursive(dir, maxDepth = 6, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '__pycache__') continue;
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...scanDirRecursive(fullPath, maxDepth, depth + 1));
      } else if (entry.isFile()) {
        try {
          const stat = statSync(fullPath);
          if (stat.size <= MAX_DATA_FILE_SIZE) results.push(fullPath);
        } catch { }
      }
    }
  } catch { }
  return results;
}

function extractStringsFromContent(content, filePath) {
  const results = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Extract quoted strings (single, double, backtick)
    const stringRegex = /(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`)/g;
    let match;
    while ((match = stringRegex.exec(line)) !== null) {
      const value = match[1] || match[2] || match[3];
      if (value && value.length >= 2 && value.length <= 200 && !/^\s*$/.test(value)) {
        results.push({ value, line: lineNum, col: match.index + 1, context: line.trim() });
      }
    }

    // For YAML/TOML: extract key: value pairs
    const kvMatch = line.match(/^\s*([\w.-]+)\s*[:=]\s*(.+?)\s*$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2].replace(/^["'`]|["'`]$/g, '').trim();
      if (key && val && val.length >= 1 && val.length <= 200) {
        results.push({ key, value: val, line: lineNum, col: 1, context: line.trim() });
      }
    }
  }

  return results;
}

function parseSimpleYamlOrJson(content, ext) {
  if (ext === '.json' || ext === '.json5' || ext === '.jsonc') {
    try {
      // Strip comments for JSONC/JSON5
      const cleaned = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return { parsed: JSON.parse(cleaned), format: 'json' };
    } catch { return { parsed: null, format: 'json' }; }
  }
  // For YAML/TOML/etc: return raw content for AI to interpret
  return { parsed: null, format: ext.replace('.', '') };
}

function topologicalSort(nodes, edges) {
  // nodes: string[], edges: [from, from][]
  const adj = new Map();
  const inDegree = new Map();
  for (const n of nodes) { adj.set(n, []); inDegree.set(n, 0); }
  for (const [from, to] of edges) {
    if (!adj.has(from)) { adj.set(from, []); inDegree.set(from, 0); }
    if (!adj.has(to)) { adj.set(to, []); inDegree.set(to, 0); }
    adj.get(from).push(to);
    inDegree.set(to, (inDegree.get(to) || 0) + 1);
  }

  const queue = [];
  for (const [n, d] of inDegree) { if (d === 0) queue.push(n); }
  const sorted = [];
  while (queue.length) {
    const n = queue.shift();
    sorted.push(n);
    for (const dep of (adj.get(n) || [])) {
      inDegree.set(dep, inDegree.get(dep) - 1);
      if (inDegree.get(dep) === 0) queue.push(dep);
    }
  }

  const cycles = sorted.length < nodes.length
    ? nodes.filter(n => !sorted.includes(n))
    : [];

  return { sorted, cycles };
}

// === dataQuery 独立处理（不需要 LSP）===

function handleDataQuery(params) {
  const { mode = 'scan', path: rootPath, query, extensions, includeCode = false, contextLines = 2, nodes, edges } = params;

  if (mode === 'scan') {
    const exts = extensions ? new Set(extensions) : DATA_FILE_EXTS;
    const allFiles = scanDirRecursive(rootPath);
    const dataFiles = allFiles.filter(f => {
      const ext = '.' + f.split('.').pop();
      return exts.has(ext);
    });
    const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.rb', '.cs']);

    const fileEntries = [];
    for (const fp of dataFiles.slice(0, 100)) {
      try {
        const content = readFileSync(fp, 'utf8');
        const ext = '.' + fp.split('.').pop();
        const strings = extractStringsFromContent(content, fp);
        const { parsed, format } = parseSimpleYamlOrJson(content, ext);
        fileEntries.push({
          file: fp,
          format,
          size: content.length,
          keys: [...new Set(strings.filter(s => s.key).map(s => s.key))].slice(0, 50),
          stringLiterals: strings.filter(s => !s.key).map(s => s.value).slice(0, 30),
          parsed: parsed ? JSON.stringify(parsed) : null,
        });
      } catch { }
    }

    const codeRefs = [];
    if (includeCode) {
      const codeFiles = allFiles.filter(f => codeExts.has('.' + f.split('.').pop())).slice(0, 50);
      for (const fp of codeFiles) {
        try {
          const content = readFileSync(fp, 'utf8');
          const strings = extractStringsFromContent(content, fp);
          const refs = strings.filter(s => !s.key).slice(0, 20);
          if (refs.length) {
            codeRefs.push({ file: fp, references: refs.map(r => ({ value: r.value, line: r.line, context: r.context })) });
          }
        } catch { }
      }
    }

    const summary = [
      `DATA_SCAN: ${dataFiles.length} data files found in ${rootPath}`,
      `Formats: ${[...new Set(fileEntries.map(f => f.format))].join(', ')}`,
      '',
      '=== Data Files ===',
      ...fileEntries.map(f => {
        const keys = f.keys.length ? `  keys: ${f.keys.join(', ')}` : '';
        const strs = f.stringLiterals.length ? `  strings: ${f.stringLiterals.slice(0, 10).join(', ')}` : '';
        const parsedLine = f.parsed ? `  parsed: ${f.parsed.slice(0, 100)}...` : '';
        return `${f.file} (${f.format}, ${f.size}B)\n${keys}\n${strs}\n${parsedLine}`.trim();
      }),
    ];
    if (includeCode && codeRefs.length) {
      summary.push('', '=== Code References to Data ===');
      for (const cr of codeRefs) {
        summary.push(`${cr.file}`);
        for (const r of cr.references) {
          summary.push(`  L${r.line}: "${r.value}"  ← ${r.context}`);
        }
      }
    }
    summary.push('', '=== AI Analysis Prompt ===');
    summary.push('Based on the above data, identify:');
    summary.push('1. Which string literals are reference IDs (e.g., rule names, action types, phase IDs)');
    summary.push('2. Which keys define dependencies between entities (e.g., depends_on, uses, references)');
    summary.push('3. The implicit schema: what fields are required, what values are valid');
    summary.push('4. Cross-references: which code strings reference which data definitions');

    return { content: [{ type: 'text', text: summary.join('\n') }] };
  } else if (mode === 'trace') {
    const allFiles = scanDirRecursive(rootPath);
    const results = [];

    for (const fp of allFiles.slice(0, 200)) {
      try {
        const content = readFileSync(fp, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length, i + contextLines + 1);
            const contextBlock = [];
            for (let j = start; j < end; j++) {
              const marker = j === i ? '>>>' : '   ';
              contextBlock.push(`${marker} ${j + 1}: ${lines[j]}`);
            }
            results.push({ file: fp, line: i + 1, context: contextBlock.join('\n') });
          }
        }
      } catch { }
    }

    const output = [
      `DATA_TRACE: "${query}" found in ${results.length} location(s)`,
      '',
      ...results.map(r => `${r.file}:${r.line}\n${r.context}`).join('\n\n'),
    ];

    if (results.length === 0) {
      output.push('No occurrences found. Try:');
      output.push('1. Use a partial string (e.g., just the ID without prefix)');
      output.push('2. Check if the value is computed/concatenated at runtime');
      output.push('3. Use lsp_workspace_symbol to search by symbol name');
    } else {
      output.push('', '=== AI Analysis Prompt ===');
      output.push('For each occurrence above, determine:');
      output.push('1. Is this a DEFINITION (where the value is created) or a REFERENCE (where it\'s used)?');
      output.push('2. What is the data flow: where does this value come from and where does it go?');
      output.push('3. Are there any orphan references (used but never defined) or dead definitions (defined but never used)?');
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  } else if (mode === 'graph') {
    const nodeArray = nodes || [];
    const edgeArray = edges || [];

    const { sorted, cycles } = topologicalSort(nodeArray, edgeArray);

    const adjDisplay = new Map();
    for (const n of nodeArray) adjDisplay.set(n, []);
    for (const [from, to] of edgeArray) {
      if (!adjDisplay.has(from)) adjDisplay.set(from, []);
      adjDisplay.get(from).push(to);
    }

    const hasIncoming = new Set(edgeArray.map(e => e[1]));
    const hasOutgoing = new Set(edgeArray.map(e => e[0]));
    const roots = nodeArray.filter(n => !hasIncoming.has(n));
    const leaves = nodeArray.filter(n => !hasOutgoing.has(n));

    const output = [
      `DATA_GRAPH: ${nodeArray.length} nodes, ${edgeArray.length} edges`,
      '',
      '=== Topological Order (execution sequence) ===',
      sorted.length ? sorted.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(empty)',
      '',
      '=== Entry Points (roots, no dependencies) ===',
      roots.length ? roots.join(', ') : '(none — possible cycle)',
      '',
      '=== Terminal Nodes (leaves, nothing depends on them) ===',
      leaves.length ? leaves.join(', ') : '(none)',
      '',
      '=== Dependency Map ===',
      ...[...adjDisplay.entries()].map(([n, deps]) => {
        if (deps.length === 0) return `${n} → (no dependencies)`;
        return `${n} → ${deps.join(', ')}`;
      }),
    ];

    if (cycles.length) {
      output.push('', '=== CYCLE DETECTED ===');
      output.push(`Circular dependency among: ${cycles.join(', ')}`);
      output.push('These nodes cannot be resolved in topological order.');
      output.push('The cycle must be broken by removing or redirecting one of the edges.');
    }

    output.push('', '=== Mermaid Diagram ===');
    output.push('```mermaid');
    output.push('graph ' + (cycles.length ? '' : 'TD'));
    for (const [from, to] of edgeArray) {
      output.push(`  ${from.replace(/[^a-zA-Z0-9_]/g, '_')} --> ${to.replace(/[^a-zA-Z0-9_]/g, '_')}`);
    }
    for (const n of nodeArray) {
      if (!hasOutgoing.has(n) && !hasIncoming.has(n)) {
        output.push(`  ${n.replace(/[^a-zA-Z0-9_]/g, '_')}[${n}]`);
      }
    }
    output.push('```');

    output.push('', '=== AI Analysis Prompt ===');
    output.push('Based on the dependency graph above:');
    output.push('1. Is the execution order correct? Should any dependency be added or removed?');
    output.push('2. Are there unnecessary dependencies that could be parallelized?');
    output.push('3. Are there missing dependencies that could cause runtime errors?');

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }

  return { content: [{ type: 'text', text: `Unknown dataQuery mode: ${mode}` }] };
}

// === 辅助函数 ===

export function findEnclosingFunction(symbols, targetLine0) {
  for (const s of symbols) {
    if ([5, 6, 8, 9, 11, 12].includes(s.kind) &&
      s.range?.start?.line <= targetLine0 && s.range?.end?.line >= targetLine0) {
      return s;
    }
    if (s.children) {
      for (const c of s.children) {
        if ([5, 6, 8, 9, 11, 12].includes(c.kind) &&
          c.range?.start?.line <= targetLine0 && c.range?.end?.line >= targetLine0) {
          return c;
        }
      }
    }
  }
  return null;
}

function flattenSymbols(syms) {
  const result = [];
  for (const s of syms) {
    result.push(s);
    if (s.children?.length) result.push(...flattenSymbols(s.children));
  }
  return result;
}

function findSymbolAtPosition(symbols, targetLine0, kindFilter = null) {
  let best = null;
  for (const s of flattenSymbols(symbols)) {
    if (kindFilter && !kindFilter.includes(s.kind)) continue;
    if (s.range?.start?.line <= targetLine0 && s.range?.end?.line >= targetLine0) {
      if (!best || (s.range.start.line >= best.range.start.line && s.range.end.line <= best.range.end.line)) best = s;
    }
  }
  return best;
}

export function getHoverText(hoverResp) {
  if (!hoverResp?.result?.contents) return '';
  const c = hoverResp.result.contents;
  if (typeof c === 'object' && c.value) return c.value;
  if (Array.isArray(c)) return c.map(i => i.value || i).join('\n');
  return String(c);
}

// === 符号名自动位置解析 ===

async function resolveSymbol(filePath, symbolName) {
  const client = await detectAndGetClient(filePath);
  if (!client) return null;
  const resp = await client.documentSymbol(filePath);
  const symbols = resp?.result || [];

  // LSP documentSymbol 有两种合法格式：
  //   扁平格式：location + containerName（typescript-language-server, pyright）
  //   嵌套格式：range + children（clangd, rust-analyzer）
  const flat = symbols.length > 0 && symbols[0].location && !symbols[0].range;
  if (flat) {
    const match = symbols.find(s => s.name === symbolName);
    if (!match?.location?.range) return null;
    const r = match.location.range;
    return {
      line: r.start.line + 1,
      character: r.start.character + 1,
      kind: match.kind,
      endLine: r.end.line + 1,
      endCharacter: r.end.character + 1,
    };
  }

  function findInTree(syms) {
    for (const s of syms) {
      if (s.name === symbolName) return s;
      if (s.children?.length) {
        const found = findInTree(s.children);
        if (found) return found;
      }
    }
    return null;
  }

  const match = findInTree(symbols);
  if (!match?.range) return null;
  return {
    line: match.range.start.line + 1,
    character: match.range.start.character + 1,
    kind: match.kind,
    endLine: match.range.end.line + 1,
    endCharacter: match.range.end.character + 1,
  };
}

export async function detectAndGetClient(filePath) {
  const [language] = detectLspServer(filePath) || [];
  if (!language) return null;
  const projectRoot = cachedFindProjectRoot(filePath);
  return getOrCreateClient(language, projectRoot);
}

// === MCP 工具 Handler ===

async function lspCall(operation, params) {
  if (operation === 'dataQuery') return handleDataQuery(params);

  const { filePath } = params;

  // === Tree-LSP Provider (优先用于 MD/YAML，比真实 LSP 结果更完整) ===
  const treeProvider = getTreeProvider(filePath);
  if (treeProvider) {
    try {
      const opMap = {
        documentSymbol: 'documentSymbol',
        hover: 'hover',
        references: 'references',
        foldingRange: 'foldingRange',
        documentHighlight: 'documentHighlight',
        diagnostic: 'diagnostic',
      };
      const providerOp = opMap[operation];
      if (providerOp && treeProvider[providerOp]) {
        const resp = treeProvider[providerOp](filePath, params.line, params.character);
        if (operation === 'documentSymbol') {
          const symbols = resp?.result || [];
          if (!symbols.length) return { content: [{ type: 'text', text: 'No symbols found in file' }] };
          const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
          function formatSymbols(syms, indent = 0) {
            return syms.map(s => {
              const kind = kindNames[s.kind - 1] || s.kind;
              const line = s.range?.start?.line != null ? s.range.start.line + 1 : '?';
              let r = `${'  '.repeat(indent)}${s.name} (${kind}) @${line}`;
              if (s.children?.length) r += '\n' + formatSymbols(s.children, indent + 1);
              return r;
            }).join('\n');
          }
          return { content: [{ type: 'text', text: `${symbols.length} symbol(s):\n${formatSymbols(symbols)}` }] };
        }
        if (operation === 'hover') {
          if (!resp?.result?.contents) return { content: [{ type: 'text', text: 'No hover information available' }] };
          const c = resp.result.contents;
          const text = typeof c === 'object' && c.value ? c.value
            : Array.isArray(c) ? c.map(i => i.value || i).join('\n')
              : String(c);
          return { content: [{ type: 'text', text }] };
        }
        if (operation === 'references') {
          return formatLocations(resp?.result || [], 'reference(s)');
        }
        if (operation === 'foldingRange') {
          const ranges = resp?.result || [];
          if (!ranges.length) return { content: [{ type: 'text', text: 'No folding ranges found' }] };
          return { content: [{ type: 'text', text: `${ranges.length} range(s):\n${ranges.map(r => `L${r.startLine + 1}-${r.endLine + 1} (${r.kind || 'region'})`).join('\n')}` }] };
        }
        if (operation === 'documentHighlight') {
          const highlights = resp?.result || [];
          if (!highlights.length) return { content: [{ type: 'text', text: 'No highlights found' }] };
          const kindNames = ['text', 'read', 'write'];
          return { content: [{ type: 'text', text: `${highlights.length} highlight(s):\n${highlights.map(h => `L${h.range.start.line + 1}:${h.range.start.character + 1} (${kindNames[h.kind - 1] || 'unknown'})`).join('\n')}` }] };
        }
        if (operation === 'diagnostic') {
          const diags = resp?.result?.items || [];
          if (!diags.length) return { content: [{ type: 'text', text: 'No diagnostics' }] };
          const severityNames = ['Error', 'Warning', 'Information', 'Hint'];
          return { content: [{ type: 'text', text: `${diags.length} diagnostic(s):\n${diags.map(d => `${severityNames[d.severity - 1] || 'Unknown'} L${d.range?.start?.line != null ? d.range.start.line + 1 : '?'}:C${d.range?.start?.character != null ? d.range.start.character + 1 : '?'}: ${d.message}`).join('\n')}` }] };
        }
      }
      // Unsupported operations (rename, edit, etc.) fall through to real LSP
    } catch {
      // Tree provider failed, fall through to real LSP
    }
  }

  const [language, config] = detectLspServer(filePath);
  if (!config) return { content: [{ type: 'text', text: `ERROR: No LSP server for file: ${filePath}` }] };

  const projectRoot = cachedFindProjectRoot(filePath);
  let client;
  try {
    client = await getOrCreateClient(language, projectRoot);
  } catch (err) {
    return { content: [{ type: 'text', text: `ERROR: ${err.message}` }] };
  }

  try {
    switch (operation) {
      case 'rename': {
        const { line, character, newName } = params;
        const resp = await client.rename(filePath, line, character, newName);
        if (resp?.error) return { content: [{ type: 'text', text: `RENAME ERROR: ${resp.error.message || JSON.stringify(resp.error)}` }] };
        if (resp?.result?.changes) {
          const r = applyWorkspaceEdit(resp.result);
          return { content: [{ type: 'text', text: `RENAME SUCCESS: ${newName}\n${r.text}` }] };
        }
        return { content: [{ type: 'text', text: 'RENAME: No changes (symbol not found or no references)' }] };
      }

      case 'applyCodeAction': {
        const { line, character, actionKind, endLine, endCharacter } = params;
        let resp;
        if (endLine != null && endCharacter != null) {
          resp = await client.codeActionRange(filePath, line, character, endLine, endCharacter);
        } else {
          resp = await client.codeAction(filePath, line, character);
        }
        const actions = resp?.result || [];
        if (!actions.length) return { content: [{ type: 'text', text: 'No code actions available at this position' }] };
        // If actionKind specified, find and apply the matching action
        if (actionKind) {
          const match = actions.find(a => a.kind === actionKind || a.kind?.startsWith(actionKind));
          if (!match) return { content: [{ type: 'text', text: `No action found for kind "${actionKind}". Available:\n${actions.map((a, i) => `[${i}] ${a.kind ? `(${a.kind}) ` : ''}${a.title}`).join('\n')}` }] };
          if (match.edit) {
            const r = applyWorkspaceEdit(match.edit);
            for (const f of (r.files || [])) {
              try {
                const fp = f.path;
                if (!fp) continue;
                const uri = fileToUri(fp);
                const existing = client.openedDocs.get(uri);
                if (existing) {
                  existing.version++;
                  const content = readFileSync(fp, 'utf8');
                  client.sendNotification('textDocument/didChange', { textDocument: { uri, version: existing.version }, contentChanges: [{ text: content }] });
                }
              } catch { }
            }
            return { content: [{ type: 'text', text: `APPLIED: ${match.title}\n${r.text}` }] };
          }
          if (match.command) return { content: [{ type: 'text', text: `COMMAND: ${match.command.command} (requires LSP command execution)` }] };
          return { content: [{ type: 'text', text: `ACTION "${match.title}" has no edit or command to apply` }] };
        }
        // No actionKind — list all available actions
        return { content: [{ type: 'text', text: actions.map((a, i) => `[${i}] ${a.kind ? `(${a.kind}) ` : ''}${a.title}`).join('\n') }] };
      }

      case 'codeAction': {
        const { line, character, endLine, endCharacter } = params;
        let resp;
        if (endLine != null && endCharacter != null) {
          resp = await client.codeActionRange(filePath, line, character, endLine, endCharacter);
        } else {
          resp = await client.codeAction(filePath, line, character);
        }
        const actions = resp?.result || [];
        if (!actions.length) return { content: [{ type: 'text', text: 'No code actions available at this position' }] };
        return { content: [{ type: 'text', text: actions.map((a, i) => `[${i}] ${a.kind ? `(${a.kind}) ` : ''}${a.title}`).join('\n') }] };
      }

      case 'applyAction': {
        const { line, character, index, endLine, endCharacter } = params;
        let resp;
        if (endLine != null && endCharacter != null) {
          resp = await client.codeActionRange(filePath, line, character, endLine, endCharacter);
        } else {
          resp = await client.codeAction(filePath, line, character);
        }
        const actions = resp?.result || [];
        if (index >= actions.length) return { content: [{ type: 'text', text: `Action index ${index} out of range (0-${actions.length - 1})` }] };
        const action = actions[index];
        if (action.edit) {
          const r = applyWorkspaceEdit(action.edit);
          // Sync LSP state
          for (const f of (r.files || [])) {
            try {
              const fp = f.path;
              if (!fp) continue;
              const uri = fileToUri(fp);
              const existing = client.openedDocs.get(uri);
              if (existing) {
                existing.version++;
                const content = readFileSync(fp, 'utf8');
                client.sendNotification('textDocument/didChange', { textDocument: { uri, version: existing.version }, contentChanges: [{ text: content }] });
              }
            } catch { }
          }
          return { content: [{ type: 'text', text: `APPLIED: ${action.title}\n${r.text}` }] };
        }
        if (action.command) return { content: [{ type: 'text', text: `COMMAND: ${action.command.command} (requires LSP command execution)` }] };
        return { content: [{ type: 'text', text: 'ACTION: No edit or command to apply' }] };
      }

      case 'organizeImports': {
        const resp = await client.organizeImports(filePath);
        const actions = resp?.result || [];
        const organizeAction = actions.find(a => a.kind === 'source.organizeImports');
        if (organizeAction?.edit) {
          const r = applyWorkspaceEdit(organizeAction.edit);
          return { content: [{ type: 'text', text: `ORGANIZE_IMPORTS: Applied\n${r.text}` }] };
        }
        return { content: [{ type: 'text', text: 'ORGANIZE_IMPORTS: No changes needed' }] };
      }

      case 'format': {
        const { startLine, endLine } = params;
        let resp;
        if (startLine != null && endLine != null) {
          resp = await client.formatRange(filePath, startLine, endLine);
        } else {
          resp = await client.format(filePath);
        }
        const edits = resp?.result || [];
        if (edits.length) {
          applyTextEdit(pathResolve(filePath), edits);
          return { content: [{ type: 'text', text: `FORMAT: ${edits.length} edit(s) applied${startLine != null ? ` (L${startLine}-${endLine})` : ''}` }] };
        }
        return { content: [{ type: 'text', text: 'FORMAT: No changes needed' }] };
      }

      case 'references': {
        const { line, character } = params;
        return formatLocations((await client.references(filePath, line, character))?.result || [], 'reference(s)');
      }

      case 'implementations': {
        const { line, character } = params;
        return formatLocations((await client.implementations(filePath, line, character))?.result || [], 'implementation(s)');
      }

      case 'typeDefinition': {
        const { line, character } = params;
        const resp = await client.typeDefinition(filePath, line, character);
        const locs = Array.isArray(resp?.result) ? resp.result : resp?.result ? [resp.result] : [];
        return formatLocations(locs, 'type definition(s)');
      }

      case 'hover': {
        const { line, character } = params;
        const resp = await client.hover(filePath, line, character);
        if (resp?.result?.contents) {
          const c = resp.result.contents;
          const text = typeof c === 'object' && c.value ? c.value
            : Array.isArray(c) ? c.map(i => i.value || i).join('\n')
              : String(c);
          return { content: [{ type: 'text', text }] };
        }
        return { content: [{ type: 'text', text: 'No hover information available' }] };
      }

      case 'documentSymbol': {
        const resp = await client.documentSymbol(filePath);
        const symbols = resp?.result || [];
        if (!symbols.length) return { content: [{ type: 'text', text: 'No symbols found in file' }] };
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
        function formatSymbols(syms, indent = 0) {
          return syms.map(s => {
            const kind = kindNames[s.kind - 1] || s.kind;
            const line = s.range?.start?.line != null ? s.range.start.line + 1 : '?';
            let r = `${'  '.repeat(indent)}${s.name} (${kind}) @${line}`;
            if (s.children?.length) r += '\n' + formatSymbols(s.children, indent + 1);
            return r;
          }).join('\n');
        }
        return { content: [{ type: 'text', text: `${symbols.length} symbol(s):\n${formatSymbols(symbols)}` }] };
      }

      case 'documentHighlight': {
        const { line, character } = params;
        const resp = await client.documentHighlight(filePath, line, character);
        const highlights = resp?.result || [];
        if (!highlights.length) return { content: [{ type: 'text', text: 'No highlights found' }] };
        const kindNames = ['text', 'read', 'write'];
        return { content: [{ type: 'text', text: `${highlights.length} highlight(s):\n${highlights.map(h => `L${h.range.start.line + 1}:${h.range.start.character + 1} (${kindNames[h.kind - 1] || 'unknown'})`).join('\n')}` }] };
      }

      case 'foldingRange': {
        const resp = await client.foldingRange(filePath);
        const ranges = resp?.result || [];
        if (!ranges.length) return { content: [{ type: 'text', text: 'No folding ranges found' }] };
        return { content: [{ type: 'text', text: `${ranges.length} range(s):\n${ranges.map(r => `L${r.startLine + 1}-${r.endLine + 1} (${r.kind || 'region'})`).join('\n')}` }] };
      }

      case 'prepareRename': {
        const { line, character } = params;
        const resp = await client.prepareRename(filePath, line, character);
        if (resp?.error) return { content: [{ type: 'text', text: `PREPARE_RENAME ERROR: ${resp.error.message}` }] };
        if (resp?.result) {
          const r = resp.result;
          const range = r.range || r;
          return { content: [{ type: 'text', text: `Can rename at L${range.start.line + 1}:C${range.start.character + 1}-${range.end.line + 1}:C${range.end.character + 1}${r.placeholder ? ` (placeholder: ${r.placeholder})` : ''}` }] };
        }
        return { content: [{ type: 'text', text: 'PREPARE_RENAME: Cannot rename at this position' }] };
      }

      case 'diagnostic': {
        const resp = await client.diagnostic(filePath);
        const diags = resp?.result?.items || resp?.result || [];
        if (!diags.length) return { content: [{ type: 'text', text: 'No diagnostics' }] };
        const severityNames = ['Error', 'Warning', 'Information', 'Hint'];
        const formatted = diags.map(d => {
          const sev = severityNames[d.severity - 1] || 'Unknown';
          const line = d.range?.start?.line != null ? d.range.start.line + 1 : '?';
          const char = d.range?.start?.character != null ? d.range.start.character + 1 : '?';
          return `${sev} L${line}:C${char}: ${d.message}`;
        });
        return { content: [{ type: 'text', text: `${diags.length} diagnostic(s):\n${formatted.join('\n')}` }] };
      }


      case 'editReferences': {
        const { line, character, newText } = params;
        const refResp = await client.references(filePath, line, character);
        const locs = refResp?.result || [];
        if (!locs.length) return { content: [{ type: 'text', text: 'EDIT_REFERENCES: No references found' }] };
        const changes = {};
        for (const loc of locs) {
          const uri = loc.uri;
          if (!changes[uri]) changes[uri] = [];
          changes[uri].push({
            range: loc.range,
            newText,
          });
        }
        const r = applyWorkspaceEdit({ changes });
        for (const f of (r.files || [])) {
          try {
            const fp = f.path;
            if (!fp) continue;
            const uri = fileToUri(fp);
            const existing = client.openedDocs.get(uri);
            if (existing) {
              existing.version++;
              const content = readFileSync(fp, 'utf8');
              client.sendNotification('textDocument/didChange', { textDocument: { uri, version: existing.version }, contentChanges: [{ text: content }] });
            }
          } catch { }
        }
        return { content: [{ type: 'text', text: `EDIT_REFERENCES: Replaced ${locs.length} reference(s) with "${newText}"\n${r.text}` }] };
      }

      case 'workspaceSymbol': {
        const { query } = params;
        const resp = await client.workspaceSymbol(query);
        const symbols = resp?.result || [];
        if (!symbols.length) return { content: [{ type: 'text', text: 'No workspace symbols found' }] };
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
        const formatted = symbols.map(s => {
          const kind = kindNames[s.kind - 1] || s.kind;
          const fp = s.location ? uriToPath(s.location.uri) : '?';
          const line = s.location?.range?.start?.line != null ? s.location.range.start.line + 1 : '?';
          return `${s.name} (${kind}) ${fp}:${line}`;
        });
        return { content: [{ type: 'text', text: `${symbols.length} symbol(s):\n${formatted.join('\n')}` }] };
      }

      case 'addImport': {
        const { importName } = params;
        // 必须先 openDocument 触发 LSP 分析文件并发送 publishDiagnostics
        await client.openDocument(filePath);
        const diagUri = fileToUri(pathResolve(filePath));
        const diagDeadline = Date.now() + 30000;
        while (!client.diagnosticCache.has(diagUri) && Date.now() < diagDeadline) {
          await new Promise(r => setTimeout(r, 200));
        }
        const diags = client.diagnosticCache.get(diagUri) || [];
        const unresolved = diags.filter(d =>
          d.code === 2304 || d.code === 2305 || d.code === 2663 || d.code === 2662 ||
          d.message?.includes('Cannot find name')
        );
        const targetDiags = importName
          ? unresolved.filter(d => d.message?.includes(importName))
          : unresolved;
        if (!targetDiags.length) {
          return { content: [{ type: 'text', text: `ADD_IMPORT: No unresolved diagnostic found for "${importName}". The symbol may already be imported or not referenced in the file.` }] };
        }
        let allActions = [];
        const tried = new Set();
        for (const d of targetDiags) {
          const line = d.range.start.line + 1;
          const char = d.range.start.character + 1;
          const key = `${line}:${char}`;
          if (tried.has(key)) continue;
          tried.add(key);
          const resp = await client.codeAction(filePath, line, char, [d]);
          allActions.push(...(resp?.result || []));
          if (allActions.some(a => a.title?.toLowerCase().includes('import'))) break;
        }
        const importAction = allActions.find(a =>
          a.kind?.includes('addMissingImports') || a.kind?.includes('addImport') ||
          (a.title?.toLowerCase().includes('import') && (!importName || a.title.includes(importName)))
        );
        if (importAction?.edit) {
          const r = applyWorkspaceEdit(importAction.edit);
          return { content: [{ type: 'text', text: `ADD_IMPORT: Applied via codeAction "${importAction.title}"\n${r.text}` }] };
        }
        return { content: [{ type: 'text', text: `ADD_IMPORT: No automatic import action found for "${importName}". Use lsp_workspace_symbol to find the symbol and add import manually.` }] };
      }

      case 'deleteSymbol': {
        const { line, deleteReferences } = params;
        // Get symbol range via documentSymbol
        const symResp = await client.documentSymbol(filePath);
        const symbols = symResp?.result || [];
        const targetLine = line - 1;
        let targetSymbol = null;
        for (const s of symbols) {
          if (s.range?.start?.line <= targetLine && s.range?.end?.line >= targetLine) {
            if (!targetSymbol || (s.range.start.line >= targetSymbol.range.start.line && s.range.end.line <= targetSymbol.range.end.line)) {
              targetSymbol = s;
            }
          }
          if (s.children) {
            for (const c of s.children) {
              if (c.range?.start?.line <= targetLine && c.range?.end?.line >= targetLine) {
                if (!targetSymbol || (c.range.start.line >= targetSymbol.range.start.line && c.range.end.line <= targetSymbol.range.end.line)) {
                  targetSymbol = c;
                }
              }
            }
          }
        }
        if (!targetSymbol) return { content: [{ type: 'text', text: 'DELETE_SYMBOL: No symbol found at this position' }] };
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const kindName = kindNames[targetSymbol.kind - 1] || `Kind${targetSymbol.kind}`;
        const changes = {};
        const uri = fileToUri(filePath);
        // Delete the symbol definition
        changes[uri] = [{ range: targetSymbol.range, newText: '' }];
        // Optionally delete all references
        let refCount = 0;
        if (deleteReferences) {
          const refResp = await client.references(filePath, targetSymbol.range.start.line + 1, targetSymbol.range.start.character + 1);
          const locs = refResp?.result || [];
          for (const loc of locs) {
            if (loc.uri === uri && loc.range.start.line === targetSymbol.range.start.line) continue; // Skip the definition itself
            if (!changes[loc.uri]) changes[loc.uri] = [];
            changes[loc.uri].push({ range: loc.range, newText: '' });
            refCount++;
          }
        }
        const r = applyWorkspaceEdit({ changes });
        return { content: [{ type: 'text', text: `DELETE_SYMBOL: Deleted ${kindName} "${targetSymbol.name}"${deleteReferences ? ` + ${refCount} reference(s)` : ''}\n${r.text}` }] };
      }

      case 'traceOrigin': {
        const { line, character, depth = 5 } = params;
        const visited = new Set();
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];

        // Get hover to identify symbol type
        const hoverResp = await client.hover(filePath, line, character);
        const hoverText = getHoverText(hoverResp);

        // Get document symbols to determine what's at this position
        const symResp = await client.documentSymbol(filePath);
        const symbols = symResp?.result || [];
        const targetLine0 = line - 1;
        const targetSym = findSymbolAtPosition(symbols, targetLine0);

        const isFunctionLike = targetSym && [5, 6, 8, 9, 11, 12].includes(targetSym.kind);
        const isParameter = targetSym && targetSym.kind === 13; // Variable — params are often variables

        const resultLines = [];
        const symName = targetSym?.name || '(unknown)';
        const symKind = targetSym ? (kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`) : 'Unknown';
        resultLines.push(`TRACE_ORIGIN: ${symKind} "${symName}" at ${filePath}:${line}:${character}`);
        if (hoverText) resultLines.push(`Type: ${hoverText.split('\n')[0]}`);
        resultLines.push('');

        // === Call chain: recursive incomingCalls ===
        async function traceCallChain(fp, ln, ch, currentDepth, indent) {
          if (currentDepth <= 0) return;
          const key = `${fp}:${ln}:${ch}`;
          if (visited.has(key)) {
            resultLines.push(`${indent}↻ (cycle detected)`);
            return;
          }
          visited.add(key);

          try {
            const prepResp = await client.prepareCallHierarchy(fp, ln, ch);
            const items = prepResp?.result || [];
            if (!items.length) return;

            const callResp = await client.incomingCalls(items[0]);
            const callers = callResp?.result || [];
            if (!callers.length) {
              resultLines.push(`${indent}← (top-level entry, no further callers)`);
              return;
            }

            for (const caller of callers) {
              const callerFp = uriToPath(caller.from.uri);
              const callerLine = caller.from.range.start.line + 1;
              const callerChar = caller.from.range.start.character + 1;
              const callerName = caller.from.name;
              resultLines.push(`${indent}← ${callerName}  ${callerFp}:${callerLine}:${callerChar}`);

              // Read the calling line to show what was passed
              try {
                const content = readFileSync(callerFp, 'utf8');
                const lines = content.split('\n');
                const callLine = lines[callerLine - 1]?.trim();
                if (callLine) {
                  resultLines.push(`${indent}  └ ${callLine}`);
                }
              } catch { }

              // Recurse
              await traceCallChain(callerFp, callerLine, callerChar, currentDepth - 1, indent + '  ');
            }
          } catch {
            resultLines.push(`${indent}← (callHierarchy not supported or error)`);
          }
        }

        // === Parameter origin: trace where the value comes from ===
        async function traceParamOrigin(fp, ln, ch, currentDepth, indent) {
          if (currentDepth <= 0) return;

          // Find all references to this symbol
          const refResp = await client.references(fp, ln, ch);
          const refs = refResp?.result || [];

          // Categorize references: assignments (write) vs usages (read)
          const writeRefs = [];
          for (const ref of refs) {
            const refFp = uriToPath(ref.uri);
            const refLine = ref.range.start.line + 1;
            const refChar = ref.range.start.character + 1;
            const key = `${refFp}:${refLine}:${refChar}`;
            if (visited.has(key)) continue;
            visited.add(key);

            // Read the line to determine if it's an assignment
            try {
              const content = readFileSync(refFp, 'utf8');
              const lines = content.split('\n');
              const refLineText = lines[refLine - 1] || '';

              // Check if this is a write (assignment/initialization)
              const beforeRef = refLineText.substring(0, ref.range.start.character);
              const afterRef = refLineText.substring(ref.range.end.character);
              const isWrite = /[=<>!+\-*/%&|^]?=$/.test(beforeRef.trimEnd()) ||
                afterRef.trimStart().startsWith('=') ||
                beforeRef.includes('('); // function parameter definition

              if (isWrite) {
                writeRefs.push({ fp: refFp, line: refLine, char: refChar, text: refLineText.trim() });
              }
            } catch { }
          }

          if (!writeRefs.length) {
            resultLines.push(`${indent}← (no assignment found, may be from function parameter or closure)`);
            return;
          }

          for (const wr of writeRefs) {
            resultLines.push(`${indent}← assigned at ${wr.fp}:${wr.line}:${wr.char}`);
            resultLines.push(`${indent}  └ ${wr.text}`);

            // Parse the right-hand side of assignment to find source symbols
            const eqIdx = wr.text.indexOf('=');
            if (eqIdx >= 0) {
              const rhs = wr.text.substring(eqIdx + 1).trim();
              // Try to find symbols in the RHS via hover on the assignment line
              // We look at the RHS expression — if it's a function call, trace the function
              const callMatch = rhs.match(/^(\w+)\s*\(/);
              if (callMatch) {
                // RHS is a function call — trace the function's return origin
                resultLines.push(`${indent}  └ (RHS is call to "${callMatch[1]}", trace its return value)`);
              } else if (/^\w+(\.\w+)*$/.test(rhs)) {
                // RHS is a property access — trace the base variable
                resultLines.push(`${indent}  └ (RHS is "${rhs}", trace its origin)`);
              }
            }

            // Recurse: trace the variable being assigned from
            await traceParamOrigin(wr.fp, wr.line, wr.char, currentDepth - 1, indent + '  ');
          }
        }

        if (isFunctionLike) {
          resultLines.push('=== Call Chain (who calls this function, recursively up) ===');
          await traceCallChain(filePath, line, character, depth, '');
        } else if (isParameter) {
          resultLines.push('=== Parameter Origin (where does this value come from, recursively up) ===');
          await traceParamOrigin(filePath, line, character, depth, '');
        } else {
          // For any symbol: do both call chain trace and reference trace
          resultLines.push('=== Call Chain (who calls the enclosing function) ===');
          // Find enclosing function
          if (targetSym) {
            for (const s of symbols) {
              if ([5, 6, 8, 9, 11, 12].includes(s.kind) &&
                s.range?.start?.line <= targetLine0 && s.range?.end?.line >= targetLine0) {
                resultLines.push(`Enclosing function: ${s.name} at ${filePath}:${s.range.start.line + 1}`);
                await traceCallChain(filePath, s.range.start.line + 1, s.range.start.character + 1, depth, '');
                break;
              }
              if (s.children) {
                for (const c of s.children) {
                  if ([5, 6, 8, 9, 11, 12].includes(c.kind) &&
                    c.range?.start?.line <= targetLine0 && c.range?.end?.line >= targetLine0) {
                    resultLines.push(`Enclosing function: ${c.name} at ${filePath}:${c.range.start.line + 1}`);
                    await traceCallChain(filePath, c.range.start.line + 1, c.range.start.character + 1, depth, '');
                    break;
                  }
                }
              }
            }
          }
          resultLines.push('');
          resultLines.push('=== Value Origin (where does this symbol get its value) ===');
          await traceParamOrigin(filePath, line, character, depth, '');
        }

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'changeSignature': {
        const { line, character, newSignature } = params;
        const hoverResp = await client.hover(filePath, line, character);
        const oldSig = getHoverText(hoverResp);
        if (!oldSig) return { content: [{ type: 'text', text: 'CHANGE_SIGNATURE: Cannot get current signature — is the cursor on a function?' }] };

        // Step 2: Find the function via documentSymbol
        const symResp = await client.documentSymbol(filePath);
        const targetSym = findSymbolAtPosition(symResp?.result || [], line - 1, [5, 6, 8, 9, 11, 12]);
        if (!targetSym) return { content: [{ type: 'text', text: 'CHANGE_SIGNATURE: No function found at this position' }] };

        // Step 3: Use selectionRange for precise signature replacement (language-agnostic)
        const funcContent = readFileSync(filePath, 'utf8');
        const funcLines = funcContent.split('\n');
        const sigRange = targetSym.selectionRange || targetSym.range;

        // Extract old signature text from selectionRange
        let oldSigPart;
        if (sigRange.start.line === sigRange.end.line) {
          oldSigPart = funcLines[sigRange.start.line].substring(sigRange.start.character, sigRange.end.character);
        } else {
          // Multi-line signature
          const firstLine = funcLines[sigRange.start.line].substring(sigRange.start.character);
          const middleLines = funcLines.slice(sigRange.start.line + 1, sigRange.end.line);
          const lastLine = funcLines[sigRange.end.line].substring(0, sigRange.end.character);
          oldSigPart = [firstLine, ...middleLines, lastLine].join('\n');
        }

        const changes = {};
        const uri = fileToUri(filePath);
        changes[uri] = [{
          range: sigRange,
          newText: newSignature,
        }];
        applyWorkspaceEdit({ changes });
        const resultLines = [`CHANGE_SIGNATURE: Definition updated`];
        resultLines.push(`  Old: ${oldSigPart}`);
        resultLines.push(`  New: ${newSignature}`);
        resultLines.push(`  File: ${filePath}:${targetSym.range.start.line + 1}`);

        // Sync LSP state
        const existingDoc = client.openedDocs.get(uri);
        if (existingDoc) {
          existingDoc.version++;
          const updatedContent = readFileSync(filePath, 'utf8');
          client.sendNotification('textDocument/didChange', { textDocument: { uri, version: existingDoc.version }, contentChanges: [{ text: updatedContent }] });
        }

        // Step 4: Find all call references and report diagnostics
        const refResp = await client.references(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
        const refs = refResp?.result || [];
        const callSites = refs.filter(r => !(r.uri === uri && r.range.start.line === targetSym.range.start.line));
        resultLines.push(`\n  ${callSites.length} call site(s) may need updating:`);
        for (const ref of callSites.slice(0, 50)) {
          const refFp = uriToPath(ref.uri);
          const refLine = ref.range.start.line + 1;
          try {
            const refContent = readFileSync(refFp, 'utf8');
            const refLineText = refContent.split('\n')[ref.range.start.line]?.trim() || '';
            resultLines.push(`  ${refFp}:${refLine}  ${refLineText}`);
          } catch { }
        }

        // Step 5: Run diagnostics on modified file
        await new Promise(r => setTimeout(r, 1000));
        const diagResp = await client.diagnostic(filePath);
        const newDiags = diagResp?.result?.items || diagResp?.result || [];
        const errors = newDiags.filter(d => d.severity === 1);
        if (errors.length) {
          resultLines.push(`\n  ⚠ ${errors.length} error(s) after signature change:`);
          for (const e of errors.slice(0, 20)) {
            resultLines.push(`    L${(e.range?.start?.line || 0) + 1}: ${e.message}`);
          }
          resultLines.push('\n  Call sites listed above need manual update to match new signature.');
        } else {
          resultLines.push('\n  ✅ No errors — signature change is type-safe.');
        }

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'changeType': {
        const { line, character, newType } = params;
        // Step 1: Get current type info via hover
        const hoverResp = await client.hover(filePath, line, character);
        const oldType = getHoverText(hoverResp);
        if (!oldType) return { content: [{ type: 'text', text: 'CHANGE_TYPE: Cannot determine current type at this position' }] };

        // Step 2: Find the type definition
        const typeDefResp = await client.typeDefinition(filePath, line, character);
        const typeLocs = Array.isArray(typeDefResp?.result) ? typeDefResp.result : typeDefResp?.result ? [typeDefResp.result] : [];
        if (!typeLocs.length) return { content: [{ type: 'text', text: 'CHANGE_TYPE: Cannot find type definition — cursor may not be on a typed symbol' }] };

        // Step 3: Show all references that will be affected
        const refResp = await client.references(filePath, line, character);
        const refs = refResp?.result || [];
        const resultLines = [`CHANGE_TYPE: Type change propagation report`];
        resultLines.push(`  Old type: ${oldType.split('\n')[0]}`);
        resultLines.push(`  New type: ${newType}`);
        resultLines.push(`\n  Type definition at:`);
        for (const loc of typeLocs) {
          resultLines.push(`    ${uriToPath(loc.uri)}:${loc.range.start.line + 1}`);
        }
        resultLines.push(`\n  ${refs.length} reference(s) affected:`);
        for (const ref of refs.slice(0, 80)) {
          const refFp = uriToPath(ref.uri);
          const refLine = ref.range.start.line + 1;
          try {
            const c = readFileSync(refFp, 'utf8');
            const lt = c.split('\n')[ref.range.start.line]?.trim() || '';
            resultLines.push(`    ${refFp}:${refLine}  ${lt}`);
          } catch { }
        }

        // Step 4: Find the type definition line and show what to change
        const typeLoc = typeLocs[0];
        const typeFp = uriToPath(typeLoc.uri);
        const typeContent = readFileSync(typeFp, 'utf8');
        const typeLine = typeContent.split('\n')[typeLoc.range.start.line];
        resultLines.push(`\n  Type definition line: ${typeLine.trim()}`);
        resultLines.push(`\n  Next steps:`);
        resultLines.push(`  1. Edit the type definition at ${typeFp}:${typeLoc.range.start.line + 1}`);
        resultLines.push(`  2. Run lsp_diagnostic on affected files to find type errors`);
        resultLines.push(`  3. Fix each diagnostic error using lsp_apply_code_action or Edit`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'moveSymbol': {
        const { line, character, targetFile } = params;
        // Step 1: Get symbol info
        const symResp = await client.documentSymbol(filePath);
        const targetLine0 = line - 1;
        const targetSym = findSymbolAtPosition(symResp?.result || [], targetLine0);
        if (!targetSym) return { content: [{ type: 'text', text: 'MOVE_SYMBOL: No symbol found at this position' }] };

        // Step 2: Get all references
        const refResp = await client.references(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
        const refs = refResp?.result || [];
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const kindName = kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`;

        // Step 3: Extract the symbol code
        const srcContent = readFileSync(filePath, 'utf8');
        const srcLines = srcContent.split('\n');
        const symbolCode = srcLines.slice(targetSym.range.start.line, targetSym.range.end.line + 1).join('\n');

        // Step 4: Report the move plan
        const resultLines = [`MOVE_SYMBOL: ${kindName} "${targetSym.name}" → ${targetFile}`];
        resultLines.push(`\n  Symbol code (${targetSym.range.end.line - targetSym.range.start.line + 1} lines):`);
        resultLines.push(`    ${symbolCode.split('\n').slice(0, 5).join('\n    ')}${symbolCode.split('\n').length > 5 ? '\n    ...' : ''}`);

        // Group references by file
        const refsByFile = new Map();
        for (const ref of refs) {
          const fp = uriToPath(ref.uri);
          if (fp === pathResolve(filePath) && ref.range.start.line === targetSym.range.start.line) continue; // Skip definition
          if (!refsByFile.has(fp)) refsByFile.set(fp, []);
          refsByFile.get(fp).push(ref);
        }

        resultLines.push(`\n  ${refsByFile.size} file(s) need import update:`);
        for (const [fp, fileRefs] of refsByFile) {
          resultLines.push(`    ${fp} (${fileRefs.length} ref${fileRefs.length > 1 ? 's' : ''})`);
        }

        resultLines.push(`\n  Execution plan:`);
        resultLines.push(`    1. Append symbol code to ${targetFile}`);
        resultLines.push(`    2. Delete symbol from ${filePath} (L${targetSym.range.start.line + 1}-${targetSym.range.end.line + 1})`);
        resultLines.push(`    3. Add import in ${refsByFile.size} files`);
        resultLines.push(`    4. Run lsp_diagnostic to verify`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      // ==================== 高级复合工具 ====================

      case 'impactAnalysis': {
        const { line, character } = params;
        const targetLine0 = line - 1;
        const uri = fileToUri(filePath);
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'];
        const resultLines = [`IMPACT ANALYSIS: ${filePath}:${line}:${character}`];

        // Step 1: Symbol identity
        const hoverResp = await client.hover(filePath, line, character);
        const hoverText = getHoverText(hoverResp);
        const symResp = await client.documentSymbol(filePath);
        const targetSym = findSymbolAtPosition(symResp?.result || [], targetLine0);
        const symName = targetSym?.name || '(unknown)';
        const symKind = targetSym ? (kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`) : 'Unknown';
        resultLines.push(`Symbol: ${symKind} "${symName}"`);
        if (hoverText) resultLines.push(`Type: ${hoverText.split('\n')[0]}`);
        resultLines.push('');

        // Step 2: Downstream impact — who uses this symbol
        const refResp = await client.references(filePath, line, character);
        const refs = refResp?.result || [];
        const selfUri = fileToUri(pathResolve(filePath));
        const externalRefs = refs.filter(r => !(r.uri === selfUri && r.range.start.line === targetLine0));
        resultLines.push(`=== Downstream Impact (${externalRefs.length} consumers) ===`);
        const refsByFile = new Map();
        for (const ref of externalRefs) {
          const fp = uriToPath(ref.uri);
          if (!refsByFile.has(fp)) refsByFile.set(fp, []);
          refsByFile.get(fp).push(ref);
        }
        for (const [fp, fileRefs] of refsByFile) {
          resultLines.push(`  ${fp} (${fileRefs.length} ref${fileRefs.length > 1 ? 's' : ''})`);
          for (const ref of fileRefs.slice(0, 5)) {
            try {
              const c = readFileSync(fp, 'utf8');
              const lt = c.split('\n')[ref.range.start.line]?.trim() || '';
              resultLines.push(`    L${ref.range.start.line + 1}: ${lt}`);
            } catch { }
          }
        }

        // Step 3: Implementation impact — if this is an interface/abstract
        let impls = [];
        try {
          const implResp = await client.implementations(filePath, line, character);
          impls = implResp?.result || [];
          if (!Array.isArray(impls)) impls = impls ? [impls] : [];
        } catch { }
        if (impls.length) {
          resultLines.push(`\n=== Implementation Impact (${impls.length} implementors) ===`);
          for (const impl of impls) {
            const fp = uriToPath(impl.uri);
            resultLines.push(`  ${fp}:${impl.range.start.line + 1}`);
          }
        }

        // Step 4: Type dependency
        let typeLocs = [];
        try {
          const typeDefResp = await client.typeDefinition(filePath, line, character);
          typeLocs = Array.isArray(typeDefResp?.result) ? typeDefResp.result : typeDefResp?.result ? [typeDefResp.result] : [];
        } catch { }
        if (typeLocs.length) {
          resultLines.push(`\n=== Type Dependency (${typeLocs.length} definition(s)) ===`);
          for (const loc of typeLocs) {
            const fp = uriToPath(loc.uri);
            try {
              const c = readFileSync(fp, 'utf8');
              const lt = c.split('\n')[loc.range.start.line]?.trim() || '';
              resultLines.push(`  ${fp}:${loc.range.start.line + 1}  ${lt}`);
            } catch { }
          }
        }

        // Step 5: Upstream impact — who provides data to this symbol
        resultLines.push(`\n=== Upstream Dependencies (who provides this symbol) ===`);
        if (targetSym) {
          const enclosing = findEnclosingFunction(symbols, targetLine0);
          if (enclosing) {
            try {
              const prepResp = await client.prepareCallHierarchy(filePath, enclosing.range.start.line + 1, enclosing.range.start.character + 1);
              const items = prepResp?.result || [];
              if (items.length) {
                const callResp = await client.incomingCalls(items[0]);
                const callers = callResp?.result || [];
                resultLines.push(`  Enclosing function "${enclosing.name}" called by ${callers.length} caller(s):`);
                for (const caller of callers.slice(0, 20)) {
                  const callerFp = uriToPath(caller.from.uri);
                  resultLines.push(`    ${caller.from.name}  ${callerFp}:${caller.from.range.start.line + 1}`);
                }
              }
            } catch {
              resultLines.push('  (callHierarchy not supported)');
            }
          }
        }

        // Step 6: Mermaid impact graph
        resultLines.push(`\n=== Impact Graph (Mermaid) ===`);
        resultLines.push('```mermaid');
        resultLines.push('graph TD');
        const safeName = symName.replace(/[^a-zA-Z0-9]/g, '_');
        for (const [fp, fileRefs] of refsByFile) {
          const safeFile = basename(fp, extname(fp)).replace(/[^a-zA-Z0-9]/g, '_');
          resultLines.push(`  ${safeName} -->|${fileRefs.length} refs| ${safeFile}`);
        }
        for (const impl of impls) {
          const fp = uriToPath(impl.uri);
          const safeFile = basename(fp, extname(fp)).replace(/[^a-zA-Z0-9]/g, '_');
          resultLines.push(`  ${safeName} -.->|implements| ${safeFile}`);
        }
        resultLines.push('```');

        // Step 7: Risk assessment
        const totalImpact = externalRefs.length + impls.length;
        resultLines.push(`\n=== Risk Assessment ===`);
        resultLines.push(`  Total impact points: ${totalImpact}`);
        if (totalImpact === 0) resultLines.push(`  ✅ Safe to modify/delete — no consumers`);
        else if (totalImpact <= 3) resultLines.push(`  🟢 Low risk — few consumers`);
        else if (totalImpact <= 10) resultLines.push(`  🟡 Medium risk — verify each consumer after change`);
        else resultLines.push(`  🔴 High risk — changes will cascade widely, consider deprecation path`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'findDeadCode': {
        const symResp = await client.documentSymbol(filePath);
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const resultLines = [`DEAD CODE ANALYSIS: ${filePath}`];

        const flatSymbols = flattenSymbols(symResp?.result || []);
        const content = readFileSync(filePath, 'utf8');
        const fileLines = content.split('\n');
        const selfUriNorm = fileToUri(pathResolve(filePath));

        const deadSymbols = [];
        const lowUsageSymbols = [];

        for (const sym of flatSymbols) {
          if (!sym.name || sym.kind === 1 || sym.kind === 2) continue;

          try {
            const refResp = await client.references(filePath, sym.range.start.line + 1, sym.range.start.character + 1);
            const refs = refResp?.result || [];
            const externalRefs = refs.filter(r => {
              const isSameLine = r.uri === selfUriNorm && r.range.start.line === sym.range.start.line;
              return !isSameLine;
            });
            // LSP 语义判断导出：有跨文件引用 → 导出
            const crossFileRefs = refs.filter(r => r.uri !== selfUriNorm);
            const isExported = crossFileRefs.length > 0;

            const kindName = kindNames[sym.kind - 1] || `Kind${sym.kind}`;

            // 入口函数豁免：main/MainWindow/NewApp 等不会被引用但不是死代码
            const ext = extname(filePath);
            const isEntry = (ext === '.rs' && sym.name === 'main') ||
              (ext === '.go' && sym.name === 'main') ||
              (ext === '.py' && sym.name === '__init__') ||
              (ext === '' && sym.name === 'main');

            if (externalRefs.length === 0 && !isExported && !isEntry) {
              deadSymbols.push({ sym, kindName });
            } else if (externalRefs.length <= 2 && !isExported && !isEntry) {
              lowUsageSymbols.push({ sym, kindName, refCount: externalRefs.length });
            }
          } catch { }
        }

        // Report dead code
        resultLines.push(`\n=== Dead Code (0 external references, not exported) ===`);
        if (!deadSymbols.length) {
          resultLines.push('  (none found)');
        } else {
          for (const { sym, kindName } of deadSymbols) {
            const lineRange = `${sym.range.start.line + 1}-${sym.range.end.line + 1}`;
            const codeLine = fileLines[sym.range.start.line]?.trim() || '';
            resultLines.push(`  ${kindName} "${sym.name}"  L${lineRange}  ${codeLine}`);
          }
        }

        // Report low-usage code
        resultLines.push(`\n=== Low Usage (≤2 references, not exported) ===`);
        if (!lowUsageSymbols.length) {
          resultLines.push('  (none found)');
        } else {
          for (const { sym, kindName, refCount } of lowUsageSymbols) {
            const lineRange = `${sym.range.start.line + 1}-${sym.range.end.line + 1}`;
            resultLines.push(`  ${kindName} "${sym.name}"  L${lineRange}  (${refCount} ref${refCount > 1 ? 's' : ''})`);
          }
        }

        resultLines.push(`\n=== Summary ===`);
        resultLines.push(`  Total symbols: ${flatSymbols.length}`);
        resultLines.push(`  Dead code: ${deadSymbols.length}`);
        resultLines.push(`  Low usage: ${lowUsageSymbols.length}`);
        resultLines.push(`  Dead code ratio: ${((deadSymbols.length / Math.max(flatSymbols.length, 1)) * 100).toFixed(1)}%`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'safeDelete': {
        const { line, character } = params;
        const targetLine0 = line - 1;
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const resultLines = [`SAFE DELETE: ${filePath}:${line}`];

        // Step 1: Identify symbol
        const symResp = await client.documentSymbol(filePath);
        const targetSym = findSymbolAtPosition(symResp?.result || [], targetLine0);
        if (!targetSym) return { content: [{ type: 'text', text: 'SAFE DELETE: No symbol found at this position' }] };

        const kindName = kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`;
        resultLines.push(`Symbol: ${kindName} "${targetSym.name}"  L${targetSym.range.start.line + 1}-${targetSym.range.end.line + 1}`);

        // Step 2: Check all references
        const refResp = await client.references(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
        const refs = refResp?.result || [];
        const selfUri = fileToUri(pathResolve(filePath));
        const externalRefs = refs.filter(r => !(r.uri === selfUri && r.range.start.line === targetSym.range.start.line));

        if (externalRefs.length === 0) {
          // Step 3a: Safe to delete — execute deletion
          resultLines.push(`\n✅ No external references found. Safe to delete.`);
          resultLines.push(`\nExecuting deletion...`);
          const deleteResult = await lspCall('deleteSymbol', { filePath, line: targetSym.range.start.line + 1, character: targetSym.range.start.character + 1, deleteReferences: false });
          resultLines.push(`\nDeletion complete.`);
          return { content: [{ type: 'text', text: resultLines.join('\n') + '\n\n' + (deleteResult?.content?.[0]?.text || '') }] };
        } else {
          // Step 3b: Blocked — report all references
          resultLines.push(`\n🛑 BLOCKED: ${externalRefs.length} external reference(s) found. Cannot safely delete.`);
          resultLines.push(`\n  References that must be removed first:`);
          const refsByFile = new Map();
          for (const ref of externalRefs) {
            const fp = uriToPath(ref.uri);
            if (!refsByFile.has(fp)) refsByFile.set(fp, []);
            refsByFile.get(fp).push(ref);
          }
          for (const [fp, fileRefs] of refsByFile) {
            resultLines.push(`\n  ${fp}:`);
            for (const ref of fileRefs) {
              try {
                const c = readFileSync(fp, 'utf8');
                const lt = c.split('\n')[ref.range.start.line]?.trim() || '';
                resultLines.push(`    L${ref.range.start.line + 1}: ${lt}`);
              } catch { }
            }
          }
          resultLines.push(`\n  Options:`);
          resultLines.push(`  1. Remove references first, then retry safe delete`);
          resultLines.push(`  2. Use lsp_delete_symbol with deleteReferences=true for cascade delete`);
          return { content: [{ type: 'text', text: resultLines.join('\n') }] };
        }
      }

      case 'extractFunction': {
        const { startLine, endLine, functionName } = params;
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const start0 = startLine - 1;
        const end0 = endLine - 1;

        if (start0 < 0 || end0 >= lines.length || start0 > end0) {
          return { content: [{ type: 'text', text: `EXTRACT_FUNCTION: Invalid range L${startLine}-${endLine}` }] };
        }

        const selectedCode = lines.slice(start0, end0 + 1).join('\n');
        const resultLines = [`EXTRACT FUNCTION: "${functionName}" from ${filePath}:${startLine}-${endLine}`];

        // Tree-sitter CST: 确定性自由变量分析
        const tsQuery = await tsParseFile(filePath, content);
        const freeVarNames = tsQuery ? tsQuery.findFreeVariables(start0, end0) : [];
        const leadingWhitespace = lines[start0].match(/^(\s*)/)?.[1] || '';

        // LSP references: 判断选区内赋值的变量是否在选区后被引用 → 返回值
        const tsFnSigs = tsQuery ? tsQuery.extractFunctionSignatures() : [];
        const symbolsInSelection = tsFnSigs.filter(s =>
          s.range?.start?.line >= start0 && s.range?.end?.line <= end0
        );
        const assignedVars = new Set(symbolsInSelection.map(s => s.name));
        const returnVars = [];
        for (const varName of assignedVars) {
          try {
            const varSym = symbolsInSelection.find(s => s.name === varName);
            if (!varSym) continue;
            const refResp = await client.references(filePath, varSym.range.start.line + 1, varSym.range.start.column + 1);
            const refs = refResp?.result || [];
            const usedAfter = refs.some(r => r.range.start.line > end0);
            if (usedAfter) returnVars.push(varName);
          } catch { }
        }

        // LSP hover: 为每个自由变量推断类型
        const paramInfos = [];
        const seen = new Set();
        for (const varName of freeVarNames) {
          if (seen.has(varName)) continue;
          seen.add(varName);
          let typeInfo = 'unknown';
          for (let i = start0; i <= end0 && i < lines.length; i++) {
            const col = lines[i].indexOf(varName);
            if (col >= 0) {
              try {
                const hoverResp = await client.hover(filePath, i + 1, col + 1);
                const hoverText = getHoverText(hoverResp);
                const typeMatch = hoverText.match(/:\s*([^,\n]+)/);
                if (typeMatch) typeInfo = typeMatch[1].trim();
              } catch { }
              break;
            }
          }
          paramInfos.push({ name: varName, type: typeInfo });
        }

        // Step 4: Generate extraction plan
        const paramsList = paramInfos.map(p => `${p.name}: ${p.type}`).join(', ');
        const returnType = returnVars.length === 0 ? 'void'
          : returnVars.length === 1 ? 'inferred' : `[${returnVars.join(', ')}]`;

        resultLines.push(`\n=== Extraction Plan ===`);
        resultLines.push(`\nParameters (from outer scope):`);
        for (const p of paramInfos) {
          resultLines.push(`  - ${p.name}: ${p.type}`);
        }
        resultLines.push(`\nReturn value(s): ${returnVars.length ? returnVars.join(', ') : '(none — void)'}`);
        resultLines.push(`\n=== Generated Function ===`);
        resultLines.push(`\n${leadingWhitespace}function ${functionName}(${paramsList}): ${returnType} {`);
        resultLines.push(selectedCode.split('\n').map(l => leadingWhitespace + '  ' + l.trim()).join('\n'));
        if (returnVars.length) {
          resultLines.push(`${leadingWhitespace}  return ${returnVars.length > 1 ? `{ ${returnVars.join(', ')} }` : returnVars[0]};`);
        }
        resultLines.push(`${leadingWhitespace}}`);

        resultLines.push(`\n=== Replacement at L${startLine} ===`);
        const callArgs = paramInfos.map(p => p.name).join(', ');
        if (returnVars.length) {
          resultLines.push(`${leadingWhitespace}${returnVars.length > 1 ? `const { ${returnVars.join(', ')} }` : `const ${returnVars[0]}`} = ${functionName}(${callArgs});`);
        } else {
          resultLines.push(`${leadingWhitespace}${functionName}(${callArgs});`);
        }

        resultLines.push(`\n=== Execution Steps ===`);
        resultLines.push(`  1. Insert function definition after L${end0 + 1} (or in a utility file)`);
        resultLines.push(`  2. Replace L${startLine}-${endLine} with the call expression above`);
        resultLines.push(`  3. Run lsp_diagnostic to verify`);
        resultLines.push(`  4. Run lsp_organize_imports to clean up`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'inlineSymbol': {
        const { line, character } = params;
        const targetLine0 = line - 1;
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const resultLines = [`INLINE SYMBOL: ${filePath}:${line}`];

        // Step 1: Identify symbol and get definition
        const symResp = await client.documentSymbol(filePath);
        const targetSym = findSymbolAtPosition(symResp?.result || [], targetLine0);
        if (!targetSym) return { content: [{ type: 'text', text: 'INLINE: No symbol found at this position' }] };

        const kindName = kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`;
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const defCode = lines.slice(targetSym.range.start.line, targetSym.range.end.line + 1).join('\n');

        resultLines.push(`Symbol: ${kindName} "${targetSym.name}"`);
        resultLines.push(`Definition (${targetSym.range.end.line - targetSym.range.start.line + 1} lines):`);

        // Tree-sitter CST: 确定性提取函数体和参数
        const isFunction = [5, 6, 8, 9, 11, 12].includes(targetSym.kind);
        let inlineBody = defCode;
        let params = [];
        if (isFunction) {
          const tsQuery = await tsParseFile(filePath, content);
          if (tsQuery) {
            // Tree-sitter: 确定性提取函数签名和参数
            const fnSigs = tsQuery.extractFunctionSignatures();
            const fn = fnSigs.find(f => f.name === targetSym.name &&
              f.range.start.line === targetSym.range.start.line);
            if (fn) {
              params = fn.params.map(p => p.name);
              if (fn.bodyRange) {
                inlineBody = fn.bodyRange.text.trim();
              }
            }
          }
          if (params.length === 0 || inlineBody === defCode) {
            // 非 Tree-sitter 语言: LSP hover 提取参数
            try {
              const hoverResp = await client.hover(filePath, targetSym.range.start.line + 1, targetSym.selectionRange.start.character + 1);
              const hoverText = getHoverText(hoverResp);
              const sigLine = hoverText.split('\n')[0];
              const sigMatch = sigLine.match(/\(([^)]*)\)/);
              params = sigMatch ? sigMatch[1].split(',').map(p => {
                const parts = p.trim().split(/[:=]/);
                return parts[0].trim();
              }).filter(Boolean) : [];
            } catch { }
            // LSP selectionRange 定位签名结束 → 提取函数体
            const selEnd = targetSym.selectionRange || targetSym.range;
            for (let i = selEnd.end.line; i <= targetSym.range.end.line; i++) {
              const braceIdx = lines[i].indexOf('{', i === selEnd.end.line ? selEnd.end.character : 0);
              if (braceIdx >= 0) {
                const bodyStartOff = content.indexOf('{', lines.slice(0, i).join('\n').length + braceIdx);
                const bodyEndOff = content.lastIndexOf('}', content.length - 1);
                if (bodyStartOff >= 0 && bodyEndOff > bodyStartOff) {
                  inlineBody = content.substring(bodyStartOff + 1, bodyEndOff).trim();
                }
                break;
              }
            }
          }
          resultLines.push(`Parameters: ${params.length ? params.join(', ') : '(none)'}`);
        }

        // Tree-sitter CST: 确定性提取变量 RHS
        const isVariable = [13, 14].includes(targetSym.kind);
        if (isVariable) {
          const tsQuery = await tsParseFile(filePath, content);
          if (tsQuery) {
            const fnSigs = tsQuery.extractFunctionSignatures();
            // 变量不在 fnSigs 中, 用 CSTQuery.findAll 查找声明节点
            // 变量 RHS = selectionRange 结束后到行尾/分号
            const selEnd = targetSym.selectionRange?.end || targetSym.range.end;
            const lineAfterName = lines[selEnd.line].substring(selEnd.character);
            const eqIdx = lineAfterName.indexOf('=');
            if (eqIdx >= 0) {
              inlineBody = lineAfterName.substring(eqIdx + 1).replace(/;?\s*$/, '').trim();
            }
          } else {
            const selEnd = targetSym.selectionRange?.end || targetSym.range.end;
            const lineAfterName = lines[selEnd.line].substring(selEnd.character);
            const eqIdx = lineAfterName.indexOf('=');
            if (eqIdx >= 0) {
              inlineBody = lineAfterName.substring(eqIdx + 1).replace(/;?\s*$/, '').trim();
            }
          }
        }

        resultLines.push(`Inline body:\n  ${inlineBody.split('\n').join('\n  ')}`);

        // Step 2: Find all references
        const refResp = await client.references(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
        const refs = refResp?.result || [];
        const selfUri = fileToUri(pathResolve(filePath));
        const callSites = refs.filter(r => !(r.uri === selfUri && r.range.start.line === targetSym.range.start.line));

        resultLines.push(`\n=== Inline Plan (${callSites.length} call site(s)) ===`);
        for (const ref of callSites.slice(0, 50)) {
          const refFp = uriToPath(ref.uri);
          const refLine = ref.range.start.line + 1;
          try {
            const c = readFileSync(refFp, 'utf8');
            const lt = c.split('\n')[ref.range.start.line]?.trim() || '';
            resultLines.push(`  ${refFp}:${refLine}  ${lt}`);
          } catch { }
        }

        resultLines.push(`\n=== Execution Steps ===`);
        resultLines.push(`  1. Replace each call site with the inline body`);
        if (isFunction) resultLines.push(`  2. Substitute actual arguments for parameters in each inlined copy`);
        resultLines.push(`  ${isFunction ? '3' : '2'}. Delete definition at L${targetSym.range.start.line + 1}-${targetSym.range.end.line + 1}`);
        resultLines.push(`  ${isFunction ? '4' : '3'}. Run lsp_diagnostic to verify`);

        if (callSites.length > 10) {
          resultLines.push(`\n  ⚠ ${callSites.length} call sites — consider whether inlining is worth the code size increase`);
        }

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'extractInterface': {
        const { line, character, interfaceName } = params;
        const targetLine0 = line - 1;
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const resultLines = [`EXTRACT INTERFACE: "${interfaceName}" from ${filePath}:${line}`];

        // Step 1: Find class at position
        const symResp = await client.documentSymbol(filePath);
        const targetClass = findSymbolAtPosition(symResp?.result || [], targetLine0, [5]);
        if (!targetClass) return { content: [{ type: 'text', text: 'EXTRACT_INTERFACE: No class found at this position. Place cursor on a class.' }] };

        resultLines.push(`Class: "${targetClass.name}"  L${targetClass.range.start.line + 1}-${targetClass.range.end.line + 1}`);

        // Step 2: Get public/private members via LSP hover (language-agnostic visibility)
        const publicMembers = [];
        const privateMembers = [];
        const children = targetClass.children || [];
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const ext = extname(filePath);

        for (const child of children) {
          const defLine = lines[child.range?.start?.line] || '';
          const member = {
            name: child.name,
            kind: kindNames[child.kind - 1] || `Kind${child.kind}`,
            line: child.range.start.line + 1,
            code: defLine.trim(),
          };

          if (child.kind === 9) member.name = 'constructor';

          // LSP hover 判断可见性：hover 文本含 private/protected → 私有
          // Rust: hover 含 pub → 公开，不含 pub → 私有
          // Go: hover 显示导出状态
          // TS/JS: hover 含 private/protected/# → 私有
          let isPrivate;
          try {
            const hoverResp = await client.hover(filePath, child.range.start.line + 1, child.range.start.character + 1);
            const hoverText = getHoverText(hoverResp);
            if (ext === '.rs') {
              isPrivate = !/\bpub\b/.test(hoverText);
            } else if (ext === '.go') {
              // Go: 小写首字母 = 私有（在同一个包内可见）
              isPrivate = child.name.length > 0 && child.name[0] === child.name[0].toLowerCase() && child.name[0] !== '_';
            } else {
              isPrivate = /\b(private|protected)\b/.test(hoverText) || defLine.includes('#');
            }
          } catch {
            // hover 失败时 fallback 到行级正则
            isPrivate = /(?:private|protected|#)\b/.test(defLine);
          }

          if (isPrivate) {
            privateMembers.push(member);
          } else {
            publicMembers.push(member);
          }
        }

        // Tree-sitter CST: 确定性提取公开方法签名和属性类型
        const interfaceMembers = [];
        const tsQuery = await tsParseFile(filePath, content);
        const tsClassDefs = tsQuery ? tsQuery.extractClassDefinitions() : [];
        const tsClass = tsClassDefs.find(c => c.name === targetClass.name);
        const tsFnSigs = tsQuery ? tsQuery.extractFunctionSignatures() : [];

        for (const member of publicMembers) {
          let sig = member.code;
          if (tsQuery && tsClass) {
            // Tree-sitter: 从 CST 精确提取成员签名
            const tsMember = tsClass.members?.find(m => m.name === member.name);
            if (tsMember) {
              sig = tsMember.kind ? `${tsMember.kind} ${member.name}` : member.code;
            }
            // 函数成员: 用 Tree-sitter extractFunctionSignatures 获取精确签名
            const tsFn = tsFnSigs.find(f => f.name === member.name &&
              f.range.start.line >= targetClass.range.start.line &&
              f.range.end.line <= targetClass.range.end.line);
            if (tsFn) {
              const paramList = tsFn.params.map(p => `${p.name}${p.type ? ': ' + p.type : ''}`).join(', ');
              const retPart = tsFn.returnType ? `: ${tsFn.returnType}` : '';
              sig = `${member.name}(${paramList})${retPart}`;
            }
          }
          if (!tsQuery || !tsClass) {
            // 非 Tree-sitter 语言: LSP hover 提取
            try {
              const hoverResp = await client.hover(filePath, member.line, 1);
              const hoverText = getHoverText(hoverResp) || member.code;
              sig = hoverText.split('\n')[0]
                .replace(/^\s*(public\s+)?/, '')
                .replace(/\s*\{.*\}/, '')
                .replace(/\s*;\s*$/, '')
                .trim();
            } catch {
              sig = member.code;
            }
          }
          interfaceMembers.push({ ...member, signature: sig });
        }

        // Step 4: Generate interface
        resultLines.push(`\n=== Generated Interface ===`);
        resultLines.push(`\nexport interface ${interfaceName} {`);
        for (const m of interfaceMembers) {
          if (m.kind === 'Method' || m.kind === 'Constructor') {
            resultLines.push(`  ${m.signature};`);
          } else {
            // Property — strip the definition to just name: type
            const propSig = m.signature.replace(/^\s*(public\s+)?(readonly\s+)?/, '').replace(/\s*=\s*.+$/, '').replace(/;$/, '');
            resultLines.push(`  ${propSig};`);
          }
        }
        resultLines.push(`}`);

        // Step 5: Report what to change
        resultLines.push(`\n=== Class Changes ===`);
        resultLines.push(`  1. Add "implements ${interfaceName}" to class "${targetClass.name}"`);
        resultLines.push(`  2. Insert interface definition before the class or in a types file`);
        resultLines.push(`  3. Run lsp_diagnostic to verify the class conforms to the interface`);

        // Step 6: Find all places that reference this class — could use the interface instead
        const refResp = await client.references(filePath, targetClass.range.start.line + 1, targetClass.range.start.character + 1);
        const refs = refResp?.result || [];
        const selfUri = fileToUri(pathResolve(filePath));
        const externalRefs = refs.filter(r => !(r.uri === selfUri));

        if (externalRefs.length) {
          resultLines.push(`\n=== Opportunities to use ${interfaceName} instead of ${targetClass.name} ===`);
          const refsByFile = new Map();
          for (const ref of externalRefs) {
            const fp = uriToPath(ref.uri);
            if (!refsByFile.has(fp)) refsByFile.set(fp, []);
            refsByFile.get(fp).push(ref);
          }
          for (const [fp, fileRefs] of refsByFile) {
            resultLines.push(`  ${fp} (${fileRefs.length} ref${fileRefs.length > 1 ? 's' : ''})`);
          }
        }

        if (privateMembers.length) {
          resultLines.push(`\n=== Private Members (excluded from interface) ===`);
          for (const m of privateMembers) {
            resultLines.push(`  ${m.kind} "${m.name}"  L${m.line}`);
          }
        }

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'dependencyGraph': {
        const { direction = 'both' } = params;
        const resultLines = [`DEPENDENCY GRAPH: ${filePath}`];

        const symResp = await client.documentSymbol(filePath);
        const allSymbols = flattenSymbols(symResp?.result || []);

        // Step 1: Outgoing — Tree-sitter CST 确定性提取 import 列表 → LSP goToDefinition 语义解析路径
        const outgoingDeps = new Map(); // targetFile → Set<symbolName>
        if (direction === 'both' || direction === 'outgoing') {
          const thisFileAbs = pathResolve(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const tsQuery = await tsParseFile(filePath, content);

          if (tsQuery) {
            // Tree-sitter: 确定性提取所有 import 语句
            const imports = tsQuery.extractImports();
            for (const imp of imports) {
              // 对 import 中的标识符 goToDefinition → 精确目标文件
              try {
                // 从 import 范围内找符号，LSP 解析定义位置
                const defResp = await client.sendRequest('textDocument/definition', {
                  textDocument: { uri: fileToUri(filePath) },
                  position: { line: imp.range.start.line, character: imp.range.start.column },
                });
                const locations = Array.isArray(defResp?.result) ? defResp.result : defResp?.result ? [defResp.result] : [];
                for (const loc of locations) {
                  const targetPath = uriToPath(loc.uri || '');
                  if (!targetPath || targetPath === thisFileAbs) continue;
                  if (!outgoingDeps.has(targetPath)) outgoingDeps.set(targetPath, new Set());
                  outgoingDeps.get(targetPath).add(imp.path);
                }
              } catch { }
            }
          } else {
            // 非 Tree-sitter 支持语言 → 回退到 LSP symbol goToDefinition
            for (const sym of allSymbols.slice(0, 50)) {
              try {
                const defResp = await client.sendRequest('textDocument/definition', {
                  textDocument: { uri: fileToUri(filePath) },
                  position: { line: sym.selectionRange.start.line, character: sym.selectionRange.start.character },
                });
                const locations = Array.isArray(defResp?.result) ? defResp.result : defResp?.result ? [defResp.result] : [];
                for (const loc of locations) {
                  const targetPath = uriToPath(loc.uri || '');
                  if (!targetPath || targetPath === thisFileAbs) continue;
                  if (!outgoingDeps.has(targetPath)) outgoingDeps.set(targetPath, new Set());
                  outgoingDeps.get(targetPath).add(sym.name);
                }
              } catch { }
            }
          }
        }

        // Step 2: Incoming — references on every top-level symbol, collect cross-file sources
        const incomingDeps = new Map(); // sourceFile → Set<symbolName>
        if (direction === 'both' || direction === 'incoming') {
          const thisFileAbs = pathResolve(filePath);
          for (const sym of allSymbols.slice(0, 30)) {
            try {
              const refResp = await client.references(filePath, sym.selectionRange.start.line + 1, sym.selectionRange.start.character + 1);
              const refs = refResp?.result || [];
              for (const ref of refs) {
                const sourcePath = uriToPath(ref.uri || '');
                if (!sourcePath || sourcePath === thisFileAbs) continue;
                if (!incomingDeps.has(sourcePath)) incomingDeps.set(sourcePath, new Set());
                incomingDeps.get(sourcePath).add(sym.name);
              }
            } catch { }
          }
        }

        // Step 3: Build Mermaid graph
        const baseName = basename(filePath, extname(filePath));
        const safeId = (name) => name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, 'mod_');
        const thisId = safeId(baseName);

        resultLines.push(`\n=== Outgoing Dependencies (${outgoingDeps.size}) ===`);
        for (const [targetPath, syms] of outgoingDeps) {
          resultLines.push(`  → ${targetPath} (via ${[...syms].slice(0, 5).join(', ')}${syms.size > 5 ? '...' : ''})`);
        }

        resultLines.push(`\n=== Incoming Dependencies (${incomingDeps.size}) ===`);
        for (const [sourcePath, syms] of incomingDeps) {
          resultLines.push(`  ← ${sourcePath} (uses ${[...syms].slice(0, 5).join(', ')}${syms.size > 5 ? '...' : ''})`);
        }

        resultLines.push(`\n=== Dependency Graph (Mermaid) ===`);
        resultLines.push('```mermaid');
        resultLines.push(`graph ${direction === 'incoming' ? 'BT' : 'TD'}`);
        for (const [targetPath] of outgoingDeps) {
          const depBase = basename(targetPath, extname(targetPath));
          resultLines.push(`  ${thisId} --> ${safeId(depBase)}`);
        }
        for (const [sourcePath] of incomingDeps) {
          const depBase = basename(sourcePath, extname(sourcePath));
          resultLines.push(`  ${safeId(depBase)} --> ${thisId}`);
        }
        resultLines.push('```');

        resultLines.push(`\n=== Summary ===`);
        resultLines.push(`  Outgoing dependencies: ${outgoingDeps.size}`);
        resultLines.push(`  Incoming dependents: ${incomingDeps.size}`);
        resultLines.push(`  Coupling score: ${outgoingDeps.size + incomingDeps.size} (lower is better)`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'callGraph': {
        const { line, character, depth = 3 } = params;
        const targetLine0 = line - 1;
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const resultLines = [`CALL GRAPH: ${filePath}:${line}`];

        // Step 1: Identify the function
        const symResp = await client.documentSymbol(filePath);
        const targetSym = findSymbolAtPosition(symResp?.result || [], targetLine0, [5, 6, 8, 9, 11, 12]);
        if (!targetSym) return { content: [{ type: 'text', text: 'CALL_GRAPH: No symbol found at this position' }] };

        const kindName = kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`;
        if (![5, 6, 8, 9, 11, 12].includes(targetSym.kind)) {
          return { content: [{ type: 'text', text: `CALL_GRAPH: Symbol is a ${kindName}, not a function/method. Place cursor on a function.` }] };
        }

        resultLines.push(`Function: ${kindName} "${targetSym.name}"  L${targetSym.range.start.line + 1}-${targetSym.range.end.line + 1}`);

        // Step 2: Trace outgoing calls (what does this function call)
        const visited = new Set();
        const mermaidLines = ['graph TD'];
        const safeName = targetSym.name.replace(/[^a-zA-Z0-9]/g, '_');

        async function traceOutgoing(fp, sym, currentDepth, prefix) {
          if (currentDepth <= 0) return;
          const key = `${fp}:${sym.name}`;
          if (visited.has(key)) return;
          visited.add(key);

          // Get outgoing calls via call hierarchy
          try {
            const prepResp = await client.prepareCallHierarchy(fp, sym.range.start.line + 1, sym.range.start.character + 1);
            const items = prepResp?.result || [];
            if (!items.length) return;

            const callResp = await client.outgoingCalls(items[0]);
            const callees = callResp?.result || [];

            for (const callee of callees) {
              const calleeFp = uriToPath(callee.to.uri);
              const calleeLine = callee.from.range.start.line + 1;
              const calleeName = callee.to.name;
              const calleeSafeName = calleeName.replace(/[^a-zA-Z0-9]/g, '_');

              resultLines.push(`${prefix}→ ${calleeName}  ${calleeFp}:${calleeLine}`);
              mermaidLines.push(`  ${safeName} --> ${calleeSafeName}`);

              // Recurse — find the callee's symbol to get its range
              try {
                const calleeSymResp = await client.documentSymbol(calleeFp);
                const calleeSymbols = calleeSymResp?.result || [];
                let calleeSym = null;
                for (const s of calleeSymbols) {
                  if (s.name === calleeName) { calleeSym = s; break; }
                  if (s.children) for (const c of s.children) {
                    if (c.name === calleeName) { calleeSym = c; break; }
                  }
                }
                if (calleeSym) {
                  await traceOutgoing(calleeFp, calleeSym, currentDepth - 1, prefix + '  ');
                }
              } catch { }
            }
          } catch {
            resultLines.push(`${prefix}(callHierarchy not supported)`);
          }
        }

        // Step 3: Trace incoming calls (who calls this function)
        resultLines.push(`\n=== Incoming Calls (callers) ===`);
        try {
          const prepResp = await client.prepareCallHierarchy(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
          const items = prepResp?.result || [];
          if (items.length) {
            const callResp = await client.incomingCalls(items[0]);
            const callers = callResp?.result || [];
            for (const caller of callers.slice(0, 30)) {
              const callerFp = uriToPath(caller.from.uri);
              resultLines.push(`  ← ${caller.from.name}  ${callerFp}:${caller.from.range.start.line + 1}`);
              const callerSafeName = caller.from.name.replace(/[^a-zA-Z0-9]/g, '_');
              mermaidLines.push(`  ${callerSafeName} --> ${safeName}`);
            }
            resultLines.push(`  Total callers: ${callers.length}`);
          }
        } catch { }

        // Step 4: Outgoing calls (what this function calls)
        resultLines.push(`\n=== Outgoing Calls (callees) ===`);
        await traceOutgoing(filePath, targetSym, depth, '  ');

        // Step 5: Mermaid graph
        resultLines.push(`\n=== Call Graph (Mermaid) ===`);
        resultLines.push('```mermaid');
        resultLines.push(...mermaidLines);
        resultLines.push('```');

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

      case 'propagateChange': {
        const { line, character, changeDescription } = params;
        const targetLine0 = line - 1;
        const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
        const resultLines = [`PROPAGATE CHANGE: ${filePath}:${line}`];
        resultLines.push(`Change: ${changeDescription}`);

        // Step 1: Identify symbol
        const symResp = await client.documentSymbol(filePath);
        const targetSym = findSymbolAtPosition(symResp?.result || [], targetLine0);
        if (!targetSym) return { content: [{ type: 'text', text: 'PROPAGATE: No symbol found at this position' }] };

        const kindName = kindNames[targetSym.kind - 1] || `Kind${targetSym.kind}`;
        resultLines.push(`Symbol: ${kindName} "${targetSym.name}"`);

        // Step 2: Direct references
        const refResp = await client.references(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
        const refs = refResp?.result || [];
        const selfUri = fileToUri(pathResolve(filePath));
        const directRefs = refs.filter(r => !(r.uri === selfUri && r.range.start.line === targetSym.range.start.line));

        // Step 3: Implementations (if interface/abstract)
        let impls = [];
        try {
          const implResp = await client.implementations(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
          impls = Array.isArray(implResp?.result) ? implResp.result : implResp?.result ? [implResp.result] : [];
        } catch { }

        // Step 4: Type definition (if type-related change)
        let typeLocs = [];
        try {
          const typeDefResp = await client.typeDefinition(filePath, targetSym.range.start.line + 1, targetSym.range.start.character + 1);
          typeLocs = Array.isArray(typeDefResp?.result) ? typeDefResp.result : typeDefResp?.result ? [typeDefResp.result] : [];
        } catch { }

        // Step 5: For each implementation, also find their references
        const cascadeRefs = new Map();
        for (const impl of impls) {
          const implFp = uriToPath(impl.uri);
          try {
            const implRefResp = await client.references(implFp, impl.range.start.line + 1, impl.range.start.character + 1);
            const implRefs = implRefResp?.result || [];
            if (implRefs.length) cascadeRefs.set(implFp, implRefs);
          } catch { }
        }

        // Step 6: Build propagation report
        resultLines.push(`\n=== Wave 1: Direct Consumers (${directRefs.length}) ===`);
        const refsByFile = new Map();
        for (const ref of directRefs) {
          const fp = uriToPath(ref.uri);
          if (!refsByFile.has(fp)) refsByFile.set(fp, []);
          refsByFile.get(fp).push(ref);
        }
        for (const [fp, fileRefs] of refsByFile) {
          resultLines.push(`  ${fp} (${fileRefs.length} ref${fileRefs.length > 1 ? 's' : ''})`);
          for (const ref of fileRefs.slice(0, 3)) {
            try {
              const c = readFileSync(fp, 'utf8');
              const lt = c.split('\n')[ref.range.start.line]?.trim() || '';
              resultLines.push(`    L${ref.range.start.line + 1}: ${lt}`);
            } catch { }
          }
        }

        if (impls.length) {
          resultLines.push(`\n=== Wave 2: Implementations (${impls.length}) ===`);
          for (const impl of impls) {
            const fp = uriToPath(impl.uri);
            resultLines.push(`  ${fp}:${impl.range.start.line + 1}`);
          }
        }

        if (cascadeRefs.size) {
          resultLines.push(`\n=== Wave 3: Implementation Consumers (cascade) ===`);
          let totalCascade = 0;
          for (const [fp, refs] of cascadeRefs) {
            totalCascade += refs.length;
            resultLines.push(`  ${fp}: ${refs.length} consumer(s)`);
          }
          resultLines.push(`  Total cascade references: ${totalCascade}`);
        }

        if (typeLocs.length) {
          resultLines.push(`\n=== Type Definitions Affected ===`);
          for (const loc of typeLocs) {
            const fp = uriToPath(loc.uri);
            resultLines.push(`  ${fp}:${loc.range.start.line + 1}`);
          }
        }

        // Summary
        const totalWaves = directRefs.length + impls.length;
        const totalCascade = Array.from(cascadeRefs.values()).reduce((sum, r) => sum + r.length, 0);
        resultLines.push(`\n=== Propagation Summary ===`);
        resultLines.push(`  Wave 1 (direct): ${directRefs.length} references in ${refsByFile.size} files`);
        if (impls.length) resultLines.push(`  Wave 2 (implementations): ${impls.length} classes`);
        if (totalCascade) resultLines.push(`  Wave 3 (cascade): ${totalCascade} references`);
        resultLines.push(`  Total propagation scope: ${directRefs.length + impls.length + totalCascade} impact points`);

        // Execution plan
        resultLines.push(`\n=== Execution Plan ===`);
        resultLines.push(`  1. Apply change to definition at ${filePath}:${line}`);
        if (impls.length) resultLines.push(`  2. Update ${impls.length} implementation(s) to match`);
        resultLines.push(`  ${impls.length ? '3' : '2'}. Fix Wave 1 references (${directRefs.length} in ${refsByFile.size} files)`);
        if (totalCascade) resultLines.push(`  ${impls.length ? '4' : '3'}. Fix Wave 3 cascade references (${totalCascade})`);
        resultLines.push(`  ${impls.length ? (totalCascade ? '5' : '4') : (totalCascade ? '4' : '3')}. Run lsp_diagnostic on all affected files`);

        return { content: [{ type: 'text', text: resultLines.join('\n') }] };
      }

        return { content: [{ type: 'text', text: `Unknown operation: ${operation}` }] };
    }
  } catch (err) {
    const [lang] = detectLspServer(filePath) || [];
    if (lang) clientPool.delete(`${lang}:${projectRoot}`);
    return { content: [{ type: 'text', text: `ERROR: LSP [${lang || '?'}] operation '${operation}' failed: ${err.message}\n${err.stack?.split('\n').slice(1,4).join('\n')}` }] };
  }
}

// === MCP Server ===

// 位置解析中间件：symbolName 优先，自动解析为 line+character
async function resolvePosition(p) {
  if (p.symbolName && (!p.line || !p.character)) {
    const r = await resolveSymbol(p.filePath, p.symbolName);
    if (!r) return { content: [{ type: 'text', text: `Symbol "${p.symbolName}" not found in ${p.filePath}. Use line+character instead.` }] };
    p.line = r.line;
    p.character = r.character;
    if (!p.endLine) p.endLine = r.endLine;
    return null;
  }
  return null;
}

// === 0. 符号画像 — 替代内置 hover+goToDefinition+findReferences+goToImplementation ===

export function registerLspTools(server) {

server.tool('lsp_symbol_profile',
  '符号完整画像：类型签名+定义位置+所有引用+接口实现类。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().describe('符号名（如函数名、类名、变量名）。自动解析位置，无需传 line/character'),
    line: z.number().optional().describe('行号（1-indexed，可选，不传则用 symbolName 自动定位）'),
    character: z.number().optional().describe('列号（1-indexed，可选）'),
  },
  async (p) => {
    const err = await resolvePosition(p);
    if (err) return err;
    const client = await detectAndGetClient(p.filePath);
    if (!client) return { content: [{ type: 'text', text: `No LSP server for ${p.filePath}` }] };
    const { line, character, filePath } = p;
    const out = [`SYMBOL PROFILE: ${p.symbolName || `@${line}:${character}`}`];
    const kindNames = ['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','EnumMember','Struct','Event','Operator','TypeParameter'];

    // hover
    try {
      const hoverResp = await client.hover(filePath, line, character);
      const text = getHoverText(hoverResp);
      if (text) { out.push(`\n=== Type Signature ===`); out.push(text); }
    } catch {}

    // definition
    try {
      const defResp = await client.definition(filePath, line, character);
      const locs = defResp?.result;
      if (locs) {
        const arr = Array.isArray(locs) ? locs : locs.uri ? [locs] : [];
        if (arr.length) {
          out.push(`\n=== Definition (${arr.length}) ===`);
          for (const l of arr.slice(0, 10)) {
            const uri = l.uri || l.targetUri;
            const range = l.range || l.targetRange;
            if (uri) out.push(`  ${uri.replace(/^file:\/\//, '')}${range ? `:${range.start.line + 1}:${range.start.character + 1}` : ''}`);
          }
        }
      }
    } catch {}

    // references
    try {
      const refResp = await client.references(filePath, line, character);
      const refs = refResp?.result || [];
      if (refs.length) {
        out.push(`\n=== References (${refs.length}) ===`);
        for (const r of refs.slice(0, 30)) {
          out.push(`  ${r.uri.replace(/^file:\/\//, '')}:${r.range.start.line + 1}:${r.range.start.character + 1}`);
        }
        if (refs.length > 30) out.push(`  ... and ${refs.length - 30} more`);
      } else {
        out.push(`\n=== References: none ===`);
      }
    } catch {}

    // implementations
    try {
      const implResp = await client.implementations(filePath, line, character);
      const impls = implResp?.result || [];
      if (impls.length) {
        out.push(`\n=== Implementations (${impls.length}) ===`);
        for (const i of impls.slice(0, 20)) {
          out.push(`  ${i.uri.replace(/^file:\/\//, '')}:${i.range.start.line + 1}:${i.range.start.character + 1}`);
        }
      }
    } catch {}

    return { content: [{ type: 'text', text: out.join('\n') }] };
  });

// === A. 代码操作引擎 ===

server.tool('lsp_code_action',
  '代码操作：rename|organizeImports|format|quickFix|addImport。',
  {
    action: z.enum(['rename', 'organizeImports', 'format', 'quickFix', 'addImport']).describe('操作类型'),
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('[rename/quickFix] 符号名。自动解析位置，无需传 line/character'),
    newName: z.string().optional().describe('[rename] 新名称'),
    startLine: z.number().optional().describe('[format] 起始行号（不传=全文件）'),
    endLine: z.number().optional().describe('[format] 结束行号'),
    line: z.number().optional().describe('[rename/quickFix] 行号（可选，有 symbolName 则自动定位）'),
    character: z.number().optional().describe('[rename/quickFix] 列号'),
    actionKind: z.string().optional().describe('[quickFix] 操作类型过滤'),
    endCharacter: z.number().optional().describe('[quickFix] 结束列号'),
    importName: z.string().optional().describe('[addImport] 要导入的符号名'),
  },
  async (p) => {
    const err = await resolvePosition(p);
    if (err) return err;
    const { action } = p;
    switch (action) {
      case 'rename': return lspCall('rename', p);
      case 'organizeImports': return lspCall('organizeImports', p);
      case 'format': return lspCall('format', p);
      case 'quickFix': return lspCall('applyCodeAction', p);
      case 'addImport': return lspCall('addImport', p);
    }
  });

// === B. 签名/类型/移动 ===

server.tool('lsp_change_signature',
  '修改函数签名并同步所有调用点。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('函数名。自动定位，无需传 line/character'),
    line: z.number().optional().describe('函数所在行号（可选）'),
    character: z.number().optional().describe('函数名起始列号（可选）'),
    newSignature: z.string().describe('新的函数签名（如 "function foo(a: number, b: string): boolean"）'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('changeSignature', p); });

server.tool('lsp_change_type',
  '修改类型定义并生成影响传播报告。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('类型名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
    newType: z.string().describe('新的类型表达式（如 "string | null"、"MyNewType"）'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('changeType', p); });

server.tool('lsp_move_symbol',
  '移动符号到目标文件并生成迁移计划。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('符号名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
    targetFile: z.string().describe('目标文件绝对路径'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('moveSymbol', p); });

// === C. 提取/内联 ===

server.tool('lsp_extract_function',
  '提取代码范围为独立函数，自动分析自由变量→参数、返回值→类型。',
  { filePath: z.string().describe('源文件绝对路径'), startLine: z.number().describe('起始行号（1-indexed）'), endLine: z.number().describe('结束行号（1-indexed）'), functionName: z.string().describe('新函数名') },
  async (p) => lspCall('extractFunction', p));

server.tool('lsp_inline_symbol',
  '内联符号到所有调用点。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('符号名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('inlineSymbol', p); });

server.tool('lsp_extract_interface',
  '从类提取interface定义，自动获取公开方法类型签名。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('类名。自动定位'),
    line: z.number().optional().describe('类所在行号（可选）'),
    character: z.number().optional().describe('类名列号（可选）'),
    interfaceName: z.string().describe('新接口名'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('extractInterface', p); });

// === D. 删除/替换 ===

server.tool('lsp_safe_delete',
  '安全删除符号：先检查引用，无引用直接删除，有引用列阻塞点。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('符号名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
    force: z.boolean().default(false).describe('true=级联删除所有引用'),
    oldText: z.string().optional().describe('批量替换：旧文本'),
    newText: z.string().optional().describe('批量替换：新文本'),
  },
  async (p) => {
    const err = await resolvePosition(p);
    if (err) return err;
    if (p.oldText && p.newText) return lspCall('editReferences', p);
    if (p.force) return lspCall('deleteSymbol', { ...p, deleteReferences: true });
    return lspCall('safeDelete', p);
  });

// === E. 分析引擎 ===

server.tool('lsp_trace_origin',
  '递归追踪符号调用链和数据来源，默认5层。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('符号名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
    depth: z.number().default(5).describe('递归深度（默认5层）'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('traceOrigin', p); });

server.tool('lsp_impact_analysis',
  '修改符号的影响范围：下游消费者数+实现类+依赖链+Mermaid影响图+风险评级。删除或重构前必调。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('符号名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('impactAnalysis', p); });

server.tool('lsp_find_dead_code',
  '扫描文件找出死代码：无引用函数、未使用变量、不可达导出。',
  { filePath: z.string().describe('源文件绝对路径') },
  async (p) => lspCall('findDeadCode', p));

server.tool('lsp_call_graph',
  '函数调用关系图(Mermaid)。',
  {
    filePath: z.string().describe('源文件绝对路径'),
    symbolName: z.string().optional().describe('函数名。自动定位'),
    line: z.number().optional().describe('行号（可选）'),
    character: z.number().optional().describe('列号（可选）'),
    depth: z.number().default(3).describe('递归深度（默认3层）'),
  },
  async (p) => { const err = await resolvePosition(p); if (err) return err; return lspCall('callGraph', p); });

server.tool('lsp_dependency_graph',
  '模块依赖关系图(Mermaid)。',
  { filePath: z.string().describe('源文件绝对路径'), direction: z.enum(['outgoing', 'incoming', 'both']).default('both').describe('outgoing=依赖 | incoming=被依赖 | both=双向') },
  async (p) => lspCall('dependencyGraph', p));

server.tool('lsp_data_query',
  '配置文件分析：scan=键值对 | trace=字符串引用 | graph=依赖拓扑图。',
  {
    mode: z.enum(['scan', 'trace', 'graph']).describe('scan=扫描配置文件 | trace=追踪字符串引用 | graph=文件依赖图'),
    path: z.string().describe('scan/graph=目录路径 | trace=起始文件或目录'),
    query: z.string().optional().describe('trace 模式必填：要追踪的字符串'),
    extensions: z.array(z.string()).default(['.yaml', '.yml', '.json', '.toml', '.conf', '.ini', '.env', '.properties']).describe('scan 模式：文件扩展名'),
    depth: z.number().default(5).describe('graph 模式：依赖追踪深度'),
  },
  async (p) => lspCall('dataQuery', p));

// === 启动时预热当前项目 LSP ===

async function warmupProject() {
  const cwd = process.cwd();

  const foundExts = new Set();
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) foundExts.add(extname(entry.name));
    }
  } catch { return; }

  for (const [language, config] of Object.entries(LSP_SERVERS)) {
    const hasMatchingFiles = config.exts.some(ext => foundExts.has(ext));
    if (!hasMatchingFiles) continue;

    try {
      await getOrCreateClient(language, cwd);
    } catch {
      // daemon 启动失败，跳过
    }
  }
}

} // end registerLspTools
