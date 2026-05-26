// SPEC Markdown 解析器 — 鲁棒版
// 支持：多种格式变体、大文件保护、表格解析、递归目录、编码兼容

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_FILES = 50;
const MAX_REQS = 2000;

// === 预处理 ===

function normalize(raw) {
  let c = raw;
  // BOM
  if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
  // 行尾统一
  c = c.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return c;
}

// === REQ ID 检测 ===
// 匹配：REQ-1, REQ-1.1, REQ-01-001, REQ-3.1.2, REQ_1_2, REQ3.1.2
const REQ_RE = /\bREQ[-_.\s]*(\d+(?:[.\-]\d+)*)\b/i;

// === 章节分类（双语） ===

const SECTION_MAP = [
  ['constraint', /约束|限制|规则|Constraint|Rule|Valid/i],
  ['precondition', /前置条件?|前提|Precondition|假设|Assumption/i],
  ['postcondition', /后置条件?|结果|Postcondition|效果|Effect/i],
  ['invariant', /不变[量式]|恒[量式]|Invariant|恒等/i],
  ['stateMachine', /状态机|状态图|State\s*Machine|FSM/i],
  ['dataModel', /数据模型|Data\s*Model|Schema|数据结构|表结构/i],
];

function classifySection(title) {
  for (const [key, re] of SECTION_MAP) {
    if (re.test(title)) return key;
  }
  return null;
}

// === 表格行解析 ===

function parseTableRow(line) {
  if (/^\|[\s\-:|]+\|$/.test(line.trim())) return null; // 分隔行
  const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  return cells.length >= 2 ? cells : null;
}

// === 约束提取 ===

