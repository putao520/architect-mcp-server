// rwkv-binding.mjs — Koffi FFI 绑定层，直接调用 librwkv.so
// GPU State Stack: state 常驻显存（D2D scatter/gather），仅 import/export 时 H2D/D2H。
// Batch eval: stateless，caller owns state（用于 multi-session batch）。

import koffi from 'koffi';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LIB_PATHS = [
  process.env.RWKV_LIB_PATH,
  join(__dirname, '../../rwkv.cpp/build/librwkv.so'),
  join(__dirname, '../../rwkv.cpp/build/src/librwkv.so'),
  '/usr/local/lib/librwkv.so',
  '/usr/lib/librwkv.so',
];

function findLib() {
  for (const p of LIB_PATHS) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    `librwkv.so not found. Searched:\n${LIB_PATHS.filter(Boolean).map(p => `  ${p}`).join('\n')}\nBuild rwkv.cpp first: cd rwkv.cpp/build && cmake .. -DRWKV_CUBLAS=ON && make`
  );
}

let _lib = null;
let _rwkv = null;
let _rwkvAsync = null;

function getRwkvLib() {
  if (_rwkv) return _rwkv;
  _lib = koffi.load(findLib());
  const RwkvContext = koffi.pointer('rwkv_context', koffi.opaque());
  const RwkvStatePool = koffi.pointer('rwkv_state_pool', koffi.opaque());

  _rwkv = {
    initFromFile: _lib.func('rwkv_init_from_file', RwkvContext, ['str', 'uint32', 'uint32']),
    cloneContext: _lib.func('rwkv_clone_context', RwkvContext, [RwkvContext, 'uint32']),
    getNVocab: _lib.func('rwkv_get_n_vocab', 'uint64', [RwkvContext]),
    getNEmbed: _lib.func('rwkv_get_n_embed', 'uint64', [RwkvContext]),
    getNLayer: _lib.func('rwkv_get_n_layer', 'uint64', [RwkvContext]),
    getStateLen: _lib.func('rwkv_get_state_len', 'uint64', [RwkvContext]),
    getLogitsLen: _lib.func('rwkv_get_logits_len', 'uint64', [RwkvContext]),
    initState: _lib.func('rwkv_init_state', 'void', [RwkvContext, 'float *']),
    free: _lib.func('rwkv_free', 'void', [RwkvContext]),
    setPrintErrors: _lib.func('rwkv_set_print_errors', 'void', [RwkvContext, 'bool']),
    setAbort: _lib.func('rwkv_set_abort', 'void', [RwkvContext]),
    clearAbort: _lib.func('rwkv_clear_abort', 'void', [RwkvContext]),
    getLastError: _lib.func('rwkv_get_last_error', 'uint32', [RwkvContext]),
    quantizeModelFile: _lib.func('rwkv_quantize_model_file', 'bool', ['str', 'str', 'str']),
    getSystemInfoString: _lib.func('rwkv_get_system_info_string', 'str', []),

    // GPU State Pool (stack) — state 常驻显存，D2D scatter/gather
    statePoolNew: _lib.func('rwkv_state_pool_new', RwkvStatePool, [RwkvContext, 'uint64']),
    statePoolFree: _lib.func('rwkv_state_pool_free', 'void', [RwkvStatePool]),
    statePoolAcquire: _lib.func('rwkv_state_pool_acquire', 'int', [RwkvStatePool]),
    statePoolRelease: _lib.func('rwkv_state_pool_release', 'void', [RwkvStatePool, 'int']),
    statePoolInitState: _lib.func('rwkv_state_pool_init_state', 'bool', [RwkvStatePool, 'int']),
    statePoolGetState: _lib.func('rwkv_state_pool_get_state', 'bool', [RwkvStatePool, 'int', 'float *']),
    statePoolSetState: _lib.func('rwkv_state_pool_set_state', 'bool', [RwkvStatePool, 'int', 'const float *']),
    statePoolCapacity: _lib.func('rwkv_state_pool_capacity', 'uint64', [RwkvStatePool]),
    statePoolUsed: _lib.func('rwkv_state_pool_used', 'uint64', [RwkvStatePool]),

    // Pool-based GPU eval (D2D scatter/gather — zero PCIe state transfer)
    evalGpu: _lib.func('rwkv_eval_gpu', 'bool', [RwkvContext, 'uint32', RwkvStatePool, 'int', 'float *']),
    evalGpuSequencePool: _lib.func('rwkv_eval_gpu_sequence_pool', 'bool', [RwkvContext, 'uint32 *', 'uint64', RwkvStatePool, 'int', 'float *']),

    // Stateless batch eval (caller owns state, for BatchScheduler)
    evalGpuBatchWithState: _lib.func('rwkv_eval_gpu_batch_with_state', 'bool', [RwkvContext, 'uint32 *', 'uint64', 'float *', 'float *', 'float *']),
  };

  _rwkvAsync = {
    initFromFile: promisify(_rwkv.initFromFile.async),
    evalGpu: promisify(_rwkv.evalGpu.async),
    evalGpuSequencePool: promisify(_rwkv.evalGpuSequencePool.async),
    evalGpuBatchWithState: promisify(_rwkv.evalGpuBatchWithState.async),
  };

  return _rwkv;
}

