import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  css: {
    minify: false,
  },
  tanstackStart: {
    server: {
      entry: "server",
    },
  },
});