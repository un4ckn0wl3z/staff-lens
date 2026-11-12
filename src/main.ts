import { App } from './app';
import { initialLang, setLang } from './i18n';
import './style.css';

setLang(initialLang());
const app = new App();
app.start();
if (import.meta.env.DEV) (window as unknown as { stafflens: App }).stafflens = app;

// Deep link: ?demo=aura-lee
const demo = new URLSearchParams(location.search).get('demo');
if (demo && /^[a-z0-9-]+$/.test(demo)) app.loadUrl(`${import.meta.env.BASE_URL}samples/${demo}.musicxml`, `${demo}.musicxml`);

// Offline support after the first visit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {
      /* offline mode is optional */
    });
  });
}
