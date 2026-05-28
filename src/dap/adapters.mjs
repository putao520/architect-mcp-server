// Debug Adapter 配置映射
// 每种语言/运行时的 Debug Adapter 启动命令和参数模板

import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();

export const ADAPTERS = {
  // === Rust / C / C++ ===
  'lldb-dap': {
    command: 'lldb-dap',
    args: [],
    type: 'lldb',
    languages: ['rust', 'c', 'cpp', 'objc'],
    install: {
      apt: 'sudo apt install lldb',
      brew: 'brew install llvm',
      note: 'LLVM 调试适配器，Rust/C/C++ 推荐使用',
    },
  },
  'gdb': {
    command: 'gdb',
    args: ['--interpreter=dap'],
    type: 'gdb',
    languages: ['c', 'cpp'],
    install: {
      apt: 'sudo apt install gdb',
      brew: 'brew install gdb',
      note: 'GNU 调试器，C/C++ 备选',
    },
  },
  'codelldb': {
    command: '${HOME}/.vscode/extensions/vadimcn.vscode-lldb-*/adapter/codelldb',
    args: [],
    type: 'lldb',
    languages: ['rust', 'c', 'cpp'],
    install: {
      note: 'VS Code CodeLLDB 扩展自带，安装扩展即可',
    },
  },

  // === Node.js ===
  'node': {
    command: 'node',
    args: [],
    type: 'node',
    languages: ['javascript', 'typescript'],
    install: {
      note: 'Node.js 内置 DAP 支持（--inspect-brk），无需额外安装',
    },
  },

  // === Python ===
  'debugpy': {
    command: 'python3',
    args: ['-m', 'debugpy'],
    type: 'python',
    languages: ['python'],
    install: {
      pip: 'pip install debugpy',
      apt: 'sudo apt install python3-debugpy',
      note: 'Python 调试适配器',
    },
  },

  // === Go ===
  'dlv': {
    command: 'dlv',
    resolve: () => {
      try { return execSync('which dlv 2>/dev/null', { encoding: 'utf8' }).trim(); } catch { }
      const gopath = process.env.GOPATH || `${HOME}/go`;
      const p = `${gopath}/bin/dlv`;
      try { execSync(`test -x "${p}"`, { stdio: 'pipe' }); return p; } catch { return null; }
    },
    args: ['dap'],
    type: 'go',
    languages: ['go'],
    install: {
      go: 'go install github.com/go-delve/delve/cmd/dlv@latest',
      brew: 'brew install delve',
      note: 'Go 调试器 Delve',
    },
  },
};

// 静态分析工具依赖定义
export const TOOLS = {
  // 二进制分析
  'readelf': { check: 'readelf --version', category: 'elf', install: { apt: 'sudo apt install binutils' } },
  'nm': { check: 'nm --version', category: 'elf', install: { apt: 'sudo apt install binutils' } },
  'objdump': { check: 'objdump --version', category: 'disasm', install: { apt: 'sudo apt install binutils' } },
  'llvm-pdbutil': {
    check: 'which llvm-pdbutil 2>/dev/null || ls /usr/lib/llvm-*/bin/llvm-pdbutil 2>/dev/null',
    category: 'pdb',
    resolve: () => {
      try { return execSync('which llvm-pdbutil 2>/dev/null', { encoding: 'utf8' }).trim(); } catch {}
      for (const v of ['20', '19', '18', '17', '16']) {
        const p = `/usr/lib/llvm-${v}/bin/llvm-pdbutil`;
        try { execSync(`test -x "${p}"`, { stdio: 'pipe' }); return p; } catch {}
      }
      return null;
    },
    install: { apt: 'sudo apt install llvm' },
  },
};

export function resolveAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    const available = Object.keys(ADAPTERS).join(', ');
    throw new Error(`Unknown adapter "${name}". Available: ${available}`);
  }
  if (adapter.resolve) {
    const resolved = adapter.resolve();
    if (resolved) return { ...adapter, command: resolved };
  }
  return adapter;
}

