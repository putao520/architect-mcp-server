/**
 * DAP Client — 通过 JSON-RPC over stdin/stdout 连接 Debug Adapter 进程
 *
 * 复用 LSP 的消息格式（Content-Length 头帧 + JSON-RPC），
 * 但通信方式是 spawn 子进程而非 Unix socket。
 */

import { spawn } from 'child_process';
import { resolve as pathResolve } from 'path';

// === JSON-RPC 消息编解码（与 LSP 相同格式）===

function encodeMessage(msg) {
  const content = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
}

function parseMessages(buffer) {
  const messages = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = remaining.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (remaining.length < bodyStart + contentLength) break;

    const body = remaining.slice(bodyStart, bodyStart + contentLength).toString('utf8');
    try {
      messages.push(JSON.parse(body));
    } catch {}

    remaining = remaining.slice(bodyStart + contentLength);
  }

  return { messages, remaining };
}

// === DAP Client ===

export class DapClient {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.nextSeq = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.process = null;
    this.capabilities = {};
    this.initialized = false;
    this.stoppedCallbacks = [];
    this.lifecycleCallbacks = [];
    this.moduleCallbacks = [];
    this.threads = [];
    this.currentThreadId = null;
    this._exited = false;
  }

  async connectAdapter(command, args = [], cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.process = proc;

      proc.stdout.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const { messages, remaining } = parseMessages(this.buffer);
        this.buffer = remaining;
        for (const msg of messages) {
          this._handleMessage(msg);
        }
      });

      proc.stderr.on('data', (data) => {
        // Debug adapter stderr — usually debug output, ignore
      });

      proc.on('exit', (code) => {
        this._exited = true;
        this.process = null;
        // Reject all pending requests
        for (const [seq, callback] of this.pending) {
          callback.reject(new Error(`Debug adapter exited with code ${code}`));
        }
        this.pending.clear();
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start debug adapter: ${err.message}`));
      });

      // Wait a bit for process to start
      setTimeout(() => {
        if (proc.pid) resolve();
        else reject(new Error('Debug adapter failed to start'));
      }, 100);
    });
  }

  _handleMessage(msg) {
    // Response
    if (msg.request_seq != null && this.pending.has(msg.request_seq)) {
      const { resolve, reject } = this.pending.get(msg.request_seq);
      this.pending.delete(msg.request_seq);
      if (msg.success === false) {
        reject(new Error(msg.message || `DAP error: ${JSON.stringify(msg.body)}`));
      } else {
        resolve(msg);
      }
      return;
    }

    // Event
    if (msg.type === 'event') {
      this._handleEvent(msg);
    }
  }

  _handleEvent(event) {
    switch (event.event) {
      case 'stopped':
        if (event.body) {
          this.currentThreadId = event.body.threadId;
          for (const cb of this.stoppedCallbacks) {
            try { cb(event.body); } catch {}
          }
        }
        break;
      case 'thread':
        if (event.body) {
          if (event.body.reason === 'started') {
            this.threads.push({ id: event.body.threadId });
          } else if (event.body.reason === 'exited') {
            this.threads = this.threads.filter(t => t.id !== event.body.threadId);
          }
        }
        break;
      case 'exited':
        this._exited = true;
        this._exitCode = event.body?.exitCode;
        for (const cb of this.lifecycleCallbacks) {
          try { cb({ type: 'exited', exitCode: event.body?.exitCode }); } catch {}
        }
        break;
      case 'terminated':
        this._exited = true;
        for (const cb of this.lifecycleCallbacks) {
          try { cb({ type: 'terminated', restart: event.body?.restart }); } catch {}
        }
        break;
      case 'module':
        for (const cb of this.moduleCallbacks) {
          try { cb(event.body); } catch {}
        }
        break;
    }
  }

  onStopped(callback) {
    this.stoppedCallbacks.push(callback);
  }

  onLifecycle(callback) {
    this.lifecycleCallbacks.push(callback);
  }

  onModule(callback) {
    this.moduleCallbacks.push(callback);
  }

  sendRequest(command, args = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (this._exited || !this.process) {
        reject(new Error('Debug adapter not connected'));
        return;
      }
      const seq = this.nextSeq++;
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Timeout: ${command} (${timeout}ms)`));
      }, timeout);
      this.pending.set(seq, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      const msg = { seq, type: 'request', command, arguments: args };
      this.process.stdin.write(encodeMessage(msg));
    });
  }

  // === 生命周期 ===

  async initialize() {
    const resp = await this.sendRequest('initialize', {
      clientID: 'dap-mcp-server',
      adapterID: 'generic',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      supportsMemoryReferences: true,
    });
    if (!resp || !resp.body) throw new Error('DAP initialize failed');
    this.capabilities = resp.body || {};
    this.initialized = true;
    return resp.body;
  }

  async launch(program, args = [], cwd, env, stopOnEntry = false) {
    const launchArgs = {
      program: pathResolve(program),
      args,
      cwd: cwd || process.cwd(),
      env: env || undefined,
      stopOnEntry,
      noDebug: false,
    };
    const resp = await this.sendRequest('launch', launchArgs, 60000);
    return resp.body;
  }

  async attach(program, pid, cwd) {
    const attachArgs = {
      program: program ? pathResolve(program) : undefined,
      pid,
      cwd: cwd || process.cwd(),
    };
    const resp = await this.sendRequest('attach', attachArgs, 30000);
    return resp.body;
  }

  async disconnect(terminate = true) {
    try {
      await this.sendRequest('disconnect', { terminateDebuggee: terminate }, 10000);
    } catch {}
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this._exited = true;
  }

  // === 断点 ===

  async setBreakpoints(filePath, breakpoints) {
    const resp = await this.sendRequest('setBreakpoints', {
      source: { path: pathResolve(filePath) },
      breakpoints: breakpoints.map(bp => ({
        line: bp.line,
        column: bp.column,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
      })),
      lines: breakpoints.map(bp => bp.line),
      sourceModified: false,
    });
    return resp.body;
  }

  async setFunctionBreakpoints(breakpoints) {
    const resp = await this.sendRequest('setFunctionBreakpoints', {
      breakpoints: breakpoints.map(bp => ({
        name: bp.name,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
      })),
    });
    return resp.body;
  }

  async setInstructionBreakpoints(breakpoints) {
    const resp = await this.sendRequest('setInstructionBreakpoints', {
      breakpoints: breakpoints.map(bp => ({
        instructionReference: bp.instructionReference,
        offset: bp.offset,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
      })),
    });
    return resp.body;
  }

  async disassemble(memoryReference, instructionCount, offset, instructionOffset, resolveSymbols) {
    const args = { memoryReference, instructionCount };
    if (offset != null) args.offset = offset;
    if (instructionOffset != null) args.instructionOffset = instructionOffset;
    if (resolveSymbols != null) args.resolveSymbols = resolveSymbols;
    const resp = await this.sendRequest('disassemble', args);
    return resp.body;
  }

  // === 执行控制 ===

  async continue(threadId) {
    const tid = threadId ?? this.currentThreadId;
    if (tid == null) throw new Error('No active thread');
    const resp = await this.sendRequest('continue', { threadId: tid });
    return resp.body;
  }

  async next(threadId) {
    const tid = threadId ?? this.currentThreadId;
    if (tid == null) throw new Error('No active thread');
    const resp = await this.sendRequest('next', { threadId: tid });
    return resp.body;
  }

  async stepIn(threadId) {
    const tid = threadId ?? this.currentThreadId;
    if (tid == null) throw new Error('No active thread');
    const resp = await this.sendRequest('stepIn', { threadId: tid });
    return resp.body;
  }

  async stepOut(threadId) {
    const tid = threadId ?? this.currentThreadId;
    if (tid == null) throw new Error('No active thread');
    const resp = await this.sendRequest('stepOut', { threadId: tid });
    return resp.body;
  }

  // === 运行时检查 ===

  async stackTrace(threadId, levels = 20, startFrame = 0) {
    const tid = threadId ?? this.currentThreadId;
    if (tid == null) throw new Error('No active thread');
    const resp = await this.sendRequest('stackTrace', {
      threadId: tid,
      levels,
      startFrame,
    });
    return resp.body;
  }

  async scopes(frameId) {
    const resp = await this.sendRequest('scopes', { frameId });
    return resp.body;
  }

  async variables(variablesReference, filter, start, count) {
    const args = { variablesReference };
    if (filter) args.filter = filter;
    if (start != null) args.start = start;
    if (count != null) args.count = count;
    const resp = await this.sendRequest('variables', args);
    return resp.body;
  }

  async evaluate(expression, frameId, context = 'repl') {
    const args = { expression, context };
    if (frameId != null) args.frameId = frameId;
    const resp = await this.sendRequest('evaluate', args);
    return resp.body;
  }

  async threads() {
    const resp = await this.sendRequest('threads');
    if (resp.body?.threads) this.threads = resp.body.threads;
    return resp.body;
  }

  async getLocalVariables(frameId) {
    const scopesResp = await this.scopes(frameId);
    const scopes = scopesResp?.scopes || [];
    const localsScope = scopes.find(s => s.name === 'Locals' || s.name === 'Local') || scopes[0];
    if (!localsScope) return [];
    const varsResp = await this.variables(localsScope.variablesReference);
    return varsResp?.variables || [];
  }

  isRunning() {
    return this.process != null && !this._exited;
  }
}
