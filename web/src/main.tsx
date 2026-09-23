import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './styles/tokens.css'
import './styles/base.css'
import { getResolvedTheme } from './stores/auth'
import { App } from './App'

// Apply the theme before the first render (the CSP forbids an inline script in index.html).
document.documentElement.dataset.theme = getResolvedTheme()

const container = document.getElementById('root')
if (!container) throw new Error('Folio: #root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
