/** @type {import('next').NextConfig} */
const nextConfig = {
  // wagmi/connectors pulls in metaMask + walletConnect connectors (unused — we only
  // wire up `injected`), which reference these optional, not-installed packages.
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding", "@react-native-async-storage/async-storage");
    return config;
  },
};

export default nextConfig;