export function resolveAdapterByLanguage(language) {
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.languages.includes(language)) return { name, ...adapter };
  }
  throw new Error(`No adapter found for language "${language}". Available languages: ${[...new Set(Object.values(ADAPTERS).flatMap(a => a.languages))].join(', ')}`);
}

// 检测单个工具是否可用
function checkTool(name) {
  try {
    const tool = TOOLS[name];
    if (tool?.resolve) {
      const resolved = tool.resolve();
      return { name, available: !!resolved, path: resolved, category: tool.category };
    }
    execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8', stdio: 'pipe' });
    const p = execSync(`which ${name}`, { encoding: 'utf8' }).trim();
    return { name, available: true, path: p, category: tool?.category };
  } catch {
    return { name, available: false, path: null, category: TOOLS[name]?.category };
  }
}

// 检测 Debug Adapter 是否可用
function checkAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) return null;

  // codelldb 用 glob 检查
  if (name === 'codelldb') {
    try {
      const matches = execSync(`ls -d ${adapter.command} 2>/dev/null`, { encoding: 'utf8' }).trim();
      return { name, available: !!matches, path: matches.split('\n')[0] || null };
    } catch {
      return { name, available: false, path: null };
    }
  }

  // node 内置
  if (name === 'node') {
    try {
      const v = execSync('node --version', { encoding: 'utf8' }).trim();
      return { name, available: true, path: 'built-in', version: v };
    } catch {
      return { name, available: false, path: null };
    }
  }

  // debugpy 检查模块
  if (name === 'debugpy') {
    try {
      execSync('python3 -m debugpy --version 2>/dev/null', { encoding: 'utf8', stdio: 'pipe' });
      return { name, available: true, path: 'python3 -m debugpy' };
    } catch {
      return { name, available: false, path: null };
    }
  }

  // dlv 检查 GOPATH/bin 回退
  if (name === 'dlv') {
    try {
      const p = execSync(`which ${adapter.command} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (p) return { name, available: true, path: p };
    } catch { }
    const gopath = process.env.GOPATH || `${HOME}/go`;
    const dlvPath = `${gopath}/bin/dlv`;
    try {
      execSync(`test -x "${dlvPath}"`, { stdio: 'pipe' });
      return { name, available: true, path: dlvPath };
    } catch {
      return { name, available: false, path: null };
    }
  }

  try {
    const p = execSync(`which ${adapter.command} 2>/dev/null`, { encoding: 'utf8' }).trim();
    return { name, available: !!p, path: p || null };
  } catch {
    return { name, available: false, path: null };
  }
}

/**
 * 环境检测 — 返回所有工具和适配器的就绪状态
 */
export function checkEnvironment() {
  const adapters = {};
  for (const name of Object.keys(ADAPTERS)) {
    adapters[name] = checkAdapter(name);
  }

  const tools = {};
  for (const name of Object.keys(TOOLS)) {
    tools[name] = checkTool(name);
  }

  return { adapters, tools };
}

/**
 * 生成安装脚本 — 只安装缺失的工具
 */
export function generateInstallScript(missing) {
  const lines = ['#!/bin/bash', '# DAP MCP Server — 自动安装缺失工具', 'set -e', ''];

  const aptPackages = new Set();
  const pipPackages = [];
  const goInstalls = [];
  const notes = [];

  for (const item of missing) {
    if (item.install?.apt) {
      const pkg = item.install.apt.replace('sudo apt install ', '');
      aptPackages.add(pkg);
    }
    if (item.install?.pip) {
      pipPackages.push(item.install.pip);
    }
    if (item.install?.go) {
      goInstalls.push(item.install.go);
    }
    if (item.install?.brew) {
      notes.push(`# macOS: ${item.install.brew}`);
    }
    if (item.install?.note) {
      notes.push(`# ${item.name}: ${item.install.note}`);
    }
  }

  if (aptPackages.size) {
    lines.push(`sudo apt install -y ${[...aptPackages].join(' ')}`);
  }
  if (pipPackages.length) {
    lines.push(pipPackages.join('\n'));
  }
  if (goInstalls.length) {
    lines.push(goInstalls.join('\n'));
  }

  if (notes.length) {
    lines.push('');
    lines.push(...notes.map(n => n));
  }

  return lines.join('\n');
}
