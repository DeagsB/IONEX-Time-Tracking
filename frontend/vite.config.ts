import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Split large node_modules into separate chunks to avoid a single 500kB+ bundle warning. */
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('react-router')) return 'vendor-react'
  if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react'
  if (id.includes('@tanstack/react-query')) return 'vendor-query'
  if (id.includes('@supabase')) return 'vendor-supabase'
  if (id.includes('recharts')) return 'vendor-recharts'
  if (id.includes('pdf-lib') || id.includes('html2pdf') || id.includes('pdfjs-dist')) return 'vendor-pdf'
  if (id.includes('xlsx') || id.includes('exceljs')) return 'vendor-xlsx'
  if (id.includes('tesseract')) return 'vendor-tesseract'
  return 'vendor-misc'
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 3000,
    // host: '0.0.0.0', // Uncomment to access dev server from other devices (phone/tablet); may trigger "local network" permission
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})

