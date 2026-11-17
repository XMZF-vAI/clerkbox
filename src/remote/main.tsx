import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RemoteEntry from './RemoteEntry'
import '../i18n'
import '../index.css'
import './remote.css'

document.documentElement.classList.add('webui-mode')
createRoot(document.getElementById('root')!).render(<StrictMode><RemoteEntry /></StrictMode>)