function extractConstraint(text, line) {
  let m;

  // 禁止
  m = text.match(/(?:禁止|MUST\s+NOT|SHALL\s+NOT|不得|不能|严禁|不允许|forbidden)\s+(.+)/i);
  if (m) return { type: 'mustNot', text: m[1], raw: text, line };

  // 必须
  m = text.match(/(?:必须|MUST|SHALL|应当|需要|SHOULD|保证|确保|须)\s+(.+)/i);
  if (m) return { type: 'must', text: m[1], raw: text, line };

  // 蕴含 IF...THEN
  m = text.match(/(?:IF|如果|当)\s+(.+?)\s*(?:THEN|那么|则|时总是?|时)\s+(.+)/i);
  if (m) return { type: 'implies', condition: m[1], consequence: m[2], raw: text, line };

  // 永不
  m = text.match(/(?:NEVER|永不|绝不)\s+(.+)/i);
  if (m) return { type: 'never', text: m[1], raw: text, line };

  // 范围 x ∈ [min, max]
  m = text.match(/(\w[\w.]*)\s*(?:∈|范围|range|in)\s*[\[{(]\s*(-?\d+(?:\.\d+)?)\s*[,\-.~…]+\s*(-?\d+(?:\.\d+)?)\s*[}\])]/i);
  if (m) return { type: 'range', subject: m[1], min: parseFloat(m[2]), max: parseFloat(m[3]), raw: text, line };

  // >=, ≥, 至少
  m = text.match(/(\w[\w.]*)\s*(?:>=|≥|不小于|最少|至少|AT\s+LEAST)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { type: 'gte', subject: m[1], value: parseFloat(m[2]), raw: text, line };

  // <=, ≤, 至多
  m = text.match(/(\w[\w.]*)\s*(?:<=|≤|不大于|至多|最多|AT\s+MOST)\s+(-?\d+(?:\.\d+)?)/i);
  if (m) return { type: 'lte', subject: m[1], value: parseFloat(m[2]), raw: text, line };

  // >
  m = text.match(/(\w[\w.]*)\s*>\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { type: 'gt', subject: m[1], value: parseFloat(m[2]), raw: text, line };

  // <
  m = text.match(/(\w[\w.]*)\s*<\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { type: 'lt', subject: m[1], value: parseFloat(m[2]), raw: text, line };

  // == 数字
  m = text.match(/(\w[\w.]*)\s*(?:==|=)\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { type: 'eq_int', subject: m[1], value: parseFloat(m[2]), raw: text, line };

  // == 字符串
  m = text.match(/(\w[\w.]*)\s*(?:==|=)\s*["']([^"']+)["']/);
  if (m) return { type: 'eq_str', subject: m[1], value: m[2], raw: text, line };

  // != 数字
  m = text.match(/(\w[\w.]*)\s*(?:!=|≠|不等于)\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { type: 'neq_int', subject: m[1], value: parseFloat(m[2]), raw: text, line };

  // != 字符串
  m = text.match(/(\w[\w.]*)\s*(?:!=|≠|不等于)\s*["']([^"']+)["']/);
  if (m) return { type: 'neq_str', subject: m[1], value: m[2], raw: text, line };

  // 唯一
  m = text.match(/(\w[\w.]*)\s*(?:UNIQUE|唯一|不重复)/i);
  if (m) return { type: 'unique', subject: m[1], raw: text, line };

  // 必填
  m = text.match(/(\w[\w.]*)\s*(?:REQUIRED|必填|必选|不可为空|NOT\s+NULL)/i);
  if (m) return { type: 'required', subject: m[1], raw: text, line };

  // 枚举 x ∈ {a, b, c}
  m = text.match(/(\w[\w.]*)\s*(?:∈|is|为|取值)\s*[\[{(]\s*(.+?)\s*[}\])]/i);
  if (m) {
    const values = m[2].split(/[,，]\s*/).map(v => v.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    if (values.length > 0) return { type: 'enum', subject: m[1], values, raw: text, line };
  }

  // 兜底：关键词检测
  if (/必须|MUST|SHALL|应当|禁止|需要|保证|确保|不得|不能|至少|至多|最多|唯一|必填|IF|如果|当|范围|∈|>=|<=|>|<|!=|==|≠|≤|≥/i.test(text)) {
    return { type: 'assertion', text, raw: text, line };
  }

  return null;
}

// === 约束分发 ===

function dispatchConstraint(constraint, req, section, invariants) {
  if (!req) return;
  switch (section) {
    case 'precondition': req.preconditions.push(constraint); break;
    case 'postcondition': req.postconditions.push(constraint); break;
    case 'invariant':
      req.invariants.push(constraint);
      invariants.push({ ...constraint, source: req.id });
      break;
    case 'constraint': req.constraints.push(constraint); break;
    default: req.constraints.push(constraint); break;
  }
}

// === parseSpecFile ===

export function parseSpecFile(filePath) {
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`SPEC file too large: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const content = normalize(raw);
  const lines = content.split('\n');
  const warnings = [];

  const reqs = [];
  const stateMachines = [];
  const dataModels = [];
  const invariants = [];
  let currentSection = null;
  let currentReq = null;
  let tableHeaders = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      const title = headingMatch[2].trim();
      tableHeaders = null;

      // REQ 检测
      const reqIdMatch = title.match(REQ_RE);
      if (reqIdMatch) {
        if (currentReq) reqs.push(currentReq);
        currentReq = {
          id: `REQ-${reqIdMatch[1]}`,
          title: title.replace(REQ_RE, '').trim() || title,
          line: i,
          constraints: [],
          preconditions: [],
          postconditions: [],
          invariants: [],
          rawLines: [],
        };
        currentSection = 'req';
        continue;
      }

      // 章节分类
      const sectionType = classifySection(title);
      if (sectionType === 'stateMachine') {
        if (currentReq) { reqs.push(currentReq); currentReq = null; }
        stateMachines.push({ title, line: i, transitions: [], states: [] });
        currentSection = 'stateMachine';
        continue;
      }
      if (sectionType === 'dataModel') {
        if (currentReq) { reqs.push(currentReq); currentReq = null; }
        dataModels.push({ title, line: i, fields: [], constraints: [] });
        currentSection = 'dataModel';
        continue;
      }
      if (sectionType === 'precondition' && currentReq) { currentSection = 'precondition'; continue; }
      if (sectionType === 'postcondition' && currentReq) { currentSection = 'postcondition'; continue; }
      if (sectionType === 'invariant' && currentReq) { currentSection = 'invariant'; continue; }
      if (sectionType === 'constraint' && currentReq) { currentSection = 'constraint'; continue; }

      // 高级标题重置上下文
      if (headingMatch[1].length <= 2) currentSection = null;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('```')) continue;

    // 表格行
    if (trimmed.startsWith('|')) {
      const cells = parseTableRow(trimmed);
      if (!cells) continue;

      // 首行做表头
      if (tableHeaders === null) {
        tableHeaders = cells;
        continue;
      }

      // 数据行 → 数据模型
      if (currentSection === 'dataModel' && dataModels.length > 0) {
        const model = dataModels[dataModels.length - 1];
        const field = {};
        for (let ci = 0; ci < tableHeaders.length && ci < cells.length; ci++) {
          field[tableHeaders[ci]] = cells[ci];
        }
        model.fields.push(field);
      }

      // 表格单元格中的约束：优先原样匹配，不匹配则组合字段名
      if (currentReq) {
        const fieldName = cells[0]?.replace(/[^a-zA-Z0-9_]/g, '');
        for (let ci = 1; ci < cells.length; ci++) {
          const cell = cells[ci];
          let constraint = extractConstraint(cell, i);
          if (!constraint && fieldName && /^[<>=!∈]/.test(cell.trim())) {
            constraint = extractConstraint(`${fieldName} ${cell}`, i);
          }
          if (constraint) dispatchConstraint(constraint, currentReq, currentSection, invariants);
        }
      }
      continue;
    }

    if (currentReq && currentSection === 'req') {
      currentReq.rawLines.push(trimmed);
    }

    // 列表项（无序 + 有序）
    const listMatch = trimmed.match(/^[-*]\s+(.+)|^(\d+)[.)]\s+(.+)/);
    if (!listMatch) continue;
    const text = listMatch[1] || listMatch[3];
    if (!text) continue;

    const constraint = extractConstraint(text, i);
    if (!constraint) continue;
    dispatchConstraint(constraint, currentReq, currentSection, invariants);
  }

  if (currentReq) reqs.push(currentReq);

  return { reqs, stateMachines, dataModels, invariants, warnings };
}

// === 递归目录扫描 ===

function collectMdFiles(dirPath, maxFiles) {
  const files = [];
  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) walk(fp);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fp);
    }
  }
  walk(dirPath);
  return files;
}

