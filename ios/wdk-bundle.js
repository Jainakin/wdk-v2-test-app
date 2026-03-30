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
    getManager(chainId) {
      const mod = this.modules.get(chainId);
      if (!mod) throw new Error(`Chain module not registered: ${chainId}`);
      return mod;
    }
    /** Alias for backward compatibility */
    get(chainId) {
      return this.getManager(chainId);
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
      module.setKeyManager(this.keys);
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
      const manager = this.registry.getManager(chainId);
      switch (action) {
        // ── Account lifecycle ──────────────────────────────────────────────
        case "getAccount": {
          const index = params.index ?? 0;
          const addressType = params.addressType;
          const account = manager.getAccount(index, addressType);
          return account.toInfo();
        }
        case "getAccountByPath": {
          const path = params.path;
          if (!path) throw new StateError('Missing "path" parameter');
          const account = manager.getAccountByPath(path);
          return account.toInfo();
        }
        case "toReadOnlyAccount": {
          const index = params.index ?? 0;
          const addressType = params.addressType;
          const account = manager.getAccount(index, addressType);
          const readOnly = account.toReadOnly();
          return readOnly.toInfo();
        }
        case "disposeAccount": {
          const index = params.index ?? 0;
          const addressType = params.addressType;
          manager.disposeAccount(index, addressType);
          return {};
        }
        // ── Address ────────────────────────────────────────────────────────
        case "getAddress": {
          const index = params.index ?? 0;
          const addressType = params.addressType;
          const account = manager.getAccount(index, addressType);
          return account.address;
        }
        // ── Balance + read-only ────────────────────────────────────────────
        case "getBalance": {
          const index = params.index ?? 0;
          const addressType = params.addressType;
          const account = params.address ? manager.getReadOnlyAccount(params.address, index) : manager.getAccount(index, addressType);
          return account.getBalance();
        }
        case "getHistory": {
          const index = params.index ?? 0;
          const account = params.address ? manager.getReadOnlyAccount(params.address, index) : manager.getAccount(index);
          const limit = params.limit;
          return account.getTransactionHistory(limit);
        }
        case "getTransfers": {
          const index = params.index ?? 0;
          const account = params.address ? manager.getReadOnlyAccount(params.address, index) : manager.getAccount(index);
          return account.getTransfers({
            direction: params.direction,
            limit: params.limit,
            afterTxId: params.afterTxId,
            page: params.page
          });
        }
        case "quoteSend": {
          const index = params.index ?? 0;
          const account = params.address ? manager.getReadOnlyAccount(params.address, index) : manager.getAccount(index);
          const to = params.to;
          if (!to) throw new StateError('Missing "to" parameter');
          const amount = params.amount;
          if (!amount) throw new StateError('Missing "amount" parameter');
          return account.quoteSendTransaction({ to, amount });
        }
        case "getMaxSpendable": {
          const index = params.index ?? 0;
          const account = params.address ? manager.getReadOnlyAccount(params.address, index) : manager.getAccount(index);
          return account.getMaxSpendable();
        }
        case "getFeeRates": {
          const account = manager.getAccount(0);
          return account.getFeeRates();
        }
        case "getReceipt": {
          const txHash = params.txHash;
          if (!txHash) throw new StateError('Missing "txHash" parameter');
          const account = manager.getAccount(0);
          return account.getTransactionReceipt(txHash);
        }
        // ── Signing ────────────────────────────────────────────────────────
        case "send": {
          const sendIndex = params.index ?? 0;
          const sendAddressType = params.addressType;
          const account = manager.getAccount(sendIndex, sendAddressType);
          const to = params.to;
          if (!to) throw new StateError('Missing "to" parameter');
          const amount = params.amount;
          if (!amount) throw new StateError('Missing "amount" parameter');
          const result = await account.sendTransaction({
            to,
            amount,
            feeRate: params.feeRate
          });
          this.events.emit(WDKEvents.TX_SENT, { chain: chainId, txHash: result.txHash });
          return result;
        }
        case "signMessage": {
          const message = params.message;
          if (!message && message !== "") throw new StateError('Missing "message" parameter');
          const signIndex = params.index ?? 0;
          const signAddrType = params.addressType;
          const account = manager.getAccount(signIndex, signAddrType);
          return account.sign(message);
        }
        case "verifyMessage": {
          const message = params.message;
          const signature = params.signature;
          const address = params.address;
          if (!message && message !== "") throw new StateError('Missing "message" parameter');
          if (!signature) throw new StateError('Missing "signature" parameter');
          if (!address) throw new StateError('Missing "address" parameter');
          const account = manager.getReadOnlyAccount(address);
          return account.verifyMessage(message, signature);
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

  // src/wallet-manager.ts
  var WalletManager = class {
    constructor(chainId, coinType, curve) {
      this.config = null;
      this.keyManager = null;
      /** Cached accounts by derivation path */
      this.accounts = /* @__PURE__ */ new Map();
      this.chainId = chainId;
      this.coinType = coinType;
      this.curve = curve;
    }
    /** Injected by WDKEngine during registerChain() */
    setKeyManager(km) {
      this.keyManager = km;
    }
    /**
     * Return the BIP derivation path for a given address index.
     * Default: BIP-44 m/44'/coinType'/0'/0/index
     * Override in chain modules (e.g. BTC uses BIP-84 for P2WPKH).
     */
    getDerivationPath(index, _addressType) {
      return `m/44'/${this.coinType}'/0'/0/${index}`;
    }
    // ── Account lifecycle ──────────────────────────────────────────────────
    /**
     * Get or create an account at the given index.
     * Cached by derivation path — same index returns same account.
     */
    getAccount(index = 0, addressType) {
      const path = this.getDerivationPath(index, addressType);
      return this.getAccountByPath(path, index, addressType);
    }
    /**
     * Get or create an account by explicit derivation path.
     * Production equivalent: WalletManagerBtc.getAccountByPath(path)
     */
    getAccountByPath(path, index, addressType) {
      const cached = this.accounts.get(path);
      if (cached && !cached.isDisposed) {
        return cached;
      }
      if (!this.keyManager) {
        throw new Error("KeyManager not set \u2014 call setKeyManager() before getAccount()");
      }
      const keyHandle = this.keyManager.deriveAndTrack(path);
      const publicKey = native.crypto.getPublicKey(keyHandle, this.curve);
      const idx = index ?? parseInt(path.split("/").pop() ?? "0", 10);
      const account = this.createAccount(keyHandle, publicKey, idx, path, addressType);
      this.accounts.set(path, account);
      return account;
    }
    /** Get all currently cached (non-disposed) accounts */
    getCachedAccounts() {
      return Array.from(this.accounts.values()).filter((a) => !a.isDisposed);
    }
    /**
     * Create a read-only account for an address (no signing capabilities).
     * Does not require a key handle — just the address.
     */
    getReadOnlyAccount(address, index = 0) {
      return this.createReadOnlyAccount(address, index);
    }
    /** Clear all cached accounts (e.g. when network changes) */
    clearAccounts() {
      for (const [, account] of this.accounts) {
        account.dispose();
        if (this.keyManager) {
          this.keyManager.release(account.keyHandle);
        }
      }
      this.accounts.clear();
    }
    // ── Disposal ───────────────────────────────────────────────────────────
    /** Dispose a single account by index */
    disposeAccount(index = 0, addressType) {
      const path = this.getDerivationPath(index, addressType);
      const account = this.accounts.get(path);
      if (account) {
        account.dispose();
        if (this.keyManager) {
          this.keyManager.release(account.keyHandle);
        }
        this.accounts.delete(path);
      }
    }
    /** Dispose all accounts and clean up manager resources */
    destroy() {
      for (const [path, account] of this.accounts) {
        account.dispose();
        if (this.keyManager) {
          this.keyManager.release(account.keyHandle);
        }
      }
      this.accounts.clear();
      this.config = null;
    }
  };

  // src/wallet-account.ts
  var WalletAccountReadOnly = class {
    constructor(chainId, address, index, path) {
      this.chainId = chainId;
      this.address = address;
      this.index = index;
      this.path = path;
    }
    /** Serialize to a plain object for dispatch return */
    toInfo() {
      return {
        chainId: this.chainId,
        address: this.address,
        index: this.index,
        path: this.path
      };
    }
  };
  var WalletAccount = class extends WalletAccountReadOnly {
    constructor(chainId, address, index, path, keyHandle, publicKey) {
      super(chainId, address, index, path);
      this._disposed = false;
      this.keyHandle = keyHandle;
      this.publicKey = publicKey;
    }
    /**
     * Production-compatible keyPair property.
     * publicKey is the compressed secp256k1 key (33 bytes).
     * privateKey is ALWAYS null — key material stays in C key store.
     */
    get keyPair() {
      return { publicKey: this.publicKey, privateKey: null };
    }
    /** Check if this account has been disposed */
    get isDisposed() {
      return this._disposed;
    }
    /**
     * Mark this account as disposed.
     * The key handle release is managed by WalletManager (which owns KeyManager).
     */
    dispose() {
      this._disposed = true;
    }
    /** Serialize to a plain object including publicKey */
    toInfo() {
      return {
        ...super.toInfo(),
        publicKey: native.encoding.hexEncode(this.publicKey)
      };
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
  function selectUtxos(utxos, targetAmount, feeRate, dustThreshold = DUST_THRESHOLD_P2WPKH, destinationAddr) {
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const candidates = sorted.slice(0, MAX_UTXO_INPUTS);
    const destOutputVbytes = estimateOutputVbytes(destinationAddr);
    const changeOutputVbytes = VBYTES_PER_OUTPUT_DEFAULT;
    const changeCost = Math.ceil(changeOutputVbytes * feeRate);
    const avoidResult = avoidChange(candidates, targetAmount, feeRate, destOutputVbytes, changeCost);
    if (avoidResult) return avoidResult;
    return addUntilReach(candidates, targetAmount, feeRate, dustThreshold, destOutputVbytes, changeOutputVbytes);
  }
  function avoidChange(sorted, targetAmount, feeRate, destOutputVbytes, changeCost) {
    const selected = [];
    let totalInput = 0;
    for (const utxo of sorted) {
      selected.push(utxo);
      totalInput += utxo.value;
      const vbytes = TX_OVERHEAD_VBYTES + selected.length * VBYTES_PER_INPUT + destOutputVbytes;
      let fee = Math.ceil(vbytes * feeRate);
      if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;
      if (totalInput >= targetAmount + fee) {
        const remainder = totalInput - targetAmount - fee;
        if (remainder < changeCost) {
          return { selected: [...selected], fee: fee + remainder, change: 0 };
        }
      }
    }
    return null;
  }
  function addUntilReach(sorted, targetAmount, feeRate, dustThreshold, destOutputVbytes, changeOutputVbytes) {
    const selected = [];
    let totalInput = 0;
    for (const utxo of sorted) {
      selected.push(utxo);
      totalInput += utxo.value;
      const vbytes = TX_OVERHEAD_VBYTES + selected.length * VBYTES_PER_INPUT + destOutputVbytes + changeOutputVbytes;
      let fee = Math.ceil(vbytes * feeRate);
      if (fee < MIN_TX_FEE_SATS) fee = MIN_TX_FEE_SATS;
      if (totalInput >= targetAmount + fee) {
        const change = totalInput - targetAmount - fee;
        if (change > 0 && change < dustThreshold) {
          return { selected: [...selected], fee: totalInput - targetAmount, change: 0 };
        }
        return { selected: [...selected], fee, change };
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
  function addNonWitnessUtxo(psbt, inputIndex, rawTx) {
    psbt.inputs[inputIndex].nonWitnessUtxo = rawTx;
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
        if (inputs[i].prevTxHex) {
          addNonWitnessUtxo(psbt, i, native.encoding.hexDecode(inputs[i].prevTxHex));
        } else {
          addWitnessUtxo(psbt, i, inputs[i].value, spk);
        }
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
    async getBlockHeight() {
      const data = await this.fetchJson(
        "/api/v2"
      );
      return data.blockbook?.bestHeight ?? 0;
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
      const response = await this.limiter.run(() => native.net.fetch(`${this.baseUrl}${path}`));
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
      const hex = await this.fetchText(`/tx/${txHash}/hex`);
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
      try {
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
      } catch {
        return 1 * 1e3 / 1e8;
      }
    }
    async getBlockHeight() {
      const text = await this.fetchText("/blocks/tip/height");
      return parseInt(text, 10) || 0;
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    async fetchJson(path) {
      const response = await this.limiter.run(() => native.net.fetch(`${this.baseUrl}${path}`));
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
      const response = await this.limiter.run(() => native.net.fetch(`${this.baseUrl}${path}`));
      if (response.status !== 200) {
        const body = response.body ? native.encoding.utf8Decode(response.body) : "";
        throw new Error(
          `Mempool API error: status ${response.status} for ${path}: ${body}`
        );
      }
      return response.body ? native.encoding.utf8Decode(response.body) : "";
    }
  };

  // ../wdk-v2-wallet-btc/src/client/electrum-types.ts
  var ELECTRUM_WS_URLS = {
    bitcoin: "wss://blockstream.info/electrum-websocket",
    testnet: "wss://blockstream.info/testnet/electrum-websocket",
    regtest: ""
    // requires user-provided URL
  };
  var ELECTRUM_CLIENT_NAME = "wdk-v2";
  var ELECTRUM_PROTOCOL_VERSION = "1.4";
  var ELECTRUM_PING_INTERVAL = 55e3;
  var ELECTRUM_REQUEST_TIMEOUT = 15e3;

  // ../wdk-v2-wallet-btc/src/client/electrum-transport.ts
  var ElectrumTransport = class {
    constructor() {
      this.wsHandle = null;
      this.requestId = 0;
      this.pending = /* @__PURE__ */ new Map();
      this.subscriptions = /* @__PURE__ */ new Map();
      this.pingTimer = null;
      this.url = "";
      this.connected = false;
      this.reconnecting = false;
      this.reconnectAttempt = 0;
      this.maxReconnectDelay = 3e4;
      this.onCloseCallback = null;
    }
    /**
     * Connect to an Electrum WebSocket server.
     * Performs the server.version handshake.
     */
    async connect(url) {
      this.url = url;
      this.wsHandle = native.net.wsConnect(url);
      native.net.wsOnMessage(this.wsHandle, (data) => {
        this.handleMessage(data);
      });
      native.net.wsOnClose(this.wsHandle, (error) => {
        this.connected = false;
        this.rejectAllPending(error ?? "Connection closed");
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        if (this.onCloseCallback) this.onCloseCallback();
        if (this.wsHandle !== null && !this.reconnecting) {
          this.scheduleReconnect();
        }
      });
      this.connected = true;
      this.reconnectAttempt = 0;
      const result = await this.request("server.version", [
        ELECTRUM_CLIENT_NAME,
        ELECTRUM_PROTOCOL_VERSION
      ]);
      this.pingTimer = setInterval(() => {
        if (this.connected) {
          this.request("server.ping", []).catch(() => {
          });
        }
      }, ELECTRUM_PING_INTERVAL);
      return {
        serverVersion: result[0] ?? "unknown",
        protocolVersion: result[1] ?? "1.4"
      };
    }
    /**
     * Send a JSON-RPC request and wait for the response.
     */
    async request(method, params) {
      if (!this.connected || this.wsHandle === null) {
        throw new Error("Electrum transport not connected");
      }
      const id = ++this.requestId;
      const rpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Electrum request timeout: ${method} (${ELECTRUM_REQUEST_TIMEOUT}ms)`));
        }, ELECTRUM_REQUEST_TIMEOUT);
        this.pending.set(id, { resolve, reject, timer });
        native.net.wsSend(this.wsHandle, JSON.stringify(rpcRequest));
      });
    }
    /**
     * Send a batch of JSON-RPC requests.
     */
    async batch(calls) {
      if (!this.connected || this.wsHandle === null) {
        throw new Error("Electrum transport not connected");
      }
      const requests = [];
      const ids = [];
      for (const call of calls) {
        const id = ++this.requestId;
        ids.push(id);
        requests.push({
          jsonrpc: "2.0",
          id,
          method: call.method,
          params: call.params
        });
      }
      const promises = ids.map((id) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Electrum batch request timeout (${ELECTRUM_REQUEST_TIMEOUT}ms)`));
          }, ELECTRUM_REQUEST_TIMEOUT);
          this.pending.set(id, { resolve, reject, timer });
        });
      });
      native.net.wsSend(this.wsHandle, JSON.stringify(requests));
      return Promise.all(promises);
    }
    /**
     * Register a subscription notification handler.
     * When the server pushes a notification for this method, the callback is invoked.
     */
    onNotification(method, callback) {
      this.subscriptions.set(method, callback);
    }
    /**
     * Remove a subscription handler.
     */
    removeNotification(method) {
      this.subscriptions.delete(method);
    }
    /**
     * Set a callback for when the connection closes.
     */
    onClose(callback) {
      this.onCloseCallback = callback;
    }
    /**
     * Close the connection. Prevents auto-reconnect.
     */
    close() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.connected = false;
      this.rejectAllPending("Connection closed by client");
      if (this.wsHandle !== null) {
        const handle = this.wsHandle;
        this.wsHandle = null;
        native.net.wsClose(handle);
      }
      this.subscriptions.clear();
    }
    /** Is the transport currently connected? */
    get isConnected() {
      return this.connected;
    }
    // ── Internal ───────────────────────────────────────────────────────────
    handleMessage(data) {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          this.dispatchResponse(item);
        }
        return;
      }
      if ("id" in parsed && typeof parsed.id === "number") {
        this.dispatchResponse(parsed);
      } else if ("method" in parsed) {
        this.dispatchNotification(parsed);
      }
    }
    dispatchResponse(response) {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        const errMsg = typeof response.error === "string" ? response.error : response.error.message;
        pending.reject(new Error(`Electrum error: ${errMsg}`));
      } else {
        pending.resolve(response.result);
      }
    }
    dispatchNotification(notification) {
      const handler = this.subscriptions.get(notification.method);
      if (handler) {
        handler(notification.params);
      }
    }
    rejectAllPending(reason) {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
    }
    scheduleReconnect() {
      if (this.wsHandle === null) return;
      this.reconnecting = true;
      const delay = Math.min(
        1e3 * Math.pow(2, this.reconnectAttempt),
        this.maxReconnectDelay
      );
      this.reconnectAttempt++;
      setTimeout(async () => {
        this.reconnecting = false;
        try {
          await this.connect(this.url);
          for (const [method] of this.subscriptions) {
            const handler = this.subscriptions.get("_reconnect");
            if (handler) handler([]);
          }
        } catch {
        }
      }, delay);
    }
  };

  // ../wdk-v2-wallet-btc/src/client/electrum-ws-client.ts
  var ElectrumWsClient = class {
    constructor(network = "bitcoin", customUrl) {
      this.txCache = new LRUCache(100);
      this.limiter = new ConcurrencyLimiter(8);
      this.activeSubscriptions = /* @__PURE__ */ new Map();
      this.network = network;
      this.url = customUrl ?? ELECTRUM_WS_URLS[network];
      if (!this.url) {
        throw new Error(
          `ElectrumWsClient: no default URL for ${network}. Provide a custom URL.`
        );
      }
      this.transport = new ElectrumTransport();
    }
    // ── Connection lifecycle ────────────────────────────────────────────────
    async connect() {
      const info = await this.transport.connect(this.url);
      this.transport.onNotification(
        "blockchain.scripthash.subscribe",
        (params) => {
          const [scripthash, status] = params;
          const handler = this.activeSubscriptions.get(scripthash);
          if (handler) handler(status);
        }
      );
      this.transport.onNotification("_reconnect", async () => {
        for (const [scripthash] of this.activeSubscriptions) {
          try {
            await this.transport.request("blockchain.scripthash.subscribe", [scripthash]);
          } catch {
          }
        }
      });
    }
    async close() {
      this.transport.close();
      this.txCache.clear();
      this.activeSubscriptions.clear();
    }
    async reconnect() {
      this.transport.close();
      await this.connect();
    }
    // ── Scripthash computation ──────────────────────────────────────────────
    /**
     * Convert a Bitcoin address to Electrum scripthash.
     * scripthash = reverse(SHA256(scriptPubKey))
     */
    addressToScripthash(address) {
      const spk = addressToScriptPubKey(address);
      const hash = native.crypto.sha256(spk);
      const reversed = new Uint8Array(hash.length);
      for (let i = 0; i < hash.length; i++) {
        reversed[i] = hash[hash.length - 1 - i];
      }
      return native.encoding.hexEncode(reversed);
    }
    // ── IBtcClient methods ──────────────────────────────────────────────────
    async getBalance(address) {
      const scripthash = this.addressToScripthash(address);
      const result = await this.limiter.run(
        () => this.transport.request("blockchain.scripthash.get_balance", [scripthash])
      );
      return {
        confirmed: result.confirmed,
        unconfirmed: result.unconfirmed
      };
    }
    async listUnspent(address) {
      const scripthash = this.addressToScripthash(address);
      const result = await this.limiter.run(
        () => this.transport.request("blockchain.scripthash.listunspent", [scripthash])
      );
      return result.map((u) => ({
        tx_hash: u.tx_hash,
        tx_pos: u.tx_pos,
        value: u.value,
        height: u.height
      }));
    }
    async getHistory(address) {
      const scripthash = this.addressToScripthash(address);
      const result = await this.limiter.run(
        () => this.transport.request("blockchain.scripthash.get_history", [scripthash])
      );
      return result.map((h) => ({
        tx_hash: h.tx_hash,
        height: h.height
      }));
    }
    async getDetailedHistory(address, limit = 25, _afterTxId, _page) {
      const history = await this.getHistory(address);
      const entries = history.slice(0, limit);
      const batchCalls = entries.map((h) => ({
        method: "blockchain.transaction.get",
        params: [h.tx_hash, true]
        // verbose=true
      }));
      const txDetails = await this.transport.batch(batchCalls);
      return txDetails.map((tx) => {
        const inputAddresses = /* @__PURE__ */ new Set();
        let totalIn = 0;
        for (const vin of tx.vin) {
          if (vin.prevout?.scriptpubkey_address) {
            inputAddresses.add(vin.prevout.scriptpubkey_address);
            totalIn += vin.prevout.value;
          }
        }
        const outputAddresses = /* @__PURE__ */ new Set();
        let totalOut = 0;
        let myOut = 0;
        for (const vout of tx.vout) {
          if (vout.scriptpubkey_address) {
            outputAddresses.add(vout.scriptpubkey_address);
            totalOut += vout.value;
            if (vout.scriptpubkey_address === address) myOut += vout.value;
          }
        }
        const isSender = inputAddresses.has(address);
        const isReceiver = outputAddresses.has(address);
        const direction = isSender && isReceiver ? "self" : isSender ? "sent" : "received";
        let amount = 0;
        if (direction === "received") {
          amount = myOut;
        } else if (direction === "sent") {
          amount = totalIn - myOut - (tx.fee ?? 0);
        }
        const counterparties = [];
        if (direction === "sent") {
          outputAddresses.forEach((a) => {
            if (a !== address) counterparties.push(a);
          });
        } else if (direction === "received") {
          inputAddresses.forEach((a) => {
            if (a !== address) counterparties.push(a);
          });
        }
        const confirmed = (tx.confirmations ?? 0) > 0;
        const height = entries.find((h) => h.tx_hash === tx.txid)?.height ?? 0;
        return {
          txHash: tx.txid,
          direction,
          amount,
          fee: tx.fee ?? 0,
          timestamp: tx.blocktime ?? 0,
          blockHeight: height > 0 ? height : 0,
          confirmed,
          counterparties: [...new Set(counterparties)]
        };
      });
    }
    async getTransaction(txHash) {
      const cached = this.txCache.get(txHash);
      if (cached !== void 0) return cached;
      const hex = await this.limiter.run(
        () => this.transport.request("blockchain.transaction.get", [txHash, false])
      );
      this.txCache.set(txHash, hex);
      return hex;
    }
    async estimateFee(blocks) {
      const result = await this.limiter.run(
        () => this.transport.request("blockchain.estimatefee", [blocks])
      );
      if (result < 0) return 1e-5;
      return result;
    }
    async broadcast(rawTx) {
      const txid = await this.transport.request(
        "blockchain.transaction.broadcast",
        [rawTx]
      );
      return txid;
    }
    async getTxStatus(txHash) {
      const tx = await this.limiter.run(
        () => this.transport.request("blockchain.transaction.get", [txHash, true])
      );
      const height = await this.getBlockHeightForTx(txHash);
      return {
        txHash: tx.txid,
        confirmed: (tx.confirmations ?? 0) > 0,
        blockHeight: height,
        blockTime: tx.blocktime ?? 0,
        fee: tx.fee ?? 0
      };
    }
    async getBlockHeight() {
      try {
        const result = await this.limiter.run(
          () => this.transport.request("blockchain.headers.subscribe", [])
        );
        return result.height ?? 0;
      } catch {
        return 0;
      }
    }
    // ── Subscription support ────────────────────────────────────────────────
    /**
     * Subscribe to address balance changes.
     * The callback fires when the address's transaction history changes.
     */
    async subscribeAddress(address, callback) {
      const scripthash = this.addressToScripthash(address);
      this.activeSubscriptions.set(scripthash, callback);
      const status = await this.transport.request(
        "blockchain.scripthash.subscribe",
        [scripthash]
      );
      return status;
    }
    /**
     * Unsubscribe from address balance changes.
     */
    unsubscribeAddress(address) {
      const scripthash = this.addressToScripthash(address);
      this.activeSubscriptions.delete(scripthash);
    }
    // ── Helpers ─────────────────────────────────────────────────────────────
    async getBlockHeightForTx(txHash) {
      try {
        const tx = await this.limiter.run(
          () => this.transport.request("blockchain.transaction.get", [txHash, true])
        );
        return tx.blockheight ?? tx.block_height ?? 0;
      } catch {
        return 0;
      }
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
      // Electrum WebSocket — production-compatible transport
      case "electrum-ws":
        return new ElectrumWsClient(net, desc.url);
      // Electrum TCP — not yet supported (requires native TCP bridge)
      case "electrum":
        throw new Error(
          `BTC client type "electrum" (TCP) is not yet implemented in v2. Use "electrum-ws" for WebSocket or "blockbook-http"/"mempool-rest" for HTTP.`
        );
      default:
        throw new Error(`Unknown BTC client type: ${desc.type}`);
    }
  }

  // ../wdk-v2-wallet-btc/src/btc-helpers.ts
  function bitcoinMessageHash(message) {
    const prefix = new Uint8Array([
      24,
      66,
      105,
      116,
      99,
      111,
      105,
      110,
      32,
      83,
      105,
      103,
      110,
      101,
      100,
      32,
      77,
      101,
      115,
      115,
      97,
      103,
      101,
      58,
      10
    ]);
    const msgBytes = native.encoding.utf8Encode(message);
    const varint = encodeVarint(msgBytes.length);
    const payload = new Uint8Array(prefix.length + varint.length + msgBytes.length);
    payload.set(prefix, 0);
    payload.set(varint, prefix.length);
    payload.set(msgBytes, prefix.length + varint.length);
    return native.crypto.sha256(native.crypto.sha256(payload));
  }
  function encodeVarint(n) {
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
  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function uint8ArrayToBase64(data) {
    let result = "";
    for (let i = 0; i < data.length; i += 3) {
      const a = data[i];
      const b = i + 1 < data.length ? data[i + 1] : 0;
      const c = i + 2 < data.length ? data[i + 2] : 0;
      result += B64_CHARS[a >> 2 & 63];
      result += B64_CHARS[(a << 4 | b >> 4) & 63];
      result += i + 1 < data.length ? B64_CHARS[(b << 2 | c >> 6) & 63] : "=";
      result += i + 2 < data.length ? B64_CHARS[c & 63] : "=";
    }
    return result;
  }
  function base64ToUint8Array(base64) {
    const lookup = /* @__PURE__ */ new Map();
    for (let i = 0; i < B64_CHARS.length; i++) lookup.set(B64_CHARS[i], i);
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
  function btcPerKbToSatVb(btcPerKb) {
    return Math.ceil(btcPerKb * 1e8 / 1e3);
  }

  // ../wdk-v2-wallet-btc/src/btc-account-read-only.ts
  var BtcAccountReadOnly = class extends WalletAccountReadOnly {
    constructor(manager, address, index, path) {
      super("btc", address, index, path);
      this.manager = manager;
    }
    /** Convenience: get the shared client */
    get client() {
      return this.manager.getClient();
    }
    get network() {
      return this.manager.getNetwork();
    }
    get isTestnet() {
      return this.manager.isTestnetNetwork();
    }
    // ── Balance ────────────────────────────────────────────────────────────
    async getBalance() {
      const balance = await this.client.getBalance(this.address);
      return String(balance.confirmed + balance.unconfirmed);
    }
    // ── Fee rates ──────────────────────────────────────────────────────────
    async getFeeRates() {
      const [fast, medium, slow] = await Promise.all([
        this.client.estimateFee(1),
        this.client.estimateFee(3),
        this.client.estimateFee(6)
      ]);
      return {
        fast: btcPerKbToSatVb(fast),
        medium: btcPerKbToSatVb(medium),
        slow: btcPerKbToSatVb(slow),
        normal: btcPerKbToSatVb(medium)
      };
    }
    // ── Quote + Max Spendable ──────────────────────────────────────────────
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
          changeValue: 0,
          error: `Invalid amount: ${params.amount}`
        };
      }
      try {
        const utxos = await this.fetchUtxos();
        const btcPerKb = await this.client.estimateFee(3);
        const feeRate = btcPerKbToSatVb(btcPerKb);
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
            changeValue: 0,
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
          changeValue: 0,
          error: e.message ?? String(e)
        };
      }
    }
    async getMaxSpendable() {
      const utxos = await this.fetchUtxos();
      const btcPerKb = await this.client.estimateFee(3);
      const feeRate = btcPerKbToSatVb(btcPerKb);
      const maxSpendable = calculateMaxSpendable(utxos, feeRate, DUST_THRESHOLD_P2WPKH);
      const totalInput = utxos.reduce((s, u) => s + u.value, 0);
      return {
        maxSpendable,
        amount: maxSpendable,
        fee: totalInput - maxSpendable,
        changeValue: 0,
        utxoCount: utxos.length
      };
    }
    // ── History + Transfers ────────────────────────────────────────────────
    async getTransactionHistory(limit = 25) {
      const result = await this.getTransfers({ limit });
      return result.transfers.map((tx) => ({
        txHash: tx.txHash,
        chain: "btc",
        from: tx.direction === "received" ? tx.counterparties[0] ?? "" : this.address,
        to: tx.direction === "sent" ? tx.counterparties[0] ?? "" : this.address,
        amount: String(Math.abs(tx.amount)),
        fee: String(tx.fee),
        direction: tx.direction,
        counterparties: tx.counterparties,
        timestamp: tx.timestamp,
        status: tx.confirmed ? "confirmed" : "pending",
        blockNumber: tx.blockHeight > 0 ? tx.blockHeight : void 0
      }));
    }
    async getTransfers(query) {
      const q = query;
      const limit = q?.limit ?? 25;
      const detailed = await this.client.getDetailedHistory(
        this.address,
        limit,
        q?.afterTxId,
        q?.page
      );
      let filtered = detailed;
      if (q?.direction && q.direction !== "all") {
        filtered = detailed.filter((tx) => tx.direction === q.direction);
      }
      const transfers = [];
      for (const tx of filtered) {
        const uniqueCounterparties = [...new Set(tx.counterparties)];
        if (uniqueCounterparties.length <= 1) {
          transfers.push({ ...tx, counterparties: uniqueCounterparties });
        } else {
          for (const cp of uniqueCounterparties) {
            transfers.push({ ...tx, counterparties: [cp] });
          }
        }
      }
      const hasMore = detailed.length >= limit;
      const nextCursor = detailed.length > 0 ? detailed[detailed.length - 1].txHash : void 0;
      return { transfers, hasMore, nextCursor };
    }
    // ── Receipt ────────────────────────────────────────────────────────────
    async getTransactionReceipt(txHash) {
      try {
        const status = await this.client.getTxStatus(txHash);
        let confirmations = 0;
        if (status.confirmed && status.blockHeight > 0) {
          try {
            const tipHeight = await this.client.getBlockHeight();
            confirmations = tipHeight > 0 ? tipHeight - status.blockHeight + 1 : 1;
          } catch {
            confirmations = 1;
          }
        }
        let rawTx;
        try {
          rawTx = await this.client.getTransaction(txHash);
        } catch {
        }
        return { ...status, confirmations, rawTx };
      } catch {
        return null;
      }
    }
    // ── Verify ─────────────────────────────────────────────────────────────
    async verifyMessage(message, signature) {
      const sigBytes = base64ToUint8Array(signature);
      if (sigBytes.length !== 65) return false;
      const flagByte = sigBytes[0];
      const recid = flagByte - 27 & 3;
      const compressed = (flagByte - 27 & 4) !== 0;
      if (!compressed) return false;
      const recoverableSig = new Uint8Array(65);
      recoverableSig.set(sigBytes.slice(1, 65), 0);
      recoverableSig[64] = recid;
      const msgHash = bitcoinMessageHash(message);
      let recoveredPubkey;
      try {
        recoveredPubkey = native.crypto.recoverSecp256k1(msgHash, recoverableSig);
      } catch {
        return false;
      }
      const sha = native.crypto.sha256(recoveredPubkey);
      const hash160 = native.crypto.ripemd160(sha);
      const data5 = convertBits(hash160, 8, 5, true);
      if (data5) {
        const hrp = this.network === "regtest" ? "bcrt" : this.isTestnet ? "tb" : "bc";
        const witnessData = new Uint8Array(1 + data5.length);
        witnessData[0] = 0;
        witnessData.set(data5, 1);
        const segwitAddr = native.encoding.bech32Encode(hrp, witnessData);
        if (segwitAddr === this.address) return true;
      }
      const version = this.isTestnet ? 111 : 0;
      const payload = new Uint8Array(21);
      payload[0] = version;
      payload.set(hash160, 1);
      try {
        const legacyAddr = native.encoding.base58CheckEncode(payload);
        if (legacyAddr === this.address) return true;
      } catch {
      }
      return false;
    }
    // ── Helpers ────────────────────────────────────────────────────────────
    async fetchUtxos() {
      const electrumUtxos = await this.client.listUnspent(this.address);
      const senderScriptPubKey = native.encoding.hexEncode(
        addressToScriptPubKey(this.address)
      );
      return electrumUtxos.map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: u.value,
        scriptPubKey: senderScriptPubKey,
        address: this.address
      }));
    }
  };

  // ../wdk-v2-wallet-btc/src/btc-account.ts
  var BtcAccount = class extends WalletAccount {
    constructor(manager, keyHandle, publicKey, address, index, path, addressType = "p2wpkh") {
      super("btc", address, index, path, keyHandle, publicKey);
      this.manager = manager;
      this.addressType = addressType;
    }
    get client() {
      return this.manager.getClient();
    }
    get network() {
      return this.manager.getNetwork();
    }
    get isTestnet() {
      return this.manager.isTestnetNetwork();
    }
    // ── Read-only operations (delegate to shared client) ────────────────────
    async getBalance() {
      const balance = await this.client.getBalance(this.address);
      return String(balance.confirmed + balance.unconfirmed);
    }
    async getFeeRates() {
      const [fast, medium, slow] = await Promise.all([
        this.client.estimateFee(1),
        this.client.estimateFee(3),
        this.client.estimateFee(6)
      ]);
      return {
        fast: btcPerKbToSatVb(fast),
        medium: btcPerKbToSatVb(medium),
        slow: btcPerKbToSatVb(slow),
        normal: btcPerKbToSatVb(medium)
      };
    }
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
          changeValue: 0,
          error: `Invalid amount: ${params.amount}`
        };
      }
      try {
        const utxos = await this.fetchUtxos();
        const btcPerKb = await this.client.estimateFee(3);
        const feeRate = btcPerKbToSatVb(btcPerKb);
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
            changeValue: 0,
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
          changeValue: 0,
          error: e.message ?? String(e)
        };
      }
    }
    async getMaxSpendable() {
      const utxos = await this.fetchUtxos();
      const btcPerKb = await this.client.estimateFee(3);
      const feeRate = btcPerKbToSatVb(btcPerKb);
      const maxSpendable = calculateMaxSpendable(utxos, feeRate, DUST_THRESHOLD_P2WPKH);
      const totalInput = utxos.reduce((s, u) => s + u.value, 0);
      return {
        maxSpendable,
        amount: maxSpendable,
        fee: totalInput - maxSpendable,
        changeValue: 0,
        utxoCount: utxos.length
      };
    }
    async getTransactionHistory(limit = 25) {
      const result = await this.getTransfers({ limit });
      return result.transfers.map((tx) => ({
        txHash: tx.txHash,
        chain: "btc",
        from: tx.direction === "received" ? tx.counterparties[0] ?? "" : this.address,
        to: tx.direction === "sent" ? tx.counterparties[0] ?? "" : this.address,
        amount: String(Math.abs(tx.amount)),
        fee: String(tx.fee),
        direction: tx.direction,
        counterparties: tx.counterparties,
        timestamp: tx.timestamp,
        status: tx.confirmed ? "confirmed" : "pending",
        blockNumber: tx.blockHeight > 0 ? tx.blockHeight : void 0
      }));
    }
    async getTransfers(query) {
      const q = query;
      const limit = q?.limit ?? 25;
      const detailed = await this.client.getDetailedHistory(
        this.address,
        limit,
        q?.afterTxId,
        q?.page
      );
      let filtered = detailed;
      if (q?.direction && q.direction !== "all") {
        filtered = detailed.filter((tx) => tx.direction === q.direction);
      }
      const transfers = [];
      for (const tx of filtered) {
        const uniqueCounterparties = [...new Set(tx.counterparties)];
        if (uniqueCounterparties.length <= 1) {
          transfers.push({ ...tx, counterparties: uniqueCounterparties });
        } else {
          for (const cp of uniqueCounterparties) {
            transfers.push({ ...tx, counterparties: [cp] });
          }
        }
      }
      const hasMore = detailed.length >= limit;
      const nextCursor = detailed.length > 0 ? detailed[detailed.length - 1].txHash : void 0;
      return { transfers, hasMore, nextCursor };
    }
    async getTransactionReceipt(txHash) {
      try {
        const status = await this.client.getTxStatus(txHash);
        let confirmations = 0;
        if (status.confirmed && status.blockHeight > 0) {
          try {
            const tipHeight = await this.client.getBlockHeight();
            confirmations = tipHeight > 0 ? tipHeight - status.blockHeight + 1 : 1;
          } catch {
            confirmations = 1;
          }
        }
        let rawTx;
        try {
          rawTx = await this.client.getTransaction(txHash);
        } catch {
        }
        return { ...status, confirmations, rawTx };
      } catch {
        return null;
      }
    }
    async verifyMessage(message, signature) {
      const sigBytes = base64ToUint8Array(signature);
      if (sigBytes.length !== 65) return false;
      const flagByte = sigBytes[0];
      const recid = flagByte - 27 & 3;
      const compressed = (flagByte - 27 & 4) !== 0;
      if (!compressed) return false;
      const recoverableSig = new Uint8Array(65);
      recoverableSig.set(sigBytes.slice(1, 65), 0);
      recoverableSig[64] = recid;
      const msgHash = bitcoinMessageHash(message);
      let recoveredPubkey;
      try {
        recoveredPubkey = native.crypto.recoverSecp256k1(msgHash, recoverableSig);
      } catch {
        return false;
      }
      const sha = native.crypto.sha256(recoveredPubkey);
      const hash160 = native.crypto.ripemd160(sha);
      const data5 = convertBits(hash160, 8, 5, true);
      if (data5) {
        const hrp = this.network === "regtest" ? "bcrt" : this.isTestnet ? "tb" : "bc";
        const witnessData = new Uint8Array(1 + data5.length);
        witnessData[0] = 0;
        witnessData.set(data5, 1);
        if (native.encoding.bech32Encode(hrp, witnessData) === this.address) return true;
      }
      const version = this.isTestnet ? 111 : 0;
      const payload = new Uint8Array(21);
      payload[0] = version;
      payload.set(hash160, 1);
      try {
        if (native.encoding.base58CheckEncode(payload) === this.address) return true;
      } catch {
      }
      return false;
    }
    // ── Signing operations ─────────────────────────────────────────────────
    async sendTransaction(params) {
      const targetSats = parseInt(params.amount, 10);
      if (isNaN(targetSats) || targetSats <= 0) {
        throw new Error(`Invalid amount: ${params.amount}`);
      }
      const utxos = await this.fetchUtxos();
      if (utxos.length === 0) throw new Error("No UTXOs available");
      let feeRate = params.feeRate;
      if (!feeRate) {
        const btcPerKb = await this.client.estimateFee(3);
        feeRate = btcPerKbToSatVb(btcPerKb);
      }
      const selection = selectUtxos(utxos, targetSats, feeRate, DUST_THRESHOLD_P2WPKH, params.to);
      if (!selection) throw new Error("Insufficient funds");
      const spkBytes = native.encoding.hexDecode(utxos[0].scriptPubKey);
      const isLegacy = spkBytes.length === 25 && spkBytes[0] === 118;
      const inputs = await Promise.all(
        selection.selected.map(async (u) => {
          const input = {
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            scriptPubKey: u.scriptPubKey,
            address: this.address
          };
          if (isLegacy) {
            try {
              input.prevTxHex = await this.client.getTransaction(u.txid);
            } catch {
            }
          }
          return input;
        })
      );
      const outputs = [
        { address: params.to, value: targetSats }
      ];
      if (selection.change > 0) {
        outputs.push({ address: this.address, value: selection.change });
      }
      const keyHandles = inputs.map(() => this.keyHandle);
      const psbtInputs = inputs.map((inp) => ({
        txid: inp.txid,
        vout: inp.vout,
        value: inp.value,
        scriptPubKey: inp.scriptPubKey,
        prevTxHex: inp.prevTxHex
      }));
      const psbtOutputs = outputs.map((out) => ({
        address: out.address,
        value: out.value
      }));
      const { rawTx, txid } = buildAndSignPsbt(psbtInputs, psbtOutputs, keyHandles);
      const rawBytes = native.encoding.hexDecode(rawTx);
      const actualWeight = rawBytes.length * 4;
      const actualVsize = Math.ceil(actualWeight / 4);
      const minRequiredFee = Math.ceil(actualVsize * feeRate);
      if (selection.fee < minRequiredFee) {
      }
      const broadcastTxid = await this.client.broadcast(rawTx);
      return { txHash: broadcastTxid || txid, fee: selection.fee };
    }
    async sign(message) {
      const msgHash = bitcoinMessageHash(message);
      const recoverableSig = native.crypto.signRecoverableSecp256k1(this.keyHandle, msgHash);
      const recid = recoverableSig[64];
      const flagByte = 27 + recid + 4;
      const result = new Uint8Array(65);
      result[0] = flagByte;
      result.set(recoverableSig.slice(0, 64), 1);
      return uint8ArrayToBase64(result);
    }
    // ── Downcast to read-only ──────────────────────────────────────────────
    toReadOnly() {
      return new BtcAccountReadOnly(
        this.manager,
        this.address,
        this.index,
        this.path
      );
    }
    // ── Helpers ────────────────────────────────────────────────────────────
    async fetchUtxos() {
      const electrumUtxos = await this.client.listUnspent(this.address);
      const senderScriptPubKey = native.encoding.hexEncode(
        addressToScriptPubKey(this.address)
      );
      return electrumUtxos.map((u) => ({
        txid: u.tx_hash,
        vout: u.tx_pos,
        value: u.value,
        scriptPubKey: senderScriptPubKey,
        address: this.address
      }));
    }
  };

  // ../wdk-v2-wallet-btc/src/btc-wallet-manager.ts
  var BtcWalletManager = class extends WalletManager {
    constructor() {
      super("btc", 0, "secp256k1");
      this.isTestnet_ = false;
      this.network_ = "bitcoin";
    }
    // ── Lifecycle ──────────────────────────────────────────────────────────
    async initialize(config) {
      this.config = config;
      this.clearAccounts();
      this.network_ = config.network ?? (config.isTestnet ? "testnet" : "bitcoin");
      this.isTestnet_ = this.network_ !== "bitcoin";
      this.coinType = this.network_ === "bitcoin" ? 0 : 1;
      if (config.btcClient) {
        this.client_ = createClient(config.btcClient, this.network_);
        await this.client_.connect();
      } else {
        try {
          const electrum = new ElectrumWsClient(this.network_);
          await electrum.connect();
          this.client_ = electrum;
        } catch {
          this.client_ = new MempoolRestClient(this.network_);
          await this.client_.connect();
        }
      }
    }
    /**
     * BIP-84 (P2WPKH) or BIP-44 (P2PKH) derivation path.
     */
    getDerivationPath(index, addressType) {
      const purpose = addressType === "p2pkh" ? 44 : 84;
      return `m/${purpose}'/${this.coinType}'/0'/0/${index}`;
    }
    // ── Accessors for account classes ──────────────────────────────────────
    getClient() {
      return this.client_;
    }
    getNetwork() {
      return this.network_;
    }
    isTestnetNetwork() {
      return this.isTestnet_;
    }
    // ── Account creation (template methods) ────────────────────────────────
    createAccount(keyHandle, publicKey, index, path, addressType) {
      let address;
      if (addressType === "p2pkh") {
        address = generateLegacyAddress(keyHandle, this.isTestnet_);
      } else {
        address = generateSegwitAddress(keyHandle, this.isTestnet_, this.network_);
      }
      return new BtcAccount(
        this,
        keyHandle,
        publicKey,
        address,
        index,
        path,
        addressType ?? "p2wpkh"
      );
    }
    createReadOnlyAccount(address, index) {
      const path = this.getDerivationPath(index);
      return new BtcAccountReadOnly(this, address, index, path);
    }
    // ── Cleanup ────────────────────────────────────────────────────────────
    destroy() {
      if (this.client_) {
        this.client_.close().catch(() => {
        });
      }
      this.network_ = "bitcoin";
      this.isTestnet_ = false;
      super.destroy();
    }
  };

  // src/bundle-entry.ts
  var engine = new WDKEngine();
  var btcManager = new BtcWalletManager();
  engine.registerChain(btcManager);
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
    },
    // ── Account lifecycle (production parity) ──
    getAccount(params) {
      return engine.dispatch("getAccount", params);
    },
    getAccountByPath(params) {
      return engine.dispatch("getAccountByPath", params);
    },
    toReadOnlyAccount(params) {
      return engine.dispatch("toReadOnlyAccount", params);
    },
    disposeAccount(params) {
      return engine.dispatch("disposeAccount", params);
    }
  };
  globalThis.wdk = wdk;
})();
