import './index.css';
import './components/styles/common.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// DEV: Allow per-tab session override via ?devSession=xxx URL parameter.
// This patches localStorage.getItem so each tab can use a different session
// (localStorage is shared across all tabs on the same origin).
const _devSessionParam = new URLSearchParams(window.location.search).get('devSession');
if (_devSessionParam) {
  const _origGetItem = localStorage.getItem.bind(localStorage);
  localStorage.getItem = function(key: string) {
    if (key === 'sessionId') return _devSessionParam;
    return _origGetItem(key);
  };
}

const rootElement = document.getElementById('root');
if (rootElement) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}