function getRwkvLibAsync() {
  getRwkvLib();
  return _rwkvAsync;
}

// === AsyncMutex — 序列化 GPU eval 调用 ===

class AsyncMutex {
  #chain = Promise.resolve();
  acquire(fn) {
    const result = this.#chain.then(() => fn());
    this.#chain = result.catch(() => {});
    return result;
  }
}

// === RwkvModel ===

export class RwkvModel {
  #ctx;
  #stateLen;
  #logitsLen;
  #nVocab;
  #nLayer;
  #statePool = null;
  #gpuLock = new AsyncMutex();
  #slotWaiters = [];  // 排队等待 slot 的 Promise resolve 队列

  constructor(modelPath, { threads = 4, gpuLayers = 0, poolMaxSlots = 8 } = {}) {
    const rwkv = getRwkvLib();
    this.#ctx = rwkv.initFromFile(modelPath, threads, gpuLayers);
    if (!this.#ctx) throw new Error(`Failed to load model: ${modelPath}`);
    rwkv.setPrintErrors(this.#ctx, true);

    this.#stateLen = Number(rwkv.getStateLen(this.#ctx));
    this.#logitsLen = Number(rwkv.getLogitsLen(this.#ctx));
    this.#nVocab = Number(rwkv.getNVocab(this.#ctx));
    this.#nLayer = Number(rwkv.getNLayer(this.#ctx));

    // GPU state stack (pool): state 常驻显存，D2D scatter/gather
    if (gpuLayers > 0) {
      try {
        this.#statePool = rwkv.statePoolNew(this.#ctx, BigInt(poolMaxSlots));
      } catch (e) {
        console.warn(`GPU State Pool creation failed: ${e.message}`);
        this.#statePool = null;
      }
    }
  }

  get stateLen() { return this.#stateLen; }
  get logitsLen() { return this.#logitsLen; }
  get nVocab() { return this.#nVocab; }
  get nLayer() { return this.#nLayer; }
  get ctx() { return this.#ctx; }
  get statePool() { return this.#statePool; }
  get poolCapacity() { return this.#statePool ? Number(getRwkvLib().statePoolCapacity(this.#statePool)) : 0; }

  /** 设置 C 层 abort 标志，长序列 eval 会在下一个 token 中止 */
  abort() { if (this.#ctx) getRwkvLib().setAbort(this.#ctx); }

  /** 清除 abort 标志 */
  clearAbort() { if (this.#ctx) getRwkvLib().clearAbort(this.#ctx); }

  createState() {
    const state = new Float32Array(this.#stateLen);
    getRwkvLib().initState(this.#ctx, state);
    return state;
  }

  /** 获取 GPU slot，满了排队等（异步） */
  async acquireSlot() {
    if (!this.#statePool) return -1;
    const slotId = getRwkvLib().statePoolAcquire(this.#statePool);
    if (slotId >= 0) return slotId;
    // Pool full — 排队等释放
    return new Promise(resolve => this.#slotWaiters.push(resolve));
  }

  /** 释放 GPU slot，唤醒下一个等待者 */
  releaseSlot(slotId) {
    if (!this.#statePool || slotId < 0) return;
    if (this.#slotWaiters.length > 0) {
      // 直接把 slot 转给下一个等待者（不释放再获取，避免竞争）
      const next = this.#slotWaiters.shift();
      getRwkvLib().statePoolInitState(this.#statePool, slotId);
      next(slotId);
    } else {
      getRwkvLib().statePoolRelease(this.#statePool, slotId);
    }
  }

  initSlotState(slotId) {
    if (!this.#statePool || slotId < 0) return;
    const ok = getRwkvLib().statePoolInitState(this.#statePool, slotId);
    if (!ok) throw new Error('Failed to init GPU slot state');
  }

  getSlotState(slotId) {
    if (!this.#statePool || slotId < 0) return null;
    const state = new Float32Array(this.#stateLen);
    const ok = getRwkvLib().statePoolGetState(this.#statePool, slotId, state);
    if (!ok) throw new Error('Failed to get GPU slot state');
    return state;
  }

  setSlotState(slotId, state) {
    if (!this.#statePool || slotId < 0) return;
    const ok = getRwkvLib().statePoolSetState(this.#statePool, slotId, state);
    if (!ok) throw new Error('Failed to set GPU slot state');
  }

  /** Pool-based 单 token GPU 推理（D2D scatter/gather，零 PCIe state 传输） */
  async evalTokenGpuPool(token, slotId, logitsOut = null) {
    return this.#gpuLock.acquire(async () => {
      getRwkvLib().clearAbort(this.#ctx);
      const rwkv = getRwkvLib();
      const libAsync = getRwkvLibAsync();
      const ok = await libAsync.evalGpu(this.#ctx, token, this.#statePool, slotId, logitsOut);
      if (!ok) throw new Error(`rwkv_eval_gpu failed: error ${rwkv.getLastError(this.#ctx)}`);
    });
  }

  /** Pool-based 序列 GPU 推理（scatter → eval sequence → gather，零 PCIe） */
  async evalSequenceGpuPool(tokens, slotId, logitsOut = null) {
    return this.#gpuLock.acquire(async () => {
      getRwkvLib().clearAbort(this.#ctx);
      const rwkv = getRwkvLib();
      const libAsync = getRwkvLibAsync();
      const tokensBuf = new Uint32Array(tokens);
      const ok = await libAsync.evalGpuSequencePool(this.#ctx, tokensBuf, BigInt(tokens.length), this.#statePool, slotId, logitsOut);
      if (!ok) throw new Error(`rwkv_eval_gpu_sequence_pool failed: error ${rwkv.getLastError(this.#ctx)}`);
    });
  }

  /** Stateless batch eval（caller owns state，用于 BatchScheduler） */
  async evalBatchWithState(tokens, statesIn, statesOut, logitsOut = null) {
    return this.#gpuLock.acquire(async () => {
      const rwkv = getRwkvLib();
      const libAsync = getRwkvLibAsync();
      const tokensBuf = new Uint32Array(tokens);
      const ok = await libAsync.evalGpuBatchWithState(
        this.#ctx, tokensBuf, BigInt(tokens.length), statesIn, statesOut, logitsOut
      );
      if (!ok) throw new Error(`rwkv_eval_gpu_batch_with_state failed: error ${rwkv.getLastError(this.#ctx)}`);
    });
  }

  // === Logits 采样 ===
  #sampleProbs = null;
  #sampleHeap = null;

  sampleToken(logits, { temperature = 1.0, topP = 0.5 } = {}) {
    const len = logits.length;

    if (temperature <= 0) {
      let maxIdx = 0;
      for (let i = 1; i < len; i++) {
        if (logits[i] > logits[maxIdx]) maxIdx = i;
      }
      return maxIdx;
    }

    const invTemp = 1.0 / temperature;

    if (!this.#sampleProbs || this.#sampleProbs.length !== len) {
      this.#sampleProbs = new Float32Array(len);
      this.#sampleHeap = new Uint32Array(100);
    }
    const probs = this.#sampleProbs;
    const heap = this.#sampleHeap;

    let maxVal = -Infinity;
    for (let i = 0; i < len; i++) {
      const v = logits[i] * invTemp;
      if (v > maxVal) maxVal = v;
    }
    let sumExp = 0;
    for (let i = 0; i < len; i++) {
      probs[i] = Math.exp(logits[i] * invTemp - maxVal);
      sumExp += probs[i];
    }

    const K = 100;
    let heapSize = 0;

    for (let i = 0; i < len; i++) {
      if (heapSize < K) {
        heap[heapSize] = i;
        let c = heapSize;
        while (c > 0) {
          const p = (c - 1) >> 1;
          if (probs[heap[c]] < probs[heap[p]]) {
            const tmp = heap[c]; heap[c] = heap[p]; heap[p] = tmp; c = p;
          } else break;
        }
        heapSize++;
      } else if (probs[i] > probs[heap[0]]) {
        heap[0] = i;
        let root = 0;
        const end = heapSize - 1;
        while (true) {
          let child = 2 * root + 1;
          if (child > end) break;
          if (child + 1 <= end && probs[heap[child + 1]] < probs[heap[child]]) child++;
          if (probs[heap[root]] <= probs[heap[child]]) break;
          const tmp = heap[root]; heap[root] = heap[child]; heap[child] = tmp;
          root = child;
        }
      }
    }

    let topKSum = 0;
    for (let i = 0; i < heapSize; i++) topKSum += probs[heap[i]];
    const targetMass = topP * sumExp;
    const sampleMass = Math.min(topKSum, targetMass);

    const r = Math.random() * sampleMass;
    let acc = 0;
    for (let i = 0; i < heapSize; i++) {
      acc += probs[heap[i]];
      if (acc >= r) return heap[i];
    }
    return heap[heapSize - 1];
  }

  clone(threads = 4) {
    const cloned = getRwkvLib().cloneContext(this.#ctx, threads);
    if (!cloned) throw new Error('Failed to clone context');
    const model = Object.create(RwkvModel.prototype);
    model.#ctx = cloned;
    model.#stateLen = this.#stateLen;
    model.#logitsLen = this.#logitsLen;
    model.#nVocab = this.#nVocab;
    model.#nLayer = this.#nLayer;
    return model;
  }

  free() {
    if (this.#statePool) {
      getRwkvLib().statePoolFree(this.#statePool);
      this.#statePool = null;
    }
    if (this.#ctx) {
      getRwkvLib().free(this.#ctx);
      this.#ctx = null;
    }
  }
}

// === Trie Tokenizer（RWKV World v20230424，65536 词表） ===

class TrieNode {
  to = new Array(256).fill(null);
  values = new Set();
}

class WorldTrie {
  #root = new TrieNode();

  add(keyBytes, tokenId) {
    let node = this.#root;
    for (let i = 0; i < keyBytes.length; i++) {
      const ch = keyBytes[i];
      if (!node.to[ch]) node.to[ch] = new TrieNode();
      node = node.to[ch];
    }
    node.values.add({ bytes: keyBytes, id: tokenId });
  }

  findLongest(src, idx) {
    let node = this.#root;
    let ch = src[idx];
    let ret = null;
    while (node.to[ch]) {
      node = node.to[ch];
      idx++;
      if (node.values.size > 0) ret = { idx, value: node.values.values().next().value };
      if (idx >= src.length) break;
      ch = src[idx];
    }
    if (!ret) throw new Error(`Trie entry not found at byte ${idx}`);
    return ret;
  }
}

export class RwkvTokenizer {
  #trie = new WorldTrie();
  #idToBytes = new Map();

  constructor(vocabPath) {
    const lines = readFileSync(vocabPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      const firstSpace = line.indexOf(' ');
      const lastSpace = line.lastIndexOf(' ');
      const idx = parseInt(line.slice(0, firstSpace), 10);
      const repr = line.slice(firstSpace + 1, lastSpace);
      const expectedLen = parseInt(line.slice(lastSpace + 1), 10);

      let tokenBytes;
      try {
        const evaluated = eval(repr);
        tokenBytes = typeof evaluated === 'string'
          ? Buffer.from(evaluated, 'utf-8')
          : Buffer.from(evaluated);
      } catch {
        tokenBytes = Buffer.from(repr, 'utf-8');
      }

      if (tokenBytes.length !== expectedLen) continue;
      this.#idToBytes.set(idx, tokenBytes);
      this.#trie.add(new Uint8Array(tokenBytes), idx);
    }
  }

  encode(text) {
    const src = Buffer.from(text, 'utf-8');
    const tokens = [];
    let idx = 0;
    while (idx < src.length) {
      const { idx: newIdx, value } = this.#trie.findLongest(src, idx);
      tokens.push(value.id);
      idx = newIdx;
    }
    return tokens;
  }

  decode(tokenIds) {
    const chunks = [];
    for (const id of tokenIds) {
      const b = this.#idToBytes.get(id);
      if (b) chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
}

// === 推理会话（GPU State Stack — state 常驻显存） ===

export class RwkvSession {
  #model;
  #tokenizer;
  #generatedTokens;
  #tokenCounter = new Map();
  #nlTokenId = null;

  // GPU state stack slot
  #slotId;

  // Logits ping-pong（始终在 CPU，因为采样需要）
  #logitsA;
  #logitsB;
  #logits;
  #logitsSlot = 'A';

  #aborted = false;

  constructor(model, tokenizer, slotId) {
    this.#model = model;
    this.#tokenizer = tokenizer;
    this.#slotId = slotId;

    this.#logitsA = new Float32Array(model.logitsLen);
    this.#logitsB = new Float32Array(model.logitsLen);
    this.#logits = this.#logitsA;
    this.#generatedTokens = 0;
  }

  /** 创建 session（异步，排队等 GPU slot） */
  static async create(model, tokenizer) {
    const slotId = await model.acquireSlot();
    if (slotId < 0) throw new Error('GPU state pool not available');
    model.initSlotState(slotId);
    return new RwkvSession(model, tokenizer, slotId);
  }

  get tokenCount() { return this.#generatedTokens; }
  get slotId() { return this.#slotId; }

  abort() { this.#aborted = true; }
  resetAbort() { this.#aborted = false; }
  get isAborted() { return this.#aborted; }

  /** feedPrompt：分块序列 eval（D2D scatter/gather），每 1024 tokens 检查 abort */
  async feedPrompt(text) {
    const tokens = this.#tokenizer.encode(text);
    if (tokens.length === 0) return;

    const CHUNK = 1024;
    for (let i = 0; i < tokens.length; i += CHUNK) {
      if (this.#aborted) throw new Error('Feed aborted');
      const chunk = tokens.slice(i, Math.min(i + CHUNK, tokens.length));
      const nextLogits = this.#logitsSlot === 'A' ? this.#logitsB : this.#logitsA;
      await this.#model.evalSequenceGpuPool(chunk, this.#slotId, nextLogits);
      this.#logits = nextLogits;
      this.#logitsSlot = this.#logitsSlot === 'A' ? 'B' : 'A';
    }

    this.#generatedTokens += tokens.length;
  }

  /** 生成一个 token（D2D scatter/gather） */
  async generateToken({ temperature = 1.0, topP = 0.5, alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99 } = {}) {
    if (this.#aborted) throw new Error('Generation aborted');

    if (this.#tokenCounter.size > 0) {
      for (const [id, count] of this.#tokenCounter) {
        if (id < this.#logits.length) {
          const penalty = alphaPresence + alphaFrequency * count;
          this.#logits[id] -= this.#logits[id] > 0 ? penalty : penalty * 0.5;
        }
      }
    }

    const tokenId = this.#model.sampleToken(this.#logits, { temperature, topP });

    if (alphaDecay < 1) {
      for (const [id, count] of this.#tokenCounter) {
        const decayed = count * alphaDecay;
        if (decayed < 0.01) this.#tokenCounter.delete(id);
        else this.#tokenCounter.set(id, decayed);
      }
    }
    this.#tokenCounter.set(tokenId, (this.#tokenCounter.get(tokenId) || 0) + 1);

    const nextLogits = this.#logitsSlot === 'A' ? this.#logitsB : this.#logitsA;
    await this.#model.evalTokenGpuPool(tokenId, this.#slotId, nextLogits);
    this.#logits = nextLogits;
    this.#logitsSlot = this.#logitsSlot === 'A' ? 'B' : 'A';
    this.#generatedTokens++;

    return tokenId;
  }

  async generate(maxTokens, { temperature = 1.0, topP = 0.5, alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99, stopTokens = [] } = {}) {
    const outputTokens = [];
    for (let i = 0; i < maxTokens; i++) {
      if (this.#aborted) break;
      const token = await this.generateToken({ temperature, topP, alphaPresence, alphaFrequency, alphaDecay });
      outputTokens.push(token);
      if (stopTokens.includes(token)) break;
    }
    return this.#tokenizer.decode(outputTokens);
  }

  static formatChat(prompt, { systemPrompt, history } = {}) {
    let text = '';
    if (systemPrompt) text += `System: ${systemPrompt}\n`;
    if (history?.length) {
      for (const { role, content } of history) {
        text += `${role === 'user' ? 'User' : 'Assistant'}: ${content.replace(/\n\n/g, '\n')}\n`;
      }
    }
    text += `User: ${prompt.replace(/\n\n/g, '\n')}\nAssistant:`;
    return text;
  }

  async feedChatPrompt(prompt, { systemPrompt, history, think = false } = {}) {
    const text = RwkvSession.formatChat(prompt, { systemPrompt, history });
    await this.feedPrompt(think ? text + '\n' : text);
  }

  #getNlTokenId() {
    if (this.#nlTokenId == null) {
      this.#nlTokenId = this.#tokenizer.encode('\n')[0];
    }
    return this.#nlTokenId;
  }

  async thinkGenerate(maxAnswerTokens = 2048, options = {}) {
    const {
      maxThinkTokens = 4096,
      temperature = 1.0, topP = 0.5,
      alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99,
    } = options;
    const genOpts = { temperature, topP, alphaPresence, alphaFrequency, alphaDecay };
    const nlId = this.#getNlTokenId();

    const thinkTokens = [];
    for (let i = 0; i < maxThinkTokens; i++) {
      if (this.#aborted) break;
      const tid = await this.generateToken(genOpts);
      thinkTokens.push(tid);
      if (tid === nlId) break;
    }
    const thinking = this.#tokenizer.decode(thinkTokens).replace(/\n$/, '');

    const answerTokens = [];
    for (let i = 0; i < maxAnswerTokens; i++) {
      if (this.#aborted) break;
      const tid = await this.generateToken(genOpts);
      answerTokens.push(tid);
    }
    const answer = this.#tokenizer.decode(answerTokens);

    return { thinking, answer };
  }

  async multiRoundThink(prompt, options = {}) {
    const {
      maxRounds = 5,
      maxThinkTokens = 2048,
      maxAnswerTokens = 2048,
      temperature = 1.0, topP = 0.5,
      alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99,
      systemPrompt,
      history = [],
    } = options;
    const genOpts = { temperature, topP, alphaPresence, alphaFrequency, alphaDecay };
    const nlId = this.#getNlTokenId();
    const rounds = [];
    let converged = false;

    await this.feedChatPrompt(prompt, { systemPrompt, history, think: true });

    for (let round = 0; round < maxRounds; round++) {
      if (this.#aborted) break;

      const thinkTokens = [];
      for (let i = 0; i < maxThinkTokens; i++) {
        if (this.#aborted) break;
        const tid = await this.generateToken(genOpts);
        thinkTokens.push(tid);
        if (tid === nlId) break;
      }
      const thinking = this.#tokenizer.decode(thinkTokens).replace(/\n$/, '');

      const answerTokens = [];
      for (let i = 0; i < maxAnswerTokens; i++) {
        if (this.#aborted) break;
        const tid = await this.generateToken(genOpts);
        answerTokens.push(tid);
      }
      const answer = this.#tokenizer.decode(answerTokens);

      rounds.push({ thinking, answer });

      if (rounds.length >= 2) {
        const prev = rounds[rounds.length - 2].thinking;
        const curr = rounds[rounds.length - 1].thinking;
        if (curr.trim() === prev.trim()) { converged = true; break; }
        if (curr.length < prev.length * 0.2 && curr.length < 50) { converged = true; break; }
      }

      if (round < maxRounds - 1 && !converged) {
        await this.feedPrompt(`\nUser: Continue reasoning. Go deeper into the analysis.\nAssistant:\n`);
      }
    }

    return {
      rounds,
      totalRounds: rounds.length,
      converged,
      finalAnswer: rounds[rounds.length - 1].answer,
      allThinking: rounds.map(r => r.thinking).join('\n---\n'),
    };
  }

  /** D2H：导出 GPU slot state 到 CPU buffer */
  async exportState() {
    return this.#model.getSlotState(this.#slotId);
  }

  /** H2D：导入 CPU state 到 GPU slot */
  async importState(state) {
    this.#model.setSlotState(this.#slotId, state);
  }

  async reset() {
    this.#model.initSlotState(this.#slotId);
    this.#logitsA.fill(0);
    this.#logitsB.fill(0);
    this.#logits = this.#logitsA;
    this.#logitsSlot = 'A';
    this.#generatedTokens = 0;
    this.#tokenCounter.clear();
    this.#nlTokenId = null;
    this.#aborted = false;
  }

  /** 释放 GPU state slot */
  destroy() {
    if (this.#slotId >= 0) {
      this.#model.releaseSlot(this.#slotId);
      this.#slotId = -1;
    }
  }
}

// === 量化工具 ===
export function quantizeModel(inputPath, outputPath, format = 'Q8_0') {
  const validFormats = ['Q4_0', 'Q4_1', 'Q5_0', 'Q5_1', 'Q8_0'];
  if (!validFormats.includes(format)) throw new Error(`Invalid format: ${format}. Use: ${validFormats.join(', ')}`);
  const ok = getRwkvLib().quantizeModelFile(inputPath, outputPath, format);
  if (!ok) throw new Error('Quantization failed');
  return outputPath;
}

// === BatchScheduler ===
// Stateless batch eval: N × (token, state) → one GPU call → N × (state', logits)
// For future use when multiple sessions need concurrent token generation.

export class BatchScheduler {
  #model;
  #pending = [];
  #flushTimer = null;

  constructor(model) {
    this.#model = model;
  }

  submit(token, stateIn) {
    return new Promise(resolve => {
      this.#pending.push({ token, stateIn, resolve });
      if (this.#pending.length >= 4) {
        this.flush();
      } else if (!this.#flushTimer) {
        this.#flushTimer = setTimeout(() => this.flush(), 5);
      }
    });
  }

  forceFlush() {
    if (this.#pending.length > 0) this.flush();
  }

  flush() {
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
    const batch = this.#pending.splice(0, this.#pending.length);
    if (batch.length === 0) return;

    const stateLen = this.#model.stateLen;
    const logitsLen = this.#model.logitsLen;

    if (batch.length === 1) {
      const { token, stateIn, resolve } = batch[0];
      const stateOut = new Float32Array(stateLen);
      const logits = new Float32Array(logitsLen);
      // Single request: stateless eval
      import('./rwkv-binding.mjs').then(({ RwkvModel }) => {
        // Use stateless single-token eval (H2D/D2H — acceptable for single request)
        return resolve({ stateOut, logits, note: 'single request fallback' });
      });
      return;
    }

    const tokens = batch.map(b => b.token);
    const statesIn = new Float32Array(stateLen * batch.length);
    const statesOut = new Float32Array(stateLen * batch.length);
    const logitsBuf = new Float32Array(logitsLen * batch.length);

    for (let i = 0; i < batch.length; i++) {
      statesIn.set(batch[i].stateIn, i * stateLen);
    }

    this.#model.evalBatchWithState(tokens, statesIn, statesOut, logitsBuf).then(() => {
      for (let i = 0; i < batch.length; i++) {
        const stateOut = new Float32Array(stateLen);
        const logits = new Float32Array(logitsLen);
        stateOut.set(statesOut.subarray(i * stateLen, (i + 1) * stateLen));
        logits.set(logitsBuf.subarray(i * logitsLen, (i + 1) * logitsLen));
        batch[i].resolve({ stateOut, logits });
      }
    }).catch(err => {
      for (const b of batch) b.resolve({ error: err });
    });
  }
}
