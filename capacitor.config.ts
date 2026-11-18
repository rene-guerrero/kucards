import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kucards.app',
  appName: 'KuCards',
  webDir: 'dist',
  // dark background behind the WebView while it boots (matches the game's boot screen)
  backgroundColor: '#13232e',
  android: {
    backgroundColor: '#13232e',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
