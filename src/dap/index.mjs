#!/usr/bin/env node

/**
 * DAP MCP Server — CC 原生 MCP 调试工具 (v2.0.0)
 *
 * 8 个高级融合工具：会话管理、断点、执行控制、运行时检查、二进制分析。
 * 与 lsp-tools 配合使用，实现 LSP 静态理解 + DAP 动态验证的融合诊断。
 */

import { z } from 'zod';
import { execSync } from 'child_process';
import { DapClient } from './dap-client.mjs';
import { ADAPTERS, TOOLS, resolveAdapter, checkEnvironment, generateInstallScript } from './adapters.mjs';
import { detectAndGetClient, getHoverText, findEnclosingFunction } from '../lsp/index.mjs';
import { detectLspServer } from '../lsp/shared.mjs';

// === 会话管理 ===

export function registerDapTools(server) {

const sessions = new Map();
let sessionCounter = 0;

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found. Active sessions: ${[...sessions.keys()].join(', ') || 'none'}`);
  return session;
}

// === 断点命中通知 ===

async function handleStoppedEvent(sessionId, stoppedBody) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const { client } = session;
  const reason = stoppedBody.reason || 'unknown';
  const description = stoppedBody.description || stoppedBody.text || '';
  const threadId = stoppedBody.threadId;

  const reasonMap = {
    breakpoint: '断点命中',
    step: '单步暂停',
    exception: '异常触发',
    pause: '手动暂停',
    entry: '入口暂停',
    goto: '跳转暂停',
    'function breakpoint': '函数断点命中',
    'instruction breakpoint': '指令断点命中',
    'data breakpoint': '数据断点命中',
    signal: '信号中断',
  };
  const reasonText = reasonMap[reason] || reason;

  let exceptionInfo = null;
  if (reason === 'exception') {
    try {
      const resp = await client.sendRequest('exceptionInfo', { threadId });
      exceptionInfo = resp.body;
    } catch {}
  }

  const isCrash = reason === 'exception' || reason === 'signal';
  const stackLevels = isCrash ? 50 : 1;
  let stackFrames = [];
  let topFrameId = null;
  let topLocation = '(位置未知)';

  try {
    const stack = await client.stackTrace(threadId, stackLevels);
    stackFrames = stack?.stackFrames || [];
    if (stackFrames.length) {
      const frame = stackFrames[0];
      const file = frame.source?.path || frame.source?.name || '?';
      topLocation = `${file}:${frame.line}:${frame.column || 1} — ${frame.name}`;
      topFrameId = frame.id;
    }
  } catch {}

  const varFrames = isCrash ? Math.min(3, stackFrames.length) : (topFrameId != null ? 1 : 0);
  const frameVars = [];
  for (let i = 0; i < varFrames; i++) {
    const frame = stackFrames[i];
    if (!frame) continue;
    try {
      const vars = await client.getLocalVariables(frame.id);
      const summary = vars.slice(0, 10).map(v => `${v.name}=${v.value}`);
      frameVars.push({ frame: `#${i} ${frame.name}`, vars: summary });
    } catch {}
  }

  const lines = [];
  lines.push(`[DAP ${sessionId}] ${reasonText}`);
  lines.push(`位置: ${topLocation}`);

  if (description) {
    lines.push(`描述: ${description}`);
  }

  if (exceptionInfo) {
    lines.push('');
    lines.push('=== 异常详情 ===');
    if (exceptionInfo.exceptionId) lines.push(`异常ID: ${exceptionInfo.exceptionId}`);
    if (exceptionInfo.description) lines.push(`描述: ${exceptionInfo.description}`);
    if (exceptionInfo.breakMode) lines.push(`中断模式: ${exceptionInfo.breakMode}`);
    if (exceptionInfo.details) {
      const d = exceptionInfo.details;
      if (d.message) lines.push(`消息: ${d.message}`);
      if (d.typeName) lines.push(`类型: ${d.typeName}`);
      if (d.stackTrace) lines.push(`异常栈:\n${d.stackTrace}`);
      if (d.innerException) lines.push(`内部异常: ${JSON.stringify(d.innerException)}`);
    }
  }

  if (reason === 'signal' && stoppedBody.body) {
    lines.push('');
    lines.push('=== 信号详情 ===');
    if (stoppedBody.body.name) lines.push(`信号: ${stoppedBody.body.name}`);
    if (stoppedBody.body.description) lines.push(`描述: ${stoppedBody.body.description}`);
  }

  if (isCrash && stackFrames.length > 1) {
    lines.push('');
    lines.push(`=== 调用栈 (${stackFrames.length} 帧) ===`);
    for (let i = 0; i < stackFrames.length; i++) {
      const f = stackFrames[i];
      const file = f.source?.path || f.source?.name || '?';
      lines.push(`  #${i} ${f.name}  at ${file}:${f.line}:${f.column || 1}`);
    }
  }

  if (frameVars.length) {
    lines.push('');
    lines.push('=== 局部变量 ===');
    for (const fv of frameVars) {
      lines.push(`  ${fv.frame}: ${fv.vars.join(', ') || '(空)'}`);
    }
  }

  lines.push('');
  if (isCrash) {
    lines.push('崩溃/异常中断！使用以下工具继续诊断：');
    lines.push('  dap_evaluate — 求值可疑表达式');
    lines.push('  dap_stack_trace — 查看完整调用栈');
    lines.push('  dap_inspect — LSP+DAP 融合诊断');
  } else {
    lines.push('使用 dap_run_control / dap_evaluate / dap_inspect 继续调试。');
  }

  const message = lines.join('\n');

  try {
    await server.server.notification({
      method: 'notifications/message',
      params: {
        level: isCrash ? 'error' : 'info',
        logger: 'dap-tools',
        data: message,
      },
    });
  } catch {}
}

