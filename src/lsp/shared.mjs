/**
 * LSP 共享模块 — 被 daemon.mjs 和 index.mjs (MCP Server) 共用
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { extname, dirname, basename, join, resolve as pathResolve } from 'path';
import { homedir, tmpdir, userInfo } from 'os';
import { connect as netConnect } from 'net';
import { fileURLToPath } from 'url';

// === LSP Server 配置 ===

export const LSP_SERVERS = {
  typescript: {
    cmd: ['typescript-language-server', '--stdio'],
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    langId: { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mts: 'typescript', cts: 'typescript', mjs: 'javascript', cjs: 'javascript' },
    install: { type: 'npm', package: 'typescript-language-server' },
  },
  go: {
    cmd: ['gopls', 'serve'],
    exts: ['.go'],
    langId: { go: 'go' },
    install: { type: 'go', package: 'golang.org/x/tools/gopls@latest' },
  },
  clangd: {
    cmd: ['clangd'],
    exts: ['.c', '.cpp', '.h', '.hpp', '.cc', '.cxx', '.hxx'],
    langId: {},
    install: { type: 'apt', package: 'clangd' },
  },
  rust: {
    cmd: ['rust-analyzer'],
    exts: ['.rs'],
    langId: { rs: 'rust' },
    install: { type: 'cargo', package: 'rust-analyzer' },
  },
  python: {
    cmd: ['pyright-langserver', '--stdio'],
    exts: ['.py'],
    langId: { py: 'python' },
    install: { type: 'npm', package: 'pyright' },
  },
  markdown: {
    cmd: [join(homedir(), 'bin', 'marksman'), 'server'],
    exts: ['.md', '.markdown'],
    langId: { md: 'markdown', markdown: 'markdown' },
    install: { type: 'github-release', repo: 'artempyanykh/marksman', binary: 'marksman' },
  },
  zig: {
    cmd: ['zls', '--stdio'],
    exts: ['.zig', '.zon'],
    langId: { zig: 'zig', zon: 'zig' },
    install: { type: 'npm', package: 'zls' },
  },
};

const _extMap = new Map();
for (const [name, config] of Object.entries(LSP_SERVERS)) {
  for (const ext of config.exts) {
    _extMap.set(ext, [name, config]);
  }
}

// === 工具函数 ===

export function detectLspServer(filePath) {
  const ext = extname(filePath);
  return _extMap.get(ext) || [null, null];
}

export function fileToUri(filePath) {
  return `file://${pathResolve(filePath)}`;
}

export function uriToPath(uri) {
  return uri.replace(/^file:\/\//, '');
}

export function findProjectRoot(filePath) {
  const markers = [
    // JS/TS
    'package.json', 'tsconfig.json', 'deno.json', 'bun.lockb', 'pnpm-workspace.yaml',
    // Rust
    'Cargo.toml',
    // Go
    'go.mod',
    // Python
    'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'poetry.lock', 'uv.lock',
    // Java/Kotlin/Scala
    'pom.xml', 'build.gradle', 'build.gradle.kts', '.gradle',
    // C/C++
    'CMakeLists.txt', 'Makefile', 'meson.build', 'conanfile.txt', 'conanfile.py',
    // .NET
    '*.sln', 'global.json',
    // Ruby
    'Gemfile',
    // PHP
    'composer.json',
    // Elixir/Erlang
    'mix.exs', 'rebar.config',
    // Swift/ObjC
    'Package.swift', 'Podfile',
    // Zig
    'build.zig',
    // Haskell
    'cabal.project', 'stack.yaml',
    // Dart/Flutter
    'pubspec.yaml',
    // Generic
    '.git',
  ];
  let dir = dirname(pathResolve(filePath));
  while (dir !== '/' && dir) {
    for (const marker of markers) {
      if (existsSync(`${dir}/${marker}`)) {
        try { return realpathSync(dir); } catch { return dir; }
      }
    }
    dir = dirname(dir);
  }
  try { return realpathSync(dirname(pathResolve(filePath))); } catch { return dirname(pathResolve(filePath)); }
}

export function hashCwd(cwd) {
  let resolved;
  try { resolved = realpathSync(cwd); } catch { resolved = cwd; }
  let h = 0;
  for (let i = 0; i < resolved.length; i++) {
    h = ((h << 5) - h + resolved.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export function getUid() {
  try { return process.getuid(); } catch {
    let h = 0;
    for (let i = 0; i < userInfo().username.length; i++) {
      h = ((h << 5) - h + userInfo().username.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }
}

export function socketPath(language, cwd) {
  return join(tmpdir(), `lsp-${language}-${hashCwd(cwd)}-${getUid()}.sock`);
}

export function pidPath(language, cwd) {
  return join(tmpdir(), `lsp-${language}-${hashCwd(cwd)}-${getUid()}.pid`);
}

export function getDaemonPath() {
  return pathResolve(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs');
}

// === LSP 消息解析 ===

export function parseLspMessages(buffer) {
  const messages = [];
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.toString('utf8', 0, headerEnd);
    let contentLength = 0;
    for (const line of header.split('\r\n')) {
      if (line.startsWith('Content-Length:')) {
        contentLength = parseInt(line.split(':')[1].trim());
      }
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) break;

    const rawBody = buffer.toString('utf8', bodyStart, bodyEnd);
    buffer = buffer.subarray(bodyEnd);

    try {
      messages.push({ msg: JSON.parse(rawBody), rawBody });
    } catch {
      // malformed JSON — skip
    }
  }
  return { messages, remaining: buffer };
}

export function encodeLspMessage(msg) {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

export function encodeRawLspMessage(rawBody) {
  return `Content-Length: ${Buffer.byteLength(rawBody)}\r\n\r\n${rawBody}`;
}

const MAX_BUFFER = 10 * 1024 * 1024;
const KEEP_TAIL = 1024 * 1024;

export function trimBuffer(buffer) {
  if (buffer.length <= MAX_BUFFER) return buffer;
  return Buffer.from(buffer.subarray(buffer.length - KEEP_TAIL));
}

export function isSocketAlive(sockPath) {
  return new Promise((resolve) => {
    const s = netConnect(sockPath);
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
}

// === LSP Client 能力声明 ===

export const CLIENT_CAPABILITIES = {
  textDocument: {
    rename: { prepareSupport: true },
    synchronization: { didOpen: true, didChange: true, didClose: true },
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.addMissingImports'] } } },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true, versionSupport: true, codeDescriptionSupport: true, dataSupport: true },
  },
  workspace: { workspaceFolders: true, applyEdit: true, symbol: { dynamicRegistration: false } },
};

// === Workspace 管理 ===

// workspace 管理 — 新架构中不再需要，保留空导出以防 launcher 引用
export function addWorkspaceFolder() {}
export function removeWorkspaceFolder() {}

// === 文件指纹（mtimeMs + size 替代 sha256）===

export function getFileFingerprint(filePath) {
  const stat = statSync(filePath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

export function fingerprintEqual(a, b) {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

// === 文档同步 ===

export function buildOpenDocNotification(filePath) {
  const absPath = pathResolve(filePath);
  const uri = fileToUri(filePath);
  const content = readFileSync(absPath, 'utf8');
  const fingerprint = getFileFingerprint(absPath);
  const ext = extname(filePath).slice(1);
  const [, config] = detectLspServer(filePath);
  const langId = config?.langId?.[ext] || ext;
  return { uri, content, fingerprint, langId };
}

export function syncDocument(client, uri, content, fingerprint, langId, openedDocs) {
  const existing = openedDocs.get(uri);
  if (existing && fingerprintEqual(existing.fingerprint, fingerprint)) return;

  if (existing) {
    existing.version++;
    existing.fingerprint = fingerprint;
    client.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text: content }],
    });
  } else {
    openedDocs.set(uri, { version: 1, fingerprint });
    client.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: langId, version: 1, text: content },
    });
  }
}

// 首次 open 时扫描同目录文件（LSP Server 需要同目录文件做跨文件分析）
const MAX_SIBLINGS = 30;

export function syncSiblingFiles(client, filePath, openedDocs) {
  const absPath = pathResolve(filePath);
  const [, config] = detectLspServer(filePath);
  if (!config) return;

  const dir = dirname(absPath);
  let entries;
  try { entries = readdirSync(dir); } catch { return; }

  let synced = 0;
  for (const entry of entries) {
    if (synced >= MAX_SIBLINGS) break;
    if (entry === basename(absPath)) continue;
    const siblingExt = extname(entry);
    if (!config.exts.includes(siblingExt)) continue;

    const siblingPath = `${dir}/${entry}`;
    if (!existsSync(siblingPath)) continue;

    const siblingUri = `file://${siblingPath}`;
    try {
      const siblingFingerprint = getFileFingerprint(siblingPath);
      const existing = openedDocs.get(siblingUri);
      if (existing && fingerprintEqual(existing.fingerprint, siblingFingerprint)) continue;

      const siblingContent = readFileSync(siblingPath, 'utf8');
      const siblingExtKey = siblingExt.slice(1);
      const siblingLangId = config?.langId?.[siblingExtKey] || siblingExtKey;
      syncDocument(client, siblingUri, siblingContent, siblingFingerprint, siblingLangId, openedDocs);
      synced++;
    } catch {
      // 文件可能被删除，跳过
    }
  }
}

// === WorkspaceEdit 应用 ===

function applyEditsToLines(lines, edits) {
  const sorted = [...edits].sort((a, b) => {
    const al = a.range.start.line, bl = b.range.start.line;
    if (al !== bl) return bl - al;
    return b.range.start.character - a.range.start.character;
  });

  for (const te of sorted) {
    const sl = te.range.start.line, sc = te.range.start.character;
    const el = te.range.end.line, ec = te.range.end.character;
    if (sl === el) {
      lines[sl] = lines[sl].slice(0, sc) + te.newText + lines[sl].slice(ec);
    } else {
      const before = lines[sl].slice(0, sc);
      const after = lines[el].slice(ec);
      const newLines = te.newText.split('\n');
      const replacement = [before + newLines[0]];
      if (newLines.length > 1) {
        replacement.push(...newLines.slice(1, -1));
        replacement.push(newLines[newLines.length - 1] + after);
      } else {
        replacement[0] = before + te.newText + after;
      }
      lines.splice(sl, el - sl + 1, ...replacement);
    }
  }
}

export function applyWorkspaceEdit(edit) {
  const changes = edit.changes || {};
  if (!Object.keys(changes).length) return { ok: true, text: 'No changes to apply' };

  const files = [];
  for (const [uri, edits] of Object.entries(changes)) {
    const filePath = uriToPath(uri);
    if (!existsSync(filePath)) { files.push({ path: filePath, edits: 0, error: 'File not found' }); continue; }

    const lines = readFileSync(filePath, 'utf8').split('\n');
    applyEditsToLines(lines, edits);
    writeFileSync(filePath, lines.join('\n'));
    files.push({ path: filePath, edits: edits.length });
  }
  return { ok: true, text: `Modified ${files.length} file(s)`, files };
}

export function applyTextEdit(filePath, edits) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  applyEditsToLines(lines, edits);
  writeFileSync(filePath, lines.join('\n'));
  return { ok: true, text: `Modified ${filePath}: ${edits.length} edit(s)` };
}
