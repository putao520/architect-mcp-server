/**
 * Tree-LSP Provider — MD/YAML 文件的虚拟 LSP 支持
 *
 * 当真实 LSP Server 不存在或返回空时，用纯 JS 解析器提供兼容 LSP 接口的结果。
 * 输出格式与真实 LSP response 完全一致，MCP 工具层无感知。
 *
 * 支持：documentSymbol, hover, references, foldingRange, documentHighlight, diagnostic
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, dirname, resolve as pathResolve, basename } from 'path';
import yaml from 'js-yaml';

// === Markdown 解析 ===

function parseMarkdown(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const symbols = [];
  const foldingRanges = [];
  const headings = []; // { level, text, line, endLine }

  // 解析标题层级
  const headingStack = []; // { level, line, text }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      // 关闭之前的同级或更深层级的标题
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        const closed = headingStack.pop();
        closed.endLine = i - 1;
        headings.push(closed);
      }

      headingStack.push({ level, text, line: i, endLine: lines.length - 1 });
    }
  }

  // Flush 剩余标题
  while (headingStack.length) {
    headings.push(headingStack.pop());
  }
  headings.sort((a, b) => a.line - b.line);

  // 构建符号树（嵌套结构）
  const kindMap = { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5 }; // all Class kind (for display)

  function buildSymbolTree(headingsList, startIdx, parentLevel) {
    const children = [];
    let i = startIdx;
    while (i < headingsList.length) {
      const h = headingsList[i];
      if (parentLevel !== undefined && h.level <= parentLevel) break;

      // Find children
      const childSymbols = [];
      let j = i + 1;
      while (j < headingsList.length && headingsList[j].level > h.level) {
        j++;
      }
      const subChildren = buildSymbolTree(headingsList, i + 1, h.level);

      const sym = {
        name: h.text,
        kind: 5, // Class
        range: {
          start: { line: h.line, character: 0 },
          end: { line: h.endLine, character: lines[h.endLine]?.length || 0 },
        },
        selectionRange: {
          start: { line: h.line, character: 0 },
          end: { line: h.line, character: line_length(lines[h.line]) },
        },
        children: subChildren.length ? subChildren : undefined,
      };
      children.push(sym);
      i = subChildren.length ? i + 1 + subChildren.length : i + 1;
      // Recalculate i based on consumed headings
      i = j;
    }
    return children;
  }

  // Simple flat symbol list (for compatibility)
  for (const h of headings) {
    symbols.push({
      name: h.text,
      kind: 5,
      range: {
        start: { line: h.line, character: 0 },
        end: { line: h.endLine, character: 0 },
      },
      selectionRange: {
        start: { line: h.line, character: 0 },
        end: { line: h.line, character: line_length(lines[h.line]) },
      },
      _heading: h,
    });

    foldingRanges.push({
      startLine: h.line,
      endLine: h.endLine,
      kind: 'region',
    });
  }

  // Add fenced code blocks as folding ranges
  let inCodeBlock = false;
  let codeBlockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^```/)) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockStart = i;
      } else {
        foldingRanges.push({ startLine: codeBlockStart, endLine: i, kind: 'region' });
        inCodeBlock = false;
      }
    }
  }

  // Parse links/references for cross-file reference support
  const outgoingLinks = [];
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  for (let i = 0; i < lines.length; i++) {
    while ((match = linkRegex.exec(lines[i])) !== null) {
      outgoingLinks.push({
        text: match[1],
        target: match[2],
        line: i,
        character: match.index,
      });
    }
  }

  return { content, lines, symbols, foldingRanges, headings, outgoingLinks };
}

function line_length(line) {
  return line ? line.length : 0;
}

// === YAML 解析 ===

function parseYaml(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // Parse YAML structure
  let parsed = null;
  try {
    parsed = yaml.load(content, { filename: filePath });
  } catch {
    parsed = null;
  }

  // Build symbol list from YAML key structure
  const symbols = [];
  const foldingRanges = [];

  // Line-based YAML key extraction
  const keyRegex = /^(\s*)([\w._-]+)\s*:/;
  const stack = []; // { indent, key, line }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const keyMatch = line.match(keyRegex);
    if (keyMatch) {
      const indent = keyMatch[1].length;
      const key = keyMatch[2];

      // Pop stack entries with >= indent
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        const closed = stack.pop();
        closed.endLine = i - 1;
      }

      const isSeq = line.includes('- ');
      const kind = isSeq ? 6 : 8; // Method or Property

      symbols.push({
        name: key,
        kind: 8, // Property
        range: {
          start: { line: i, character: indent },
          end: { line: i, character: line.length },
        },
        selectionRange: {
          start: { line: i, character: indent },
          end: { line: i, character: indent + key.length },
        },
        _indent: indent,
        endLine: lines.length - 1,
        _line: line.trim(),
      });

      stack.push({ indent, key, line: i, endLine: lines.length - 1 });
      foldingRanges.push({ startLine: i, endLine: lines.length - 1, kind: 'region' });
    }
  }

  return { content, lines, symbols, foldingRanges, parsed };
}

// === Provider 接口（兼容 LSP response 格式）===

const PROVIDERS = {
  markdown: {
    parse: parseMarkdown,
    exts: ['.md', '.markdown'],

    documentSymbol(filePath) {
      const { symbols } = this.parse(filePath);
      return { result: symbols.map(s => ({ name: s.name, kind: s.kind, range: s.range, selectionRange: s.selectionRange })) };
    },

    hover(filePath, line, character) {
      const { headings, content, lines } = this.parse(filePath);
      const line0 = line - 1;

      // Find the heading at or above this line
      let target = null;
      for (const h of headings) {
        if (h.line <= line0 && h.endLine >= line0) {
          if (!target || h.level > target.level) target = h;
        }
      }

      if (!target) return { result: null };

      // Show heading info + line range
      const lineCount = target.endLine - target.line + 1;
      const preview = lines.slice(target.line + 1, Math.min(target.line + 4, target.endLine + 1))
        .filter(l => l.trim())
        .map(l => l.trim())
        .join('\n');

      return {
        result: {
          contents: {
            kind: 'markdown',
            value: `## ${target.text}\n\nLines ${target.line + 1}-${target.endLine + 1} (${lineCount} lines)\n\n${preview ? '```\n' + preview + '\n```' : '(empty section)'}`,
          },
          range: {
            start: { line: target.line, character: 0 },
            end: { line: target.line, character: lines[target.line]?.length || 0 },
          },
        },
      };
    },

    references(filePath, line, character) {
      const { headings, outgoingLinks, lines } = this.parse(filePath);
      const line0 = line - 1;

      // Find heading at this line
      let targetHeading = null;
      for (const h of headings) {
        if (h.line === line0) { targetHeading = h; break; }
      }

      if (!targetHeading) {
        // Try to find links that reference something at this position
        return { result: [] };
      }

      // Find all references to this heading in the project
      const projectRoot = findProjectRoot(filePath);
      const refs = [];

      // Search for markdown link references to this heading
      const headingSlug = targetHeading.text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

      const baseName = basename(filePath, extname(filePath));
      const mdFiles = findMdFiles(dirname(filePath));

      for (const f of mdFiles) {
        try {
          const c = readFileSync(f, 'utf8');
          const ls = c.split('\n');
          for (let i = 0; i < ls.length; i++) {
            // Match links that reference this file and heading
            const linkPattern = new RegExp(`\\[([^\\]]*)\\]\\(${escapeRegex(baseName)}(?:\\.md)?#${escapeRegex(headingSlug)}\\)`, 'i');
            if (linkPattern.test(ls[i])) {
              refs.push({
                uri: `file://${f}`,
                range: { start: { line: i, character: 0 }, end: { line: i, character: ls[i].length } },
              });
            }
          }
        } catch { }
      }

      // Also add the heading definition itself as a reference
      refs.unshift({
        uri: `file://${pathResolve(filePath)}`,
        range: { start: { line: targetHeading.line, character: 0 }, end: { line: targetHeading.line, character: lines[targetHeading.line]?.length || 0 } },
      });

      return { result: refs };
    },

    foldingRange(filePath) {
      const { foldingRanges } = this.parse(filePath);
      return { result: foldingRanges };
    },

    documentHighlight(filePath, line, character) {
      const { headings, lines } = this.parse(filePath);
      const line0 = line - 1;

      // Find heading at this line
      let targetHeading = null;
      for (const h of headings) {
        if (h.line === line0) { targetHeading = h; break; }
      }

      if (!targetHeading) return { result: [] };

      // Highlight all occurrences of this heading text in the file
      const highlights = [];
      const text = targetHeading.text;
      for (let i = 0; i < lines.length; i++) {
        let idx = lines[i].indexOf(text);
        while (idx !== -1) {
          highlights.push({
            range: { start: { line: i, character: idx }, end: { line: i, character: idx + text.length } },
            kind: 1, // text
          });
          idx = lines[i].indexOf(text, idx + 1);
        }
      }

      return { result: highlights };
    },

    diagnostic(filePath) {
      const { content, lines } = this.parse(filePath);
      const diags = [];

      // Check for broken links [text](missing-file.md)
      const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
      let match;
      for (let i = 0; i < lines.length; i++) {
        while ((match = linkRegex.exec(lines[i])) !== null) {
          const target = match[2];
          if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto')) continue;
          // Check if referenced file exists
          const refPath = pathResolve(dirname(filePath), target.split('#')[0]);
          if (!target.includes('.md') && !target.includes('.png') && !target.includes('.jpg')) continue;
          try {
            statSync(refPath);
          } catch {
            diags.push({
              range: { start: { line: i, character: match.index }, end: { line: i, character: match.index + match[0].length } },
              severity: 2, // Warning
              message: `Broken link: "${target}" — file not found`,
            });
          }
        }
      }

      return { result: { items: diags, kind: 'push' } };
    },
  },

  yaml: {
    parse: parseYaml,
    exts: ['.yaml', '.yml'],

    documentSymbol(filePath) {
      const { symbols } = this.parse(filePath);
      return { result: symbols.map(s => ({ name: s.name, kind: s.kind, range: s.range, selectionRange: s.selectionRange })) };
    },

    hover(filePath, line, character) {
      const { symbols, lines, parsed } = this.parse(filePath);
      const line0 = line - 1;

      // Find the key at this line
      let target = null;
      for (const s of symbols) {
        if (s.range.start.line === line0) { target = s; break; }
      }

      if (!target) return { result: null };

      // Extract value
      const lineText = lines[line0];
      const colonIdx = lineText.indexOf(':');
      if (colonIdx === -1) return { result: null };

      const value = lineText.substring(colonIdx + 1).trim();

      // Try to get the value from parsed YAML
      let typeInfo = '';
      if (value === '' || value.startsWith('|') || value.startsWith('>')) {
        typeInfo = 'type: string (multiline)';
      } else if (value === 'true' || value === 'false') {
        typeInfo = 'type: boolean';
      } else if (/^-?\d+$/.test(value)) {
        typeInfo = 'type: integer';
      } else if (/^-?\d+\.\d+$/.test(value)) {
        typeInfo = 'type: number';
      } else if (value.startsWith('[')) {
        typeInfo = 'type: array';
      } else if (value.startsWith('{')) {
        typeInfo = 'type: object';
      } else if (value === 'null' || value === '~') {
        typeInfo = 'type: null';
      } else {
        typeInfo = 'type: string';
      }

      return {
        result: {
          contents: {
            kind: 'plaintext',
            value: `${target.name}: ${typeInfo}\n${value ? 'value: ' + (value.length > 200 ? value.substring(0, 200) + '...' : value) : '(nested object)'}`,
          },
          range: target.range,
        },
      };
    },

    references(filePath, line, character) {
      const { symbols } = this.parse(filePath);
      const line0 = line - 1;

      // Find the key at this line
      let target = null;
      for (const s of symbols) {
        if (s.range.start.line === line0) { target = s; break; }
      }

      if (!target) return { result: [] };

      // Search for this key name across all YAML files in the project
      const dir = dirname(filePath);
      const refs = [];
      const yamlFiles = findYamlFiles(dir);

      for (const f of yamlFiles) {
        try {
          const c = readFileSync(f, 'utf8');
          const ls = c.split('\n');
          for (let i = 0; i < ls.length; i++) {
            const keyMatch = ls[i].match(/^(\s*)([\w._-]+)\s*:/);
            if (keyMatch && keyMatch[2] === target.name) {
              refs.push({
                uri: `file://${f}`,
                range: { start: { line: i, character: keyMatch[1].length }, end: { line: i, character: keyMatch[1].length + target.name.length } },
              });
            }
          }
        } catch { }
      }

      return { result: refs };
    },

    foldingRange(filePath) {
      const { foldingRanges } = this.parse(filePath);
      return { result: foldingRanges };
    },

    documentHighlight(filePath, line, character) {
      const { symbols, lines } = this.parse(filePath);
      const line0 = line - 1;

      let target = null;
      for (const s of symbols) {
        if (s.range.start.line === line0) { target = s; break; }
      }

      if (!target) return { result: [] };

      // Highlight all occurrences of this key in the file
      const highlights = [];
      const name = target.name;
      for (let i = 0; i < lines.length; i++) {
        const keyMatch = lines[i].match(/^(\s*)([\w._-]+)\s*:/);
        if (keyMatch && keyMatch[2] === name) {
          highlights.push({
            range: { start: { line: i, character: keyMatch[1].length }, end: { line: i, character: keyMatch[1].length + name.length } },
            kind: 1,
          });
        }
      }

      return { result: highlights };
    },

    diagnostic(filePath) {
      const { content } = this.parse(filePath);
      const diags = [];

      try {
        yaml.load(content, { filename: filePath });
      } catch (err) {
        const lineMatch = err.message?.match(/at line (\d+)/);
        const line = lineMatch ? parseInt(lineMatch[1]) - 1 : 0;
        diags.push({
          range: { start: { line, character: 0 }, end: { line, character: 0 } },
          severity: 1, // Error
          message: `YAML syntax error: ${err.reason || err.message}`,
        });
      }

      return { result: { items: diags, kind: 'push' } };
    },
  },
};

// === 工具函数 ===

function findProjectRoot(filePath) {
  const markers = ['package.json', 'go.mod', 'Cargo.toml', '.git', 'tsconfig.json', 'pyproject.toml', 'SPEC'];
  let dir = dirname(pathResolve(filePath));
  while (dir !== '/' && dir) {
    for (const marker of markers) {
      try {
        if (statSync(`${dir}/${marker}`).isFile() || statSync(`${dir}/${marker}`).isDirectory()) return dir;
      } catch { }
    }
    dir = dirname(dir);
  }
  return dirname(pathResolve(filePath));
}

function findMdFiles(dir) {
  return findFilesByExt(dir, new Set(['.md', '.markdown']));
}

function findYamlFiles(dir) {
  return findFilesByExt(dir, new Set(['.yaml', '.yml']));
}

function findFilesByExt(dir, exts, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'vendor') continue;
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...findFilesByExt(fullPath, exts, maxDepth, depth + 1));
      } else if (exts.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }
  } catch { }
  return results;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// === Provider 查找 ===

const _providerMap = new Map();
for (const [, provider] of Object.entries(PROVIDERS)) {
  for (const ext of provider.exts) {
    _providerMap.set(ext, provider);
  }
}

export function getTreeProvider(filePath) {
  const ext = extname(filePath);
  return _providerMap.get(ext) || null;
}

export function isTreeSupported(filePath) {
  return _providerMap.has(extname(filePath));
}
