/**
 * WDK v2 Test App
 *
 * Uses the proper TurboModule pattern via wdk-v2-react-native:
 *   import { WDKWallet } from 'wdk-v2-react-native'
 *
 * All WDK calls go through WDKWallet (which uses NativeWDKEngine internally).
 * The native side (WDKEngineModule.swift) routes calls to the C engine.
 */

import React, {useState} from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  ScrollView,
  View,
  ActivityIndicator,
} from 'react-native';

import {WDKWallet} from 'wdk-v2-react-native';

const App = () => {
  const [results, setResults] = useState<string>('Press "Run Tests" to begin.');
  const [loading, setLoading] = useState(false);

  const log = (msg: string) => {
    setResults(prev => prev + '\n' + msg);
  };

  const runTests = async () => {
    setResults('');
    setLoading(true);

    try {
      // 1. Initialize engine (loads QuickJS + JS bundle + all bridges)
      log('[1] Initializing WDK engine...');
      await WDKWallet.initialize();
      log('    Result: ok');

      // 2. Create wallet
      log('\n[2] Creating wallet...');
      const wallet = await WDKWallet.createWallet();
      log(`    Result: ${JSON.stringify(wallet)}`);

      const mnemonic = wallet.mnemonic ?? '';
      if (mnemonic) {
        log(`    Mnemonic: ${mnemonic}`);
      }

      // 3. Get BTC address
      if (mnemonic) {
        log('\n[3] Getting BTC address...');
        const address = await WDKWallet.getAddress({chain: 'btc', mnemonic});
        log(`    Result: ${address}`);
      }

      // 4. Get wallet state
      log('\n[4] Getting wallet state...');
      const state = await WDKWallet.getState();
      log(`    State: ${state}`);

      log('\n--- Tests complete ---');
    } catch (error: any) {
      log(`\nERROR: ${error.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>WDK v2 Test</Text>
      <Text style={styles.subtitle}>TurboModule + C Engine + QuickJS</Text>

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={runTests}
        disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Run Tests</Text>
        )}
      </TouchableOpacity>

      <View style={styles.resultsContainer}>
        <Text style={styles.resultsLabel}>Results:</Text>
        <ScrollView style={styles.scrollView}>
          <Text style={styles.resultsText} selectable>
            {results}
          </Text>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    padding: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#e94560',
    textAlign: 'center',
    marginTop: 20,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#e94560',
    paddingVertical: 14,
    paddingHorizontal: 30,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 20,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  resultsContainer: {
    flex: 1,
    backgroundColor: '#16213e',
    borderRadius: 10,
    padding: 15,
  },
  resultsLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e94560',
    marginBottom: 10,
  },
  scrollView: {
    flex: 1,
  },
  resultsText: {
    fontSize: 13,
    color: '#c4c4c4',
    fontFamily: 'Menlo',
    lineHeight: 20,
  },
});

export default App;
