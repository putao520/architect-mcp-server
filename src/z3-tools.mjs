// Z3 spec-verify 工具集 — 4 个形式化验证工具
// 纯 CPU 计算，进程内执行，无外部进程或 API 调用

import { z } from 'zod';
import { statSync } from 'fs';
import { ensureZ3, getCtx, intVar, boolVar, strVar, intVal, boolVal, strVal, extractValue } from './z3-engine.mjs';
import { parseSpecFile, parseSpecDir } from './spec-parser.mjs';

// === 约束解析器（鲁棒版） ===

function preprocessConstraint(raw) {
  let line = raw;
  // 去内联注释
  line = line.replace(/(?:^|[^:])\/\/.*$/, '').replace(/(?:^|\s)#.*$/, '').trim();
  // 去尾部分隔符
  line = line.replace(/[,;。，；]+$/, '').trim();
  // 规范化运算符
  line = line.replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/≠/g, '!=');
  // 规范化 ∈ → in
  line = line.replace(/\s*∈\s*/g, ' in ');
  // 压缩空白
  line = line.replace(/\s+/g, ' ');
  return line;
}

const NUM_RE = /-?\d+(?:\.\d+)?/;
const QUOTED_RE = /["']([^"']+)["']/;

function parseConstraintLine(raw, vars) {
  const line = preprocessConstraint(raw);
  if (!line) return null;
  let m;

  // 范围 x in [min, max]
  m = line.match(new RegExp(`^(\\w+)\\s*in\\s*\\[?(${NUM_RE.source})\\s*[,.\\-~…]+\\s*(${NUM_RE.source})\\]?$`, 'i'));
  if (m) { vars.set(m[1], intVar(m[1])); return getCtx().And([vars.get(m[1]).ge(intVal(m[2])), vars.get(m[1]).le(intVal(m[3]))]); }

  // >=
  m = line.match(new RegExp(`^(\\w+)\\s*>=\\s*(${NUM_RE.source})$`));
  if (m) { vars.set(m[1], intVar(m[1])); return vars.get(m[1]).ge(intVal(m[2])); }
  // <=
  m = line.match(new RegExp(`^(\\w+)\\s*<=\\s*(${NUM_RE.source})$`));
  if (m) { vars.set(m[1], intVar(m[1])); return vars.get(m[1]).le(intVal(m[2])); }
  // >
  m = line.match(new RegExp(`^(\\w+)\\s*>\\s*(${NUM_RE.source})$`));
  if (m) { vars.set(m[1], intVar(m[1])); return vars.get(m[1]).gt(intVal(m[2])); }
  // <
  m = line.match(new RegExp(`^(\\w+)\\s*<\\s*(${NUM_RE.source})$`));
  if (m) { vars.set(m[1], intVar(m[1])); return vars.get(m[1]).lt(intVal(m[2])); }

  // == 数字
  m = line.match(new RegExp(`^(\\w+)\\s*(?:==|=)\\s*(${NUM_RE.source})$`));
  if (m) { vars.set(m[1], intVar(m[1])); return vars.get(m[1]).eq(intVal(m[2])); }
  // != 数字
  m = line.match(new RegExp(`^(\\w+)\\s*!=\\s*(${NUM_RE.source})$`));
  if (m) { vars.set(m[1], intVar(m[1])); return vars.get(m[1]).neq(intVal(m[2])); }

  // == 字符串（双引号或单引号）
  m = line.match(new RegExp(`^(\\w+)\\s*(?:==|=)\\s*${QUOTED_RE.source}$`));
  if (m) { vars.set(m[1], strVar(m[1])); return vars.get(m[1]).eq(strVal(m[2])); }
  // != 字符串
  m = line.match(new RegExp(`^(\\w+)\\s*!=\\s*${QUOTED_RE.source}$`));
  if (m) { vars.set(m[1], strVar(m[1])); return vars.get(m[1]).neq(strVal(m[2])); }

  // 布尔
  m = line.match(/^(\w+)\s*(?:==|=)?\s*(true|false)$/i);
  if (m) { vars.set(m[1], boolVar(m[1])); return vars.get(m[1]).eq(boolVal(m[2].toLowerCase() === 'true')); }

  // 枚举 x in {a, b, c}
  m = line.match(/^(\w+)\s*in\s*\{(.+)\}$/i);
  if (m) {
    const values = m[2].split(/,\s*/).map(v => v.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    if (values.length > 0) {
      vars.set(m[1], strVar(m[1]));
      let expr = vars.get(m[1]).eq(strVal(values[0]));
      for (let i = 1; i < values.length; i++) expr = expr.or(vars.get(m[1]).eq(strVal(values[i])));
      return expr;
    }
  }

  // IF x THEN y
  m = line.match(/^IF\s+(\w+)\s+THEN\s+(\w+)$/i);
  if (m) {
    if (!vars.has(m[1])) vars.set(m[1], boolVar(m[1]));
    if (!vars.has(m[2])) vars.set(m[2], boolVar(m[2]));
    return getCtx().Implies(vars.get(m[1]), vars.get(m[2]));
  }

  // x != y（变量不等于）
  m = line.match(/^(\w+)\s*!=\s*(\w+)$/);
  if (m) {
    if (!vars.has(m[1])) vars.set(m[1], intVar(m[1]));
    if (!vars.has(m[2])) vars.set(m[2], intVar(m[2]));
    return vars.get(m[1]).neq(vars.get(m[2]));
  }

  return null;
}

function constraintToBool(constraint, defaultVar) {
  switch (constraint.type) {
    case 'must': return defaultVar;
    case 'mustNot': return defaultVar.not();
    case 'implies': {
      const cond = boolVar(`cond_${constraint.line}`);
      const cons = boolVar(`cons_${constraint.line}`);
      return getCtx().Implies(cond, cons);
    }
    case 'never': return defaultVar.not();
    case 'assertion': return defaultVar;
    default: return defaultVar;
  }
}

// === 工具 1: verify_spec ===
// 合并 verify_spec_consistency + verify_data_constraints
// 输入 specPath → Phase 1 全局一致性 + Phase 2 数据约束求解 + Phase 3 两两冲突

async function verifySpec(params) {
  const c = await ensureZ3();
  const { specPath } = params;
  const stat = statSync(specPath);
  const spec = stat.isDirectory() ? parseSpecDir(specPath) : parseSpecFile(specPath);
  const out = [`SPEC VERIFICATION: ${specPath}`];
  out.push(`Files: ${spec.files?.length || 1} | REQs: ${spec.reqs.length} | Constraints: ${spec.reqs.reduce((s, r) => s + r.constraints.length, 0)}`);

  if (!spec.reqs.length) {
    out.push('\nNo REQ definitions found. Ensure SPEC files contain REQ-XXX headings.');
    return { content: [{ type: 'text', text: out.join('\n') }] };
  }

  // Warnings
  if (spec.warnings?.length) {
    out.push('\n--- Parse Warnings ---');
    for (const w of spec.warnings) out.push(`  ⚠ ${w}`);
  }

  // === Phase 1: 数据约束求解（数值 + 布尔 + 枚举） ===
  const NUMERIC_TYPES = new Set(['range', 'gte', 'lte', 'gt', 'lt', 'eq_int', 'neq_int']);
  const BOOL_TYPES = new Set(['implies', 'must', 'mustNot', 'never']);
  const STRING_TYPES = new Set(['eq_str', 'neq_str', 'enum']);
  const INFO_TYPES = new Set(['unique', 'required', 'assertion']);
  const numericConstraints = [];
  const boolConstraints = [];
  const stringConstraints = [];
  let infoCount = 0;

  for (const req of spec.reqs) {
    for (const cItem of req.constraints) {
      const tagged = { ...cItem, source: req.id };
      if (NUMERIC_TYPES.has(cItem.type)) numericConstraints.push(tagged);
      else if (BOOL_TYPES.has(cItem.type)) boolConstraints.push(tagged);
      else if (STRING_TYPES.has(cItem.type)) stringConstraints.push(tagged);
      else if (INFO_TYPES.has(cItem.type)) infoCount++;
    }
  }

  out.push(`\n=== Phase 1: Data Constraint Satisfiability ===`);
  out.push(`Numeric: ${numericConstraints.length} | Boolean: ${boolConstraints.length} | String/Enum: ${stringConstraints.length} | Info: ${infoCount}`);

  // 数值约束按变量分组求解
  if (numericConstraints.length) {
    const solver = new c.Solver();
    solver.set('timeout', 30000);
    const vars = new Map();

    for (const nc of numericConstraints) {
      const safeName = (nc.subject || `v_${nc.line}`).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
      if (!vars.has(safeName)) vars.set(safeName, intVar(safeName));
      const v = vars.get(safeName);

      if (nc.type === 'range') { solver.add(v.ge(intVal(nc.min))); solver.add(v.le(intVal(nc.max))); }
      else if (nc.type === 'gte') { solver.add(v.ge(intVal(nc.value))); }
      else if (nc.type === 'lte') { solver.add(v.le(intVal(nc.value))); }
      else if (nc.type === 'gt') { solver.add(v.gt(intVal(nc.value))); }
      else if (nc.type === 'lt') { solver.add(v.lt(intVal(nc.value))); }
      else if (nc.type === 'eq_int') { solver.add(v.eq(intVal(nc.value))); }
      else if (nc.type === 'neq_int') { solver.add(v.neq(intVal(nc.value))); }
    }

    out.push('\n--- Numeric Constraints ---');
    const numResult = await solver.check();
    if (numResult === 'sat') {
      out.push('SAT ✅ All numeric constraints simultaneously satisfiable.');
      const model = solver.model();
      for (const [name, v] of vars) out.push(`  ${name} = ${model.eval(v).toString()}`);
    } else if (numResult === 'unsat') {
      out.push('UNSAT 🛑 Numeric constraints contradictory!');
      const core = solver.unsatCore();
      if (core.length) { out.push('Conflicting:'); for (const cc of core.slice(0, 10)) out.push(`  ${cc.toString()}`); }
      for (const nc of numericConstraints) out.push(`  ${nc.source}: ${nc.raw}`);
    }
  }

  if (boolConstraints.length) {
    const solver = new c.Solver();
    solver.set('timeout', 30000);
    let idx = 0;

    for (const bc of boolConstraints) {
      const v = boolVar(`b_${idx++}`);
      if (bc.type === 'must') solver.add(v);
      else if (bc.type === 'mustNot' || bc.type === 'never') solver.add(v.not());
      else if (bc.type === 'implies') {
        const cond = boolVar(`cond_${idx}`);
        const cons = boolVar(`cons_${idx}`);
        solver.add(c.Implies(cond, cons));
        solver.add(cond);
      }
    }

    out.push('\n--- Boolean Constraints ---');
    const boolResult = await solver.check();
    if (boolResult === 'sat') { out.push('SAT ✅ All boolean constraints consistent.'); }
    else if (boolResult === 'unsat') {
      out.push('UNSAT 🛑 Boolean constraints contradictory!');
      const core = solver.unsatCore();
      if (core.length) { out.push('Unsatisfiable core:'); for (const cc of core.slice(0, 10)) out.push(`  ${cc.toString()}`); }
      for (const bc of boolConstraints) out.push(`  ${bc.source}: ${bc.raw}`);
    }
  }

  // 字符串/枚举约束一致性
  if (stringConstraints.length) {
    out.push('\n--- String/Enum Constraints ---');
    const enumFields = new Map();
    for (const sc of stringConstraints) {
      const subj = sc.subject || 'unknown';
      if (!enumFields.has(subj)) enumFields.set(subj, []);
      enumFields.get(subj).push(sc);
    }
    let conflicts = 0;
    for (const [field, items] of enumFields) {
      const eqs = items.filter(i => i.type === 'eq_str').map(i => i.value);
      const neqs = items.filter(i => i.type === 'neq_str').map(i => i.value);
      const enumVals = items.filter(i => i.type === 'enum').flatMap(i => i.values);
      // 检查 eq 和 neq 是否矛盾
      for (const eq of eqs) {
        if (neqs.includes(eq)) { out.push(`  🛑 ${field}: == "${eq}" AND != "${eq}" contradictory`); conflicts++; }
      }
      // 检查 enum 和 eq 是否兼容
      for (const eq of eqs) {
        if (enumVals.length > 0 && !enumVals.includes(eq)) {
          out.push(`  ⚠ ${field}: == "${eq}" not in enum [${enumVals.join(', ')}]`); conflicts++;
        }
      }
    }
    if (!conflicts) out.push(`All ${stringConstraints.length} string/enum constraints consistent ✅`);
  }

  if (!numericConstraints.length && !boolConstraints.length && !stringConstraints.length) {
    out.push('No formalizable data constraints found.');
  }

  // === Phase 2: 全局 REQ 一致性 ===
  out.push('\n=== Phase 2: REQ Mutual Consistency ===');

  const solver = new c.Solver();
  solver.set('timeout', 30000);
  const boolVars = new Map();
  let constraintCount = 0;

  for (const req of spec.reqs) {
    const reqVar = boolVar(`req_${req.id.replace(/[^a-zA-Z0-9]/g, '_')}`);
    boolVars.set(req.id, reqVar);

    for (const cItem of req.constraints) {
      const cv = boolVar(`c_${constraintCount++}`);
      solver.add(c.Implies(reqVar, constraintToBool(cItem, cv)));
      solver.add(cv);
    }
    for (let pi = 0; pi < req.preconditions.length; pi++) {
      const pv = boolVar(`pre_${constraintCount++}`);
      solver.add(c.Implies(reqVar, pv));
    }
    for (let pi = 0; pi < req.postconditions.length; pi++) {
      const pv = boolVar(`post_${constraintCount++}`);
      solver.add(c.Implies(reqVar, pv));
    }
    for (let pi = 0; pi < req.invariants.length; pi++) {
      const iv = boolVar(`inv_${constraintCount++}`);
      solver.add(iv);
    }
  }

  const allReqs = c.And(...boolVars.values());
  solver.push();
  solver.add(allReqs);

  const globalResult = await solver.check();
  if (globalResult === 'sat') {
    out.push('SAT ✅ All REQ constraints simultaneously satisfiable.');
  } else if (globalResult === 'unsat') {
    out.push('UNSAT 🛑 REQ constraints contradictory!');
    const core = solver.unsatCore();
    if (core.length) { out.push(`Unsatisfiable core (${core.length}):`); for (const cc of core.slice(0, 20)) out.push(`  ${cc.toString()}`); }
  } else {
    out.push(`UNKNOWN ⚠️ (${globalResult})`);
  }

  // === Phase 3: 两两冲突检测（分段） ===
  solver.pop();
  out.push('\n=== Phase 3: Pairwise Conflict Detection ===');
  const conflicts = [];
  const reqList = [...boolVars.entries()];

  // 动态限制：≤100 全量检查，>100 取前 100
  const MAX_PAIR_REQS = 100;
  const checkList = reqList.length > MAX_PAIR_REQS
    ? reqList.slice(0, MAX_PAIR_REQS)
    : reqList;
  const totalPairs = (checkList.length * (checkList.length - 1)) / 2;
  if (reqList.length > MAX_PAIR_REQS) {
    out.push(`(Checking first ${MAX_PAIR_REQS} of ${reqList.length} REQs — ${totalPairs} pairs)`);
  }

  // push/pop 增量求解：每对独立 push/pop，Z3 自动维护内部状态
  for (let i = 0; i < checkList.length; i++) {
    for (let j = i + 1; j < checkList.length; j++) {
      const [id1, v1] = checkList[i];
      const [id2, v2] = checkList[j];
      solver.push();
      solver.add(v1);
      solver.add(v2);
      const pairResult = await solver.check();
      if (pairResult === 'unsat') conflicts.push([id1, id2]);
      solver.pop();
    }
  }

  if (!conflicts.length) { out.push('No pairwise conflicts ✅'); }
  else {
    out.push(`${conflicts.length} conflicting pair(s):`);
    for (const [a, b] of conflicts) out.push(`  ${a} ↔ ${b}`);
  }

  out.push('\n=== Summary ===');
  out.push(`REQs: ${spec.reqs.length} | Constraints: ${constraintCount}`);
  out.push(`Global: ${globalResult.toUpperCase()} | Pairwise conflicts: ${conflicts.length}`);

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// === 工具 2: verify_formal ===
// 合并 find_counterexample + verify_interface_contract
// 根据 preconditions/postconditions 是否提供自动选择模式

async function verifyFormal(params) {
  const c = await ensureZ3();
  const { constraints, property, preconditions, postconditions } = params;
  const out = [`FORMAL VERIFICATION`];

  // 模式 A：接口契约验证（提供了 preconditions + postconditions）
  if (preconditions?.length && postconditions?.length) {
    out.push('Mode: Interface Contract Verification');
    const solver = new c.Solver();
    solver.set('timeout', 30000);
    const vars = new Map();

    out.push(`\nPreconditions (${preconditions.length}):`);
    for (const pre of preconditions) {
      out.push(`  ${pre}`);
      const parsed = parseConstraintLine(pre, vars);
      if (parsed) solver.add(parsed);
    }

    out.push(`\nPostconditions (${postconditions.length}):`);
    const postSolver = new c.Solver();
    postSolver.set('timeout', 30000);
    for (const pre of preconditions) {
      const parsed = parseConstraintLine(pre, vars);
      if (parsed) postSolver.add(parsed);
    }
    for (const post of postconditions) {
      out.push(`  ${post}`);
      const parsed = parseConstraintLine(post, new Map());
      if (parsed) { postSolver.push(); postSolver.add(parsed.not()); }
    }

    out.push('\n=== Contract Validity ===');
    const preResult = await solver.check();
    if (preResult === 'unsat') {
      out.push('Preconditions UNSAT 🛑 — contradictory preconditions!');
      return { content: [{ type: 'text', text: out.join('\n') }] };
    }
    out.push(`Preconditions SAT ✅`);
    if (preResult === 'sat') {
      const model = solver.model();
      out.push('Example input:');
      for (const [name, v] of vars) out.push(`  ${name} = ${extractValue(model.eval(v))}`);
    }

    const postResult = await postSolver.check();
    if (postResult === 'sat') {
      out.push('\nPostconditions VIOLABLE 🛑');
      const model = postSolver.model();
      out.push('Counterexample:');
      for (const [name, v] of vars) out.push(`  ${name} = ${extractValue(model.eval(v))}`);
      out.push('Contract NOT sound — implementation must enforce additional guards.');
    } else if (postResult === 'unsat') {
      out.push('\nPostconditions ALWAYS HOLD ✅');
      out.push('Contract is sound.');
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  }

  // 模式 B：反例搜索（默认，仅提供 constraints）
  out.push('Mode: Counterexample Search');
  const solver = new c.Solver();
  solver.set('timeout', 30000);
  const vars = new Map();

  const lines = constraints.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const parsed = parseConstraintLine(line.trim(), vars);
    if (parsed) solver.add(parsed);
  }

  out.push(`Variables: ${vars.size} | Constraints: ${lines.length}`);

  if (property) {
    const propVars = new Map();
    const propParsed = parseConstraintLine(property, propVars);
    if (propParsed) solver.add(propParsed.not());
    out.push(`Negated property: "${property}"`);
  }

  const result = await solver.check();
  out.push('\n=== Result ===');
  if (result === 'sat') {
    out.push('COUNTEREXAMPLE FOUND ✅');
    const model = solver.model();
    out.push('Counterexample values:');
    for (const [name, v] of vars) out.push(`  ${name} = ${extractValue(model.eval(v))}`);
  } else if (result === 'unsat') {
    out.push('NO COUNTEREXAMPLE — property holds under all constraints ✅');
  } else {
    out.push(`UNKNOWN (${result})`);
  }

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// === 工具 3: verify_state_machine ===
// 保留原实现，仅改名为内部函数

async function verifyStateMachine(params) {
  const c = await ensureZ3();
  const { states, transitions, initialState } = params;
  const out = [`STATE MACHINE VERIFICATION`];

  if (!states.length) {
    return { content: [{ type: 'text', text: 'STATE_MACHINE: No states provided.' }] };
  }

  out.push(`States: ${states.join(', ')} (${states.length})`);
  out.push(`Transitions: ${transitions.length}`);
  out.push(`Initial: ${initialState || states[0]}`);

  // Phase 1: Valid state references
  out.push('\n=== Transition Target Validation ===');
  const stateSet = new Set(states);
  const invalidTargets = [];
  for (const t of transitions) {
    if (!stateSet.has(t.to)) invalidTargets.push(t);
    if (!stateSet.has(t.from)) invalidTargets.push(t);
  }
  if (!invalidTargets.length) { out.push('All transitions reference valid states ✅'); }
  else {
    out.push(`Invalid transitions (${invalidTargets.length}):`);
    for (const t of invalidTargets) out.push(`  ${t.from} → ${t.to} (${t.on || 'no trigger'})`);
  }

  // Phase 2: BFS reachability
  out.push('\n=== Reachability Analysis ===');
  const init = initialState || states[0];
  const reachable = new Set([init]);
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 100) {
    changed = false;
    iterations++;
    for (const t of transitions) {
      if (reachable.has(t.from) && !reachable.has(t.to)) { reachable.add(t.to); changed = true; }
    }
  }

  const unreachable = states.filter(s => !reachable.has(s));
  if (!unreachable.length) { out.push('All states reachable ✅'); }
  else {
    out.push(`Unreachable states (${unreachable.length}):`);
    for (const s of unreachable) out.push(`  ${s} — dead state`);
  }

  // Phase 3: Dead ends
  out.push('\n=== Dead End Analysis ===');
  const hasOutgoing = new Set();
  for (const t of transitions) hasOutgoing.add(t.from);
  const terminalStates = states.filter(s => reachable.has(s) && !hasOutgoing.has(s));

  if (!terminalStates.length) { out.push('No terminal states ⚠️ — may loop forever'); }
  else {
    out.push('Terminal states:');
    for (const s of terminalStates) out.push(`  ${s}`);
  }

  // Phase 4: Non-determinism
  out.push('\n=== Non-determinism Check ===');
  const transByKey = new Map();
  for (const t of transitions) {
    const key = `${t.from}|${t.on || '*'}`;
    if (!transByKey.has(key)) transByKey.set(key, []);
    transByKey.get(key).push(t);
  }
  const nondeterministic = [...transByKey.entries()].filter(([, ts]) => ts.length > 1);
  if (!nondeterministic.length) { out.push('All transitions deterministic ✅'); }
  else {
    out.push(`Non-deterministic (${nondeterministic.length}):`);
    for (const [key, ts] of nondeterministic) {
      const [from, on] = key.split('|');
      out.push(`  ${from} on "${on}":`);
      for (const t of ts) out.push(`    → ${t.to}`);
    }
  }

  // Phase 5: Z3 counterexample search for key invariants
  out.push('\n=== Formal Verification (Z3 Counterexample Search) ===');
  const stateIndex = new Map(states.map((s, i) => [s, i]));

  // Invariant 1: Determinism — no (state, event) pair maps to two distinct targets
  out.push('\n  [Determinism]');
  let determinismHolds = true;
  for (const [key, ts] of transByKey.entries()) {
    if (ts.length <= 1) continue;
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        if (ts[i].to !== ts[j].to) {
          const [from, on] = key.split('|');
          out.push(`    VIOLATED: ${from} on "${on}" → ${ts[i].to} AND ${ts[j].to}`);
          determinismHolds = false;
        }
      }
    }
  }
  if (determinismHolds) out.push('    All transitions deterministic ✅');

  // Invariant 2: Liveness — every reachable non-terminal state has at least one outgoing transition
  // Z3 proves: ∃ reachable state with no outgoing edge → counterexample
  out.push('\n  [Liveness]');
  const s = intVar('state');
  const liveSolver = new c.Solver();
  liveSolver.set('timeout', 10000);
  const reachableOrs = [...reachable].map(st => s.eq(intVal(stateIndex.get(st))));
  liveSolver.add(reachableOrs.reduce((a, b) => a.or(b)));
  const hasOutOrs = [...hasOutgoing].map(st => s.eq(intVal(stateIndex.get(st))));
  liveSolver.add(hasOutOrs.reduce((a, b) => a.or(b)).not());
  const liveResult = await liveSolver.check();
  if (liveResult === 'sat') {
    const model = liveSolver.model();
    const deadIdx = Number(model.eval(s).toString());
    out.push(`    DEAD END found: ${states[deadIdx]} — reachable but no outgoing transition ❌`);
  } else {
    out.push('    Every reachable non-terminal state has outgoing transitions ✅');
  }

  // Invariant 3: Unreachable states — Z3 confirms BFS result
  // Z3 proves: ∀ valid transition chain, unreachable state is never reached
  out.push('\n  [Unreachability Confirmation]');
  if (unreachable.length === 0) {
    out.push('    No unreachable states ✅');
  } else {
    for (const us of unreachable.slice(0, 5)) {
      // Build reachability constraints: from init, follow transitions via integer step variables
      const steps = Math.min(transitions.length + 1, 20);
      const pathVars = Array.from({ length: steps }, (_, i) => intVar(`p${i}`));
      const reachSolver = new c.Solver();
      reachSolver.set('timeout', 5000);
      // Start at init
      reachSolver.add(pathVars[0].eq(intVal(stateIndex.get(init))));
      // Each step follows a valid transition
      for (let i = 0; i < steps - 1; i++) {
        const stepOrs = transitions.map(t =>
          pathVars[i].eq(intVal(stateIndex.get(t.from))).and(pathVars[i + 1].eq(intVal(stateIndex.get(t.to))))
        );
        reachSolver.add(stepOrs.reduce((a, b) => a.or(b)));
      }
      // Target: reach the unreachable state at any step
      const targetOrs = pathVars.map(p => p.eq(intVal(stateIndex.get(us))));
      reachSolver.add(targetOrs.reduce((a, b) => a.or(b)));
      const r = await reachSolver.check();
      out.push(`    ${us}: Z3 ${r === 'unsat' ? 'unreachable ✅' : `PATH FOUND ❌ (BFS missed)`}`);
    }
  }

  // Invariant 4: Transition coverage — every declared state appears in at least one transition
  out.push('\n  [Transition Coverage]');
  const usedInTransition = new Set();
  for (const t of transitions) { usedInTransition.add(t.from); usedInTransition.add(t.to); }
  const unusedStates = states.filter(st => !usedInTransition.has(st));
  if (unusedStates.length === 0) {
    out.push('    All states appear in transitions ✅');
  } else {
    for (const st of unusedStates) out.push(`    ${st}: never used in any transition ⚠️`);
  }

  out.push('\n=== Summary ===');
  out.push(`States: ${states.length} | Reachable: ${reachable.size} | Unreachable: ${unreachable.length}`);
  out.push(`Terminal: ${terminalStates.length} | Non-deterministic: ${nondeterministic.length}`);
  const health = unreachable.length === 0 && nondeterministic.length === 0;
  out.push(`Health: ${health ? 'SOUND ✅' : 'ISSUES 🛑'}`);

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// === 工具 4 辅助函数 ===

function parseSpecAlignment(raw) {
  const constraintStr = preprocessConstraint(raw);
  if (!constraintStr) return null;
  let m;

  // 范围
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*in\\s*\\[?(${NUM_RE.source})\\s*[,.\\-~…]+\\s*(${NUM_RE.source})\\]?$`, 'i'));
  if (m) return { field: m[1], specConstraint: { type: 'range', min: parseFloat(m[2]), max: parseFloat(m[3]) } };
  // >=
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*>=\\s*(${NUM_RE.source})$`));
  if (m) return { field: m[1], specConstraint: { type: 'gte', value: parseFloat(m[2]) } };
  // <=
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*<=\\s*(${NUM_RE.source})$`));
  if (m) return { field: m[1], specConstraint: { type: 'lte', value: parseFloat(m[2]) } };
  // >
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*>\\s*(${NUM_RE.source})$`));
  if (m) return { field: m[1], specConstraint: { type: 'gt', value: parseFloat(m[2]) } };
  // <
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*<\\s*(${NUM_RE.source})$`));
  if (m) return { field: m[1], specConstraint: { type: 'lt', value: parseFloat(m[2]) } };
  // == 字符串
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*(?:==|=)\\s*${QUOTED_RE.source}$`));
  if (m) return { field: m[1], specConstraint: { type: 'eq_str', value: m[2] } };
  // == 数字
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*(?:==|=)\\s*(${NUM_RE.source})$`));
  if (m) return { field: m[1], specConstraint: { type: 'eq_int', value: parseFloat(m[2]) } };
  // != 数字
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*!=\\s*(${NUM_RE.source})$`));
  if (m) return { field: m[1], specConstraint: { type: 'neq_int', value: parseFloat(m[2]) } };
  // != 字符串
  m = constraintStr.match(new RegExp(`^(\\w+)\\s*!=\\s*${QUOTED_RE.source}$`));
  if (m) return { field: m[1], specConstraint: { type: 'neq_str', value: m[2] } };
  // 枚举 x in {a, b, c} 或 x in [a, b, c]
  m = constraintStr.match(/^(\w+)\s*in\s*[\[{]\s*(.+?)\s*[}\]]$/i);
  if (m) {
    const vals = m[2].split(/,\s*/).map(v => v.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    return { field: m[1], specConstraint: { type: 'enum', values: vals } };
  }
  // 布尔
  m = constraintStr.match(/^(\w+)\s*(?:==|=)?\s*(true|false)$/i);
  if (m) return { field: m[1], specConstraint: { type: 'eq_bool', value: m[2].toLowerCase() === 'true' } };

  return null;
}

