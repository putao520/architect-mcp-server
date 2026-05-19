# Architect MCP Server — SPEC

## 1. 产品定位

CC 原生 MCP 架构顾问工具。通过 @anthropic-ai/claude-agent-sdk 生成子 CC 实例，
继承项目 CWD、CLAUDE.md、工具集，执行深度架构分析、SPEC 审计、代码设计审查。

## 2. 架构

```
主 CC → MCP 协议 → architect-tools → query() → 子 CC 进程
                                            ↓
                                    读取代码库 + CLAUDE.md
                                    + LSP 语义分析
                                    + DAP 运行时验证
                                    + WebSearch 技术背景
                                            ↓
                                    返回结构化分析结果
```

## 3. 核心机制

### 3.1 环境变量（双模式）

- 直接设置 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN → 优先使用
- 设置 ARCHITECT_ENV_SCRIPT 指向 sh 脚本（默认 ~/kocode.sh）→ 从脚本加载
- 配置项：ARCHITECT_MAX_TURNS（全局默认轮次）

### 3.2 子 CC 配置

- systemPrompt: claude_code preset + 任务类型追加
- permissionMode: bypassPermissions
- allowedTools: Read/Glob/Grep/Bash/WebSearch/WebFetch + LSP 全量 + DAP 全量
- maxTurns: 默认 3000-5000

### 3.3 结构化解析

- SPEC MD 文件：提取标题层级、REQ ID 列表、代码块、表格
- 源码文件：提取函数签名、类型定义、模块结构
- 解析结果注入子 CC prompt，避免逐行读文本

### 3.4 自动压缩

子 CC 继承 CC 内置的上下文自动 compact 机制，长时间运行不溢出。

## 4. 工具清单

| 工具 | 用途 | 默认 maxTurns |
|------|------|--------------|
| architect_consult | 架构咨询 | 3000 |
| architect_audit | SPEC 审计 | 5000 |
| architect_review | 代码架构审查 | 4000 |
| architect_analyze | 子系统全链路分析 | 4000 |