function registerStoppedHandler(sessionId, client) {
  client.onStopped(async (body) => {
    handleStoppedEvent(sessionId, body).catch(() => {});
  });

  client.onLifecycle(async (event) => {
    const lines = [];
    if (event.type === 'exited') {
      const code = event.exitCode;
      const isCrash = code != null && code !== 0;
      lines.push(`[DAP ${sessionId}] 进程退出 (exitCode=${code})`);
      if (isCrash) {
        lines.push('非零退出码！可能原因：未捕获异常/段错误/断言失败');
        lines.push('使用 dap_stack_trace / dap_evaluate 查看崩溃现场');
      }
    } else if (event.type === 'terminated') {
      lines.push(`[DAP ${sessionId}] 调试会话终止`);
      if (event.restart) lines.push('支持重启 (restart=true)');
    }

    if (lines.length) {
      try {
        await server.server.notification({
          method: 'notifications/message',
          params: {
            level: event.type === 'exited' && event.exitCode !== 0 ? 'error' : 'info',
            logger: 'dap-tools',
            data: lines.join('\n'),
          },
        });
      } catch {}
    }
  });

  client.onModule(async (body) => {
    if (!body?.module) return;
    const mod = body.module;
    const reason = body.reason || 'new';
    const lines = [];
    lines.push(`[DAP ${sessionId}] 模块加载: ${mod.name || '?'}`);
    if (mod.path) lines.push(`  路径: ${mod.path}`);
    if (reason === 'changed') lines.push(`  原因: 已更新`);
    if (mod.symbolStatus) lines.push(`  符号: ${mod.symbolStatus}`);
    if (mod.addressRange) lines.push(`  地址: ${mod.addressRange}`);

    try {
      await server.server.notification({
        method: 'notifications/message',
        params: {
          level: 'info',
          logger: 'dap-tools',
          data: lines.join('\n'),
        },
      });
    } catch {}
  });
}

// ============================================================
// 工具 1/8: dap_check_env
// ============================================================

