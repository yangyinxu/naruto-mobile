import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({mode}) => ({
  base: mode === 'hosted' ? '/naruto/' : '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: (mode === 'hosted'
      ? {'/naruto/api': 'http://127.0.0.1:8080', '/auth': 'http://127.0.0.1:8080'}
      : {'/api': 'http://127.0.0.1:3765'}) as Record<string, string>
  },
  build: {outDir: mode === 'hosted' ? 'hosted-dist' : 'dist', manifest: mode === 'hosted'},
  test: {
    environment: 'jsdom',
    css: {include: [/styles\.css|htmlReport\.css/]},
    setupFiles: './src/test/setup.ts'
  }
}));
