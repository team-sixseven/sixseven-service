import { AlertIcon } from '../icons';

export interface Toast { key: string; patientId: string; name: string; score: number; leaving?: boolean }

export function ToastStack({ toasts, onView, onDismiss }: { toasts: Toast[]; onView: (t: Toast) => void; onDismiss: (t: Toast) => void }) {
  const visible = toasts.slice(0, 3);
  const more = toasts.length - visible.length;
  return (
    <div className="toast-stack" aria-live="assertive">
      {visible.map((t) => (
        <div key={t.key} className={`toast${t.leaving ? ' leaving' : ''}`} role="alert">
          <div className="toast-head"><AlertIcon /><b>고위험 알림</b></div>
          <p className="toast-title">{t.name} · 위험 점수 {Math.round(t.score * 100)}점</p>
          <p className="toast-sub">Holter 분석이 끝났습니다. 휴대폰 앱으로도 발송했습니다.</p>
          <div className="toast-actions">
            <button className="btn-danger" onClick={() => onView(t)}>환자 보기</button>
            <button className="btn-ghost" onClick={() => onDismiss(t)}>나중에</button>
          </div>
        </div>
      ))}
      {more > 0 && <div className="toast-more">고위험 알림 {more}건 더 · 알림함에서 확인</div>}
    </div>
  );
}

export function Snackbar({ message }: { message: string | null }) {
  return <div className={`snackbar${message ? ' show' : ''}`} role="status" aria-live="polite">{message}</div>;
}