function translateCodeType(ct, vars) {
  const { field, type } = ct;
  const typeLower = type.toLowerCase().trim();

  const unionMatch = type.match(/^"([^"]+)"(\s*\|\s*"[^"]+")*$/);
  if (unionMatch) {
    const values = type.match(/"([^"]+)"/g).map(v => v.replace(/"/g, ''));
    const v = strVar(field);
    let enumExpr = v.eq(strVal(values[0]));
    for (let i = 1; i < values.length; i++) enumExpr = enumExpr.or(v.eq(strVal(values[i])));
    return { var: v, constraints: [enumExpr], enumValues: values };
  }

  if (/^(number|int|integer|i8|i16|i32|i64|u8|u16|u32|u64|usize|isize|bigint|long|short)$/.test(typeLower)) {
    const v = intVar(field);
    const constraints = [];
    const boundMap = { u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647] };
    const bounds = boundMap[typeLower];
    if (bounds) { constraints.push(v.ge(intVal(bounds[0]))); constraints.push(v.le(intVal(bounds[1]))); }
    else if (typeLower.startsWith('u')) { constraints.push(v.ge(intVal(0))); }
    return { var: v, constraints };
  }

  if (/^(float|f32|f64|double|real|decimal)$/.test(typeLower)) {
    return { var: intVar(field), constraints: [] };
  }

  if (/^(bool|boolean)$/.test(typeLower)) {
    return { var: boolVar(field), constraints: [] };
  }

  if (/^(string|str|text|varchar|char)$/.test(typeLower)) {
    return { var: strVar(field), constraints: [] };
  }

  const nullableMatch = type.match(/^(.+?)\s*\|\s*null$/);
  if (nullableMatch) {
    const inner = translateCodeType({ field, type: nullableMatch[1] }, vars);
    if (inner) inner.nullable = true;
    return inner;
  }

  const arrayMatch = type.match(/^(.+?)\[\]$|^(?:Array|Vec|List)<(.+)>$/);
  if (arrayMatch) {
    return { var: intVar(`${field}_len`), constraints: [intVar(`${field}_len`).ge(intVal(0))], isArray: true };
  }

  return { var: intVar(field), constraints: [] };
}

