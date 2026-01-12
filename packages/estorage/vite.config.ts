import { defineConfig } from "vite";

export default defineConfig({
    server: {
        port: 3001
    },
    build: {
        outDir: "dist",
        assetsDir: "assets",
        rollupOptions: {
            output: {
                entryFileNames: "assets/estorage.js",
                chunkFileNames: "assets/[name].js",
                assetFileNames: "assets/[name][extname]"
            }
        }
    }
});