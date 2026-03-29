const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * watchFolders: tells Metro to watch the wdk-v2-react-native package
 * directory directly. Required because the package is installed as a
 * "file:" symlink (npm) which Metro doesn't follow outside the project root.
 *
 * resolver.nodeModulesPaths: ensures Metro resolves React/RN from the
 * test app's node_modules when inside the watched package directory,
 * preventing "two copies of React" errors.
 */

const wdkPackagePath = path.resolve(__dirname, '../wdk-v2-react-native');

const config = {
  watchFolders: [wdkPackagePath],

  resolver: {
    // When resolving modules from within wdk-v2-react-native, look in the
    // test app's node_modules first so we don't get duplicate React instances.
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
