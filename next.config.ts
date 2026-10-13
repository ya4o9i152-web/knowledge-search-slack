import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDFの抽出（pdf-parse → pdfjs-dist）は、サーバー上で DOMMatrix などの代わりに @napi-rs/canvas を使う。
  // まとめてバンドルすると実行時に読み込めず「DOMMatrix is not defined」で落ちるため、
  // バンドルから外して Node.js の require で読み込ませ、ネイティブの部品もデプロイに含める
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/cron/ingest": ["./node_modules/@napi-rs/**/*", "./node_modules/pdfjs-dist/legacy/build/**/*"],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
