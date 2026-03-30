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
          const addressType = params.addressType;
          const keyHandle = this.keys.deriveAndTrack(
            wallet.getDerivationPath(index, addressType)
          );
          return wallet.getAddress(keyHandle, index, addressType);
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
        case "getFeeRates": {
          if (typeof wallet.getFeeRates === "function") {
            return wallet.getFeeRates();
          }
          throw new StateError("getFeeRates not supported for this chain");
        }
        case "getReceipt": {
          const txHash = params.txHash;
          if (!txHash) throw new StateError('Missing "txHash" parameter');
          return wallet.getTransactionReceipt(txHash);
        }
        case "getTransfers": {
          const address = params.address;
          if (!address) throw new StateError('Missing "address" parameter');
          if (typeof wallet.getTransfers === "function") {
            return wallet.getTransfers(address, {
              direction: params.direction,
              limit: params.limit,
              afterTxId: params.afterTxId,
              page: params.page
            });
          }
          throw new StateError("getTransfers not supported for this chain");
        }
        case "signMessage": {
          const message = params.message;
          if (!message && message !== "") throw new StateError('Missing "message" parameter');
          const signIndex = params.index ?? 0;
          const msgKeyHandle = this.keys.deriveAndTrack(
            wallet.getDerivationPath(signIndex)
          );
          if (typeof wallet.signMessage === "function") {
            return wallet.signMessage(message, msgKeyHandle);
          }
          throw new StateError("signMessage not supported for this chain");
        }
        case "verifyMessage": {
          const message = params.message;
          const signature = params.signature;
          const address = params.address;
          if (!message && message !== "") throw new StateError('Missing "message" parameter');
          if (!signature) throw new StateError('Missing "signature" parameter');
          if (!address) throw new StateError('Missing "address" parameter');
          if (typeof wallet.verifyMessage === "function") {
            return wallet.verifyMessage(message, signature, address);
          }
          throw new StateError("verifyMessage not supported for this chain");
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
    getDerivationPath(index, _addressType) {
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
      const bodyText = response.body ? native.encoding.utf8Decode(response.body) : "{}";
      const json = JSON.parse(bodyText);
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
  function generateLegacyAddress(keyHandle, isTestnet = false) {
    const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
    const sha = native.crypto.sha256(pubkey);
    const hash160 = native.crypto.ripemd160(sha);
    const version = isTestnet ? 111 : 0;
    const payload = new Uint8Array(21);
    payload[0] = version;
    payload.set(hash160, 1);
    return native.encoding.base58CheckEncode(payload);
  }

  // ../wdk-v2-wallet-btc/src/utxo.ts
  var VBYTES_PER_INPUT = 68;
  var VBYTES_PER_OUTPUT_DEFAULT = 31;
  var TX_OVERHEAD_VBYTES = 11;
  function estimateOutputVbytes(address) {
    if (!address) return VBYTES_PER_OUTPUT_DEFAULT;
    if (address.startsWith("1") || address.startsWith("m") || address.startsWith("n")) return 34;
    if (address.startsWith("3") || address.startsWith("2")) return 32;
    if (address.startsWith("bc1p") || address.startsWith("tb1p") || address.startsWith("bcrt1p")) return 43;
    if (address.length > 50) return 43;
    return VBYTES_PER_OUTPUT_DEFAULT;
  }
  var DUST_THRESHOLD_P2WPKH = 294;
  var MIN_TX_FEE_SATS = 141;
  var MAX_UTXO_INPUTS = 200;
  function selectUtxos(utxos, targetAmount, feeRate, dustThreshold = DUST_THRESHOLD_P2WPKH, destinationAddress) {
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const candidates = sorted.slice(0, MAX_UTXO_INPUTS);
    const selected = [];
    let totalInput = 0;
    const destOutputVbytes = estimateOutputVbytes(destinationAddress);
    const changeOutputVbytes = VBYTES_PER_OUTPUT_DEFAULT;
    for (const utxo of candidates) {
      selected.push(utxo);
      totalInput += utxo.value;
      const vbytes2 = TX_OVERHEAD_VBYTES + selected.length * VBYTES_PER_INPUT + destOutputVbytes + changeOutputVbytes;
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
    const vbytes = TX_OVERHEAD_VBYTES + candidates.length * VBYTES_PER_INPUT + 1 * VBYTES_PER_OUTPUT_DEFAULT;
    let fee = Math.ceil(vbytes * feeRate);
    if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;
    const maxSpendable = totalInput - fee;
    if (maxSpendable < dustThreshold) return 0;
    return maxSpendable;
  }

  // ../wdk-v2-wallet-btc/src/transaction.ts
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

  // ../wdk-v2-wallet-btc/src/psbt.ts
  var PSBT_MAGIC = new Uint8Array([112, 115, 98, 116, 255]);
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
    if (value < 253) return new Uint8Array([value]);
    if (value <= 65535) {
      const buf2 = new Uint8Array(3);
      buf2[0] = 253;
      buf2[1] = value & 255;
      buf2[2] = value >>> 8 & 255;
      return buf2;
    }
    const buf = new Uint8Array(5);
    buf[0] = 254;
    buf[1] = value & 255;
    buf[2] = value >>> 8 & 255;
    buf[3] = value >>> 16 & 255;
    buf[4] = value >>> 24 & 255;
    return buf;
  }
  function concat(...arrays) {
    let len = 0;
    for (const a of arrays) len += a.length;
    const result = new Uint8Array(len);
    let off = 0;
    for (const a of arrays) {
      result.set(a, off);
      off += a.length;
    }
    return result;
  }
  function reverseTxid(txidHex) {
    const bytes = native.encoding.hexDecode(txidHex);
    const reversed = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) reversed[i] = bytes[bytes.length - 1 - i];
    return reversed;
  }
  function hash256(data) {
    return native.crypto.sha256(native.crypto.sha256(data));
  }
  function appendByte(data, byte) {
    const out = new Uint8Array(data.length + 1);
    out.set(data);
    out[data.length] = byte;
    return out;
  }
  function encodeSignedInt(value) {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const trimmed = value.slice(start);
    if (trimmed[0] & 128) {
      const padded = new Uint8Array(trimmed.length + 1);
      padded[0] = 0;
      padded.set(trimmed, 1);
      return padded;
    }
    return trimmed;
  }
  function encodeDER(sig) {
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
  function createPsbt(inputs, outputs) {
    return {
      unsignedTx: {
        version: 2,
        inputs,
        outputs,
        locktime: 0
      },
      inputs: inputs.map(() => ({
        partialSigs: /* @__PURE__ */ new Map(),
        sighashType: 1,
        // SIGHASH_ALL
        unknowns: /* @__PURE__ */ new Map()
      })),
      outputs: outputs.map(() => ({
        unknowns: /* @__PURE__ */ new Map()
      }))
    };
  }
  function addWitnessUtxo(psbt, inputIndex, amount, scriptPubKey) {
    psbt.inputs[inputIndex].witnessUtxo = { amount, scriptPubKey };
  }
  function signInput(psbt, inputIndex, keyHandle) {
    const { inputs, outputs } = psbt.unsignedTx;
    const input = psbt.inputs[inputIndex];
    if (input.witnessUtxo) {
      const sighash = computeSegwitSighash(psbt, inputIndex, keyHandle);
      const signature = native.crypto.signSecp256k1(keyHandle, sighash);
      const derSig = encodeDER(signature);
      const sigWithHashType = appendByte(derSig, input.sighashType);
      const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
      input.partialSigs.set(native.encoding.hexEncode(pubkey), sigWithHashType);
    } else if (input.nonWitnessUtxo) {
      const sighash = computeLegacySighash(psbt, inputIndex, keyHandle);
      const signature = native.crypto.signSecp256k1(keyHandle, sighash);
      const derSig = encodeDER(signature);
      const sigWithHashType = appendByte(derSig, input.sighashType);
      const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
      input.partialSigs.set(native.encoding.hexEncode(pubkey), sigWithHashType);
    } else {
      throw new Error(`Input ${inputIndex} has no witnessUtxo or nonWitnessUtxo`);
    }
  }
  function computeSegwitSighash(psbt, inputIndex, keyHandle) {
    const { inputs, outputs, version, locktime } = psbt.unsignedTx;
    const sighashType = psbt.inputs[inputIndex].sighashType;
    const outpoints = [];
    for (const inp of inputs) {
      outpoints.push(reverseTxid(inp.txid));
      outpoints.push(writeUint32LE(inp.vout));
    }
    const hashPrevouts = hash256(concat(...outpoints));
    const sequences = [];
    for (let i = 0; i < inputs.length; i++) sequences.push(writeUint32LE(4294967295));
    const hashSequence = hash256(concat(...sequences));
    const outputParts = [];
    for (const out of outputs) {
      outputParts.push(writeUint64LE(out.value));
      const spk = addressToScriptPubKey(out.address);
      outputParts.push(writeVarInt(spk.length));
      outputParts.push(spk);
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
    const preimage = concat(
      writeUint32LE(version),
      hashPrevouts,
      hashSequence,
      thisOutpoint,
      scriptCode,
      value,
      writeUint32LE(4294967295),
      // nSequence
      hashOutputs,
      writeUint32LE(locktime),
      writeUint32LE(sighashType)
    );
    return hash256(preimage);
  }
  function computeLegacySighash(psbt, inputIndex, keyHandle) {
    const { inputs, outputs, version, locktime } = psbt.unsignedTx;
    const sighashType = psbt.inputs[inputIndex].sighashType;
    const pubkey = native.crypto.getPublicKey(keyHandle, "secp256k1");
    const pubkeySha = native.crypto.sha256(pubkey);
    const pubkeyHash = native.crypto.ripemd160(pubkeySha);
    const prevScriptPubKey = new Uint8Array(25);
    prevScriptPubKey[0] = 118;
    prevScriptPubKey[1] = 169;
    prevScriptPubKey[2] = 20;
    prevScriptPubKey.set(pubkeyHash, 3);
    prevScriptPubKey[23] = 136;
    prevScriptPubKey[24] = 172;
    const parts = [];
    parts.push(writeUint32LE(version));
    parts.push(writeVarInt(inputs.length));
    for (let i = 0; i < inputs.length; i++) {
      parts.push(reverseTxid(inputs[i].txid));
      parts.push(writeUint32LE(inputs[i].vout));
      if (i === inputIndex) {
        parts.push(writeVarInt(prevScriptPubKey.length));
        parts.push(prevScriptPubKey);
      } else {
        parts.push(writeVarInt(0));
      }
      parts.push(writeUint32LE(4294967295));
    }
    parts.push(writeVarInt(outputs.length));
    for (const out of outputs) {
      parts.push(writeUint64LE(out.value));
      const spk = addressToScriptPubKey(out.address);
      parts.push(writeVarInt(spk.length));
      parts.push(spk);
    }
    parts.push(writeUint32LE(locktime));
    parts.push(writeUint32LE(sighashType));
    return hash256(concat(...parts));
  }
  function finalizeInput(psbt, inputIndex) {
    const input = psbt.inputs[inputIndex];
    if (input.partialSigs.size === 0) {
      throw new Error(`Input ${inputIndex} has no signatures`);
    }
    const [pubkeyHex, sigWithHashType] = input.partialSigs.entries().next().value;
    const pubkey = native.encoding.hexDecode(pubkeyHex);
    if (input.witnessUtxo) {
      const witnessParts = [];
      witnessParts.push(writeVarInt(2));
      witnessParts.push(writeVarInt(sigWithHashType.length));
      witnessParts.push(sigWithHashType);
      witnessParts.push(writeVarInt(pubkey.length));
      witnessParts.push(pubkey);
      input.finalScriptWitness = concat(...witnessParts);
    } else if (input.nonWitnessUtxo) {
      const scriptParts = [];
      scriptParts.push(new Uint8Array([sigWithHashType.length]));
      scriptParts.push(sigWithHashType);
      scriptParts.push(new Uint8Array([pubkey.length]));
      scriptParts.push(pubkey);
      input.finalScriptSig = concat(...scriptParts);
    }
    input.partialSigs.clear();
    input.bip32Derivation = void 0;
    input.sighashType = 1;
  }
  function extractTransaction(psbt) {
    const { inputs, outputs, version, locktime } = psbt.unsignedTx;
    const hasWitness = psbt.inputs.some((inp) => inp.finalScriptWitness);
    const parts = [];
    parts.push(writeUint32LE(version));
    if (hasWitness) {
      parts.push(new Uint8Array([0, 1]));
    }
    parts.push(writeVarInt(inputs.length));
    for (let i = 0; i < inputs.length; i++) {
      parts.push(reverseTxid(inputs[i].txid));
      parts.push(writeUint32LE(inputs[i].vout));
      const scriptSig = psbt.inputs[i].finalScriptSig ?? new Uint8Array(0);
      parts.push(writeVarInt(scriptSig.length));
      if (scriptSig.length > 0) parts.push(scriptSig);
      parts.push(writeUint32LE(4294967295));
    }
    parts.push(writeVarInt(outputs.length));
    for (const out of outputs) {
      parts.push(writeUint64LE(out.value));
      const spk = addressToScriptPubKey(out.address);
      parts.push(writeVarInt(spk.length));
      parts.push(spk);
    }
    if (hasWitness) {
      for (let i = 0; i < inputs.length; i++) {
        const witness = psbt.inputs[i].finalScriptWitness;
        if (witness) {
          parts.push(witness);
        } else {
          parts.push(new Uint8Array([0]));
        }
      }
    }
    parts.push(writeUint32LE(locktime));
    const rawTx = concat(...parts);
    const noWitnessParts = [];
    noWitnessParts.push(writeUint32LE(version));
    noWitnessParts.push(writeVarInt(inputs.length));
    for (let i = 0; i < inputs.length; i++) {
      noWitnessParts.push(reverseTxid(inputs[i].txid));
      noWitnessParts.push(writeUint32LE(inputs[i].vout));
      const scriptSig = psbt.inputs[i].finalScriptSig ?? new Uint8Array(0);
      noWitnessParts.push(writeVarInt(scriptSig.length));
      if (scriptSig.length > 0) noWitnessParts.push(scriptSig);
      noWitnessParts.push(writeUint32LE(4294967295));
    }
    noWitnessParts.push(writeVarInt(outputs.length));
    for (const out of outputs) {
      noWitnessParts.push(writeUint64LE(out.value));
      const spk = addressToScriptPubKey(out.address);
      noWitnessParts.push(writeVarInt(spk.length));
      noWitnessParts.push(spk);
    }
    noWitnessParts.push(writeUint32LE(locktime));
    const rawNoWitness = concat(...noWitnessParts);
    const txidBytes = hash256(rawNoWitness);
    const txidReversed = new Uint8Array(txidBytes.length);
    for (let i = 0; i < txidBytes.length; i++) {
      txidReversed[i] = txidBytes[txidBytes.length - 1 - i];
    }
    return {
      rawTx: native.encoding.hexEncode(rawTx),
      txid: native.encoding.hexEncode(txidReversed)
    };
  }
  function buildAndSignPsbt(inputs, outputs, keyHandles) {
    if (inputs.length !== keyHandles.length) {
      throw new Error(`Mismatched inputs (${inputs.length}) and keyHandles (${keyHandles.length})`);
    }
    if (inputs.length === 0) throw new Error("Transaction must have at least one input");
    if (outputs.length === 0) throw new Error("Transaction must have at least one output");
    const psbt = createPsbt(inputs, outputs);
    for (let i = 0; i < inputs.length; i++) {
      const spk = inputs[i].scriptPubKey ? native.encoding.hexDecode(inputs[i].scriptPubKey) : addressToScriptPubKey(inputs[i].address ?? "");
      if (spk.length === 25 && spk[0] === 118) {
        addWitnessUtxo(psbt, i, inputs[i].value, spk);
      } else {
        addWitnessUtxo(psbt, i, inputs[i].value, spk);
      }
    }
    for (let i = 0; i < inputs.length; i++) {
      signInput(psbt, i, keyHandles[i]);
    }
    for (let i = 0; i < inputs.length; i++) {
      finalizeInput(psbt, i);
    }
    return extractTransaction(psbt);
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
    /**
     * Constructor accepts two forms for production compatibility:
     *   new BlockbookClient('testnet')              — use default URL
     *   new BlockbookClient('bitcoin', 'https://...') — custom URL
     *   new BlockbookClient({ url: 'https://...' }) — production config shape
     */
    constructor(networkOrConfig = "bitcoin", customUrl) {
      this.txCache = new LRUCache(100);
      this.limiter = new ConcurrencyLimiter(8);
      let network;
      if (typeof networkOrConfig === "object") {
        network = networkOrConfig.network ?? "bitcoin";
        this.baseUrl = networkOrConfig.url.replace(/\/$/, "");
      } else {
        network = networkOrConfig;
        this.baseUrl = customUrl ? customUrl.replace(/\/$/, "") : BASE_URLS[network];
      }
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
    async getDetailedHistory(address, limit = 25, _afterTxId, page = 1) {
      const data = await this.fetchJson(`/api/v2/address/${address}?details=txs&pageSize=${limit}&page=${page}`);
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
    regtest: ""
    // regtest MUST use a user-provided URL
  };
  var MempoolRestClient = class {
    constructor(network = "bitcoin", customUrl) {
      /** LRU cache for raw transaction hex (avoids re-fetching same tx) */
      this.txCache = new LRUCache(100);
      /** Concurrency limiter for parallel requests (matches production pLimit(8)) */
      this.limiter = new ConcurrencyLimiter(8);
      if (network === "regtest" && !customUrl) {
        throw new Error("MempoolRestClient: regtest requires a custom URL (e.g. http://localhost:3000/api)");
      }
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
    async getDetailedHistory(address, limit = 25, afterTxId, _page) {
      const endpoint = afterTxId ? `/address/${address}/txs/chain/${afterTxId}` : `/address/${address}/txs`;
      const txs = await this.fetchJson(endpoint);
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
     * BTC legacy (P2PKH) uses BIP-44: m/44'/coinType'/account'/change/index
     * coinType is set dynamically in initialize(): 0 for mainnet, 1 for testnet.
     */
    getDerivationPath(index, addressType) {
      const purpose = addressType === "p2pkh" ? 44 : 84;
      return `m/${purpose}'/${this.coinType}'/0'/0/${index}`;
    }
    // -----------------------------------------------------------------------
    // Address
    // -----------------------------------------------------------------------
    async getAddress(keyHandle, _index, addressType) {
      if (addressType === "p2pkh") {
        return generateLegacyAddress(keyHandle, this.isTestnet);
      }
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
    // Fee rates
    // -----------------------------------------------------------------------
    /**
     * Get current fee rates in sat/vB for different priority levels.
     * Matches production WDK's fee rate exposure.
     */
    async getFeeRates() {
      const [fast, medium, slow] = await Promise.all([
        this.client.estimateFee(1),
        this.client.estimateFee(3),
        this.client.estimateFee(6)
      ]);
      const toSatVb = (btcPerKb) => Math.ceil(btcPerKb * 1e8 / 1e3);
      return {
        fast: toSatVb(fast),
        medium: toSatVb(medium),
        slow: toSatVb(slow)
      };
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
        const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH, params.to);
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
          change: selection.change,
          changeValue: selection.change
          // production alias
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
        amount: maxSpendable,
        // production alias
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
      const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH, to);
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
      const signed = buildAndSignPsbt(btcTx.inputs, btcTx.outputs, keyHandles);
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
    // Paginated transfers (production parity: getTransfers)
    // -----------------------------------------------------------------------
    /**
     * Get paginated, filterable transfer history.
     * Matches production WDK's getTransfers({direction, limit, skip}).
     *
     * @param address  The Bitcoin address to query
     * @param query    Optional: direction filter, limit, pagination cursor
     * @returns transfers array + hasMore flag + nextCursor for pagination
     */
    async getTransfers(address, query) {
      const limit = query?.limit ?? 25;
      const detailed = await this.client.getDetailedHistory(
        address,
        limit,
        query?.afterTxId,
        query?.page
      );
      let filtered = detailed;
      if (query?.direction && query.direction !== "all") {
        filtered = detailed.filter((tx) => tx.direction === query.direction);
      }
      const transfers = filtered.map((tx) => ({
        ...tx,
        counterparties: [...new Set(tx.counterparties)]
      }));
      const hasMore = detailed.length >= limit;
      const nextCursor = detailed.length > 0 ? detailed[detailed.length - 1].txHash : void 0;
      return { transfers, hasMore, nextCursor };
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
    // Message signing (Bitcoin Signed Message format)
    // -----------------------------------------------------------------------
    /**
     * Sign a message using the Bitcoin Signed Message standard.
     * Compatible with bitcoinjs-message / Electrum / Bitcoin Core signmessage.
     *
     * Format: double-SHA256 of "\x18Bitcoin Signed Message:\n" + varint(len) + message
     * Output: base64-encoded 65-byte signature (1 flag byte + 32r + 32s)
     *
     * @param message    The message string to sign
     * @param keyHandle  Key handle for the signing key
     * @returns base64-encoded signature string
     */
    async signMessage(message, keyHandle) {
      const msgHash = this.bitcoinMessageHash(message);
      const recoverableSig = native.crypto.signRecoverableSecp256k1(keyHandle, msgHash);
      const recid = recoverableSig[64];
      const flagByte = 27 + 4 + recid;
      const result = new Uint8Array(65);
      result[0] = flagByte;
      result.set(recoverableSig.slice(0, 64), 1);
      return this.uint8ArrayToBase64(result);
    }
    /**
     * Verify a Bitcoin Signed Message against an address.
     * Recovers the public key from the signature, derives the address,
     * and compares to the expected address.
     *
     * @param message    The original message string
     * @param signature  base64-encoded 65-byte signature
     * @param address    The expected Bitcoin address
     * @returns true if the signature is valid for this address
     */
    async verifyMessage(message, signature, address) {
      const sigBytes = this.base64ToUint8Array(signature);
      if (sigBytes.length !== 65) return false;
      const flagByte = sigBytes[0];
      const recid = flagByte - 27 & 3;
      const compressed = (flagByte - 27 & 4) !== 0;
      if (!compressed) return false;
      const recoverableSig = new Uint8Array(65);
      recoverableSig.set(sigBytes.slice(1, 65), 0);
      recoverableSig[64] = recid;
      const msgHash = this.bitcoinMessageHash(message);
      let recoveredPubkey;
      try {
        recoveredPubkey = native.crypto.recoverSecp256k1(msgHash, recoverableSig);
      } catch {
        return false;
      }
      const sha = native.crypto.sha256(recoveredPubkey);
      const hash160 = native.crypto.ripemd160(sha);
      const data5 = convertBits(hash160, 8, 5, true);
      if (!data5) return false;
      const hrp = this.network === "regtest" ? "bcrt" : this.isTestnet ? "tb" : "bc";
      const witnessData = new Uint8Array(1 + data5.length);
      witnessData[0] = 0;
      witnessData.set(data5, 1);
      const derivedAddress = native.encoding.bech32Encode(hrp, witnessData);
      return derivedAddress === address;
    }
    // ── Bitcoin Signed Message helpers ──
    bitcoinMessageHash(message) {
      const prefix = new Uint8Array([
        24,
        // length of "Bitcoin Signed Message:\n"
        66,
        105,
        116,
        99,
        111,
        105,
        110,
        32,
        // "Bitcoin "
        83,
        105,
        103,
        110,
        101,
        100,
        32,
        // "Signed "
        77,
        101,
        115,
        115,
        97,
        103,
        101,
        58,
        // "Message:"
        10
        // "\n"
      ]);
      const msgBytes = native.encoding.utf8Encode(message);
      const varint = this.encodeVarint(msgBytes.length);
      const payload = new Uint8Array(prefix.length + varint.length + msgBytes.length);
      payload.set(prefix, 0);
      payload.set(varint, prefix.length);
      payload.set(msgBytes, prefix.length + varint.length);
      return native.crypto.sha256(native.crypto.sha256(payload));
    }
    encodeVarint(n) {
      if (n < 253) return new Uint8Array([n]);
      if (n <= 65535) {
        const buf2 = new Uint8Array(3);
        buf2[0] = 253;
        buf2[1] = n & 255;
        buf2[2] = n >> 8 & 255;
        return buf2;
      }
      const buf = new Uint8Array(5);
      buf[0] = 254;
      buf[1] = n & 255;
      buf[2] = n >> 8 & 255;
      buf[3] = n >> 16 & 255;
      buf[4] = n >> 24 & 255;
      return buf;
    }
    uint8ArrayToBase64(data) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let result = "";
      for (let i = 0; i < data.length; i += 3) {
        const a = data[i];
        const b = i + 1 < data.length ? data[i + 1] : 0;
        const c = i + 2 < data.length ? data[i + 2] : 0;
        result += chars[a >> 2 & 63];
        result += chars[(a << 4 | b >> 4) & 63];
        result += i + 1 < data.length ? chars[(b << 2 | c >> 6) & 63] : "=";
        result += i + 2 < data.length ? chars[c & 63] : "=";
      }
      return result;
    }
    base64ToUint8Array(base64) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const lookup = /* @__PURE__ */ new Map();
      for (let i = 0; i < chars.length; i++) lookup.set(chars[i], i);
      const clean = base64.replace(/=/g, "");
      const outLen = Math.floor(clean.length * 3 / 4);
      const result = new Uint8Array(outLen);
      let j = 0;
      for (let i = 0; i < clean.length; i += 4) {
        const a = lookup.get(clean[i]) ?? 0;
        const b = lookup.get(clean[i + 1]) ?? 0;
        const c = lookup.get(clean[i + 2]) ?? 0;
        const d = lookup.get(clean[i + 3]) ?? 0;
        result[j++] = a << 2 | b >> 4;
        if (j < outLen) result[j++] = (b << 4 | c >> 2) & 255;
        if (j < outLen) result[j++] = (c << 6 | d) & 255;
      }
      return result;
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
      return engine.dispatch("getAddress", { chain: "btc", index: params.index ?? 0 });
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
    },
    getFeeRates(params) {
      return engine.dispatch("getFeeRates", params);
    },
    getTransfers(params) {
      return engine.dispatch("getTransfers", params);
    },
    signMessage(params) {
      return engine.dispatch("signMessage", params);
    },
    verifyMessage(params) {
      return engine.dispatch("verifyMessage", params);
    }
  };
  globalThis.wdk = wdk;
})();