function buildSpecExpr(specConstraint, codeVarInfo) {
  const v = codeVarInfo.var;
  switch (specConstraint.type) {
    case 'gte': return v.ge(intVal(specConstraint.value));
    case 'lte': return v.le(intVal(specConstraint.value));
    case 'gt': return v.gt(intVal(specConstraint.value));
    case 'lt': return v.lt(intVal(specConstraint.value));
    case 'eq_int': return v.eq(intVal(specConstraint.value));
    case 'neq_int': return v.neq(intVal(specConstraint.value));
    case 'eq_bool': return v.eq(boolVal(specConstraint.value));
    case 'eq_str': return v.eq(strVal(specConstraint.value));
    case 'neq_str': return v.neq(strVal(specConstraint.value));
    case 'range': return getCtx().And([v.ge(intVal(specConstraint.min)), v.le(intVal(specConstraint.max))]);
    case 'enum': {
      if (codeVarInfo.enumValues) {
        const specSet = new Set(specConstraint.values);
        const codeSet = new Set(codeVarInfo.enumValues);
        if ([...specSet].every(x => codeSet.has(x))) return boolVal(true);
      }
      let enumExpr = v.eq(strVal(specConstraint.values[0]));
      for (let i = 1; i < specConstraint.values.length; i++) enumExpr = enumExpr.or(v.eq(strVal(specConstraint.values[i])));
      return enumExpr;
    }
    default: return null;
  }
}

