import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// The admin dashboard lives in the same app at /admin; it's code-split so the
// public config page doesn't download it.
const Admin = lazy(() => import('./Admin.jsx'));
const isAdminRoute = /^\/admin(\/|$)/.test(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdminRoute ? (
      <Suspense fallback={null}>
        <Admin />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
