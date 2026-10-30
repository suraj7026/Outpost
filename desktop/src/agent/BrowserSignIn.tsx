import { useEffect, useRef, useState } from 'react';
import { call } from '../api';

function openAILoopback(value: string) {
  try {
    const url = new URL(value), redirect = new URL(url.searchParams.get('redirect_uri') || '');
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com' &&
      ['127.0.0.1', 'localhost'].includes(redirect.hostname) && redirect.port === '1455' && redirect.pathname === '/auth/callback';
  } catch { return false; }
}

/** Capture a callback on this Mac; Pi on the server still validates PKCE/state and exchanges tokens. */
export default function BrowserSignIn({ url, expiresAt, manualPrompt, disabled, answer }: {
  url: string; expiresAt: number; manualPrompt: boolean; disabled: boolean; answer: (value: string) => void;
}) {
  const [listening, setListening] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), pending = useRef<string | null>(null);
  const latest = useRef({ answer, disabled, manualPrompt });
  latest.current = { answer, disabled, manualPrompt };
  const automatic = openAILoopback(url);
  const cancel = () => {
    const id = pending.current; pending.current = null;
    if (id) void call('oauth_callback_cancel', { id }).catch(() => {});
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; cancel(); }; }, []);
  useEffect(() => { if (disabled || (automatic && !manualPrompt)) { cancel(); setListening(false); } }, [disabled, automatic, manualPrompt]);
  const open = async (capture: boolean) => {
    if (pending.current || disabled || (capture && !manualPrompt)) return;
    setError('');
    if (!capture) {
      try { await call('open_url', { url }); }
      catch { if (alive.current) setError('The browser could not be opened. Try again.'); }
      return;
    }
    const id = crypto.randomUUID(); pending.current = id; setListening(true);
    let stage = 'bind';
    try {
      await call('oauth_callback_start', { id, authorizationUrl: url, expiresAt });
      if (!alive.current || pending.current !== id) { await call('oauth_callback_cancel', { id }); return; }
      const waiting = call<string>('oauth_callback_wait', { id }).then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
      stage = 'open';
      await call('open_url', { url });
      stage = 'wait';
      const result = await waiting;
      if (!alive.current || pending.current !== id || latest.current.disabled || !latest.current.manualPrompt) return;
      if (!result.ok) throw new Error('callback_unavailable');
      // Never render, log, cache or persist the callback URL. It goes straight to the secret IPC path.
      latest.current.answer(result.value);
    } catch {
      if (alive.current && pending.current === id) setError(stage === 'bind'
        ? 'Automatic return could not start. Port 1455 may be in use by another login. Close that login and retry, or open sign-in manually and paste the full redirect URL below.'
        : stage === 'open' ? 'The browser could not be opened. Try again.'
          : 'Browser return expired or was interrupted. Start a fresh sign-in, or paste the full redirect URL below if this sign-in is still active.');
    } finally {
      if (pending.current === id) cancel();
      if (alive.current) setListening(false);
    }
  };
  return <div>
    <button type="button" disabled={disabled || listening || (automatic && !manualPrompt)} onClick={() => void open(automatic)}>
      {listening ? 'Waiting for browser sign-in…' : 'Open provider sign-in'}
    </button>
    {automatic && <p>Outpost receives the browser return on this Mac and sends it securely to Pi on your server. Keep this Settings page open.</p>}
    {listening && <button type="button" onClick={() => { cancel(); setListening(false); }}>Use manual return instead</button>}
    {error && <><p role="alert">{error}</p><button type="button" disabled={disabled} onClick={() => void open(false)}>Open sign-in manually</button></>}
  </div>;
}
