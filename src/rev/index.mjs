#!/usr/bin/env node

/**
 * Reverse Engineering MCP Server — 基于 angr 的无源码逆向分析 (v1.0.0)
 *
 * 8 个工具：环境检测、导入分析、反编译、函数列表、交叉引用、字符串搜索、控制流图、符号执行。
 * 与 DAP 互补：DAP 覆盖有源码调试，rev 覆盖无源码逆向分析。
 */

import { z } from 'zod';
import { runAngrScript } from './angr-runner.mjs';

// ============================================================
// Reverse Engineering Tools — Register on external McpServer
// ============================================================

export function registerRevTools(server) {

// ============================================================
// 工具 1/8: rev_check_env
// ============================================================

server.tool('rev_check_env',
  '检测 Python3、angr 及依赖安装状态，install=true 输出安装命令。',
  {
    install: z.boolean().default(false).describe('是否输出安装命令(默认否,只输出检测报告)'),
  },
  async ({ install }) => {
    const result = runAngrScript('rev_check_env', {}, 30000);

    if (result.error) {
      const output = [
        '=== Reverse Engineering Environment Check ===',
        '',
        `Python: ${result.message?.includes('python3') ? 'NOT FOUND' : 'check failed'}`,
        'angr: NOT INSTALLED',
        '',
        'Install: pip install angr',
      ];
      return { content: [{ type: 'text', text: output.join('\n') }] };
    }

    const output = ['=== Reverse Engineering Environment Check ===', ''];
    output.push(`Python: ${result.python || 'unknown'}`);
    output.push('');

    for (const [name, info] of Object.entries(result.tools || {})) {
      const status = info.available ? '✓' : '✗';
      const ver = info.version ? ` ${info.version}` : '';
      output.push(`  ${status} ${name}${ver}`);
      if (!info.available && info.install) {
        output.push(`    Install: ${info.install}`);
      }
    }

    output.push('');
    output.push(result.ready ? '=== ALL TOOLS READY ===' : `=== NOT READY — run: pip install angr ===`);

    if (install && !result.ready) {
      output.push('');
      output.push('Install command:');
      output.push('  pip install angr');
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 2/8: rev_import_binary
// ============================================================

server.tool('rev_import_binary',
  '导入二进制并自动分析：架构、入口、函数数、段信息概览。所有rev工具必须先导入。',
  {
    file: z.string().describe('二进制文件路径(如 /bin/ls、./target/release/myapp)'),
    autoLoadLibs: z.boolean().default(false).describe('是否自动加载共享库(默认否,加速分析)'),
  },
  async ({ file, autoLoadLibs }) => {
    const result = runAngrScript('rev_import', { file, autoLoadLibs }, 180000);

    if (result.error) {
      return { content: [{ type: 'text', text: `IMPORT ERROR: ${result.message || result.stderr || 'unknown error'}` }] };
    }

    const output = [
      `=== Binary Analysis: ${result.file} ===`,
      '',
      `Architecture: ${result.arch} (${result.bits}-bit)`,
      `Entry Point: ${result.entry}`,
      `PIE: ${result.pie ? 'Yes' : 'No'}`,
      '',
      `Functions: ${result.functions_count} total, ${result.named_functions_count} named, ${result.thunk_functions_count} thunk`,
      `Strings: ${result.strings_count}`,
      `Imports: ${result.imports_count}`,
      `Exports: ${result.exports_count}`,
      `Sections: ${result.sections_count}`,
    ];

    if (result.sections?.length) {
      output.push('');
      output.push('--- Sections ---');
      for (const sec of result.sections.slice(0, 20)) {
        const perms = sec.permissions ? ` [${sec.permissions}]` : '';
        output.push(`  ${sec.name} ${sec.vaddr} size=${sec.size}${perms}`);
      }
    }

    if (result.exports?.length) {
      output.push('');
      output.push('--- Exports (top 20) ---');
      for (const exp of result.exports.slice(0, 20)) {
        output.push(`  ${exp.address} ${exp.name} (${exp.size}B)`);
      }
    }

    if (result.strings_sample?.length) {
      output.push('');
      output.push('--- Strings Sample (top 20) ---');
      for (const s of result.strings_sample.slice(0, 20)) {
        output.push(`  ${s.slice(0, 80)}`);
      }
    }

    output.push('');
    output.push('Next: rev_list_functions / rev_decompile / rev_search_strings / rev_analyze_control_flow');

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 3/8: rev_decompile
// ============================================================

server.tool('rev_decompile',
  '反编译函数为伪C代码+签名+调用关系。',
  {
    file: z.string().describe('二进制文件路径'),
    function: z.string().optional().describe('函数名(如 "main"、"handle_request")'),
    address: z.string().optional().describe('函数地址(如 "0x401000"),与 function 二选一'),
  },
  async ({ file, function: funcName, address }) => {
    const result = runAngrScript('rev_decompile', { file, function: funcName, address }, 120000);

    if (result.error) {
      return { content: [{ type: 'text', text: `DECOMPILE ERROR: ${result.error}` }] };
    }

    const output = [
      `=== Decompile: ${result.function} at ${result.address} ===`,
      '',
      `Signature: ${result.signature || result.function}`,
      `Size: ${result.size} bytes`,
      '',
      '--- Decompiled Code ---',
      result.decompiled,
    ];

    if (result.callees?.length) {
      output.push('');
      output.push(`--- Callees (${result.callees_count}) ---`);
      for (const c of result.callees.slice(0, 30)) {
        output.push(`  → ${c.address} ${c.name}`);
      }
    }

    if (result.callers?.length) {
      output.push('');
      output.push(`--- Callers (${result.callers_count}) ---`);
      for (const c of result.callers.slice(0, 30)) {
        output.push(`  ← ${c.address} ${c.name}`);
      }
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 4/8: rev_list_functions
// ============================================================

server.tool('rev_list_functions',
  '列出二进制函数：all|named|thunk|entry，支持namespace过滤和分页。',
  {
    file: z.string().describe('二进制文件路径'),
    filter: z.enum(['all', 'named', 'thunk', 'entry']).default('named').describe('过滤:all=全部 | named=仅命名函数 | thunk=仅跳转 | entry=仅入口'),
    namespace: z.string().optional().describe('关键词过滤(如 "main"、"handle")'),
    offset: z.number().default(0).describe('分页偏移'),
    limit: z.number().default(200).describe('每页数量(默认 200)'),
  },
  async ({ file, filter, namespace, offset, limit }) => {
    const result = runAngrScript('rev_list_functions', { file, filter, namespace, offset, limit }, 120000);

    if (result.error) {
      return { content: [{ type: 'text', text: `LIST FUNCTIONS ERROR: ${result.error || 'unknown'}` }] };
    }

    const output = [
      `=== Functions: ${filter} filter${namespace ? ` (namespace: ${namespace})` : ''} ===`,
      `Total: ${result.total}, Showing: ${result.showing} (offset ${result.offset})`,
      '',
    ];

    for (const f of result.functions) {
      const flags = [];
      if (f.is_thunk) flags.push('thunk');
      if (f.is_plt) flags.push('plt');
      const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
      output.push(`  ${f.address} ${f.name} (${f.size}B, ${f.blocks} blocks)${flagStr}`);
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 5/8: rev_cross_references
// ============================================================

server.tool('rev_cross_references',
  '交叉引用：to=谁引用了这地址|from=这地址引用了谁|both=双向。',
  {
    file: z.string().describe('二进制文件路径'),
    address: z.string().describe('目标地址(如 "0x401000")'),
    direction: z.enum(['to', 'from', 'both']).default('both').describe('to=谁引用了这里 | from=这里引用了谁 | both=双向'),
  },
  async ({ file, address, direction }) => {
    const result = runAngrScript('rev_xrefs', { file, address, direction }, 120000);

    if (result.error) {
      return { content: [{ type: 'text', text: `XREFS ERROR: ${result.error}` }] };
    }

    const output = [`=== Cross References: ${result.address} ===`, ''];

    if (result.xrefs_to?.length) {
      output.push(`--- References TO (${result.xrefs_to_count}) ---`);
      for (const x of result.xrefs_to.slice(0, 50)) {
        const jt = x.jump_type ? ` (${x.jump_type})` : '';
        output.push(`  ${x.from_address} ${x.from_function}${jt} → ${x.to_address}`);
      }
      output.push('');
    }

    if (result.xrefs_from?.length) {
      output.push(`--- References FROM (${result.xrefs_from_count}) ---`);
      for (const x of result.xrefs_from.slice(0, 50)) {
        const jt = x.jump_type ? ` (${x.jump_type})` : '';
        output.push(`  ${x.from_address} ${x.from_function} → ${x.to_address} ${x.to_function}${jt}`);
      }
    }

    if (!result.xrefs_to?.length && !result.xrefs_from?.length) {
      output.push('No cross references found.');
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 6/8: rev_search_strings
// ============================================================

server.tool('rev_search_strings',
  '搜索二进制中的字符串，返回字符串+地址+引用函数。',
  {
    file: z.string().describe('二进制文件路径'),
    query: z.string().optional().describe('搜索关键词(不传则列出所有)'),
    minLen: z.number().default(4).describe('最小字符串长度(默认 4)'),
  },
  async ({ file, query, minLen }) => {
    const result = runAngrScript('rev_strings', { file, query, minLen }, 120000);

    if (result.error) {
      return { content: [{ type: 'text', text: `STRINGS ERROR: ${result.error || 'unknown'}` }] };
    }

    const output = [
      `=== Strings${query ? ` (query: "${query}")` : ''} ===`,
      `Total: ${result.total}`,
      '',
    ];

    for (const s of (result.strings || []).slice(0, 100)) {
      const ref = s.referenced_by ? ` ← ${s.referenced_by}` : '';
      const sec = s.section ? ` [${s.section}]` : '';
      output.push(`  ${s.address}${sec} "${s.string.slice(0, 100)}"${ref}`);
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 7/8: rev_analyze_control_flow
// ============================================================

server.tool('rev_analyze_control_flow',
  '函数控制流图(CFG)，返回基本块+跳转+Mermaid图。',
  {
    file: z.string().describe('二进制文件路径'),
    function: z.string().optional().describe('函数名'),
    address: z.string().optional().describe('函数地址,与 function 二选一'),
  },
  async ({ file, function: funcName, address }) => {
    const result = runAngrScript('rev_cfg', { file, function: funcName, address }, 120000);

    if (result.error) {
      return { content: [{ type: 'text', text: `CFG ERROR: ${result.error}` }] };
    }

    const output = [
      `=== Control Flow Graph: ${result.function} at ${result.address} ===`,
      `Blocks: ${result.blocks_count}, Edges: ${result.edges_count}`,
      '',
      '--- Blocks ---',
    ];

    for (const b of (result.blocks || [])) {
      output.push(`  ${b.address} (${b.size}B, ${b.instructions || '?'} insns)`);
    }

    if (result.edges?.length) {
      output.push('');
      output.push('--- Edges ---');
      for (const e of result.edges.slice(0, 100)) {
        output.push(`  ${e.from} → ${e.to} (${e.type})`);
      }
    }

    if (result.mermaid_cfg) {
      output.push('');
      output.push('--- Mermaid CFG ---');
      output.push('```mermaid');
      output.push(result.mermaid_cfg);
      output.push('```');
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

// ============================================================
// 工具 8/8: rev_symexec
// ============================================================

server.tool('rev_symexec',
  '符号执行探索路径：输入目标地址，自动求解从入口到目标的可达路径和触发输入。',
  {
    file: z.string().describe('二进制文件路径'),
    find: z.string().describe('目标地址(如 "0x401234")'),
    avoid: z.string().optional().describe('避免地址,逗号分隔(如 "0x401100,0x401200")'),
    maxSteps: z.number().default(1000).describe('最大探索步数(默认 1000)'),
  },
  async ({ file, find, avoid, maxSteps }) => {
    const result = runAngrScript('rev_symexec', { file, find, avoid, maxSteps }, 300000);

    if (result.error) {
      return { content: [{ type: 'text', text: `SYMEXEC ERROR: ${result.error}` }] };
    }

    const output = [
      `=== Symbolic Execution: find ${result.find_address} ===`,
      '',
      `Reachable: ${result.reachable ? 'YES ✓' : 'NO ✗'}`,
      `Active: ${result.active_states}, Deadended: ${result.deadended_states}, Found: ${result.found_states}`,
    ];

    if (result.avoided_states) {
      output.push(`Avoided: ${result.avoided_states}`);
    }
    if (result.errored_states) {
      output.push(`Errored: ${result.errored_states}`);
    }

    if (result.reachable) {
      output.push('');
      output.push('--- Trigger Input ---');
      if (result.trigger_stdin_ascii) {
        output.push(`Stdin (ASCII): ${result.trigger_stdin_ascii.slice(0, 200)}`);
      }
      if (result.trigger_stdin) {
        output.push(`Stdin (hex): ${result.trigger_stdin.slice(0, 200)}`);
      }
      if (result.trigger_stdout) {
        output.push(`Stdout: ${result.trigger_stdout.slice(0, 200)}`);
      }
      if (result.path_length != null) {
        output.push(`Path length: ${result.path_length} steps`);
      }
      if (result.path?.length) {
        output.push(`Path: ${result.path.join(' → ')}`);
      }
    } else {
      output.push('');
      output.push('Target not reachable from entry point.');
      output.push('Try: increase maxSteps, adjust avoid addresses, or check target address.');
    }

    return { content: [{ type: 'text', text: output.join('\n') }] };
  }
);

} // registerRevTools
