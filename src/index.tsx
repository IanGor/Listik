/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'

const root = document.getElementById('root')

render(() => <App />, root!)

// iOS Safari applies :active (the press feedback in index.css) only on a page that listens to touches.
document.addEventListener('touchstart', () => {}, { passive: true });

// Offline and installable: the built app caches itself (public/sw.js). Not in
// development, where a cached build would shadow the dev server.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js');
}
