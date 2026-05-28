#!/usr/bin/env node
/**
 * LSP Server Daemon — 语言+CWD 单实例
 *
 * 每个 (language, cwd) 对运行一个独立 Daemon + LSP Server 子进程
 * 由 MCP Server lazy spawn，无需手动启动
 *
 * 协议规则：
 * - 请求消息（有 id）→ 转发给 LSP Server，响应路由回请求方
 * - 通知消息（无 id）→ 转发给 LSP Server
 * - LSP Server 的通知 → 广播给所有客户端
 * - 第一个客户端完成 initialize → 缓存响应，后续客户端返回缓存
 * - 最后一个客户端断开 → 30 秒后自动退出
 * - 父进程（MCP Server）死亡 → 立即退出
 */

import { spawn } from 'child_process';
import { createServer } from 'net';
import { unlinkSync, existsSync, writeFileSync } from 'fs';
import {
  parseLspMessages, encodeLspMessage, encodeRawLspMessage, trimBuffer, isSocketAlive,
  LSP_SERVERS, socketPath, pidPath,
} from './shared.mjs';

const [,, language, cwd, parentPidStr] = process.argv;
if (!language || !cwd) {
  console.error('Usage: node daemon.mjs <language> <cwd> [parentPid]');
  process.exit(1);
}

const PARENT_PID = parentPidStr ? parseInt(parentPidStr, 10) : null;
const serverCmd = LSP_SERVERS[language]?.cmd;
if (!serverCmd) {
  console.error(`Unknown language: ${language}. Supported: ${Object.keys(LSP_SERVERS).join(', ')}`);
  process.exit(1);
}

const SOCKET_PATH = socketPath(language, cwd);
const PID_FILE = pidPath(language, cwd);
const IDLE_TIMEOUT_MS = 30_000; // 30 seconds (was 5 minutes)
const PARENT_CHECK_INTERVAL_MS = 5_000;

// === Stale Socket 检测 ===

if (existsSync(SOCKET_PATH)) {
  if (await isSocketAlive(SOCKET_PATH)) {
    console.error(`Daemon already running on ${SOCKET_PATH}`);
    process.exit(0);
  }
  try { unlinkSync(SOCKET_PATH); } catch {}
}

// === 启动 LSP Server 子进程 ===

const lspProc = spawn(serverCmd[0], serverCmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
let spawnFailed = false;
const startTime = Date.now();

lspProc.on('error', (err) => {
  console.error(`LSP Server spawn failed: ${err.message}`);
  spawnFailed = true;
  for (const client of clients) { try { client.end(); } catch {} }
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(2);
});

lspProc.stderr.on('data', () => {});

lspProc.on('exit', (code) => {
  const uptime = Date.now() - startTime;
  const permanentFailure = spawnFailed || (uptime < 5000 && !initialized);
  for (const client of clients) { try { client.end(); } catch {} }
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(permanentFailure ? 2 : (code || 1));
});

// === 客户端管理 ===

const clients = new Set();
const pendingRequests = new Map();
const PENDING_TIMEOUT = 900000;
let lspBuffer = Buffer.alloc(0);
let initialized = false;
let initNotified = false;
let cachedInitResponse = null;
let initRequestId = null;
let idleTimer = null;

const sendToLsp = (msg) => { try { lspProc.stdin.write(encodeLspMessage(msg)); } catch {} };
const sendRawToLsp = (raw) => { try { lspProc.stdin.write(raw); } catch {} };

function startIdleTimer() {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (clients.size > 0) return;
    console.error(`Daemon [${language}:${cwd}] idle timeout, exiting`);
    gracefulShutdown();
  }, IDLE_TIMEOUT_MS);
}

function cancelIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

// === 父进程存活检测 ===

function isParentAlive() {
  if (!PARENT_PID) return true;
  try {
    process.kill(PARENT_PID, 0);
    return true;
  } catch {
    return false;
  }
}

const parentCheckTimer = setInterval(() => {
  if (!isParentAlive()) {
    console.error(`Daemon [${language}:${cwd}] parent (PID ${PARENT_PID}) died, exiting`);
    clearInterval(parentCheckTimer);
    gracefulShutdown();
  }
}, PARENT_CHECK_INTERVAL_MS);

parentCheckTimer.unref();

// === LSP Server stdout → 路由回客户端 ===

lspProc.stdout.on('data', (chunk) => {
  lspBuffer = trimBuffer(Buffer.concat([lspBuffer, chunk]));
  const { messages, remaining } = parseLspMessages(lspBuffer);
  lspBuffer = remaining;

  for (const { msg, rawBody } of messages) {
    if (msg.id != null) {
      if (!initialized && msg.result && msg.id === initRequestId) {
        initialized = true;
        cachedInitResponse = Buffer.from(encodeRawLspMessage(rawBody));
      }

      const target = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (target && !target.destroyed) {
        target.write(encodeRawLspMessage(rawBody));
      }
    } else {
      const rawBuf = Buffer.from(encodeRawLspMessage(rawBody));
      for (const client of clients) {
        if (!client.destroyed) { try { client.write(rawBuf); } catch {} }
      }
    }
  }
});

// === Unix Socket Server ===

const server = createServer((socket) => {
  clients.add(socket);
  cancelIdleTimer();
  let clientBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    clientBuffer = trimBuffer(Buffer.concat([clientBuffer, chunk]));
    const { messages, remaining } = parseLspMessages(clientBuffer);
    clientBuffer = remaining;

    for (const { msg, rawBody } of messages) {
      if (msg.method === 'lsp/registerWorkspace' || msg.method === 'lsp/unregisterWorkspace') continue;

      if (msg.id != null) {
        pendingRequests.set(msg.id, socket);
        setTimeout(() => pendingRequests.delete(msg.id), PENDING_TIMEOUT);
      }

      if (msg.method === 'initialize' && initialized && cachedInitResponse) {
        socket.write(cachedInitResponse);
        pendingRequests.delete(msg.id);
        continue;
      }

      if (msg.method === 'initialized' && initNotified) {
        pendingRequests.delete(msg.id);
        continue;
      }

      if (msg.method === 'initialized' && !initNotified) {
        initNotified = true;
        sendRawToLsp(encodeRawLspMessage(rawBody));
        continue;
      }

      if (msg.method === 'initialize' && msg.params) {
        msg.params.processId = null;
        if (msg.id != null) initRequestId = msg.id;
        sendToLsp(msg);
        continue;
      }

      sendRawToLsp(encodeRawLspMessage(rawBody));
    }
  });

  const cleanup = () => {
    clients.delete(socket);
    for (const [id, target] of pendingRequests) {
      if (target === socket) pendingRequests.delete(id);
    }
    if (clients.size === 0) startIdleTimer();
  };

  socket.on('end', cleanup);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(SOCKET_PATH, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.error(`LSP Daemon [${language}:${cwd}] listening on ${SOCKET_PATH} (PID: ${process.pid}, parent: ${PARENT_PID || 'unknown'})`);
});

// === 优雅退出 ===

function gracefulShutdown() {
  cancelIdleTimer();
  clearInterval(parentCheckTimer);
  try { lspProc.kill('SIGTERM'); } catch {}
  server.close(() => {
    try { unlinkSync(SOCKET_PATH); } catch {}
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