// === parseSpecDir ===

export function parseSpecDir(dirPath) {
  const results = { reqs: [], stateMachines: [], dataModels: [], invariants: [], files: [], warnings: [] };

  if (!existsSync(dirPath)) return results;

  const stat = statSync(dirPath);
  if (!stat.isDirectory()) {
    try {
      const parsed = parseSpecFile(dirPath);
      results.files.push(dirPath);
      Object.assign(results, parsed);
    } catch (e) {
      results.warnings.push(`Failed: ${dirPath}: ${e.message}`);
    }
    return results;
  }

  const files = collectMdFiles(dirPath, MAX_FILES);
  if (files.length >= MAX_FILES) {
    results.warnings.push(`File limit (${MAX_FILES}) reached, some files skipped`);
  }

  for (const fp of files) {
    try {
      const parsed = parseSpecFile(fp);
      results.files.push(fp);
      results.reqs.push(...parsed.reqs);
      results.stateMachines.push(...parsed.stateMachines);
      results.dataModels.push(...parsed.dataModels);
      results.invariants.push(...parsed.invariants);
      if (parsed.warnings?.length) results.warnings.push(...parsed.warnings);
    } catch (e) {
      results.warnings.push(`Failed: ${fp}: ${e.message}`);
    }
  }

  if (results.reqs.length > MAX_REQS) {
    results.warnings.push(`REQ limit (${MAX_REQS}), truncated from ${results.reqs.length}`);
    results.reqs.length = MAX_REQS;
  }

  return results;
}
