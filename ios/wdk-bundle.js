"use strict";
var __wdk_exports = (() => {
  // ../wdk-v2-utils/src/errors.ts
  var WDKError = class extends Error {
    constructor(code, message) {
      super(message);
      this.name = "WDKError";
      this.code = code;
    }
  };
  var CryptoError = class extends WDKError {
    constructor(message) {
      super("CRYPTO_ERROR", message);
      this.name = "CryptoError";
    }
  };
  var StateError = class extends WDKError {
    constructor(message) {
      super("STATE_ERROR", message);
      this.name = "StateError";
    }
  };

  // src/keys.ts
  var KeyManager = class {
    constructor() {
      this.handles = /* @__PURE__ */ new Set();
      this.seedHandle = null;
      /** Cache: derivation path → key handle (avoids re-deriving the same key) */
      this.derivedCache = /* @__PURE__ */ new Map();
    }
    /** Track a key handle (returned by native.crypto.deriveKey etc.) */
    track(handle) {
      this.handles.add(handle);
      return handle;
    }
    /** Release a single key handle */
    release(handle) {
      if (this.handles.has(handle)) {
        native.crypto.releaseKey(handle);
        this.handles.delete(handle);
        for (const [path, h] of this.derivedCache) {
          if (h === handle) {
            this.derivedCache.delete(path);
            break;
          }
        }
      }
    }
    /** Set the master seed handle. Releases the previous handle if one is already tracked. */
    setSeedHandle(handle) {
      if (this.seedHandle !== null) {
        native.crypto.releaseKey(this.seedHandle);
        this.handles.delete(this.seedHandle);
      }
      this.seedHandle = handle;
      this.handles.add(handle);
    }
    /** Get the seed handle (throws if not set) */
    getSeedHandle() {
      if (this.seedHandle === null) {
        throw new Error("Seed handle not set \u2014 wallet not unlocked");
      }
      return this.seedHandle;
    }
    /**
     * Derive a key from seed at a BIP path and cache it.
     * Returns the cached handle if the same path was already derived.
     * This prevents handle leaks from repeated getAddress/send calls.
     */
    deriveAndTrack(path) {
      const cached = this.derivedCache.get(path);
      if (cached !== void 0 && this.handles.has(cached)) {
        return cached;
      }
      const handle = native.crypto.deriveKey(this.getSeedHandle(), path);
      this.handles.add(handle);
      this.derivedCache.set(path, handle);
      return handle;
    }
    /** Release ALL tracked handles including seed. Called on lock/destroy. */
    releaseAll() {
      for (const handle of this.handles) {
        native.crypto.releaseKey(handle);
      }
      this.handles.clear();
      this.derivedCache.clear();
      this.seedHandle = null;
    }
    /** Number of active handles */
    get count() {
      return this.handles.size;
    }
  };

  // src/events.ts
  var EventEmitter = class {
    constructor() {
      this.listeners = /* @__PURE__ */ new Map();
    }
    on(event, callback) {
      let set = this.listeners.get(event);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        this.listeners.set(event, set);
      }
      set.add(callback);
    }
    off(event, callback) {
      const set = this.listeners.get(event);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.listeners.delete(event);
        }
      }
    }
    once(event, callback) {
      const wrapper = (...args) => {
        this.off(event, wrapper);
        callback(...args);
      };
      this.on(event, wrapper);
    }
    emit(event, ...args) {
      const set = this.listeners.get(event);
      if (set) {
        for (const callback of set) {
          callback(...args);
        }
      }
    }
    removeAllListeners(event) {
      if (event !== void 0) {
        this.listeners.delete(event);
      } else {
        this.listeners.clear();
      }
    }
  };
  var WDKEvents = {
    WALLET_CREATED: "wallet:created",
    WALLET_UNLOCKED: "wallet:unlocked",
    WALLET_LOCKED: "wallet:locked",
    WALLET_DESTROYED: "wallet:destroyed",
    CHAIN_REGISTERED: "chain:registered",
    TX_SENT: "tx:sent",
    TX_CONFIRMED: "tx:confirmed",
    TX_FAILED: "tx:failed",
    ERROR: "error"
  };

  // src/registry.ts
  var ChainRegistry = class {
    constructor() {
      this.modules = /* @__PURE__ */ new Map();
    }
    register(module) {
      this.modules.set(module.chainId, module);
    }
    get(chainId) {
      const mod = this.modules.get(chainId);
      if (!mod) throw new Error(`Chain module not registered: ${chainId}`);
      return mod;
    }
    has(chainId) {
      return this.modules.has(chainId);
    }
    getAll() {
      return Array.from(this.modules.values());
    }
    destroyAll() {
      for (const mod of this.modules.values()) {
        mod.destroy();
      }
      this.modules.clear();
    }
  };

  // src/config.ts
  var DEFAULT_CONFIG = {
    defaultNetwork: "mainnet",
    networks: {
      btc: {
        chainId: "btc",
        networkId: "mainnet",
        rpcUrl: "",
        isTestnet: false,
        network: "bitcoin"
      },
      evm: {
        chainId: "evm",
        networkId: "mainnet",
        rpcUrl: "",
        isTestnet: false
      },
      ton: {
        chainId: "ton",
        networkId: "mainnet",
        rpcUrl: "",
        isTestnet: false
      },
      tron: {
        chainId: "tron",
        networkId: "mainnet",
        rpcUrl: "",
        isTestnet: false
      },
      solana: {
        chainId: "solana",
        networkId: "mainnet",
        rpcUrl: "",
        isTestnet: false
      }
    },
    logLevel: "info"
  };
  function mergeConfig(base, override) {
    return {
      defaultNetwork: override.defaultNetwork ?? base.defaultNetwork,
      networks: override.networks ? { ...base.networks, ...override.networks } : { ...base.networks },
      logLevel: override.logLevel ?? base.logLevel
    };
  }

  // src/engine.ts
  var WDKEngine = class {
    constructor(config) {
      this.state = "locked";
      this.keys = new KeyManager();
      this.events = new EventEmitter();
      this.registry = new ChainRegistry();
      this.config = mergeConfig(DEFAULT_CONFIG, config || {});
    }
    // ── Lifecycle ──
    /** Generate a new wallet (12 or 24 word mnemonic) */
    createWallet(params) {
      if (this.state === "destroyed") {
        throw new StateError("Wallet has been destroyed and cannot be reused");
      }
      const wordCount = params?.wordCount || 12;
      const mnemonic = native.crypto.generateMnemonic(wordCount);
      this.state = "created";
      this.events.emit(WDKEvents.WALLET_CREATED);
      return { mnemonic };
    }
    /** Unlock wallet with mnemonic — derives seed and master key */
    async unlockWallet(params) {
      if (this.state === "destroyed") {
        throw new StateError("Wallet has been destroyed and cannot be reused");
      }
      const words = params.mnemonic.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 24) {
        throw new CryptoError("Mnemonic must be 12 or 24 words");
      }
      const seedHandle = native.crypto.mnemonicToSeed(params.mnemonic, params.passphrase);
      this.keys.setSeedHandle(seedHandle);
      this.state = "unlocked";
      this.events.emit(WDKEvents.WALLET_UNLOCKED);
      for (const wallet of this.registry.getAll()) {
        const networkKey = `${wallet.chainId}:${this.config.defaultNetwork}`;
        const networkConfig = this.config.networks[networkKey] || this.config.networks[wallet.chainId];
        if (networkConfig) {
          await wallet.initialize(networkConfig);
        }
      }
      this.state = "ready";
      return { seedHandle };
    }
    /** Lock wallet — releases all key handles */
    lockWallet() {
      if (this.state === "destroyed") {
        throw new StateError("Wallet has been destroyed");
      }
      this.keys.releaseAll();
      this.state = "locked";
      this.events.emit(WDKEvents.WALLET_LOCKED);
    }
    /** Destroy wallet — release keys, clear state, cannot be reused */
    destroyWallet() {
      this.keys.releaseAll();
      this.registry.destroyAll();
      this.events.emit(WDKEvents.WALLET_DESTROYED);
      this.events.removeAllListeners();
      this.state = "destroyed";
    }
    // ── Chain Module Registration ──
    registerChain(module) {
      this.registry.register(module);
      this.events.emit(WDKEvents.CHAIN_REGISTERED, { chain: module.chainId });
    }
    // ── Dispatch ──
    /** Route API calls to the right chain module */
    async dispatch(action, params) {
      if (this.state !== "ready") {
        throw new StateError("Wallet not ready");
      }
      const chainId = params.chain;
      if (!chainId) {
        throw new StateError('Missing "chain" parameter');
      }
      const wallet = this.registry.get(chainId);
      switch (action) {
        case "getAddress": {
          const index = params.index ?? 0;
          const keyHandle = this.keys.deriveAndTrack(
            wallet.getDerivationPath(index)
          );
          return wallet.getAddress(keyHandle, index);
        }
        case "getBalance": {
          const address = params.address;
          if (!address) throw new StateError('Missing "address" parameter');
          return wallet.getBalance(address);
        }
        case "send": {
          const sendIndex = params.index ?? 0;
          const senderKeyHandle = this.keys.deriveAndTrack(
            wallet.getDerivationPath(sendIndex)
          );
          const senderAddress = await wallet.getAddress(senderKeyHandle, sendIndex);
          const txParams = {
            ...params,
            from: senderAddress
          };
          const tx = await wallet.buildTransaction(txParams);
          const signed = await wallet.signTransaction(tx, senderKeyHandle);
          const txHash = await wallet.broadcastTransaction(signed);
          this.events.emit(WDKEvents.TX_SENT, { chain: chainId, txHash });
          return { txHash };
        }
        case "getHistory": {
          const address = params.address;
          if (!address) throw new StateError('Missing "address" parameter');
          const limit = params.limit;
          return wallet.getTransactionHistory(address, limit);
        }
        case "quoteSend": {
          const from = params.from ?? params.address;
          if (!from) throw new StateError('Missing "from"/"address" parameter');
          const to = params.to;
          if (!to) throw new StateError('Missing "to" parameter');
          const amount = params.amount;
          if (!amount) throw new StateError('Missing "amount" parameter');
          return wallet.quoteSendTransaction({ from, to, amount });
        }
        case "getMaxSpendable": {
          const address = params.address;
          if (!address) throw new StateError('Missing "address" parameter');
          return wallet.getMaxSpendable(address);
        }
        case "getReceipt": {
          const txHash = params.txHash;
          if (!txHash) throw new StateError('Missing "txHash" parameter');
          return wallet.getTransactionReceipt(txHash);
        }
        default:
          throw new StateError(`Unknown action: ${action}`);
      }
    }
    // ── Configuration ──
    /**
     * Merge a partial config into the engine's current config.
     * Call before unlockWallet() so chain modules are initialized with
     * the updated settings (e.g. switching to testnet).
     */
    configure(partial) {
      this.config = mergeConfig(this.config, partial);
    }
    // ── Accessors ──
    getState() {
      return this.state;
    }
    getConfig() {
      return this.config;
    }
    getKeyManager() {
      return this.keys;
    }
    getEvents() {
      return this.events;
    }
  };

  // src/wallet.ts
  var BaseWallet = class {
    constructor(chainId, coinType, curve) {
      this.config = null;
      this.chainId = chainId;
      this.coinType = coinType;
      this.curve = curve;
    }
    /** Initialize with network config */
    async initialize(config) {
      this.config = config;
    }
    /**
     * Return the BIP derivation path for a given address index.
     * Override in chain modules that use a non-BIP-44 standard.
     * e.g. Bitcoin SegWit uses BIP-84: m/84'/coinType'/0'/0/index
     */
    getDerivationPath(index) {
      return `m/44'/${this.coinType}'/0'/0/${index}`;
    }
    /** Cleanup resources */
    destroy() {
      this.config = null;
    }
    /** Helper: make an RPC call via native.net.fetch */
    async rpcCall(method, params) {
      if (!this.config) throw new Error("Wallet not initialized");
      const response = await native.net.fetch(this.config.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
      });
      const json = JSON.parse(native.encoding.utf8Decode(response.body));
      if (json.error) throw new Error(json.error.message);
      return json.result;
    }
  };

  // ../wdk-v2-wallet-btc/src/address.ts
  function convertBits(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    const maxv = (1 << toBits) - 1;
    const result = [];
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (value < 0 || value >> fromBits !== 0) return null;
      acc = acc << fromBits | value;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        result.push(acc >> bits & maxv);
      }
    }
    if (pad) {
      if (bits > 0) {
        result.push(acc << toBits - bits & maxv);
      }
    } else {
      if (bits >= fromBits) return null;
      if ((acc << toBits - bits & maxv) !== 0) return null;
    }
    return new Uint8Array(result);
  }
  function generateSegwitAddress(keyHandle, isTestnet = false, network) {
    const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
    const sha = native.crypto.sha256(pubkey);
    const hash160 = native.crypto.ripemd160(sha);
    const data5 = convertBits(hash160, 8, 5, true);
    if (!data5) {
      throw new Error("Failed to convert pubkey hash to 5-bit groups");
    }
    const hrp = network === "regtest" ? "bcrt" : isTestnet ? "tb" : "bc";
    const witnessData = new Uint8Array(1 + data5.length);
    witnessData[0] = 0;
    witnessData.set(data5, 1);
    return native.encoding.bech32Encode(hrp, witnessData);
  }

  // ../wdk-v2-wallet-btc/src/utxo.ts
  var VBYTES_PER_INPUT = 68;
  var VBYTES_PER_OUTPUT = 31;
  var TX_OVERHEAD_VBYTES = 11;
  var DUST_THRESHOLD_P2WPKH = 294;
  var MIN_TX_FEE_SATS = 250;
  var MAX_UTXO_INPUTS = 200;
  function selectUtxos(utxos, targetAmount, feeRate, dustThreshold = DUST_THRESHOLD_P2WPKH) {
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const candidates = sorted.slice(0, MAX_UTXO_INPUTS);
    const selected = [];
    let totalInput = 0;
    for (const utxo of candidates) {
      selected.push(utxo);
      totalInput += utxo.value;
      const vbytes2 = TX_OVERHEAD_VBYTES + selected.length * VBYTES_PER_INPUT + 2 * VBYTES_PER_OUTPUT;
      let fee = Math.ceil(vbytes2 * feeRate);
      if (fee < MIN_TX_FEE_SATS) {
        fee = MIN_TX_FEE_SATS;
      }
      if (totalInput >= targetAmount + fee) {
        const change = totalInput - targetAmount - fee;
        if (change > 0 && change < dustThreshold) {
          const totalFee = totalInput - targetAmount;
          return { selected, fee: totalFee, change: 0 };
        }
        return { selected, fee, change };
      }
    }
    return null;
  }
  function calculateMaxSpendable(utxos, feeRate, dustThreshold = DUST_THRESHOLD_P2WPKH) {
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const candidates = sorted.slice(0, MAX_UTXO_INPUTS);
    const totalInput = candidates.reduce((sum, u) => sum + u.value, 0);
    const vbytes = TX_OVERHEAD_VBYTES + candidates.length * VBYTES_PER_INPUT + 1 * VBYTES_PER_OUTPUT;
    let fee = Math.ceil(vbytes * feeRate);
    if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;
    const maxSpendable = totalInput - fee;
    if (maxSpendable < dustThreshold) return 0;
    return maxSpendable;
  }

  // ../wdk-v2-wallet-btc/src/transaction.ts
  function writeUint32LE(value) {
    const buf = new Uint8Array(4);
    buf[0] = value & 255;
    buf[1] = value >>> 8 & 255;
    buf[2] = value >>> 16 & 255;
    buf[3] = value >>> 24 & 255;
    return buf;
  }
  function writeUint64LE(value) {
    const buf = new Uint8Array(8);
    buf[0] = value & 255;
    buf[1] = value >>> 8 & 255;
    buf[2] = value >>> 16 & 255;
    buf[3] = value >>> 24 & 255;
    const hi = Math.floor(value / 4294967296);
    buf[4] = hi & 255;
    buf[5] = hi >>> 8 & 255;
    buf[6] = hi >>> 16 & 255;
    buf[7] = hi >>> 24 & 255;
    return buf;
  }
  function writeVarInt(value) {
    if (value < 253) {
      return new Uint8Array([value]);
    } else if (value <= 65535) {
      const buf = new Uint8Array(3);
      buf[0] = 253;
      buf[1] = value & 255;
      buf[2] = value >>> 8 & 255;
      return buf;
    } else if (value <= 4294967295) {
      const buf = new Uint8Array(5);
      buf[0] = 254;
      buf[1] = value & 255;
      buf[2] = value >>> 8 & 255;
      buf[3] = value >>> 16 & 255;
      buf[4] = value >>> 24 & 255;
      return buf;
    } else {
      const buf = new Uint8Array(9);
      buf[0] = 255;
      const lo = value & 4294967295;
      const hi = Math.floor(value / 4294967296);
      buf[1] = lo & 255;
      buf[2] = lo >>> 8 & 255;
      buf[3] = lo >>> 16 & 255;
      buf[4] = lo >>> 24 & 255;
      buf[5] = hi & 255;
      buf[6] = hi >>> 8 & 255;
      buf[7] = hi >>> 16 & 255;
      buf[8] = hi >>> 24 & 255;
      return buf;
    }
  }
  function concat(...arrays) {
    let totalLength = 0;
    for (const arr of arrays) totalLength += arr.length;
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }
  function appendByte(data, byte) {
    const out = new Uint8Array(data.length + 1);
    out.set(data);
    out[data.length] = byte;
    return out;
  }
  function hash256(data) {
    return native.crypto.sha256(native.crypto.sha256(data));
  }
  function reverseTxid(txidHex) {
    const bytes = native.encoding.hexDecode(txidHex);
    const reversed = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      reversed[i] = bytes[bytes.length - 1 - i];
    }
    return reversed;
  }
  function addressToScriptPubKey(address) {
    try {
      const raw = native.encoding.base58CheckDecode(address);
      if (raw.length === 21) {
        const version = raw[0];
        const hash = raw.slice(1);
        if (version === 0 || version === 111) {
          const script2 = new Uint8Array(25);
          script2[0] = 118;
          script2[1] = 169;
          script2[2] = 20;
          script2.set(hash, 3);
          script2[23] = 136;
          script2[24] = 172;
          return script2;
        }
        if (version === 5 || version === 196) {
          const script2 = new Uint8Array(23);
          script2[0] = 169;
          script2[1] = 20;
          script2.set(hash, 2);
          script2[22] = 135;
          return script2;
        }
      }
    } catch {
    }
    let decoded;
    try {
      decoded = native.encoding.bech32Decode(address);
    } catch {
      try {
        decoded = native.encoding.bech32mDecode(address);
      } catch {
        throw new Error(`Unsupported address format: ${address}`);
      }
    }
    const witnessVersion = decoded.data[0];
    const data5bit = decoded.data.slice(1);
    const program = convertBits5to8(data5bit);
    const script = new Uint8Array(2 + program.length);
    script[0] = witnessVersion === 0 ? 0 : 80 + witnessVersion;
    script[1] = program.length;
    script.set(program, 2);
    return script;
  }
  function convertBits5to8(data) {
    let acc = 0;
    let bits = 0;
    const result = [];
    for (let i = 0; i < data.length; i++) {
      acc = acc << 5 | data[i];
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        result.push(acc >> bits & 255);
      }
    }
    return new Uint8Array(result);
  }
  function encodeDER(sig) {
    if (sig.length !== 64) {
      throw new Error(`Expected 64-byte signature, got ${sig.length}`);
    }
    const r = sig.slice(0, 32);
    const s = sig.slice(32, 64);
    const encR = encodeSignedInt(r);
    const encS = encodeSignedInt(s);
    const totalLen = 2 + encR.length + 2 + encS.length;
    const der = new Uint8Array(2 + totalLen);
    let pos = 0;
    der[pos++] = 48;
    der[pos++] = totalLen;
    der[pos++] = 2;
    der[pos++] = encR.length;
    der.set(encR, pos);
    pos += encR.length;
    der[pos++] = 2;
    der[pos++] = encS.length;
    der.set(encS, pos);
    return der;
  }
  function encodeSignedInt(value) {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) {
      start++;
    }
    const trimmed = value.slice(start);
    if (trimmed[0] & 128) {
      const padded = new Uint8Array(trimmed.length + 1);
      padded[0] = 0;
      padded.set(trimmed, 1);
      return padded;
    }
    return trimmed;
  }
  function computeSegwitSighash(inputs, outputs, inputIndex, keyHandle) {
    const SIGHASH_ALL = 1;
    const nVersion = writeUint32LE(2);
    const nLockTime = writeUint32LE(0);
    const nHashType = writeUint32LE(SIGHASH_ALL);
    const outpoints = [];
    for (const inp of inputs) {
      outpoints.push(reverseTxid(inp.txid));
      outpoints.push(writeUint32LE(inp.vout));
    }
    const hashPrevouts = hash256(concat(...outpoints));
    const sequences = [];
    for (let i = 0; i < inputs.length; i++) {
      sequences.push(writeUint32LE(4294967295));
    }
    const hashSequence = hash256(concat(...sequences));
    const outputParts = [];
    for (const out of outputs) {
      outputParts.push(writeUint64LE(out.value));
      const scriptPubKey = addressToScriptPubKey(out.address);
      outputParts.push(writeVarInt(scriptPubKey.length));
      outputParts.push(scriptPubKey);
    }
    const hashOutputs = hash256(concat(...outputParts));
    const thisOutpoint = concat(
      reverseTxid(inputs[inputIndex].txid),
      writeUint32LE(inputs[inputIndex].vout)
    );
    const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
    const pubkeySha = native.crypto.sha256(pubkey);
    const pubkeyHash = native.crypto.ripemd160(pubkeySha);
    const scriptCode = new Uint8Array(26);
    scriptCode[0] = 25;
    scriptCode[1] = 118;
    scriptCode[2] = 169;
    scriptCode[3] = 20;
    scriptCode.set(pubkeyHash, 4);
    scriptCode[24] = 136;
    scriptCode[25] = 172;
    const value = writeUint64LE(inputs[inputIndex].value);
    const nSequence = writeUint32LE(4294967295);
    const preimage = concat(
      nVersion,
      hashPrevouts,
      hashSequence,
      thisOutpoint,
      scriptCode,
      value,
      nSequence,
      hashOutputs,
      nLockTime,
      nHashType
    );
    return hash256(preimage);
  }
  function serializeTransaction(inputs, outputs, witnesses) {
    const parts = [];
    parts.push(writeUint32LE(2));
    parts.push(new Uint8Array([0, 1]));
    parts.push(writeVarInt(inputs.length));
    for (const inp of inputs) {
      parts.push(reverseTxid(inp.txid));
      parts.push(writeUint32LE(inp.vout));
      parts.push(writeVarInt(0));
      parts.push(writeUint32LE(4294967295));
    }
    parts.push(writeVarInt(outputs.length));
    for (const out of outputs) {
      parts.push(writeUint64LE(out.value));
      const scriptPubKey = addressToScriptPubKey(out.address);
      parts.push(writeVarInt(scriptPubKey.length));
      parts.push(scriptPubKey);
    }
    for (const witness of witnesses) {
      parts.push(writeVarInt(witness.length));
      for (const item of witness) {
        parts.push(writeVarInt(item.length));
        parts.push(item);
      }
    }
    parts.push(writeUint32LE(0));
    return concat(...parts);
  }
  function serializeTransactionNoWitness(inputs, outputs) {
    const parts = [];
    parts.push(writeUint32LE(2));
    parts.push(writeVarInt(inputs.length));
    for (const inp of inputs) {
      parts.push(reverseTxid(inp.txid));
      parts.push(writeUint32LE(inp.vout));
      parts.push(writeVarInt(0));
      parts.push(writeUint32LE(4294967295));
    }
    parts.push(writeVarInt(outputs.length));
    for (const out of outputs) {
      parts.push(writeUint64LE(out.value));
      const scriptPubKey = addressToScriptPubKey(out.address);
      parts.push(writeVarInt(scriptPubKey.length));
      parts.push(scriptPubKey);
    }
    parts.push(writeUint32LE(0));
    return concat(...parts);
  }
  function computeTxid(inputs, outputs) {
    const rawNoWitness = serializeTransactionNoWitness(inputs, outputs);
    const h = hash256(rawNoWitness);
    const reversed = new Uint8Array(h.length);
    for (let i = 0; i < h.length; i++) {
      reversed[i] = h[h.length - 1 - i];
    }
    return reversed;
  }
  function buildTransaction(inputs, outputs, keyHandles) {
    if (inputs.length !== keyHandles.length) {
      throw new Error(
        `Mismatched inputs (${inputs.length}) and keyHandles (${keyHandles.length})`
      );
    }
    if (inputs.length === 0) {
      throw new Error("Transaction must have at least one input");
    }
    if (outputs.length === 0) {
      throw new Error("Transaction must have at least one output");
    }
    const witnesses = [];
    for (let i = 0; i < inputs.length; i++) {
      const sighash = computeSegwitSighash(inputs, outputs, i, keyHandles[i]);
      const signature = native.crypto.signSecp256k1(keyHandles[i], sighash);
      const derSig = encodeDER(signature);
      const sigWithHashType = appendByte(derSig, 1);
      const pubkey = native.crypto.getPublicKey(keyHandles[i], "secp256k1");
      witnesses.push([sigWithHashType, pubkey]);
    }
    const rawTx = serializeTransaction(inputs, outputs, witnesses);
    const txid = computeTxid(inputs, outputs);
    return {
      rawTx: native.encoding.hexEncode(rawTx),
      txid: native.encoding.hexEncode(txid)
    };
  }

  // ../wdk-v2-wallet-btc/src/cache.ts
  var LRUCache = class {
    constructor(maxSize = 100) {
      this.maxSize = maxSize;
      this.cache = /* @__PURE__ */ new Map();
    }
    get(key) {
      const value = this.cache.get(key);
      if (value !== void 0) {
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      return value;
    }
    set(key, value) {
      this.cache.delete(key);
      this.cache.set(key, value);
      if (this.cache.size > this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== void 0) {
          this.cache.delete(firstKey);
        }
      }
    }
    has(key) {
      return this.cache.has(key);
    }
    clear() {
      this.cache.clear();
    }
    get size() {
      return this.cache.size;
    }
  };
  var ConcurrencyLimiter = class {
    constructor(maxConcurrency = 8) {
      this.maxConcurrency = maxConcurrency;
      this.active = 0;
      this.queue = [];
    }
    async run(fn) {
      if (this.active >= this.maxConcurrency) {
        await new Promise((resolve) => {
          this.queue.push(resolve);
        });
      }
      this.active++;
      try {
        return await fn();
      } finally {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
      }
    }
  };

  // ../wdk-v2-wallet-btc/src/client/blockbook-client.ts
  var BASE_URLS = {
    bitcoin: "https://btc1.trezor.io",
    testnet: "https://tbtc1.trezor.io",
    regtest: ""
    // regtest needs user-provided URL
  };
  var MEMPOOL_FEE_URL = "https://mempool.space/api/v1/fees/recommended";
  var BlockbookClient = class {
    constructor(network = "bitcoin", customUrl) {
      this.txCache = new LRUCache(100);
      this.limiter = new ConcurrencyLimiter(8);
      this.baseUrl = customUrl ? customUrl.replace(/\/$/, "") : BASE_URLS[network];
      if (!this.baseUrl) {
        throw new Error(
          `No default Blockbook server for network '${network}'. Provide a custom URL.`
        );
      }
    }
    async connect() {
    }
    async close() {
      this.txCache.clear();
    }
    async reconnect() {
      this.txCache.clear();
    }
    async reconnect() {
    }
    async getBalance(address) {
      const data = await this.fetchJson(`/api/v2/address/${address}?details=basic`);
      return {
        confirmed: Number(data.balance),
        unconfirmed: Number(data.unconfirmedBalance)
      };
    }
    async listUnspent(address) {
      const utxos = await this.fetchJson(`/api/v2/utxo/${address}`);
      return utxos.map((u) => ({
        tx_hash: u.txid,
        tx_pos: u.vout,
        value: Number(u.value),
        height: u.height ?? 0
      }));
    }
    async getHistory(address) {
      const entries = [];
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const data = await this.fetchJson(`/api/v2/address/${address}?details=txslight&pageSize=1000&page=${page}`);
        totalPages = data.totalPages;
        if (data.transactions) {
          for (const tx of data.transactions) {
            entries.push({
              tx_hash: tx.txid,
              height: tx.blockHeight > 0 ? tx.blockHeight : 0
            });
          }
        }
        page++;
      }
      return entries;
    }
    async getTransaction(txHash) {
      const cached = this.txCache.get(txHash);
      if (cached !== void 0) return cached;
      const data = await this.fetchJson(`/api/v2/tx/${txHash}`);
      if (!data.hex) {
        throw new Error(`No hex data in Blockbook response for tx ${txHash}`);
      }
      this.txCache.set(txHash, data.hex);
      return data.hex;
    }
    async getTxStatus(txHash) {
      const data = await this.fetchJson(`/api/v2/tx/${txHash}`);
      return {
        txHash: data.txid,
        confirmed: data.confirmations > 0,
        blockHeight: data.blockHeight ?? 0,
        blockTime: data.blockTime ?? 0,
        fee: parseInt(data.fees, 10) || 0
      };
    }
    async broadcast(rawTx) {
      const data = await this.fetchJson(`/api/v2/sendtx/${rawTx}`);
      if (data.error) {
        throw new Error(`Broadcast failed: ${data.error}`);
      }
      return data.result ?? "";
    }
    async getDetailedHistory(address, limit = 25) {
      const data = await this.fetchJson(`/api/v2/address/${address}?details=txs&pageSize=${limit}`);
      if (!data.transactions) return [];
      return data.transactions.map((tx) => {
        const inputAddresses = new Set(
          tx.vin.flatMap((v) => v.addresses ?? [])
        );
        const outputAddresses = new Set(
          tx.vout.flatMap((v) => v.addresses ?? [])
        );
        const isInInput = inputAddresses.has(address);
        const isInOutput = outputAddresses.has(address);
        let direction;
        if (isInInput && isInOutput) {
          const allToUs = tx.vout.every(
            (v) => !v.addresses || v.addresses.every((a) => a === address)
          );
          direction = allToUs ? "self" : "sent";
        } else if (isInInput) {
          direction = "sent";
        } else {
          direction = "received";
        }
        let amount;
        if (direction === "received") {
          amount = tx.vout.filter((v) => v.addresses?.includes(address)).reduce((sum, v) => sum + parseInt(v.value, 10), 0);
        } else if (direction === "sent") {
          const totalIn = tx.vin.filter((v) => v.addresses?.includes(address)).reduce((sum, v) => sum + parseInt(v.value, 10), 0);
          const changeBack = tx.vout.filter((v) => v.addresses?.includes(address)).reduce((sum, v) => sum + parseInt(v.value, 10), 0);
          amount = -(totalIn - changeBack);
        } else {
          amount = 0;
        }
        const counterparties = [];
        if (direction === "sent") {
          tx.vout.forEach((v) => {
            (v.addresses ?? []).forEach((a) => {
              if (a !== address) counterparties.push(a);
            });
          });
        } else if (direction === "received") {
          inputAddresses.forEach((a) => {
            if (a !== address) counterparties.push(a);
          });
        }
        return {
          txHash: tx.txid,
          direction,
          amount,
          fee: parseInt(tx.fees, 10) || 0,
          timestamp: tx.blockTime ?? 0,
          blockHeight: tx.blockHeight ?? 0,
          confirmed: tx.confirmations > 0,
          counterparties
        };
      });
    }
    async estimateFee(blocks) {
      try {
        const data = await this.fetchJson(`/api/v2/estimatefee/${blocks}`);
        const rate = parseFloat(data.result);
        if (rate > 0) return rate;
      } catch {
      }
      return this.estimateFeeFromMempool(blocks);
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    /**
     * Fallback fee estimation from mempool.space.
     * Matches production blockbook-client.js _estimateFeeFromMempool().
     */
    async estimateFeeFromMempool(blocks) {
      const response = await native.net.fetch(MEMPOOL_FEE_URL);
      if (response.status !== 200) {
        throw new Error("Fee estimation failed from both Blockbook and mempool.space");
      }
      const bodyText = response.body ? native.encoding.utf8Decode(response.body) : "";
      const data = JSON.parse(bodyText);
      let satPerVb;
      if (blocks <= 1) {
        satPerVb = data.fastestFee;
      } else if (blocks <= 3) {
        satPerVb = data.halfHourFee;
      } else if (blocks <= 6) {
        satPerVb = data.hourFee;
      } else {
        satPerVb = data.economyFee;
      }
      return satPerVb / 1e5;
    }
    async fetchJson(path) {
      const response = await native.net.fetch(`${this.baseUrl}${path}`);
      if (response.status !== 200) {
        const body = response.body ? native.encoding.utf8Decode(response.body) : "";
        throw new Error(
          `Blockbook API error: status ${response.status} for ${path}: ${body}`
        );
      }
      const bodyText = response.body ? native.encoding.utf8Decode(response.body) : "";
      return JSON.parse(bodyText);
    }
  };

  // ../wdk-v2-wallet-btc/src/client/mempool-rest-client.ts
  var BASE_URLS2 = {
    bitcoin: "https://mempool.space/api",
    testnet: "https://mempool.space/testnet4/api",
    regtest: "https://mempool.space/api"
    // regtest needs user-provided URL
  };
  var MempoolRestClient = class {
    constructor(network = "bitcoin", customUrl) {
      /** LRU cache for raw transaction hex (avoids re-fetching same tx) */
      this.txCache = new LRUCache(100);
      /** Concurrency limiter for parallel requests (matches production pLimit(8)) */
      this.limiter = new ConcurrencyLimiter(8);
      this.baseUrl = customUrl ? customUrl.replace(/\/$/, "") : BASE_URLS2[network];
    }
    async connect() {
    }
    async close() {
      this.txCache.clear();
    }
    async reconnect() {
      this.txCache.clear();
    }
    async getBalance(address) {
      const data = await this.fetchJson(`/address/${address}`);
      const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
      const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
      return { confirmed, unconfirmed };
    }
    async listUnspent(address) {
      const rawUtxos = await this.fetchJson(`/address/${address}/utxo`);
      return rawUtxos.map((u) => ({
        tx_hash: u.txid,
        tx_pos: u.vout,
        value: u.value,
        height: u.status.block_height ?? 0
      }));
    }
    async getHistory(address) {
      const txs = await this.fetchJson(`/address/${address}/txs`);
      return txs.map((tx) => ({
        tx_hash: tx.txid,
        height: tx.status.block_height ?? 0
      }));
    }
    async getDetailedHistory(address, limit = 25) {
      const txs = await this.fetchJson(`/address/${address}/txs`);
      return txs.slice(0, limit).map((tx) => {
        const inputAddresses = new Set(
          tx.vin.filter((v) => v.prevout?.scriptpubkey_address).map((v) => v.prevout.scriptpubkey_address)
        );
        const outputAddresses = new Set(
          tx.vout.filter((v) => v.scriptpubkey_address).map((v) => v.scriptpubkey_address)
        );
        const isInInput = inputAddresses.has(address);
        const isInOutput = outputAddresses.has(address);
        let direction;
        if (isInInput && isInOutput) {
          const allOutputsToUs = tx.vout.every(
            (v) => !v.scriptpubkey_address || v.scriptpubkey_address === address
          );
          direction = allOutputsToUs ? "self" : "sent";
        } else if (isInInput) {
          direction = "sent";
        } else {
          direction = "received";
        }
        let amount;
        if (direction === "received") {
          amount = tx.vout.filter((v) => v.scriptpubkey_address === address).reduce((sum, v) => sum + v.value, 0);
        } else if (direction === "sent") {
          const totalIn = tx.vin.filter((v) => v.prevout?.scriptpubkey_address === address).reduce((sum, v) => sum + (v.prevout?.value ?? 0), 0);
          const changeBack = tx.vout.filter((v) => v.scriptpubkey_address === address).reduce((sum, v) => sum + v.value, 0);
          amount = -(totalIn - changeBack);
        } else {
          amount = 0;
        }
        const counterparties = [];
        if (direction === "sent") {
          tx.vout.forEach((v) => {
            if (v.scriptpubkey_address && v.scriptpubkey_address !== address) {
              counterparties.push(v.scriptpubkey_address);
            }
          });
        } else if (direction === "received") {
          inputAddresses.forEach((a) => {
            if (a !== address) counterparties.push(a);
          });
        }
        return {
          txHash: tx.txid,
          direction,
          amount,
          fee: tx.fee,
          timestamp: tx.status.block_time ?? 0,
          blockHeight: tx.status.block_height ?? 0,
          confirmed: tx.status.confirmed,
          counterparties
        };
      });
    }
    async getTransaction(txHash) {
      const cached = this.txCache.get(txHash);
      if (cached !== void 0) return cached;
      const hex = await this.limiter.run(() => this.fetchText(`/tx/${txHash}/hex`));
      this.txCache.set(txHash, hex);
      return hex;
    }
    /**
     * Get transaction confirmation status via mempool.space /tx/{txid} endpoint.
     * Used by btc-wallet's getTransactionReceipt().
     */
    async getTxStatus(txHash) {
      const data = await this.fetchJson(`/tx/${txHash}`);
      return {
        txHash: data.txid,
        confirmed: data.status.confirmed,
        blockHeight: data.status.block_height ?? 0,
        blockTime: data.status.block_time ?? 0,
        fee: data.fee
      };
    }
    async broadcast(rawTx) {
      const response = await native.net.fetch(`${this.baseUrl}/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rawTx
      });
      const bodyStr = response.body ? native.encoding.utf8Decode(response.body) : "";
      if (response.status !== 200) {
        throw new Error(`Broadcast failed (status ${response.status}): ${bodyStr}`);
      }
      return bodyStr.trim();
    }
    async estimateFee(blocks) {
      const data = await this.fetchJson("/v1/fees/recommended");
      let satPerVb;
      if (blocks <= 1) {
        satPerVb = data.fastestFee;
      } else if (blocks <= 3) {
        satPerVb = data.halfHourFee;
      } else if (blocks <= 6) {
        satPerVb = data.hourFee;
      } else {
        satPerVb = data.economyFee;
      }
      return satPerVb * 1e3 / 1e8;
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    async fetchJson(path) {
      const response = await native.net.fetch(`${this.baseUrl}${path}`);
      if (response.status !== 200) {
        const body = response.body ? native.encoding.utf8Decode(response.body) : "";
        throw new Error(
          `Mempool API error: status ${response.status} for ${path}: ${body}`
        );
      }
      const bodyText = response.body ? native.encoding.utf8Decode(response.body) : "";
      return JSON.parse(bodyText);
    }
    async fetchText(path) {
      const response = await native.net.fetch(`${this.baseUrl}${path}`);
      if (response.status !== 200) {
        const body = response.body ? native.encoding.utf8Decode(response.body) : "";
        throw new Error(
          `Mempool API error: status ${response.status} for ${path}: ${body}`
        );
      }
      return response.body ? native.encoding.utf8Decode(response.body) : "";
    }
  };

  // ../wdk-v2-wallet-btc/src/client/index.ts
  function createClient(descOrClient, network = "bitcoin") {
    if (descOrClient && typeof descOrClient === "object" && "getBalance" in descOrClient && "listUnspent" in descOrClient && "broadcast" in descOrClient) {
      return descOrClient;
    }
    const desc = descOrClient;
    const net = desc.network ?? network;
    switch (desc.type) {
      // Production-compatible descriptors
      case "blockbook-http":
      case "blockbook":
        return new BlockbookClient(net, desc.url);
      case "mempool-rest":
        return new MempoolRestClient(net, desc.url);
      // Production Electrum descriptors — not yet implemented, but recognized
      // so config doesn't silently break when switching from production
      case "electrum":
      case "electrum-ws":
        throw new Error(
          `BTC client type "${desc.type}" is recognized but not yet implemented in v2. Use "blockbook-http" or "mempool-rest" instead.`
        );
      default:
        throw new Error(`Unknown BTC client type: ${desc.type}`);
    }
  }

  // ../wdk-v2-wallet-btc/src/btc-wallet.ts
  var BitcoinWallet = class extends BaseWallet {
    constructor() {
      super("btc", 0, "secp256k1");
      this.isTestnet = false;
      this.network = "bitcoin";
    }
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------
    async initialize(config) {
      await super.initialize(config);
      this.network = config.network ?? (config.isTestnet ? "testnet" : "bitcoin");
      this.isTestnet = this.network !== "bitcoin";
      this.coinType = this.network === "bitcoin" ? 0 : 1;
      if (config.btcClient) {
        this.client = createClient(config.btcClient, this.network);
      } else {
        this.client = new MempoolRestClient(this.network);
      }
      await this.client.connect();
    }
    /**
     * BTC native SegWit (P2WPKH) uses BIP-84: m/84'/coinType'/account'/change/index
     * coinType is set dynamically in initialize(): 0 for mainnet, 1 for testnet.
     */
    getDerivationPath(index) {
      return `m/84'/${this.coinType}'/0'/0/${index}`;
    }
    // -----------------------------------------------------------------------
    // Address
    // -----------------------------------------------------------------------
    async getAddress(keyHandle, _index) {
      return generateSegwitAddress(keyHandle, this.isTestnet, this.network);
    }
    // -----------------------------------------------------------------------
    // Balance
    // -----------------------------------------------------------------------
    /**
     * Fetch the confirmed balance for a Bitcoin address (in satoshis).
     * Delegates to IBtcClient.getBalance().
     */
    async getBalance(address) {
      const balance = await this.client.getBalance(address);
      return String(balance.confirmed);
    }
    // -----------------------------------------------------------------------
    // Quote + Max Spendable (production parity: quoteSendTransaction, getMaxSpendable)
    // -----------------------------------------------------------------------
    /**
     * Preview a send transaction without signing or broadcasting.
     * Returns estimated fee, input/output counts, and whether the tx is feasible.
     * Matches production WDK's quoteSendTransaction().
     */
    async quoteSendTransaction(params) {
      const targetSats = parseInt(params.amount, 10);
      if (isNaN(targetSats) || targetSats <= 0) {
        return {
          feasible: false,
          fee: 0,
          feeRate: 0,
          inputCount: 0,
          outputCount: 0,
          totalInput: 0,
          change: 0,
          error: `Invalid amount: ${params.amount}`
        };
      }
      try {
        const electrumUtxos = await this.client.listUnspent(params.from);
        const utxos = electrumUtxos.map((u) => ({
          txid: u.tx_hash,
          vout: u.tx_pos,
          value: u.value,
          scriptPubKey: "",
          address: params.from
        }));
        const btcPerKb = await this.client.estimateFee(3);
        const feeRate = Math.ceil(btcPerKb * 1e8 / 1e3);
        const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH);
        if (!selection) {
          return {
            feasible: false,
            fee: 0,
            feeRate,
            inputCount: 0,
            outputCount: 0,
            totalInput: utxos.reduce((s, u) => s + u.value, 0),
            change: 0,
            error: "Insufficient funds"
          };
        }
        return {
          feasible: true,
          fee: selection.fee,
          feeRate,
          inputCount: selection.selected.length,
          outputCount: selection.change > 0 ? 2 : 1,
          totalInput: selection.selected.reduce((s, u) => s + u.value, 0),
          change: selection.change
        };
      } catch (e) {
        return {
          feasible: false,
          fee: 0,
          feeRate: 0,
          inputCount: 0,
          outputCount: 0,
          totalInput: 0,
          change: 0,
          error: e.message ?? String(e)
        };
      }
    }
    /**
     * Calculate the maximum amount that can be sent from an address.
     * Accounts for fee, dust threshold, and MAX_UTXO_INPUTS.
     * Matches production WDK's getMaxSpendable().
     */
    async getMaxSpendable(address) {
      const electrumUtxos = await this.client.listUnspent(address);
      const utxos = electrumUtxos.map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: u.value,
        scriptPubKey: "",
        address
      }));
      const btcPerKb = await this.client.estimateFee(3);
      const feeRate = Math.ceil(btcPerKb * 1e8 / 1e3);
      const maxSpendable = calculateMaxSpendable(utxos, feeRate, DUST_THRESHOLD_P2WPKH);
      const totalInput = utxos.reduce((s, u) => s + u.value, 0);
      return {
        maxSpendable,
        fee: totalInput - maxSpendable,
        utxoCount: utxos.length
      };
    }
    // -----------------------------------------------------------------------
    // Build transaction
    // -----------------------------------------------------------------------
    /**
     * Build an unsigned Bitcoin transaction.
     *
     * Steps:
     *   1. Fetch UTXOs via IBtcClient.listUnspent()
     *   2. Estimate fees via IBtcClient.estimateFee()
     *   3. Select coins
     *   4. Construct the unsigned transaction envelope
     */
    async buildTransaction(params) {
      const { to, amount } = params;
      const targetSats = parseInt(amount, 10);
      if (isNaN(targetSats) || targetSats <= 0) {
        throw new Error(`Invalid amount: ${amount}`);
      }
      const fromAddress = params.from;
      if (!fromAddress) {
        throw new Error(
          "Sender address must be provided in params.from for BTC transactions"
        );
      }
      const electrumUtxos = await this.client.listUnspent(fromAddress);
      const senderScriptPubKey = native.encoding.hexEncode(
        addressToScriptPubKey(fromAddress)
      );
      const utxos = electrumUtxos.map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: u.value,
        scriptPubKey: senderScriptPubKey,
        address: fromAddress,
        confirmations: u.height > 0 ? 1 : 0
      }));
      if (utxos.length === 0) {
        throw new Error("No UTXOs available for address");
      }
      const btcPerKb = await this.client.estimateFee(3);
      const feeRate = Math.ceil(btcPerKb * 1e8 / 1e3);
      const selection = selectUtxos(utxos, targetSats, feeRate);
      if (!selection) {
        throw new Error("Insufficient funds");
      }
      const inputs = selection.selected.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        scriptPubKey: u.scriptPubKey
      }));
      const outputs = [
        { address: to, value: targetSats }
      ];
      if (selection.change > 0) {
        outputs.push({ address: fromAddress, value: selection.change });
      }
      const btcUnsignedTx = {
        inputs,
        outputs,
        changeAddress: fromAddress,
        fee: selection.fee
      };
      return {
        chain: "btc",
        data: btcUnsignedTx,
        estimatedFee: String(selection.fee)
      };
    }
    // -----------------------------------------------------------------------
    // Sign transaction
    // -----------------------------------------------------------------------
    async signTransaction(tx, keyHandle) {
      const btcTx = tx.data;
      const keyHandles = btcTx.inputs.map(() => keyHandle);
      const signed = buildTransaction(btcTx.inputs, btcTx.outputs, keyHandles);
      return {
        chain: "btc",
        rawTx: signed.rawTx,
        txHash: signed.txid
      };
    }
    // -----------------------------------------------------------------------
    // Broadcast
    // -----------------------------------------------------------------------
    /**
     * Broadcast a signed transaction to the Bitcoin network.
     * Delegates to IBtcClient.broadcast().
     */
    async broadcastTransaction(tx) {
      const rawTx = typeof tx.rawTx === "string" ? tx.rawTx : native.encoding.hexEncode(tx.rawTx);
      return this.client.broadcast(rawTx);
    }
    // -----------------------------------------------------------------------
    // Transaction history
    // -----------------------------------------------------------------------
    /**
     * Fetch transaction history with full parsed details.
     * Uses IBtcClient.getDetailedHistory() which returns direction, amounts,
     * fees, counterparties — parsed from full transaction data.
     */
    async getTransactionHistory(address, limit = 25) {
      const detailed = await this.client.getDetailedHistory(address, limit);
      return detailed.map((tx) => {
        const uniqueCounterparties = [...new Set(tx.counterparties)];
        return {
          txHash: tx.txHash,
          chain: "btc",
          // Primary from/to for backwards compat (first counterparty)
          from: tx.direction === "received" ? uniqueCounterparties[0] ?? "" : address,
          to: tx.direction === "sent" ? uniqueCounterparties[0] ?? "" : address,
          amount: String(Math.abs(tx.amount)),
          fee: String(tx.fee),
          direction: tx.direction,
          // Full counterparty list (deduplicated)
          counterparties: uniqueCounterparties,
          timestamp: tx.timestamp,
          status: tx.confirmed ? "confirmed" : "pending",
          blockNumber: tx.blockHeight > 0 ? tx.blockHeight : void 0
        };
      });
    }
    // -----------------------------------------------------------------------
    // Transaction receipt
    // -----------------------------------------------------------------------
    /**
     * Get the confirmation status of a transaction.
     * Matches production WDK's getTransactionReceipt().
     */
    async getTransactionReceipt(txHash) {
      return this.client.getTxStatus(txHash);
    }
    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    destroy() {
      if (this.client) {
        this.client.close().catch(() => {
        });
      }
      this.network = "bitcoin";
      this.isTestnet = false;
      super.destroy();
    }
  };

  // src/bundle-entry.ts
  var engine = new WDKEngine();
  var btcWallet = new BitcoinWallet();
  engine.registerChain(btcWallet);
  var wdk = {
    // ── Lifecycle ──
    createWallet(params) {
      return engine.createWallet(params);
    },
    unlockWallet(params) {
      return engine.unlockWallet(params);
    },
    lockWallet() {
      return engine.lockWallet();
    },
    destroyWallet() {
      return engine.destroyWallet();
    },
    getState() {
      return engine.getState();
    },
    // ── BTC-specific convenience functions ──
    /**
     * Derive a BTC SegWit address at the given index.
     * Requires the wallet to already be unlocked (state === 'ready').
     * Throws StateError if called before unlockWallet().
     */
    getBtcAddress(params) {
      const index = params.index ?? 0;
      const btcConfig = engine.getConfig().networks["btc"];
      const coinType = btcConfig?.isTestnet ? 1 : 0;
      const keyHandle = engine.getKeyManager().deriveAndTrack(
        `m/84'/${coinType}'/0'/0/${index}`
      );
      const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
      const sha = native.crypto.sha256(pubkey);
      const hash160 = native.crypto.ripemd160(sha);
      const fiveBit = convertBits2(hash160, 8, 5, true);
      if (!fiveBit) return { error: "bit conversion failed" };
      const witnessProgram = new Uint8Array(1 + fiveBit.length);
      witnessProgram[0] = 0;
      witnessProgram.set(fiveBit, 1);
      const hrp = btcConfig?.isTestnet ? "tb" : "bc";
      const address = native.encoding.bech32Encode(hrp, witnessProgram);
      return { address };
    },
    // ── Configuration ──
    /**
     * Update network configuration before unlockWallet().
     * Pass { isTestnet: true } to switch a chain to testnet.
     * Pass { chain: 'btc', isTestnet: true } to target a specific chain
     * (defaults to 'btc' if chain is omitted).
     */
    configure(params) {
      const chain = params.chain ?? "btc";
      const isTestnet = params.isTestnet ?? (params.network === "testnet" || params.network === "regtest");
      const network = params.network ?? (isTestnet ? "testnet" : "bitcoin");
      engine.configure({
        networks: {
          [chain]: {
            chainId: chain,
            networkId: isTestnet ? "testnet" : "mainnet",
            rpcUrl: "",
            isTestnet,
            network,
            btcClient: params.btcClient
          }
        }
      });
      return {};
    },
    // ── Generic chain dispatch ──
    getAddress(params) {
      return engine.dispatch("getAddress", params);
    },
    getBalance(params) {
      return engine.dispatch("getBalance", params);
    },
    send(params) {
      return engine.dispatch("send", params);
    },
    getHistory(params) {
      return engine.dispatch("getHistory", params);
    },
    quoteSend(params) {
      return engine.dispatch("quoteSend", params);
    },
    getMaxSpendable(params) {
      return engine.dispatch("getMaxSpendable", params);
    },
    getReceipt(params) {
      return engine.dispatch("getReceipt", params);
    }
  };
  function convertBits2(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (value < 0 || value >> fromBits !== 0) return null;
      acc = acc << fromBits | value;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        ret.push(acc >> bits & maxv);
      }
    }
    if (pad) {
      if (bits > 0) {
        ret.push(acc << toBits - bits & maxv);
      }
    } else if (bits >= fromBits || (acc << toBits - bits & maxv) !== 0) {
      return null;
    }
    return new Uint8Array(ret);
  }
  globalThis.wdk = wdk;
})();
