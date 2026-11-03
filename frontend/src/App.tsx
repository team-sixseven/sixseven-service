import { useQuery } from '@tanstack/react-query';
import { getServiceStatus } from './api';

export function App() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['service-status'],
    queryFn: ({ signal }) => getServiceStatus(signal),
  });
  const state = isFetching ? 'loading' : error ? 'error' : data ? 'ready' : 'loading';

  return (
    <div className="app-shell">
      <header className="app-header"><span className="brand">SIXSEVEN</span></header>
      <main>
        <div className="page-heading">
          <h1>서비스 연결 상태</h1>
          <button onClick={() => void refetch()} disabled={isFetching}>다시 확인</button>
        </div>
        <section className="status-card" aria-label="연결 상태" aria-live="polite">
          <div className="status-row">
            <h2>백엔드</h2>
            <span className={`status status--${state}`}>
              {state === 'ready' ? '연결됨' : state === 'loading' ? '확인 중' : '연결 실패'}
            </span>
          </div>
          <div className="status-row">
            <h2>데이터베이스</h2>
            <span className="status">{state === 'ready' ? data?.database : '확인 전'}</span>
          </div>
          <div className="status-row">
            <h2>AI 모델</h2>
            <span className="status">{state === 'ready' ? data?.model : '확인 전'}</span>
          </div>
          {state === 'error' && <p className="error-message" role="alert">{error?.message}</p>}
        </section>
        <a className="api-link" href="/api/docs" target="_blank" rel="noreferrer">API 문서 열기 ↗</a>
      </main>
      <footer>식스세븐 · 식스레터스 PoC</footer>
    </div>
  );
}
