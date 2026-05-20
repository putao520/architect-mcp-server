// rwkv-binding.mjs — Koffi FFI 绑定层，直接调用 librwkv.so
// 状态传递：Float32Array 内存操作，无 HTTP/Python 中间层

import koffi from 'koffi';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === 动态库路径 ===
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

function getRwkvLib() {
  if (_rwkv) return _rwkv;
  _lib = koffi.load(findLib());
  const RwkvContext = koffi.pointer('rwkv_context', koffi.opaque());
  _rwkv = {
    initFromFile: _lib.func('rwkv_init_from_file', RwkvContext, ['str', 'uint32', 'uint32']),
    cloneContext: _lib.func('rwkv_clone_context', RwkvContext, [RwkvContext, 'uint32']),
    eval: _lib.func('rwkv_eval', 'bool', [RwkvContext, 'uint32', 'float *', 'float *', 'float *']),
    evalSequence: _lib.func('rwkv_eval_sequence', 'bool', [RwkvContext, 'uint32 *', 'uint64', 'float *', 'float *', 'float *']),
    evalSequenceInChunks: _lib.func('rwkv_eval_sequence_in_chunks', 'bool', [RwkvContext, 'uint32 *', 'uint64', 'uint64', 'float *', 'float *', 'float *']),
    getNVocab: _lib.func('rwkv_get_n_vocab', 'uint64', [RwkvContext]),
    getNEmbed: _lib.func('rwkv_get_n_embed', 'uint64', [RwkvContext]),
    getNLayer: _lib.func('rwkv_get_n_layer', 'uint64', [RwkvContext]),
    getStateLen: _lib.func('rwkv_get_state_len', 'uint64', [RwkvContext]),
    getLogitsLen: _lib.func('rwkv_get_logits_len', 'uint64', [RwkvContext]),
    initState: _lib.func('rwkv_init_state', 'void', [RwkvContext, 'float *']),
    free: _lib.func('rwkv_free', 'void', [RwkvContext]),
    setPrintErrors: _lib.func('rwkv_set_print_errors', 'void', [RwkvContext, 'bool']),
    getLastError: _lib.func('rwkv_get_last_error', 'uint32', [RwkvContext]),
    quantizeModelFile: _lib.func('rwkv_quantize_model_file', 'bool', ['str', 'str', 'str']),
    getSystemInfoString: _lib.func('rwkv_get_system_info_string', 'str', []),
  };
  return _rwkv;
}

// === 高级 API ===

export class RwkvModel {
  #ctx;
  #stateLen;
  #logitsLen;
  #nVocab;
  #nLayer;

