// The old reports pages still live on the previous host.
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/legacy/:path*",
        destination: "https://old.example.com/:path*",
      },
    ];
  },
};

export default nextConfig;