server.tool('dap_check_env',
  '检测 Debug Adapter 和静态分析工具安装状态，install=true 自动安装。',
  {
    install: z.boolean().default(false).describe('是否自动安装缺失工具(默认否,只输出检测报告)'),
  },
  async ({ install }) => {
    const env = checkEnvironment();
    const output = [];

    output.push('=== DAP Environment Check ===');
    output.push('');

    output.push('--- Debug Adapters ---');
    const missingAdapters = [];
    for (const [name, info] of Object.entries(env.adapters)) {
      const status = info.available ? '✓' : '✗';
      const path = info.path ? ` (${info.path})` : '';
      const v = info.version ? ` ${info.version}` : '';
      output.push(`  ${status} ${name}${path}${v}`);
      if (!info.available) {
        const adapter = ADAPTERS[name];
        missingAdapters.push({ name, install: adapter.install });
      }
    }
    output.push('');

    output.push('--- Static Analysis Tools ---');
    const missingTools = [];
    for (const [name, info] of Object.entries(env.tools)) {
      const status = info.available ? '✓' : '✗';
      const path = info.path ? ` (${info.path})` : '';
      output.push(`  ${status} ${name}${path}`);
      if (!info.available) {
        missingTools.push({ name, install: TOOLS[name]?.install });
      }
    }
    output.push('');

    const allMissing = [...missingAdapters, ...missingTools];
    if (allMissing.length === 0) {
      output.push('=== ALL TOOLS READY ===');
    } else {
      output.push(`=== ${allMissing.length} TOOL(S) MISSING ===`);
      output.push('');

      output.push('--- Install Commands ---');
      for (const item of allMissing) {
        output.push(`  # ${item.name}`);
        if (item.install?.apt) output.push(`  ${item.install.apt}`);
        if (item.install?.pip) output.push(`  ${item.install.pip}`);
        if (item.install?.go) output.push(`  ${item.install.go}`);
        if (item.install?.note) output.push(`  # Note: ${item.install.note}`);
      }
      output.push('');

      output.push('--- One-Click Install Script ---');
      const script = generateInstallScript(allMissing);
      output.push('```bash');
      output.push(script);
      output.push('```');
    }

    if (install && allMissing.length) {
      output.push('');
      output.push('--- Installing Missing Tools ---');
      const script = generateInstallScript(allMissing);
      const installCmds = script.split('\n').filter(l => l && !l.startsWith('#') && l !== '#!/bin/bash' && l !== 'set -e');
      for (const cmd of installCmds) {
        if (!cmd.startsWith('sudo') && !cmd.startsWith('pip') && !cmd.startsWith('go')) continue;
        output.push(`  $ ${cmd}`);
        try {
          execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
          output.push(`  ✓ done`);
        } catch (e) {
          output.push(`  ✗ failed: ${e.message?.slice(0, 100)}`);
        }
      }
      output.push('');
      output.push('Re-run dap_check_env to verify installation.');
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 2/8: dap_start_session — launch + attach + disconnect
// ============================================================

server.tool('dap_start_session',
  '调试会话：launch=启动 | attach=附加进程 | disconnect=断开。disconnect后必须调用否则进程残留。',
  {
    action: z.enum(['launch', 'attach', 'disconnect']).describe('launch=启动调试 | attach=附加进程 | disconnect=断开会话'),
    program: z.string().optional().describe('[launch] 可执行文件路径(如 target/debug/myapp、./src/main.py)'),
    adapter: z.string().default('lldb-dap').describe('[launch/attach] 调试适配器: lldb-dap | gdb | codelldb | node | debugpy | dlv'),
    args: z.array(z.string()).default([]).describe('[launch] 命令行参数'),
    cwd: z.string().optional().describe('[launch/attach] 工作目录'),
    env: z.record(z.string()).optional().describe('[launch] 环境变量'),
    stopOnEntry: z.boolean().default(false).describe('[launch] 是否在入口处暂停(默认否)'),
    pid: z.number().optional().describe('[attach] 目标进程 ID'),
    sessionId: z.string().optional().describe('[disconnect] 会话 ID'),
    terminate: z.boolean().default(true).describe('[disconnect] 是否终止被调试进程(默认是)'),
  },
  async (params) => {
    const { action } = params;

    if (action === 'launch') {
      const { program, adapter: adapterName, args, cwd, env, stopOnEntry } = params;
      if (!program) throw new Error('launch 需要 program 参数');
      const adapter = resolveAdapter(adapterName);

      const sessionId = `dap-${++sessionCounter}`;
      const client = new DapClient(sessionId);

      await client.connectAdapter(adapter.command, adapter.args, cwd);
      const capabilities = await client.initialize();
      await client.launch(program, args, cwd, env, stopOnEntry);

      let threadList = [];
      try { threadList = (await client.threads())?.threads || []; } catch {}

      sessions.set(sessionId, { client, adapter: adapterName, program, capabilities });
      registerStoppedHandler(sessionId, client);

      const output = [
        `SESSION: ${sessionId}`,
        `Adapter: ${adapterName} (${adapter.command})`,
        `Program: ${program}`,
        `Capabilities: ${JSON.stringify(capabilities).slice(0, 500)}`,
        `Threads: ${threadList.map(t => `#${t.id} ${t.name}`).join(', ') || 'waiting for threads'}`,
        '',
        'Next: dap_set_breakpoint → dap_run_control(continue) → dap_evaluate/dap_inspect',
      ];

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }

    if (action === 'attach') {
      const { program, pid, adapter: adapterName, cwd } = params;
      if (!pid) throw new Error('attach 需要 pid 参数');
      const adapter = resolveAdapter(adapterName);

      const sessionId = `dap-${++sessionCounter}`;
      const client = new DapClient(sessionId);

      await client.connectAdapter(adapter.command, adapter.args, cwd);
      const capabilities = await client.initialize();
      await client.attach(program, pid, cwd);

      sessions.set(sessionId, { client, adapter: adapterName, program, pid, capabilities });
      registerStoppedHandler(sessionId, client);

      return { content: [{ type: 'text', text: `SESSION: ${sessionId}\nAttached to PID ${pid}\nAdapter: ${adapterName}` }] };
    }

    if (action === 'disconnect') {
      const { sessionId, terminate } = params;
      if (!sessionId) throw new Error('disconnect 需要 sessionId 参数');
      const session = getSession(sessionId);
      await session.client.disconnect(terminate);
      sessions.delete(sessionId);
      return { content: [{ type: 'text', text: `SESSION ${sessionId} disconnected` }] };
    }
  }
);

// ============================================================
// 工具 3/8: dap_set_breakpoint — line + function + instruction
// ============================================================

server.tool('dap_set_breakpoint',
  '设置断点：line(行)|function(函数名)|instruction(地址)。支持condition和hitCondition，line支持logMessage日志点。',
  {
    sessionId: z.string().describe('会话 ID'),
    type: z.enum(['line', 'function', 'instruction']).describe('line=行断点 | function=函数断点 | instruction=指令断点'),
    file: z.string().optional().describe('[line] 源文件绝对路径'),
    line: z.number().optional().describe('[line] 行号(1-indexed)'),
    name: z.string().optional().describe('[function] 函数名(如 "process_order"、"MyClass::handle")'),
    instructionReference: z.string().optional().describe('[instruction] 指令引用(从 stackFrame 获取或内存地址如 "0x7fff5a3b2c10")'),
    offset: z.number().optional().describe('[instruction] 偏移量(相对于 instructionReference 的字节偏移)'),
    condition: z.string().optional().describe('条件表达式(如 "order_id > 100"),为真时暂停'),
    hitCondition: z.string().optional().describe('命中次数(如 "5" 表示第 5 次命中时暂停)'),
    logMessage: z.string().optional().describe('[line] 日志点消息(如 "{order_id}"),命中时输出而不暂停'),
  },
  async ({ sessionId, type, file, line, name, instructionReference, offset, condition, hitCondition, logMessage }) => {
    const session = getSession(sessionId);

    if (type === 'line') {
      if (!file || !line) throw new Error('line 断点需要 file 和 line 参数');
      const bp = { line };
      if (condition) bp.condition = condition;
      if (hitCondition) bp.hitCondition = hitCondition;
      if (logMessage) bp.logMessage = logMessage;

      const result = await session.client.setBreakpoints(file, [bp]);
      const breakpoints = result?.breakpoints || [];

      const lines = breakpoints.map((bp, i) => {
        const status = bp.verified ? 'VERIFIED' : 'PENDING';
        const extra = [];
        if (bp.id != null) extra.push(`id=${bp.id}`);
        if (bp.line != null) extra.push(`line=${bp.line}`);
        if (bp.message) extra.push(`msg: ${bp.message}`);
        return `  #${i + 1} ${status} ${extra.join(' ')}`;
      });

      return { content: [{ type: 'text', text: `BREAKPOINT SET at ${file}:${line}\n${lines.join('\n')}` }] };
    }

    if (type === 'function') {
      if (!name) throw new Error('function 断点需要 name 参数');
      const bp = { name };
      if (condition) bp.condition = condition;

      const result = await session.client.setFunctionBreakpoints([bp]);
      const breakpoints = result?.breakpoints || [];

      return { content: [{ type: 'text', text: `FUNCTION BREAKPOINT SET: ${name}\n${breakpoints.map((bp, i) => `  #${i + 1} ${bp.verified ? 'VERIFIED' : 'PENDING'}`).join('\n')}` }] };
    }

    if (type === 'instruction') {
      if (!instructionReference) throw new Error('instruction 断点需要 instructionReference 参数');
      const bp = { instructionReference };
      if (offset != null) bp.offset = offset;
      if (condition) bp.condition = condition;
      if (hitCondition) bp.hitCondition = hitCondition;

      const result = await session.client.setInstructionBreakpoints([bp]);
      const breakpoints = result?.breakpoints || [];

      const lines = breakpoints.map((bp, i) => {
        const status = bp.verified ? 'VERIFIED' : 'PENDING';
        const extra = [];
        if (bp.id != null) extra.push(`id=${bp.id}`);
        if (bp.instructionReference) extra.push(`ref=${bp.instructionReference}`);
        if (bp.offset != null) extra.push(`offset=${bp.offset}`);
        if (bp.message) extra.push(`msg: ${bp.message}`);
        return `  #${i + 1} ${status} ${extra.join(' ')}`;
      });

      return { content: [{ type: 'text', text: `INSTRUCTION BREAKPOINT SET at ${instructionReference}${offset != null ? `+${offset}` : ''}\n${lines.join('\n')}` }] };
    }
  }
);

// ============================================================
// 工具 4/8: dap_run_control — continue + step
// ============================================================

server.tool('dap_run_control',
  '执行控制：continue|next(步过)|stepIn(步入)|stepOut(步出)。',
  {
    sessionId: z.string().describe('会话 ID'),
    action: z.enum(['continue', 'next', 'stepIn', 'stepOut']).describe('continue=继续运行 | next=步过 | stepIn=步入 | stepOut=步出'),
    threadId: z.number().optional().describe('线程 ID(默认当前线程)'),
  },
  async ({ sessionId, action, threadId }) => {
    const session = getSession(sessionId);

    if (action === 'continue') {
      const result = await session.client.continue(threadId);
      return { content: [{ type: 'text', text: `CONTINUE: running${result?.allThreadsContinued ? ' (all threads)' : ''}` }] };
    }

    const modeNames = { next: '步过(NEXT)', stepIn: '步入(STEP IN)', stepOut: '步出(STEP OUT)' };

    switch (action) {
      case 'next': await session.client.next(threadId); break;
      case 'stepIn': await session.client.stepIn(threadId); break;
      case 'stepOut': await session.client.stepOut(threadId); break;
    }

    await new Promise(r => setTimeout(r, 200));

    let position = '';
    try {
      const stack = await session.client.stackTrace(threadId);
      if (stack?.stackFrames?.length) {
        const frame = stack.stackFrames[0];
        position = `\nNow at: ${frame.source?.path || '?'}:${frame.line}:${frame.column || 1} — ${frame.name}`;
      }
    } catch {}

    return { content: [{ type: 'text', text: `STEP: ${modeNames[action]}${position}` }] };
  }
);

// ============================================================
// 工具 5/8: dap_inspect — LSP+DAP 融合诊断
// ============================================================

server.tool('dap_inspect',
  'LSP+DAP融合诊断：断点处整合静态上下文(类型/引用/调用链)+运行时数据(变量/栈/表达式)，输出完整故障定位。',
  {
    sessionId: z.string().describe('会话 ID'),
    frameId: z.number().optional().describe('栈帧 ID(默认栈顶)'),
    expressions: z.array(z.string()).default([]).describe('额外要求值的表达式列表(如 ["order.status", "err.kind"])'),
  },
  async ({ sessionId, frameId, expressions }) => {
    const session = getSession(sessionId);
    const client = session.client;

    const stackResp = await client.stackTrace();
    const frames = stackResp?.stackFrames || [];
    if (!frames.length) {
      return { content: [{ type: 'text', text: 'INSPECT: program not paused, no stack frames available' }] };
    }

    const targetFrame = frameId != null
      ? frames.find(f => f.id === frameId) || frames[0]
      : frames[0];

    const output = [];
    output.push(`=== DAP+LSP INSPECT at ${targetFrame.source?.path || '?'}:${targetFrame.line}:${targetFrame.column || 1} ===`);
    output.push(`Function: ${targetFrame.name}`);
    output.push('');

    output.push('--- Call Stack (DAP) ---');
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const marker = f.id === targetFrame.id ? '>>>' : '   ';
      const file = f.source?.path || f.source?.name || '?';
      output.push(`${marker} #${i} ${f.name}  at ${file}:${f.line}`);
    }
    output.push('');

    output.push('--- Local Variables (DAP value + LSP type hint) ---');
    try {
      const vars = await client.getLocalVariables(targetFrame.id);
      for (const v of vars) {
        const type = v.type ? ` (LSP type hint: ${v.type})` : '';
        const ref = v.variablesReference ? ` [→ expand]` : '';
        output.push(`  ${v.name}: ${v.value}${type}${ref}`);
      }
      if (!vars.length) output.push('  (no local variables)');
    } catch (e) {
      output.push(`  (error reading variables: ${e.message})`);
    }
    output.push('');

    if (expressions.length) {
      output.push('--- Expression Evaluation ---');
      for (const expr of expressions) {
        try {
          const result = await client.evaluate(expr, targetFrame.id);
          const type = result.type ? ` (${result.type})` : '';
          output.push(`  ${expr} = ${result.result}${type}`);
        } catch (e) {
          output.push(`  ${expr} = ERROR: ${e.message}`);
        }
      }
      output.push('');
    }

    const currentFile = targetFrame.source?.path;
    const currentLine = targetFrame.line;
    let lspEnclosing = null;
    let lspHoverText = null;
    let lspRefCount = null;

    if (currentFile) {
      output.push('--- LSP Static Context ---');
      try {
        const client = await detectAndGetClient(currentFile);
        if (client) {
          const currentColumn = targetFrame.column || 1;

          // Hover: type signature at paused position
          try {
            const hoverResp = await client.hover(currentFile, currentLine, currentColumn);
            lspHoverText = getHoverText(hoverResp);
            if (lspHoverText) {
              const firstLine = lspHoverText.split('\n')[0];
              output.push(`  Type: ${firstLine}`);
            }
          } catch {}

          // Document symbols: find enclosing function/class
          try {
            const symResp = await client.documentSymbol(currentFile);
            const symbols = symResp?.result || [];
            lspEnclosing = findEnclosingFunction(symbols, currentLine - 1);
            if (lspEnclosing) {
              const kindNames = ['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant'];
              const kindName = kindNames[lspEnclosing.kind - 1] || `Kind${lspEnclosing.kind}`;
              output.push(`  Enclosing: ${kindName} "${lspEnclosing.name}" L${lspEnclosing.range.start.line + 1}-${lspEnclosing.range.end.line + 1}`);
            }
          } catch {}

          // References count for the symbol at paused position
          try {
            const refResp = await client.references(currentFile, currentLine, currentColumn);
            const refs = refResp?.result || [];
            lspRefCount = refs.length;
            if (refs.length > 0) {
              output.push(`  References: ${refs.length} (use lsp_trace_origin / lsp_impact_analysis for details)`);
            }
          } catch {}

          // Call hierarchy: show callers of the enclosing function
          if (lspEnclosing) {
            try {
              const prepResp = await client.prepareCallHierarchy(
                currentFile,
                lspEnclosing.range.start.line + 1,
                lspEnclosing.range.start.character + 1,
              );
              const items = prepResp?.result || [];
              if (items.length) {
                const callResp = await client.incomingCalls(items[0]);
                const callers = callResp?.result || [];
                if (callers.length) {
                  output.push(`  Callers (${callers.length}):`);
                  for (const caller of callers.slice(0, 5)) {
                    const callerFile = caller.from.uri?.replace(/^file:\/\//, '') || '?';
                    const callerLine = caller.from.range?.start?.line != null ? caller.from.range.start.line + 1 : '?';
                    output.push(`    ${caller.from.name}  ${callerFile}:${callerLine}`);
                  }
                  if (callers.length > 5) {
                    output.push(`    ... and ${callers.length - 5} more`);
                  }
                }
              }
            } catch {}
          }

          // Diagnostics for current file
          try {
            const diagResp = await client.diagnostic(currentFile);
            const diags = diagResp?.result?.items || [];
            const errors = diags.filter(d => d.severity <= 2);
            if (errors.length) {
              const severityNames = ['Error', 'Warning'];
              output.push(`  Diagnostics (${errors.length}):`);
              for (const d of errors.slice(0, 5)) {
                const sev = severityNames[d.severity - 1] || 'Unknown';
                const dLine = d.range?.start?.line != null ? d.range.start.line + 1 : '?';
                output.push(`    ${sev} L${dLine}: ${d.message}`);
              }
            }
          } catch {}

          if (!lspHoverText && !lspEnclosing && lspRefCount === null) {
            output.push('  (no LSP data available at this position)');
          }
        } else {
          const [lang] = detectLspServer(currentFile) || [];
          output.push(`  (no LSP server for ${lang ? lang : 'this file type'})`);
        }
      } catch (e) {
        output.push(`  (LSP unavailable: ${e.message})`);
      }
      output.push('');
    }

    output.push('--- AI Analysis ---');
    output.push('1. Does the call stack match the expected execution path?');
    output.push('2. Are variable values within expected ranges? Any null/unexpected values?');
    output.push('3. Does the error/failure originate from this frame or a caller?');
    if (lspEnclosing) {
      output.push(`4. Enclosing function "${lspEnclosing.name}" has ${lspRefCount ?? '?'} references — use lsp_trace_origin to trace data flow.`);
    } else {
      output.push('4. Use lsp_trace_origin to trace suspicious values back to their source.');
    }
    if (lspHoverText) {
      output.push(`5. Static type at paused position: ${lspHoverText.split('\n')[0]} — does the runtime value match?`);
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 6/8: dap_stack_trace
// ============================================================

server.tool('dap_stack_trace',
  '获取调用栈，显示从当前函数到入口的完整调用链。',
  {
    sessionId: z.string().describe('会话 ID'),
    threadId: z.number().optional().describe('线程 ID(默认当前线程)'),
    levels: z.number().default(20).describe('栈帧数量(默认 20)'),
  },
  async ({ sessionId, threadId, levels }) => {
    const session = getSession(sessionId);
    const result = await session.client.stackTrace(threadId, levels);
    const frames = result?.stackFrames || [];

    if (!frames.length) {
      return { content: [{ type: 'text', text: 'STACK TRACE: (no frames — program may not be paused)' }] };
    }

    const lines = frames.map((f, i) => {
      const file = f.source?.path || f.source?.name || '?';
      const loc = `${file}:${f.line}:${f.column || 1}`;
      return `#${i} ${f.name}  at ${loc}`;
    });

    return { content: [{ type: 'text', text: `STACK TRACE (${frames.length} frames):\n${lines.join('\n')}` }] };
  }
);

// ============================================================
// 工具 7/8: dap_evaluate
// ============================================================

server.tool('dap_evaluate',
  '断点处求值表达式，支持任意表达式如obj.field.subfield，比逐层展开变量更灵活。',
  {
    sessionId: z.string().describe('会话 ID'),
    expression: z.string().describe('要求值的表达式(如 "order.total"、"user.name"、"1 + 2")'),
    frameId: z.number().optional().describe('栈帧 ID(默认栈顶)'),
    context: z.enum(['repl', 'watch', 'hover']).default('repl').describe('求值上下文:repl=交互求值 | watch=监视 | hover=悬停'),
  },
  async ({ sessionId, expression, frameId, context }) => {
    const session = getSession(sessionId);

    let fid = frameId;
    if (fid == null) {
      const stack = await session.client.stackTrace();
      if (stack?.stackFrames?.length) fid = stack.stackFrames[0].id;
    }

    const result = await session.client.evaluate(expression, fid, context);

    const type = result.type ? ` (${result.type})` : '';
    const ref = result.variablesReference ? ` [→ expand with ref=${result.variablesReference}]` : '';

    return { content: [{ type: 'text', text: `EVALUATE: ${expression}\n  = ${result.result}${type}${ref}` }] };
  }
);

// ============================================================
// 工具 8/8: dap_analyze_binary — elf_symbols + dwarf_info + static_disassemble + disassemble + pe_exports + pdb_symbols
// ============================================================

server.tool('dap_analyze_binary',
  '二进制分析：elf_symbols|dwarf_info|static_disassemble|disassemble|pe_exports|pdb_symbols。disassemble外无需调试会话。',
  {
    mode: z.enum(['elf_symbols', 'dwarf_info', 'static_disassemble', 'disassemble', 'pe_exports', 'pdb_symbols']).describe('分析模式'),
    file: z.string().describe('二进制文件路径'),
    // elf_symbols
    filter: z.enum(['all', 'functions', 'globals', 'dynsym']).default('all').describe('[elf_symbols] 过滤:all=全部 | functions=仅函数 | globals=仅全局变量 | dynsym=仅动态符号'),
    demangle: z.boolean().default(true).describe('[elf_symbols] 是否反混淆 C++/Rust 符号名(默认是)'),
    // dwarf_info
    section: z.enum(['info', 'line', 'abbrev', 'frames', 'all']).default('info').describe('[dwarf_info] DWARF section:info=类型/函数/变量定义 | line=源码行号映射 | abbrev=缩写表 | frames=栈帧信息 | all=全部'),
    // static_disassemble
    startAddress: z.string().optional().describe('[static_disassemble] 起始地址(如 "0x401000")'),
    stopAddress: z.string().optional().describe('[static_disassemble] 结束地址(如 "0x401100")'),
    elfSection: z.string().optional().describe('[static_disassemble] 只反汇编指定 section(如 ".text")'),
    architecture: z.enum(['auto', 'x86', 'x86_64', 'arm', 'aarch64', 'mips', 'powerpc', 'riscv']).default('auto').describe('[static_disassemble] 目标架构(默认自动检测)'),
    syntax: z.enum(['att', 'intel']).default('intel').describe('[static_disassemble] 汇编语法(默认 Intel)'),
    // disassemble (runtime)
    sessionId: z.string().optional().describe('[disassemble] 调试会话 ID'),
    memoryReference: z.string().optional().describe('[disassemble] 内存地址(如 "0x7fff5a3b2c10")'),
    instructionCount: z.number().default(20).describe('[disassemble] 反汇编指令数量(默认 20)'),
    instructionOffset: z.number().optional().describe('[disassemble] 指令偏移'),
    resolveSymbols: z.boolean().default(true).describe('[disassemble] 是否解析符号名(默认是)'),
    offset: z.number().optional().describe('[disassemble/static_disassemble] 字节偏移'),
    // pdb_symbols
    pdbMode: z.enum(['symbols', 'types', 'lines', 'globals', 'compilands', 'all']).default('symbols').describe('[pdb_symbols] 查询模式:symbols=函数/符号 | types=类型定义 | lines=源码行号映射 | globals=全局变量 | compilands=编译单元 | all=全部概览'),
    // common
    maxLines: z.number().default(200).describe('最大输出行数(默认 200)'),
  },
  async (params) => {
    const { mode, file } = params;

    // --- elf_symbols ---
    if (mode === 'elf_symbols') {
      const { filter, demangle } = params;
      const output = [];
      const demangleFlag = demangle ? ' --demangle' : '';

      try { execSync(`test -f "${file}"`, { stdio: 'pipe' }); } catch {
        return { content: [{ type: 'text', text: `ELF SYMBOLS: file not found: ${file}` }] };
      }

      try {
        const magic = execSync(`head -c 4 "${file}" | od -A n -t x1`, { encoding: 'utf8' }).trim();
        if (!magic.includes('7f') || !magic.includes('45') || !magic.includes('4c') || !magic.includes('46')) {
          return { content: [{ type: 'text', text: `ELF SYMBOLS: not an ELF file: ${file}` }] };
        }
      } catch {
        return { content: [{ type: 'text', text: `ELF SYMBOLS: cannot read file: ${file}` }] };
      }

      output.push(`=== ELF SYMBOLS: ${file} ===`);
      output.push('');

      if (filter === 'all' || filter === 'functions' || filter === 'globals') {
        try {
          const nmArgs = demangleFlag + (filter === 'functions' ? ' --defined-only' : '') + (filter === 'globals' ? ' -g' : '');
          const nmOut = execSync(`nm${nmArgs} -n "${file}" 2>/dev/null | head -200`, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
          const lines = nmOut.trim().split('\n').filter(l => l.trim());

          if (filter === 'functions') {
            const funcLines = lines.filter(l => {
              const type = l.trim().split(/\s+/)[1];
              return type && 'TtWw'.includes(type);
            });
            output.push(`--- Functions (${funcLines.length} shown, max 200) ---`);
            for (const line of funcLines) output.push(`  ${line}`);
          } else {
            output.push(`--- Symbols (${lines.length} shown, max 200) ---`);
            for (const line of lines) output.push(`  ${line}`);
          }
        } catch (e) {
          output.push(`  (nm failed: ${e.message?.slice(0, 100)})`);
        }
        output.push('');
      }

      if (filter === 'all' || filter === 'dynsym') {
        try {
          const readelfOut = execSync(`readelf -Ws${demangleFlag} "${file}" 2>/dev/null | head -200`, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
          const lines = readelfOut.trim().split('\n').filter(l => l.trim());
          output.push(`--- Dynamic Symbols (${lines.length} lines, max 200) ---`);
          for (const line of lines) output.push(`  ${line}`);
        } catch (e) {
          output.push(`  (readelf failed: ${e.message?.slice(0, 100)})`);
        }
        output.push('');
      }

      try {
        const sectionsOut = execSync(`readelf -S "${file}" 2>/dev/null`, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
        const sectionLines = sectionsOut.trim().split('\n').filter(l => l.trim());
        output.push(`--- Sections (${sectionLines.length} lines) ---`);
        for (const line of sectionLines) output.push(`  ${line}`);
      } catch (e) {
        output.push(`  (readelf -S failed: ${e.message?.slice(0, 100)})`);
      }

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }

    // --- dwarf_info ---
    if (mode === 'dwarf_info') {
      const { section, maxLines } = params;
      const output = [];

      try { execSync(`test -f "${file}"`, { stdio: 'pipe' }); } catch {
        return { content: [{ type: 'text', text: `DWARF INFO: file not found: ${file}` }] };
      }

      try {
        const checkOut = execSync(`readelf -S "${file}" 2>/dev/null | grep -c debug`, { encoding: 'utf8' });
        if (parseInt(checkOut.trim()) === 0) {
          return { content: [{ type: 'text', text: `DWARF INFO: no debug sections found in ${file}\n(Compile with -g flag to include debug symbols)` }] };
        }
      } catch {
        return { content: [{ type: 'text', text: `DWARF INFO: cannot read file: ${file}` }] };
      }

      output.push(`=== DWARF DEBUG INFO: ${file} ===`);
      output.push('');

      const sectionMap = {
        info: '--debug-dump=info',
        line: '--debug-dump=line',
        abbrev: '--debug-dump=abbrev',
        frames: '--debug-dump=frames',
        all: '--debug-dump',
      };

      const readelfArg = sectionMap[section] || sectionMap.info;

      try {
        const dwarfOut = execSync(`readelf ${readelfArg} "${file}" 2>/dev/null | head -${maxLines}`, {
          encoding: 'utf8',
          maxBuffer: 2 * 1024 * 1024,
        });
        const lines = dwarfOut.trim().split('\n');
        output.push(`--- DWARF ${section} (${lines.length} lines, max ${maxLines}) ---`);
        for (const line of lines) output.push(`  ${line}`);
      } catch (e) {
        output.push(`  (readelf ${readelfArg} failed: ${e.message?.slice(0, 100)})`);
      }

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }

    // --- static_disassemble ---
    if (mode === 'static_disassemble') {
      const { startAddress, stopAddress, elfSection, architecture, maxLines, syntax } = params;
      const output = [];

      try { execSync(`test -f "${file}"`, { stdio: 'pipe' }); } catch {
        return { content: [{ type: 'text', text: `STATIC_DISASSEMBLE: file not found: ${file}` }] };
      }

      const archFlags = {
        auto: '',
        x86: '-m i386',
        x86_64: '-m i386:x86-64',
        arm: '-m arm',
        aarch64: '-m aarch64',
        mips: '-m mips',
        powerpc: '-m powerpc',
        riscv: '-m riscv',
      };

      let objdumpCmd = `objdump -d${syntax === 'intel' ? ' -M intel' : ''} ${archFlags[architecture] || ''}`;

      if (startAddress) objdumpCmd += ` --start-address=${startAddress}`;
      if (stopAddress) objdumpCmd += ` --stop-address=${stopAddress}`;
      if (elfSection) objdumpCmd += ` -j ${elfSection}`;

      objdumpCmd += ` "${file}" 2>&1 | head -${maxLines}`;

      try {
        const result = execSync(objdumpCmd, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        const lines = result.trim().split('\n');
        output.push(`=== STATIC DISASSEMBLE: ${file} ===`);
        if (startAddress || stopAddress) output.push(`Range: ${startAddress || 'start'} - ${stopAddress || 'end'}`);
        output.push(`Architecture: ${architecture} | Syntax: ${syntax}`);
        output.push(`(${lines.length} lines, max ${maxLines})`);
        output.push('');
        for (const line of lines) output.push(line);
      } catch (e) {
        const stderr = e.stderr?.toString() || e.message;
        output.push(`STATIC_DISASSEMBLE ERROR: ${stderr.slice(0, 500)}`);
      }

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }

    // --- disassemble (runtime) ---
    if (mode === 'disassemble') {
      const { sessionId, memoryReference, instructionCount, offset, instructionOffset, resolveSymbols } = params;
      if (!sessionId || !memoryReference) throw new Error('disassemble 需要 sessionId 和 memoryReference 参数');

      const session = getSession(sessionId);
      const result = await session.client.disassemble(memoryReference, instructionCount, offset, instructionOffset, resolveSymbols);
      const instructions = result?.instructions || [];

      if (!instructions.length) {
        return { content: [{ type: 'text', text: `DISASSEMBLE: no instructions at ${memoryReference}` }] };
      }

      const lines = instructions.map((inst) => {
        const addr = inst.address || '?';
        const bytes = inst.instructionBytes ? `  ${inst.instructionBytes}` : '';
        const symbol = inst.symbol ? ` <${inst.symbol}>` : '';
        const loc = inst.location ? `  ; ${inst.location.name || ''}:${inst.line || ''}` : '';
        return `  ${addr}${bytes}  ${inst.instruction}${symbol}${loc}`;
      });

      return { content: [{ type: 'text', text: `DISASSEMBLE at ${memoryReference} (${instructions.length} instructions):\n${lines.join('\n')}` }] };
    }

    // --- pe_exports ---
    if (mode === 'pe_exports') {
      const { maxLines } = params;
      const output = [];

      try { execSync(`test -f "${file}"`, { stdio: 'pipe' }); } catch {
        return { content: [{ type: 'text', text: `PE_EXPORTS: file not found: ${file}` }] };
      }

      output.push(`=== PE EXPORTS: ${file} ===`);
      output.push('');

      try {
        const headers = execSync(`objdump -f "${file}" 2>&1`, { encoding: 'utf8' });
        output.push('--- File Header ---');
        output.push(headers.trim());
        output.push('');
      } catch (e) {
        output.push(`  (objdump -f failed: ${e.message?.slice(0, 100)})`);
      }

      try {
        const exports = execSync(`objdump -p "${file}" 2>&1 | head -${maxLines}`, {
          encoding: 'utf8',
          maxBuffer: 2 * 1024 * 1024,
        });
        const lines = exports.trim().split('\n');

        let inExportSection = false;
        const exportLines = [];
        const otherLines = [];
        for (const line of lines) {
          if (line.includes('Export Table') || line.includes('[Ordinal/Name Pointer]')) {
            inExportSection = true;
          }
          if (inExportSection) {
            exportLines.push(line);
          } else {
            otherLines.push(line);
          }
        }

        if (exportLines.length) {
          output.push(`--- Export Table (${exportLines.length} lines) ---`);
          for (const line of exportLines) output.push(`  ${line}`);
          output.push('');
        }

        output.push(`--- PE Headers (${otherLines.length} lines) ---`);
        for (const line of otherLines.slice(0, 50)) output.push(`  ${line}`);
      } catch (e) {
        output.push(`  (objdump -p failed: ${e.message?.slice(0, 200)})`);
      }

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }

    // --- pdb_symbols ---
    if (mode === 'pdb_symbols') {
      const { pdbMode, maxLines } = params;
      const output = [];

      try { execSync(`test -f "${file}"`, { stdio: 'pipe' }); } catch {
        return { content: [{ type: 'text', text: `PDB_SYMBOLS: file not found: ${file}` }] };
      }

      let pdbutil = 'llvm-pdbutil';
      try {
        execSync(`which llvm-pdbutil 2>/dev/null`, { encoding: 'utf8' });
      } catch {
        const versions = ['20', '19', '18', '17', '16', '15', '14'];
        let found = false;
        for (const v of versions) {
          try {
            const p = `/usr/lib/llvm-${v}/bin/llvm-pdbutil`;
            execSync(`test -x "${p}"`, { stdio: 'pipe' });
            pdbutil = p;
            found = true;
            break;
          } catch {}
        }
        if (!found) {
          return { content: [{ type: 'text', text: 'PDB_SYMBOLS: llvm-pdbutil not found. Install: sudo apt install llvm' }] };
        }
      }

      output.push(`=== PDB SYMBOLS: ${file} ===`);
      output.push(`Tool: ${pdbutil}`);
      output.push('');

      const modeMap = {
        symbols: { cmd: 'dump -publics', label: 'Public Symbols' },
        types: { cmd: 'dump -types', label: 'Type Records' },
        lines: { cmd: 'dump -lines', label: 'Line Number Mapping' },
        globals: { cmd: 'dump -globals', label: 'Global Symbols' },
        compilands: { cmd: 'dump -compilands', label: 'Compilation Units' },
        all: { cmd: 'dump -all', label: 'All PDB Info' },
      };

      const config = modeMap[pdbMode] || modeMap.symbols;

      try {
        const result = execSync(`${pdbutil} ${config.cmd} "${file}" 2>&1 | head -${maxLines}`, {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        });
        const lines = result.trim().split('\n');
        output.push(`--- ${config.label} (${lines.length} lines, max ${maxLines}) ---`);
        for (const line of lines) output.push(`  ${line}`);
      } catch (e) {
        const stderr = e.stderr?.toString() || e.message;
        output.push(`  (${pdbutil} failed: ${stderr.slice(0, 300)})`);
      }

      return { content: [{ type: 'text', text: output.join('\n') }] };
    }
  }
);

} // registerDapTools