  constructor(modelPath, { threads = 4, gpuLayers = 0 } = {}) {
    const rwkv = getRwkvLib();
    this.#ctx = rwkv.initFromFile(modelPath, threads, gpuLayers);
    if (!this.#ctx) throw new Error(`Failed to load model: ${modelPath}`);
    rwkv.setPrintErrors(this.#ctx, true);

    this.#stateLen = Number(rwkv.getStateLen(this.#ctx));
    this.#logitsLen = Number(rwkv.getLogitsLen(this.#ctx));
    this.#nVocab = Number(rwkv.getNVocab(this.#ctx));
    this.#nLayer = Number(rwkv.getNLayer(this.#ctx));
  }

  get stateLen() { return this.#stateLen; }
  get logitsLen() { return this.#logitsLen; }
  get nVocab() { return this.#nVocab; }
  get nLayer() { return this.#nLayer; }

  /** 创建初始 state（全零初始化） */
  createState() {
    const state = new Float32Array(this.#stateLen);
    getRwkvLib().initState(this.#ctx, state);
    return state;
  }

  /** 单 token 推理 */
  evalToken(token, stateIn, stateOut, logitsOut = null) {
    const rwkv = getRwkvLib();
    const ok = rwkv.eval(this.#ctx, token, stateIn, stateOut, logitsOut);
    if (!ok) throw new Error(`rwkv_eval failed: error ${rwkv.getLastError(this.#ctx)}`);
  }

  /** 批量 token 推理（推荐用于 prompt 处理） */
  evalSequence(tokens, stateIn, stateOut, logitsOut = null) {
    const rwkv = getRwkvLib();
    const tokensBuf = new Uint32Array(tokens);
    const ok = rwkv.evalSequence(this.#ctx, tokensBuf, BigInt(tokens.length), stateIn, stateOut, logitsOut);
    if (!ok) throw new Error(`rwkv_eval_sequence failed: error ${rwkv.getLastError(this.#ctx)}`);
  }

  /** 分块批量推理（处理超长序列，避免 ggml node limit） */
  evalSequenceInChunks(tokens, chunkSize, stateIn, stateOut, logitsOut = null) {
    const rwkv = getRwkvLib();
    const tokensBuf = new Uint32Array(tokens);
    const ok = rwkv.evalSequenceInChunks(this.#ctx, tokensBuf, BigInt(tokens.length), BigInt(chunkSize), stateIn, stateOut, logitsOut);
    if (!ok) throw new Error(`rwkv_eval_sequence_in_chunks failed: error ${rwkv.getLastError(this.#ctx)}`);
  }

  /** 从 logits 采样 token（top-p sampling） */
  sampleToken(logits, { temperature = 1.0, topP = 0.5 } = {}) {
    if (temperature <= 0) {
      // greedy
      let maxIdx = 0;
      for (let i = 1; i < logits.length; i++) {
        if (logits[i] > logits[maxIdx]) maxIdx = i;
      }
      return maxIdx;
    }

    // temperature scaling
    const scaled = new Float32Array(logits.length);
    for (let i = 0; i < logits.length; i++) {
      scaled[i] = logits[i] / temperature;
    }

    // softmax
    let maxVal = -Infinity;
    for (let i = 0; i < scaled.length; i++) maxVal = Math.max(maxVal, scaled[i]);
    let sumExp = 0;
    for (let i = 0; i < scaled.length; i++) {
      scaled[i] = Math.exp(scaled[i] - maxVal);
      sumExp += scaled[i];
    }
    for (let i = 0; i < scaled.length; i++) scaled[i] /= sumExp;

    // top-p (nucleus) sampling
    const sorted = Array.from(scaled).map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p);
    let cumProb = 0;
    const nucleus = [];
    for (const item of sorted) {
      nucleus.push(item);
      cumProb += item.p;
      if (cumProb >= topP) break;
    }

    const r = Math.random();
    let acc = 0;
    for (const item of nucleus) {
      acc += item.p / cumProb;
      if (r < acc) return item.i;
    }
    return nucleus[nucleus.length - 1].i;
  }

  /** 克隆上下文（用于并行推理） */
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

  /** 释放资源 */
  free() {
    if (this.#ctx) {
      getRwkvLib().free(this.#ctx);
      this.#ctx = null;
    }
  }
}

// === Trie Tokenizer（RWKV World v20230424，65536 词表） ===
// 移植自 rwkv_cpp/rwkv_world_tokenizer.py

class TrieNode {
  /** @type {TrieNode[]} */
  to = new Array(256).fill(null);
  /** @type {Set<{bytes: Uint8Array, id: number}>} */
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

// === 推理会话（封装 state 管理） ===

export class RwkvSession {
  #model;
  #tokenizer;
  #state;
  #logits;
  #generatedTokens;
  #tokenCounter = new Map();
  #nlTokenId = null;

  constructor(model, tokenizer) {
    this.#model = model;
    this.#tokenizer = tokenizer;
    this.#state = model.createState();
    this.#logits = new Float32Array(model.logitsLen);
    this.#generatedTokens = 0;
  }

  get tokenCount() { return this.#generatedTokens; }

  /** 处理 prompt（批量注入 tokens） */
  feedPrompt(text) {
    const tokens = this.#tokenizer.encode(text);
    if (tokens.length === 0) return;

    // 最后一个 token 的 logits 才需要
    const stateOut = new Float32Array(this.#model.stateLen);

    if (tokens.length > 1) {
      // 前 N-1 个 token 不需要 logits
      this.#model.evalSequenceInChunks(
        tokens.slice(0, -1), 16,
        this.#state, stateOut, null
      );
      this.#state = stateOut;
    }

    // 最后一个 token 需要 logits
    const lastState = new Float32Array(this.#model.stateLen);
    this.#model.evalToken(tokens[tokens.length - 1], this.#state, lastState, this.#logits);
    this.#state = lastState;
    this.#generatedTokens += tokens.length;
  }

  /** 生成一个 token（RWKV-7 alpha 惩罚机制） */
  generateToken({ temperature = 1.0, topP = 0.5, alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99 } = {}) {
    // Alpha 惩罚：presence（出现即惩罚）+ frequency（按频次惩罚）
    if (this.#tokenCounter.size > 0) {
      for (const [id, count] of this.#tokenCounter) {
        if (id < this.#logits.length) {
          const penalty = alphaPresence + alphaFrequency * count;
          this.#logits[id] -= this.#logits[id] > 0 ? penalty : penalty * 0.5;
        }
      }
    }

    const tokenId = this.#model.sampleToken(this.#logits, { temperature, topP });

    // 衰减计数器 + 累加新 token
    if (alphaDecay < 1) {
      for (const [id, count] of this.#tokenCounter) {
        const decayed = count * alphaDecay;
        if (decayed < 0.01) this.#tokenCounter.delete(id);
        else this.#tokenCounter.set(id, decayed);
      }
    }
    this.#tokenCounter.set(tokenId, (this.#tokenCounter.get(tokenId) || 0) + 1);

    const stateOut = new Float32Array(this.#model.stateLen);
    const logitsOut = new Float32Array(this.#model.logitsLen);

    this.#model.evalToken(tokenId, this.#state, stateOut, logitsOut);
    this.#state = stateOut;
    this.#logits = logitsOut;
    this.#generatedTokens++;

    return tokenId;
  }

  /** 生成文本（使用 alpha 惩罚） */
  generate(maxTokens, { temperature = 1.0, topP = 0.5, alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99, stopTokens = [] } = {}) {
    const outputTokens = [];

    for (let i = 0; i < maxTokens; i++) {
      const token = this.generateToken({ temperature, topP, alphaPresence, alphaFrequency, alphaDecay });
      outputTokens.push(token);
      if (stopTokens.includes(token)) break;
    }

    return this.#tokenizer.decode(outputTokens);
  }

  // === RWKV-7 G1 Chat Template ===
  // User: ...\nAssistant: ...\n (round separator: \n)
  // Think mode: Assistant:\n → thinking → \n → answer

  /** 格式化 chat prompt（静态方法，不修改 session 状态） */
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

  /** 使用 chat template 格式 feed prompt */
  feedChatPrompt(prompt, { systemPrompt, history, think = false } = {}) {
    const text = RwkvSession.formatChat(prompt, { systemPrompt, history });
    this.feedPrompt(think ? text + '\n' : text);
  }

  /** 获取换行 token ID（延迟计算） */
  #getNlTokenId() {
    if (this.#nlTokenId == null) {
      this.#nlTokenId = this.#tokenizer.encode('\n')[0];
    }
    return this.#nlTokenId;
  }

  /**
   * Think mode 单轮推理。
   * 必须在 feedChatPrompt(think=true) 之后调用。
   * 模型先思考（直到输出 \n），再生成答案。
   */
  thinkGenerate(maxAnswerTokens = 2048, options = {}) {
    const {
      maxThinkTokens = 4096,
      temperature = 1.0, topP = 0.5,
      alphaPresence = 2.0, alphaFrequency = 0.1, alphaDecay = 0.99,
    } = options;
    const genOpts = { temperature, topP, alphaPresence, alphaFrequency, alphaDecay };
    const nlId = this.#getNlTokenId();

    // Thinking phase: 生成直到 \n 或上限
    const thinkTokens = [];
    for (let i = 0; i < maxThinkTokens; i++) {
      const tid = this.generateToken(genOpts);
      thinkTokens.push(tid);
      if (tid === nlId) break;
    }
    const thinking = this.#tokenizer.decode(thinkTokens).replace(/\n$/, '');

    // Answer phase
    const answerTokens = [];
    for (let i = 0; i < maxAnswerTokens; i++) {
      const tid = this.generateToken(genOpts);
      answerTokens.push(tid);
    }
    const answer = this.#tokenizer.decode(answerTokens);

    return { thinking, answer };
  }

  /**
   * 多轮无限推理（带循环控制）。
   * 利用 RWKV RNN 的 state passing，每轮继承上一轮的完整推理状态。
   *
   * 循环控制：
   * - maxRounds: 最大推理轮数（默认 5）
   * - 收敛检测：逐轮 thinking 文本比对，重复或缩减则停止
   */
  multiRoundThink(prompt, options = {}) {
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

    // 第一轮：完整 chat prompt + think mode
    this.feedChatPrompt(prompt, { systemPrompt, history, think: true });

    for (let round = 0; round < maxRounds; round++) {
      // Thinking phase
      const thinkTokens = [];
      for (let i = 0; i < maxThinkTokens; i++) {
        const tid = this.generateToken(genOpts);
        thinkTokens.push(tid);
        if (tid === nlId) break;
      }
      const thinking = this.#tokenizer.decode(thinkTokens).replace(/\n$/, '');

      // Answer phase
      const answerTokens = [];
      for (let i = 0; i < maxAnswerTokens; i++) {
        const tid = this.generateToken(genOpts);
        answerTokens.push(tid);
      }
      const answer = this.#tokenizer.decode(answerTokens);

      rounds.push({ thinking, answer });

      // 收敛检测
      if (rounds.length >= 2) {
        const prev = rounds[rounds.length - 2].thinking;
        const curr = rounds[rounds.length - 1].thinking;
        // 逐字重复 → 停
        if (curr.trim() === prev.trim()) { converged = true; break; }
        // 思考急剧缩短（<20%）且很短（<50 字符）→ 停
        if (curr.length < prev.length * 0.2 && curr.length < 50) { converged = true; break; }
      }

      // 非最后一轮且未收敛 → 注入继续推理指令
      if (round < maxRounds - 1 && !converged) {
        this.feedPrompt(`\nUser: Continue reasoning. Go deeper into the analysis.\nAssistant:\n`);
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

  /** 导出当前 state */
  exportState() {
    return new Float32Array(this.#state);
  }

  /** 导入 state */
  importState(state) {
    this.#state = new Float32Array(state);
  }

  /** 重置 state */
  reset() {
    this.#state = this.#model.createState();
    this.#logits = new Float32Array(this.#model.logitsLen);
    this.#generatedTokens = 0;
    this.#tokenCounter.clear();
    this.#nlTokenId = null;
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
