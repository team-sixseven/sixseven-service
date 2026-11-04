import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, setToken } from '../api';
import { PulseIcon } from '../icons';

export function Login({ onLogin, expired }: { onLogin: (token: string) => void; expired: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(expired ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : '');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const [res] = await Promise.all([
        api<{ token: string }>('/auth/login', { method: 'POST', body: { username, password } }),
        new Promise((r) => setTimeout(r, 700)),
      ]);
      setLeaving(true);
      setToken(res.token);
      setTimeout(() => onLogin(res.token), 280);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '서버에 연결할 수 없습니다.');
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className={`login${leaving ? ' leaving' : ''}`}>
      <div className="login-wrap">
      <div className="login-brand"><span className="mark"><PulseIcon /></span><b>SCD 위험 알림</b><span>심장내과 외래 · 심부전 클리닉</span></div>
      <form className="login-card" onSubmit={submit}>
        <h1>로그인</h1>
        <label>아이디<input ref={first} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
        <label>비밀번호<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn-primary" disabled={busy}>{busy ? <><span className="spinner" />로그인 중…</> : '로그인'}</button>
      </form>
      <p className="login-note">승인된 의료진과 관리자만 이용할 수 있습니다.</p>
      </div>
    </div>
  );
}