function suggestTighterType(specConstraint) {
  switch (specConstraint.type) {
    case 'gte': return `number & { >= ${specConstraint.value} } (branded type)`;
    case 'lte': return `number & { <= ${specConstraint.value} }`;
    case 'gt': return `number & { > ${specConstraint.value} }`;
    case 'lt': return `number & { < ${specConstraint.value} }`;
    case 'range': return `${specConstraint.min}...${specConstraint.max} (range type)`;
    case 'eq_int': return `${specConstraint.value} (literal type)`;
    case 'eq_str': return `"${specConstraint.value}" (literal type)`;
    case 'enum': return specConstraint.values.map(v => `"${v}"`).join(' | ');
    default: return '(manual constraint needed)';
  }
}

// === 工具 4: verify_alignment ===
// 合并 verify_code_alignment + check_type_strictness
// 根据 specPath 或 specConstraints+codeTypes 自动选择模式

async function verifyAlignment(params) {
  const c = await ensureZ3();
  const { specConstraints, codeTypes, strictMode, fieldType, codeType, specConstraint } = params;
  const out = ['SPEC-CODE ALIGNMENT VERIFICATION'];

  // 模式 A：单字段严格性检查（提供了 fieldType + codeType + specConstraint）
  if (fieldType && codeType && specConstraint) {
    out.push(`Mode: Single Field Strictness`);
    out.push(`Field: ${fieldType} | Code type: ${codeType} | SPEC: ${specConstraint}`);

    const parsed = parseSpecAlignment(specConstraint);
    if (!parsed) {
      out.push('\nCould not parse SPEC constraint.');
      return { content: [{ type: 'text', text: out.join('\n') }] };
    }

    const codeVarInfo = translateCodeType({ field: fieldType, type: codeType }, new Map());
    if (!codeVarInfo) {
      out.push('\nCould not translate code type.');
      return { content: [{ type: 'text', text: out.join('\n') }] };
    }

    const v = codeVarInfo.var;
    const solver = new c.Solver();
    solver.set('timeout', 30000);
    if (codeVarInfo.constraints) for (const cc of codeVarInfo.constraints) solver.add(cc);

    const specExpr = buildSpecExpr(parsed.specConstraint, codeVarInfo);
    if (!specExpr) {
      out.push('\nCannot formalize this SPEC constraint type.');
      return { content: [{ type: 'text', text: out.join('\n') }] };
    }

    solver.add(specExpr.not());
    const result = await solver.check();

    out.push('\n=== Strictness Analysis ===');
    if (result === 'sat') {
      out.push('TOO LOOSE ⚠️');
      const model = solver.model();
      const val = extractValue(model.eval(v));
      out.push(`Counterexample: ${fieldType} = ${val}`);
      out.push(`Violates SPEC "${specConstraint}" while satisfying code type "${codeType}"`);
      out.push(`\nRecommendation: ${fieldType}: ${suggestTighterType(parsed.specConstraint)}`);
    } else if (result === 'unsat') {
      out.push('STRICT ENOUGH ✅');
      out.push(`"${codeType}" enforces "${specConstraint}"`);
    } else {
      out.push(`Result: ${result}`);
    }

    // Code type range analysis
    const codeSolver = new c.Solver();
    if (codeVarInfo.constraints) for (const cc of codeVarInfo.constraints) codeSolver.add(cc);
    const codeResult = await codeSolver.check();
    if (codeResult === 'sat') {
      const codeModel = codeSolver.model();
      out.push(`\nCode type example: ${fieldType} = ${extractValue(codeModel.eval(v))}`);

      const boundSolver = new c.Solver();
      if (codeVarInfo.constraints) for (const cc of codeVarInfo.constraints) boundSolver.add(cc);
      let lo = null;
      for (const test of [-1000000, -1000, -1, 0, 1, 1000, 1000000]) {
        boundSolver.push();
        boundSolver.add(v.le(intVal(test)));
        if ((await boundSolver.check()) === 'unsat') { lo = test + 1; boundSolver.pop(); break; }
        boundSolver.pop();
      }
      if (lo !== null) out.push(`Lower bound: >= ${lo}`);

      const hiSolver = new c.Solver();
      if (codeVarInfo.constraints) for (const cc of codeVarInfo.constraints) hiSolver.add(cc);
      let hi = null;
      for (const test of [1000000, 1000, 100, 10, 1, 0, -1]) {
        hiSolver.push();
        hiSolver.add(v.ge(intVal(test)));
        if ((await hiSolver.check()) === 'unsat') { hi = test - 1; hiSolver.pop(); break; }
        hiSolver.pop();
      }
      if (hi !== null) out.push(`Upper bound: <= ${hi}`);
    }

    return { content: [{ type: 'text', text: out.join('\n') }] };
  }

  // 模式 B：批量对齐检查（specConstraints + codeTypes）
  const actualSpecConstraints = specConstraints || [];
  const actualCodeTypes = codeTypes || [];

  out.push('Mode: Batch Alignment');
  const gaps = [];

  out.push(`\nSPEC Constraints (${actualSpecConstraints.length}):`);
  const specVars = new Map();
  for (const sc of actualSpecConstraints) {
    out.push(`  ${sc}`);
    const parsed = parseConstraintLine(sc, specVars);
    if (!parsed) out.push('    ⚠ could not parse');
  }

  out.push(`\nCode Types (${actualCodeTypes.length}):`);
  const codeVars = new Map();
  for (const ct of actualCodeTypes) {
    out.push(`  ${ct.field}: ${ct.type}`);
    const z3Var = translateCodeType(ct, codeVars);
    if (z3Var) codeVars.set(ct.field, z3Var);
  }

  out.push('\n=== Alignment Check ===');

  for (const sc of actualSpecConstraints) {
    const specParsed = parseSpecAlignment(sc);
    if (!specParsed) continue;

    const { field, specConstraint } = specParsed;
    const codeVar = codeVars.get(field);

    if (!codeVar) {
      gaps.push({ field, spec: sc, issue: 'NOT_IN_CODE', detail: `Field "${field}" has SPEC constraint but no code type` });
      continue;
    }

    const misalignSolver = new c.Solver();
    misalignSolver.set('timeout', 15000);
    for (const [, cv] of codeVars) {
      if (cv.constraints) for (const cc of cv.constraints) misalignSolver.add(cc);
    }

    const specExpr = buildSpecExpr(specConstraint, codeVar);
    if (specExpr) { misalignSolver.add(specExpr.not()); } else { continue; }

    const misResult = await misalignSolver.check();
    if (misResult === 'sat') {
      const model = misalignSolver.model();
      const val = extractValue(model.eval(codeVar.var));
      gaps.push({ field, spec: sc, issue: 'TOO_LOOSE', detail: `Code allows "${field} = ${val}" violating "${sc}"`, counterexample: val });
    }
  }

  if (strictMode) {
    const specFields = new Set(actualSpecConstraints.map(sc => parseSpecAlignment(sc)).filter(Boolean).map(s => s.field));
    for (const [field] of codeVars) {
      if (!specFields.has(field)) gaps.push({ field, spec: null, issue: 'NOT_IN_SPEC', detail: `Code defines "${field}" but SPEC has no constraint` });
    }
  }

  const aligned = actualSpecConstraints.length - gaps.filter(g => g.issue === 'TOO_LOOSE' || g.issue === 'NOT_IN_CODE').length;
  const alignmentPct = actualSpecConstraints.length > 0 ? ((aligned / actualSpecConstraints.length) * 100).toFixed(1) : '100.0';

  out.push('\n=== Alignment Report ===');
  out.push(`SPEC constraints: ${actualSpecConstraints.length}`);
  out.push(`Code fields: ${codeVars.size}`);
  out.push(`Alignment: ${alignmentPct}%`);
  out.push(`Gaps: ${gaps.length}`);

  if (!gaps.length) {
    out.push('\n✅ PERFECT ALIGNMENT');
  } else {
    out.push('');
    for (const gap of gaps) {
      if (gap.issue === 'NOT_IN_CODE') out.push(`🛑 ${gap.field}: Missing in code — ${gap.detail}`);
      else if (gap.issue === 'TOO_LOOSE') { out.push(`⚠️  ${gap.field}: Too loose — ${gap.detail}`); out.push(`     Counterexample: ${gap.field} = ${gap.counterexample}`); }
      else if (gap.issue === 'NOT_IN_SPEC') out.push(`ℹ️  ${gap.field}: Extra in code — ${gap.detail}`);
    }
    out.push('\n=== Recommendations ===');
    for (const gap of gaps.filter(g => g.issue === 'TOO_LOOSE')) {
      const parsed = parseSpecAlignment(gap.spec);
      if (parsed) out.push(`  ${gap.field}: Tighten to ${suggestTighterType(parsed.specConstraint)}`);
    }
    for (const gap of gaps.filter(g => g.issue === 'NOT_IN_CODE')) out.push(`  Add code field for "${gap.field}"`);
  }

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// === 工具注册（4 个） ===

export function registerZ3Tools(server) {
  server.tool('verify_spec',
    'SPEC约束一致性验证：数据约束求解+全局一致性+两两冲突检测。',
    { specPath: z.string().describe('SPEC 目录路径或单个 SPEC 文件路径') },
    verifySpec);

  server.tool('verify_formal',
    '形式化验证。契约模式：preconditions→postconditions。反例模式：constraints+property→Z3求解违反值。',
    {
      constraints: z.string().optional().describe('[反例模式] 约束条件，每行一个。支持：x >= 5, x == "hello", IF p THEN q, x ∈ [0,100]'),
      property: z.string().optional().describe('[反例模式] 要验证的属性（取反后搜索反例）'),
      preconditions: z.array(z.string()).optional().describe('[契约模式] 前置条件数组，如：age >= 18'),
      postconditions: z.array(z.string()).optional().describe('[契约模式] 后置条件数组。提供此项则自动切换到契约模式'),
    },
    verifyFormal);

  server.tool('verify_state_machine',
    '状态机完备性证明：可达性+终止性+确定性。BFS+Z3双重验证。',
    {
      states: z.array(z.string()).describe('状态名称数组'),
      transitions: z.array(z.object({ from: z.string(), to: z.string(), on: z.string().optional() })).describe('转换数组：{from, to, on?}'),
      initialState: z.string().optional().describe('初始状态名（默认 states[0]）'),
    },
    verifyStateMachine);

  server.tool('verify_alignment',
    'SPEC-代码类型对齐验证(Z3)。单字段模式：fieldType+codeType+specConstraint。批量模式：specConstraints+codeTypes。',
    {
      specPath: z.string().optional().describe('[未使用，保留扩展] SPEC 路径'),
      specConstraints: z.array(z.string()).optional().describe('[批量模式] SPEC 约束数组'),
      codeTypes: z.array(z.object({ field: z.string(), type: z.string() })).optional().describe('[批量模式] 代码类型定义'),
      strictMode: z.boolean().default(false).describe('[批量模式] 严格模式：额外检查代码中有但 SPEC 无的字段'),
      fieldType: z.string().optional().describe('[单字段模式] 字段名'),
      codeType: z.string().optional().describe('[单字段模式] 代码类型（如 number, u8, "A" | "B"）'),
      specConstraint: z.string().optional().describe('[单字段模式] SPEC 约束（如 age >= 18）'),
    },
    verifyAlignment);
}
