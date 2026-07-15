import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  css: {
    minify: false,
    transformer: 'postcss',
  },
  tanstackStart: {
    server: {
      entry: "server",
    },
  },
  // Add this block to force Vite and Rolldown to turn off CSS minification globally
  vite: {
    build: {
      cssMinify: false,
      minify: false,
    }
  }
});
