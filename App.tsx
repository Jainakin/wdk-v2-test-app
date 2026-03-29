/**
 * WDK v2 — Test App with Integrated Test Runner
 *
 * Two modes:
 *   1. Manual — tap Setup / Balance / History buttons
 *   2. Auto Test — tap "▶ Run Tests" to execute all test cases sequentially
 *
 * ALL output is logged to both:
 *   - The on-screen log panel (for visual inspection)
 *   - console.log with [TEST] prefix (for Metro capture / CI parsing)
 *
 * Read test results from Metro: grep '\[TEST\]' in Metro terminal output.
 */

import React, {useState, useCallback, useRef, useEffect} from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  ScrollView,
  View,
  ActivityIndicator,
  Share,
  Alert,
} from 'react-native';

// Set to true to auto-run tests on launch (for CI / automated testing)
const AUTO_RUN_TESTS = true;

import {WDKWallet} from 'wdk-v2-react-native';
import {NativeModules} from 'react-native';

// ── File-based test log (readable via simctl) ───────────────────────────────
// We use a native call to write test output to a file that can be read
// from the host machine via the simulator's app container path.
const {WDKEngine} = NativeModules;

// Accumulate all log lines, write to file at the end
let _testLogLines: string[] = [];

function tlogReset() {
  _testLogLines = [];
}

function tlogFlush() {
  const content = _testLogLines.join('\n');
  // Write to app's tmp dir via native method — produces file readable from host
  // Also NSLogs each line so it appears in `xcrun simctl spawn ... log show`
  WDKEngine?.writeTestLog(content)
    .then((path: string) => console.log(`[TEST] Results written to: ${path}`))
    .catch(() => {});
}

// ── Config ──────────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ── Test Logger ─────────────────────────────────────────────────────────────

type TestResult = {name: string; passed: boolean; detail: string; ms: number};

function tlog(msg: string) {
  const line = `[TEST] ${msg}`;
  console.log(line);
  _testLogLines.push(line);
}

// ── Test Cases ──────────────────────────────────────────────────────────────

type TestFn = () => Promise<{passed: boolean; detail: string}>;

