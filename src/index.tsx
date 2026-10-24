/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { watchPointer } from './view/screen'

const root = document.getElementById('root')

render(() => <App />, root!)
watchPointer()

// Offline and installable: the built app caches itself (public/sw.js). Not in
// development, where a cached build would shadow the dev server.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}
