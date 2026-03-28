//
//  WDKTestApp-Bridging-Header.h
//  WDKTestApp
//
//  Swift <-> ObjC/C bridging for the test app target.
//
//  WDK engine C declarations (wdk_engine_create, etc.) are provided
//  by the wdk-v2-react-native pod via WDKEngineBridge.h in the pod's
//  module map. The app no longer calls the C engine directly.
//

// React Native bridge module support
#import <React/RCTBridgeModule.h>