function defineTests(): Array<{name: string; fn: TestFn}> {
  // Shared state across tests within a single run
  let address = '';

  return [
    // ── Setup tests ───────────────────────────────────────────────────
    {
      name: 'initialize',
      fn: async () => {
        await WDKWallet.initialize();
        return {passed: true, detail: 'engine initialized'};
      },
    },
    {
      name: 'configure_testnet',
      fn: async () => {
        await WDKWallet.configure({network: 'testnet'});
        return {passed: true, detail: 'network=testnet'};
      },
    },
    {
      name: 'unlockWallet',
      fn: async () => {
        await WDKWallet.unlockWallet({mnemonic: TEST_MNEMONIC});
        return {passed: true, detail: 'unlocked'};
      },
    },
    {
      name: 'getAddress',
      fn: async () => {
        const addr = await WDKWallet.getAddress({chain: 'btc'});
        if (!addr || typeof addr !== 'string') {
          return {passed: false, detail: `bad address: ${addr}`};
        }
        if (!addr.startsWith('tb1')) {
          return {passed: false, detail: `expected tb1... got ${addr}`};
        }
        address = addr;
        return {passed: true, detail: addr};
      },
    },

    // ── Address validation ────────────────────────────────────────────
    {
      name: 'address_is_testnet',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address from previous test'};
        const ok = address.startsWith('tb1q');
        return {passed: ok, detail: ok ? 'tb1q prefix correct' : `got: ${address.slice(0, 6)}`};
      },
    },
    {
      name: 'address_deterministic',
      fn: async () => {
        // Call getAddress again — same mnemonic should produce same address
        const addr2 = await WDKWallet.getAddress({chain: 'btc'});
        const ok = addr2 === address;
        return {passed: ok, detail: ok ? 'deterministic' : `mismatch: ${addr2} vs ${address}`};
      },
    },

    // ── Balance ───────────────────────────────────────────────────────
    {
      name: 'getBalance',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address'};
        const raw = await WDKWallet.getBalance({chain: 'btc', address});
        const sats = parseInt(raw, 10);
        if (isNaN(sats)) {
          return {passed: false, detail: `non-numeric balance: ${raw}`};
        }
        // 0 sats is valid for a fresh testnet address
        return {passed: true, detail: `${sats} sat`};
      },
    },
    {
      name: 'getBalance_returns_string',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address'};
        const raw = await WDKWallet.getBalance({chain: 'btc', address});
        const ok = typeof raw === 'string';
        return {passed: ok, detail: ok ? `type=string, value="${raw}"` : `type=${typeof raw}`};
      },
    },

    // ── Quote Send + Max Spendable ────────────────────────────────────
    {
      name: 'quoteSend',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address'};
        const quote = await WDKWallet.quoteSend({
          chain: 'btc', from: address,
          to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
          amount: '10000',
        });
        // Address has 0 balance so should be infeasible
        const ok = typeof quote.feasible === 'boolean';
        return {
          passed: ok,
          detail: quote.feasible
            ? `feasible fee=${quote.fee} inputs=${quote.inputCount}`
            : `infeasible: ${quote.error ?? 'insufficient funds'}`,
        };
      },
    },
    {
      name: 'getMaxSpendable',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address'};
        const result = await WDKWallet.getMaxSpendable({chain: 'btc', address});
        const ok = typeof result.maxSpendable === 'number';
        return {
          passed: ok,
          detail: `max=${result.maxSpendable}sat fee=${result.fee} utxos=${result.utxoCount}`,
        };
      },
    },

    // ── History ───────────────────────────────────────────────────────
    {
      name: 'getHistory',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address'};
        const txs = await WDKWallet.getHistory({chain: 'btc', address, limit: 5});
        if (!Array.isArray(txs)) {
          return {passed: false, detail: `not an array: ${typeof txs}`};
        }
        // Empty array is valid for a fresh address
        return {passed: true, detail: `${txs.length} transactions`};
      },
    },
    {
      name: 'getHistory_shape',
      fn: async () => {
        if (!address) return {passed: false, detail: 'no address'};
        const txs = await WDKWallet.getHistory({chain: 'btc', address, limit: 1});
        if (txs.length === 0) {
          return {passed: true, detail: 'empty (valid for fresh address)'};
        }
        const tx = txs[0] as any;
        const hasHash = typeof tx.txHash === 'string' && tx.txHash.length > 0;
        const hasStatus = tx.status === 'confirmed' || tx.status === 'pending';
        const hasDirection = tx.direction === 'sent' || tx.direction === 'received' || tx.direction === 'self';
        const hasAmount = typeof tx.amount === 'string' && tx.amount !== '0';
        const hasTimestamp = typeof tx.timestamp === 'number';
        const ok = hasHash && hasStatus && hasDirection && hasTimestamp;
        return {
          passed: ok,
          detail: ok
            ? `${tx.direction} ${tx.amount}sat fee=${tx.fee ?? '?'} ${tx.txHash.slice(0, 10)}...`
            : `missing fields: hash=${hasHash} status=${hasStatus} dir=${hasDirection} amt=${hasAmount} ts=${hasTimestamp} raw=${JSON.stringify(tx).slice(0, 80)}`,
        };
      },
    },

    // ── Error handling ────────────────────────────────────────────────
    {
      name: 'getBalance_bad_address',
      fn: async () => {
        try {
          await WDKWallet.getBalance({chain: 'btc', address: 'invalid_address_xyz'});
          return {passed: false, detail: 'should have thrown'};
        } catch (e: any) {
          return {passed: true, detail: `correctly threw: ${(e.message ?? '').slice(0, 60)}`};
        }
      },
    },
    {
      name: 'getBalance_missing_address',
      fn: async () => {
        try {
          await WDKWallet.getBalance({chain: 'btc'} as any);
          return {passed: false, detail: 'should have thrown'};
        } catch (e: any) {
          return {passed: true, detail: `correctly threw: ${(e.message ?? '').slice(0, 60)}`};
        }
      },
    },

    // ── State ─────────────────────────────────────────────────────────
    {
      name: 'getState_is_ready',
      fn: async () => {
        const state = await WDKWallet.getState();
        const ok = state === 'ready';
        return {passed: ok, detail: `state="${state}"`};
      },
    },

    // ── Lock / Re-unlock ──────────────────────────────────────────────
    {
      name: 'lockWallet',
      fn: async () => {
        await WDKWallet.lockWallet();
        const state = await WDKWallet.getState();
        return {passed: state === 'locked', detail: `state="${state}"`};
      },
    },
    {
      name: 'reUnlock',
      fn: async () => {
        // Re-configure and unlock for any tests that follow
        await WDKWallet.configure({network: 'testnet'});
        await WDKWallet.unlockWallet({mnemonic: TEST_MNEMONIC});
        const state = await WDKWallet.getState();
        return {passed: state === 'ready', detail: `state="${state}"`};
      },
    },
    {
      name: 'address_same_after_relock',
      fn: async () => {
        const addr2 = await WDKWallet.getAddress({chain: 'btc'});
        const ok = addr2 === address;
        return {passed: ok, detail: ok ? 'matches' : `${addr2} ≠ ${address}`};
      },
    },
  ];
}

// ── App Component ───────────────────────────────────────────────────────────

