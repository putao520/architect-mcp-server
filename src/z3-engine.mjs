// Z3 SMT Solver — 懒加载 WASM 引擎
// z3-solver 是 CJS 包，ESM 环境需 createRequire 桥接

import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);

let Z3 = null;
let _ctx = null;

export async function ensureZ3() {
  if (_ctx) return _ctx;
  const mod = cjsRequire('z3-solver');
  Z3 = await mod.init();
  _ctx = new Z3.Context('main');
  return _ctx;
}

export function getCtx() { return _ctx; }

export function intVar(name) { return _ctx.Int.const(name); }
export function boolVar(name) { return _ctx.Bool.const(name); }
export function strVar(name) { return _ctx.String.const(name); }
export function intVal(n) { return _ctx.Int.val(n); }
export function boolVal(b) { return _ctx.Bool.val(b); }
export function strVal(s) { return _ctx.String.val(s); }

export function extractValue(v) {
  const s = v.toString();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s.replace(/^"|"$/g, '');
}
