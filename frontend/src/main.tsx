import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { ToastProvider, ConfirmProvider } from './components/ui'
import '@fontsource-variable/inter'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