const App = () => {
  const [log, setLog] = useState<string>('Tap "▶ Run Tests" or use manual buttons.');
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const appendLog = useCallback((msg: string) => {
    setLog(prev => prev + '\n' + msg);
    // Also log to Metro console for capture
    console.log(msg);
  }, []);

  // Auto-run ref (used in useEffect below, after runTests is defined)
  const autoRunDone = useRef(false);

  // ── Auto Test Runner ────────────────────────────────────────────────────

  const runTests = useCallback(async () => {
    setRunning(true);
    setResults([]);
    setLog('');
    setAddress('');
    setBalance(null);

    tlogReset();
    tlog('═══════════════════════════════════════');
    tlog('START test suite');
    tlog('═══════════════════════════════════════');

    const tests = defineTests();
    const allResults: TestResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const test of tests) {
      const t0 = Date.now();
      let result: TestResult;

      try {
        const {passed: ok, detail} = await test.fn();
        const ms = Date.now() - t0;
        result = {name: test.name, passed: ok, detail, ms};
      } catch (e: any) {
        const ms = Date.now() - t0;
        const msg = e?.message ?? String(e);
        result = {name: test.name, passed: false, detail: `THREW: ${msg.slice(0, 120)}`, ms};
      }

      if (result.passed) {
        passed++;
        tlog(`PASS ${result.name} (${result.ms}ms) — ${result.detail}`);
        appendLog(`✅ ${result.name} (${result.ms}ms) — ${result.detail}`);
      } else {
        failed++;
        tlog(`FAIL ${result.name} (${result.ms}ms) — ${result.detail}`);
        appendLog(`❌ ${result.name} (${result.ms}ms) — ${result.detail}`);
      }

      allResults.push(result);
      setResults([...allResults]);

      // If getAddress passed, capture the address for UI display
      if (test.name === 'getAddress' && result.passed) {
        setAddress(result.detail);
      }
      if (test.name === 'getBalance' && result.passed) {
        setBalance(result.detail);
      }
    }

    tlog('═══════════════════════════════════════');
    tlog(`DONE ${passed}/${passed + failed} passed, ${failed} failed`);
    tlog('═══════════════════════════════════════');
    tlogFlush();
    appendLog(`\n═══ ${passed}/${passed + failed} passed, ${failed} failed ═══`);

    setRunning(false);
  }, [appendLog]);

  // Auto-run tests on launch when AUTO_RUN_TESTS is true
  useEffect(() => {
    if (AUTO_RUN_TESTS && !autoRunDone.current) {
      autoRunDone.current = true;
      setTimeout(() => { runTests(); }, 1500);
    }
  }, [runTests]);

  // ── Manual buttons (kept for interactive use) ───────────────────────────

  const handleSetup = useCallback(async () => {
    setLog('');
    try {
      appendLog('[Setup] Initializing...');
      await WDKWallet.initialize();
      appendLog('[Setup] Configuring testnet...');
      await WDKWallet.configure({network: 'testnet'});
      appendLog('[Setup] Unlocking...');
      await WDKWallet.unlockWallet({mnemonic: TEST_MNEMONIC});
      appendLog('[Setup] Getting address...');
      const addr = await WDKWallet.getAddress({chain: 'btc'});
      setAddress(addr);
      appendLog(`[Setup] ✓ ${addr}`);
    } catch (e: any) {
      appendLog(`[Setup] ✗ ${e.message ?? e}`);
    }
  }, [appendLog]);

  const handleBalance = useCallback(async () => {
    if (!address) return;
    try {
      appendLog('[Balance] Fetching...');
      const raw = await WDKWallet.getBalance({chain: 'btc', address});
      setBalance(`${raw} sat`);
      appendLog(`[Balance] ✓ ${raw} sat`);
    } catch (e: any) {
      appendLog(`[Balance] ✗ ${e.message ?? e}`);
    }
  }, [address, appendLog]);

  const handleHistory = useCallback(async () => {
    if (!address) return;
    try {
      appendLog('[History] Fetching...');
      const txs = await WDKWallet.getHistory({chain: 'btc', address, limit: 5});
      appendLog(`[History] ✓ ${txs.length} txs`);
      txs.forEach((tx: any, i: number) => {
        appendLog(`  [${i}] ${tx.txHash?.slice(0, 16)}... ${tx.status}`);
      });
    } catch (e: any) {
      appendLog(`[History] ✗ ${e.message ?? e}`);
    }
  }, [address, appendLog]);

  // ── Render ──────────────────────────────────────────────────────────────

  const passCount = results.filter(r => r.passed).length;
  const failCount = results.filter(r => !r.passed).length;

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>WDK v2 Test Runner</Text>

      {/* Test summary bar */}
      {results.length > 0 && (
        <View style={styles.summaryBar}>
          <Text style={styles.summaryText}>
            {failCount === 0 ? '✅' : '❌'}{' '}
            {passCount}/{results.length} passed
            {failCount > 0 ? ` · ${failCount} failed` : ''}
          </Text>
        </View>
      )}

      {/* Address + balance (if available) */}
      {address ? (
        <View style={styles.addrCard}>
          <Text style={styles.addrLabel}>Testnet Address</Text>
          <Text style={styles.addrText} selectable>{address}</Text>
          {balance && <Text style={styles.balanceText}>{balance}</Text>}
        </View>
      ) : null}

      {/* Button row */}
      <View style={styles.btnRow}>
        <TouchableOpacity
          style={[styles.testBtn, running && styles.btnDisabled]}
          onPress={runTests}
          disabled={running}>
          {running ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.testBtnText}>▶ Run Tests</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, running && styles.btnDisabled]}
          onPress={handleSetup}
          disabled={running}>
          <Text style={styles.actionBtnLabel}>Setup</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, (!address || running) && styles.btnDisabled]}
          onPress={handleBalance}
          disabled={!address || running}>
          <Text style={styles.actionBtnLabel}>Balance</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, (!address || running) && styles.btnDisabled]}
          onPress={handleHistory}
          disabled={!address || running}>
          <Text style={styles.actionBtnLabel}>History</Text>
        </TouchableOpacity>
      </View>

      {/* Test results list */}
      {results.length > 0 && (
        <View style={styles.resultsContainer}>
          <Text style={styles.sectionLabel}>Test Results</Text>
          <ScrollView style={styles.resultsScroll}>
            {results.map((r, i) => (
              <View key={i} style={styles.resultRow}>
                <Text style={r.passed ? styles.resultPass : styles.resultFail}>
                  {r.passed ? '✅' : '❌'}
                </Text>
                <View style={styles.resultInfo}>
                  <Text style={styles.resultName}>{r.name}</Text>
                  <Text style={styles.resultDetail} numberOfLines={2}>
                    {r.detail} ({r.ms}ms)
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Raw log */}
      <View style={styles.logContainer}>
        <Text style={styles.sectionLabel}>Console</Text>
        <ScrollView
          ref={scrollRef}
          style={styles.logScroll}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd()}>
          <Text style={styles.logText} selectable>{log}</Text>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
};

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0d0d1a', paddingHorizontal: 12},
  title: {
    fontSize: 20, fontWeight: '700', color: '#e94560',
    textAlign: 'center', marginTop: 12, marginBottom: 8,
  },

  // Summary bar
  summaryBar: {
    backgroundColor: '#16213e', borderRadius: 8, padding: 8,
    marginBottom: 8, alignItems: 'center', borderWidth: 1, borderColor: '#2a2a4a',
  },
  summaryText: {color: '#e0e0e0', fontSize: 14, fontWeight: '600'},

  // Address card
  addrCard: {
    backgroundColor: '#16213e', borderRadius: 8, padding: 10,
    marginBottom: 8, borderWidth: 1, borderColor: '#2a2a4a',
  },
  addrLabel: {fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1},
  addrText: {fontSize: 11, color: '#7ec8e3', fontFamily: 'Menlo', marginTop: 2},
  balanceText: {fontSize: 13, fontWeight: '700', color: '#4ecca3', marginTop: 6, textAlign: 'center'},

  // Buttons
  btnRow: {flexDirection: 'row', gap: 6, marginBottom: 8},
  testBtn: {
    flex: 2, backgroundColor: '#c62a47', borderRadius: 8,
    paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: '#e94560',
  },
  testBtnText: {color: '#fff', fontSize: 14, fontWeight: '700'},
  actionBtn: {
    flex: 1, backgroundColor: '#1f2041', borderRadius: 8,
    paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: '#2a2a5a',
  },
  actionBtnLabel: {color: '#aaa', fontSize: 11, fontWeight: '600'},
  btnDisabled: {opacity: 0.4},

  // Results list
  resultsContainer: {
    backgroundColor: '#16213e', borderRadius: 8, padding: 8,
    marginBottom: 8, maxHeight: 200, borderWidth: 1, borderColor: '#2a2a4a',
  },
  resultsScroll: {flex: 1},
  resultRow: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6, gap: 6},
  resultPass: {fontSize: 14},
  resultFail: {fontSize: 14},
  resultInfo: {flex: 1},
  resultName: {fontSize: 12, fontWeight: '600', color: '#e0e0e0'},
  resultDetail: {fontSize: 10, color: '#888', fontFamily: 'Menlo'},

  // Section label
  sectionLabel: {
    fontSize: 10, color: '#666', marginBottom: 4,
    textTransform: 'uppercase', letterSpacing: 1,
  },

  // Log
  logContainer: {
    flex: 1, backgroundColor: '#0a0a14', borderRadius: 8,
    padding: 8, borderWidth: 1, borderColor: '#1a1a2e',
  },
  logScroll: {flex: 1},
  logText: {fontSize: 10, color: '#8a8aaa', fontFamily: 'Menlo', lineHeight: 15},
});

export default App;
