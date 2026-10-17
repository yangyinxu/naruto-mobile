import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({mode}) => ({
  base: mode === 'hosted' ? '/naruto/' : '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Hosted proxies keep the 5173 Host: Archtree's Naruto guard compares Origin
    // with its own Host, and the string shorthand would rewrite Host to 8080.
    proxy: (mode === 'hosted'
      ? {
          '/naruto/api': {target: 'http://127.0.0.1:8080', changeOrigin: false},
          '/auth': {target: 'http://127.0.0.1:8080', changeOrigin: false}
        }
      : {'/api': 'http://127.0.0.1:3765'}) as Record<string, string | ProxyOptions>
  },
  build: {outDir: mode === 'hosted' ? 'hosted-dist' : 'dist', manifest: mode === 'hosted'},
  test: {
    environment: 'jsdom',
    css: {include: [/styles\.css|htmlReport\.css/]},
    setupFiles: './src/test/setup.ts'
  }
}));
