import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Key,
  Eye,
  EyeSlash,
  Check,
  Warning,
  Spinner,
  ShieldCheck,
  ArrowsClockwise,
  SignOut,
  MagnifyingGlass,
  Prohibit,
  Trash,
  CaretRight,
} from '@phosphor-icons/react';
import './admin.css';

const REFRESH_MS = 15000;

async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Admin-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    /* non-JSON error body */
  }
  if (!resp.ok) {
    const err = new Error((data && data.error) || `Request failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

function formatMB(mb) {
  if (mb === null || mb === undefined) return '—';
  const units = ['MB', 'GB', 'TB', 'PB'];
  let value = mb;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

function ago(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const ACTIVITY_LABEL = { active: 'Active', recent: 'Last 24h', idle: 'Idle', blocked: 'Blocked' };
const TOKEN_LABEL = {
  ok: 'Healthy',
  low: 'Low quota',
  exhausted: 'Quota used up',
  invalid: 'Invalid token',
  cooldown: 'Paused',
  unknown: 'Not checked',
};

function Brand({ subtitle }) {
  return (
    <div className="brand">
      <img src="/assets/icon.png" alt="FebBox Addon" />
      <h1>{subtitle}</h1>
    </div>
  );
}

/* ------------------------------------------------------------------ Login */

function Login({ enabled, onSuccess }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/login', { method: 'POST', body: { password } });
      setPassword('');
      onSuccess();
    } catch (err) {
      setError(err.status === 429 ? 'Too many attempts. Try again in a few minutes.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adm-login">
      <Brand subtitle="FebBox Admin" />
      <p className="tagline">Sign in to see installs, token quotas and failover activity.</p>

      {!enabled ? (
        <div className="notice amber">
          <ShieldCheck weight="bold" className="notice-icon" size={20} />
          <div>
            <strong>Admin is not enabled on this server</strong>
            <p>
              Set the <code>ADMIN_PASSWORD</code> environment variable and restart to turn it on.
            </p>
          </div>
        </div>
      ) : (
        <form className="card" onSubmit={submit}>
          <div className="field">
            <label htmlFor="admin-password">Password</label>
            <div className="token-row">
              <Key weight="bold" className="token-icon" />
              <input
                id="admin-password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus
                placeholder="Admin password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="toggle-visibility" onClick={() => setShow((v) => !v)} aria-label="Show or hide password">
                {show ? <EyeSlash weight="bold" /> : <Eye weight="bold" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="status show err">
              <Warning weight="bold" className="status-icon" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn-primary btn-block" disabled={busy || !password}>
            {busy ? <Spinner weight="bold" className="spin" /> : null}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- Dashboard */

function Stat({ value, label, warn }) {
  return (
    <div className={`adm-stat ${warn ? 'warn' : ''}`}>
      <div className="adm-stat-value">{value}</div>
      <div className="adm-stat-label">{label}</div>
    </div>
  );
}

function TokenRow({ token, index, now }) {
  const hasQuota = token.limitMB > 0 && token.remainingMB !== null && token.remainingMB !== undefined;
  const pct = hasQuota ? Math.max(0, Math.min(100, (token.remainingMB / token.limitMB) * 100)) : 0;
  const barClass = token.status === 'exhausted' || token.status === 'invalid' ? 'exhausted' : token.status === 'low' ? 'low' : '';

  const meta = [];
  meta.push(hasQuota ? `${formatMB(token.remainingMB)} left of ${formatMB(token.limitMB)}` : 'Quota not checked yet — use “Refresh quota”');
  meta.push(`used ${token.uses || 0}×`);
  meta.push(`last used ${ago(token.lastUsed, now)}`);
  if (token.cooldown) meta.push(`paused (${token.cooldown.code})`);
  if (token.lastFailure) meta.push(`last failure ${token.lastFailure.code} ${ago(token.lastFailure.at, now)}`);

  return (
    <div className="adm-token">
      <div className="adm-token-row">
        <span className="adm-token-name">
          <Key weight="bold" size={14} />
          #{index + 1} · {token.hash}
          {index === 0 && <span className="adm-primary">Primary</span>}
        </span>
        <span className={`adm-chip ${token.status}`}>{TOKEN_LABEL[token.status] || token.status}</span>
      </div>
      {hasQuota && (
        <div className={`adm-bar ${barClass}`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="adm-token-meta">{meta.join(' · ')}</div>
    </div>
  );
}

function InstallCard({ rec, now, onChanged, onError }) {
  const [busy, setBusy] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const errorTotal = Object.values(rec.errors || {}).reduce((a, b) => a + b, 0);

  const run = async (name, fn) => {
    setBusy(name);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy('');
      setConfirmRemove(false);
    }
  };

  return (
    <article className={`adm-install ${rec.blocked ? 'is-blocked' : ''}`}>
      <div className="adm-head">
        <div>
          <div className={`adm-name ${rec.label ? '' : 'unnamed'}`}>{rec.label || 'Unnamed install'}</div>
          <div className="adm-id">{rec.id}</div>
        </div>
        <span className={`adm-badge ${rec.activity}`}>{ACTIVITY_LABEL[rec.activity] || rec.activity}</span>
      </div>

      <div className="adm-metrics">
        <div className="adm-metric"><b>{ago(rec.lastSeen, now)}</b><span>Last activity</span></div>
        <div className="adm-metric"><b>{rec.streamRequests}</b><span>Stream requests</span></div>
        <div className="adm-metric"><b>{rec.streamsServed}</b><span>Served</span></div>
        <div className="adm-metric"><b>{rec.emptyResponses}</b><span>Empty</span></div>
        <div className="adm-metric"><b>{errorTotal}</b><span>Errors</span></div>
        <div className="adm-metric"><b>{rec.failovers}</b><span>Failovers</span></div>
      </div>
      <div className="adm-sub">
        First seen {ago(rec.firstSeen, now)} · playback {rec.playbackMode || 'direct'}
        {rec.lastError ? ` · last error ${rec.lastError.code} ${ago(rec.lastError.at, now)}` : ''}
      </div>

      <div className="adm-tokens">
        {rec.tokens.map((t, i) => (
          <TokenRow key={t.hash} token={t} index={i} now={now} />
        ))}
      </div>

      <div className="adm-actions">
        <button
          type="button"
          className="btn-secondary adm-btn-sm"
          disabled={Boolean(busy)}
          onClick={() => run('refresh', () => api(`/api/admin/installs/${rec.id}/refresh`, { method: 'POST' }))}
        >
          {busy === 'refresh' ? <Spinner weight="bold" className="spin" /> : <ArrowsClockwise weight="bold" />}
          Refresh quota
        </button>
        <button
          type="button"
          className="btn-secondary adm-btn-sm"
          disabled={Boolean(busy)}
          onClick={() => run('block', () => api(`/api/admin/installs/${rec.id}/block`, { method: 'POST', body: { blocked: !rec.blocked } }))}
        >
          {busy === 'block' ? <Spinner weight="bold" className="spin" /> : rec.blocked ? <Check weight="bold" /> : <Prohibit weight="bold" />}
          {rec.blocked ? 'Unblock' : 'Block'}
        </button>
        {confirmRemove ? (
          <>
            <button
              type="button"
              className="adm-danger adm-btn-sm"
              disabled={Boolean(busy)}
              onClick={() => run('remove', () => api(`/api/admin/installs/${rec.id}`, { method: 'DELETE' }))}
            >
              {busy === 'remove' ? <Spinner weight="bold" className="spin" /> : <Trash weight="bold" />}
              Confirm remove
            </button>
            <button type="button" className="btn-secondary adm-btn-sm" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="adm-danger adm-btn-sm" disabled={Boolean(busy)} onClick={() => setConfirmRemove(true)}>
            <Trash weight="bold" />
            Remove from list
          </button>
        )}
      </div>
    </article>
  );
}

function Dashboard({ onSignedOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef(null);

  const handleError = useCallback(
    (err) => {
      if (err && err.status === 401) return onSignedOut();
      setError(err && err.message ? err.message : 'Something went wrong');
      return undefined;
    },
    [onSignedOut]
  );

  const load = useCallback(async () => {
    try {
      setData(await api('/api/admin/overview'));
      setError('');
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  useEffect(() => {
    load();
    timer.current = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer.current);
  }, [load]);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await api('/api/admin/refresh-all', { method: 'POST' });
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setRefreshing(false);
    }
  };

  const signOut = async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } catch (_) {
      /* cookie expires anyway */
    }
    onSignedOut();
  };

  const installs = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.installs.filter((r) => {
      if (filter === 'active' && !(r.activity === 'active' || r.activity === 'recent')) return false;
      if (filter === 'idle' && r.activity !== 'idle') return false;
      if (filter === 'blocked' && !r.blocked) return false;
      if (q && !(`${r.label || ''} ${r.id}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [data, query, filter]);

  if (!data) {
    return (
      <div className="adm-wrap">
        <div className="adm-top"><Brand subtitle="FebBox Admin" /></div>
        {error ? (
          <div className="status show err"><Warning weight="bold" className="status-icon" /><span>{error}</span></div>
        ) : (
          <div className="status show pending"><Spinner weight="bold" className="spin status-icon" /><span>Loading…</span></div>
        )}
      </div>
    );
  }

  const t = data.totals;
  const failovers = (data.metrics.counters && data.metrics.counters.token_failover) || 0;
  const now = data.now;

  return (
    <div className="adm-wrap">
      <div className="adm-top">
        <Brand subtitle="FebBox Admin" />
        <div className="adm-top-actions">
          <span className="adm-updated">Updated {new Date(now).toLocaleTimeString()}</span>
          <button type="button" className="btn-secondary adm-btn-sm" onClick={refreshAll} disabled={refreshing}>
            {refreshing ? <Spinner weight="bold" className="spin" /> : <ArrowsClockwise weight="bold" />}
            Refresh all quotas
          </button>
          <button type="button" className="btn-secondary adm-btn-sm" onClick={signOut}>
            <SignOut weight="bold" />
            Sign out
          </button>
        </div>
      </div>

      {error && (
        <div className="notice amber">
          <Warning weight="bold" className="notice-icon" size={20} />
          <div><strong>{error}</strong></div>
        </div>
      )}

      <div className="adm-stats">
        <Stat value={t.installs} label="Installs" />
        <Stat value={t.activeLastHour} label="Active, last hour" />
        <Stat value={t.activeLast24h} label="Active, last 24 h" />
        <Stat value={t.tokens} label="Tokens" />
        <Stat value={t.tokensExhausted + t.tokensInvalid} label="Depleted / invalid" warn={t.tokensExhausted + t.tokensInvalid > 0} />
        <Stat value={failovers} label="Auto-failovers" />
      </div>

      <div className="adm-toolbar">
        <div className="adm-search">
          <MagnifyingGlass weight="bold" />
          <input type="text" placeholder="Search by name or id" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search installs" />
        </div>
        <div className="adm-seg" role="tablist" aria-label="Filter installs">
          {[
            ['all', 'All'],
            ['active', 'Active'],
            ['idle', 'Idle'],
            ['blocked', 'Blocked'],
          ].map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {installs.length === 0 ? (
        <div className="adm-empty">
          <h3>{data.installs.length === 0 ? 'No installs yet' : 'No installs match'}</h3>
          <p>
            {data.installs.length === 0
              ? 'An install appears here the first time its manifest or a stream is requested.'
              : 'Try a different search or filter.'}
          </p>
        </div>
      ) : (
        <div className="adm-list">
          {installs.map((rec) => (
            <InstallCard key={rec.id} rec={rec} now={now} onChanged={load} onError={handleError} />
          ))}
        </div>
      )}

      <details className="advanced adm-server">
        <summary>
          <CaretRight weight="bold" className="chev" />
          Server metrics · up {formatUptime(data.uptimeSeconds)}
        </summary>
        <div className="inner">
          <div className="adm-kv">
            {Object.entries(data.metrics.counters || {}).map(([k, v]) => (
              <div key={k}><span>{k}</span><b>{v}</b></div>
            ))}
            {Object.entries(data.metrics.latency || {}).map(([k, v]) => (
              <div key={k}><span>{k}</span><b>{v.avgMs} ms avg</b></div>
            ))}
            {Object.keys(data.metrics.counters || {}).length === 0 && Object.keys(data.metrics.latency || {}).length === 0 && (
              <div><span>no metrics yet</span><b>—</b></div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------- Root */

export default function Admin() {
  const [session, setSession] = useState(null); // null = loading

  const checkSession = useCallback(async () => {
    try {
      setSession(await api('/api/admin/session'));
    } catch (_) {
      setSession({ enabled: true, authenticated: false });
    }
  }, []);

  useEffect(() => {
    document.title = 'FebBox Addon — Admin';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex,nofollow';
    document.head.appendChild(meta);
    checkSession();
    return () => meta.remove();
  }, [checkSession]);

  if (!session) return null;
  if (!session.authenticated) {
    return <Login enabled={session.enabled} onSuccess={() => setSession({ enabled: true, authenticated: true })} />;
  }
  return <Dashboard onSignedOut={() => setSession({ enabled: true, authenticated: false })} />;
}
