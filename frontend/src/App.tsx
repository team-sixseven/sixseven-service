import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, connectEvents, getToken, setToken, setUnauthorizedHandler } from './api';
import { PatientView as Detail } from './components/Detail';
import { sortPatients, type SortKey } from './format';
import type { PatientSummary, ServerEvent, User } from './types';
import { UiContext, type ModalState, type Ui } from './ui';
import { Header } from './components/Header';
import { Login } from './components/Login';
import { ActionModal, AdminModal, DemoModal, ModelModal, SettingsModal } from './components/Modals';
import { SearchModal, Sidebar } from './components/Sidebar';
import { Snackbar, ToastStack, type Toast } from './components/Toasts';

export function App() {
  const qc = useQueryClient();
  const [token, setTok] = useState(getToken());
  const [expired, setExpired] = useState(false);
  useEffect(() => setUnauthorizedHandler(() => { setToken(null); setTok(null); setExpired(true); qc.clear(); }), [qc]);
  if (!token) return <Login expired={expired} onLogin={(t) => { setExpired(false); setTok(t); }} />;
  return <Main key={token} onLoggedOut={() => { setToken(null); setTok(null); qc.clear(); }} />;
}

const patientFromUrl = () => new URLSearchParams(location.search).get('patient');

function Main({ onLoggedOut }: { onLoggedOut: () => void }) {
  const qc = useQueryClient();
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => api<User>('/me') });
  const { data: patients } = useQuery({ queryKey: ['patients'], queryFn: () => api<PatientSummary[]>('/patients') });
  const [selectedId, setSelectedId] = useState<string | null>(patientFromUrl());
  const [sort, setSort] = useState<SortKey>('action');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');
  const snackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const patientsRef = useRef<PatientSummary[]>([]);
  patientsRef.current = patients ?? [];

  const snack = useCallback((m: string) => {
    setMessage(m);
    clearTimeout(snackTimer.current);
    snackTimer.current = setTimeout(() => setMessage(null), 2900);
  }, []);

  const dismissToast = useCallback((key: string) => {
    setToasts((t) => t.map((x) => (x.key === key ? { ...x, leaving: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), 380);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    const url = new URL(location.href);
    id ? url.searchParams.set('patient', id) : url.searchParams.delete('patient');
    history.replaceState(null, '', url);
    if (id) setToasts((t) => t.map((x) => x.patientId === id ? { ...x, leaving: true } : x));
    if (id) setTimeout(() => setToasts((t) => t.filter((x) => x.patientId !== id || !x.leaving)), 380);
  }, [dismissToast]);

  // 처음 열면 조치 전 환자 중 첫 번째를 보여 줍니다.
  useEffect(() => {
    if (selectedId || !patients?.length) return;
    select(sortPatients(patients, 'action')[0].id);
  }, [patients, selectedId, select]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* 이미 만료됨 */ }
    onLoggedOut();
  }, [onLoggedOut]);

  // 실시간 이벤트
  useEffect(() => {
    const nameOf = (id: string) => patientsRef.current.find((p) => p.id === id)?.name ?? '환자';
    const refresh = (pid?: string) => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
      void qc.invalidateQueries({ queryKey: ['queue'] });
      if (pid) void qc.invalidateQueries({ queryKey: ['patient', pid] });
    };
    const onEvent = (e: ServerEvent) => {
      const d = e.data ?? {};
      switch (e.type) {
        case 'hello': void qc.invalidateQueries(); break;
        case 'settings.updated':
          void qc.invalidateQueries({ queryKey: ['settings'] });
          void qc.invalidateQueries({ queryKey: ['analysis'] });
          break;
        case 'analysis.queued': refresh(d.patient_id); snack(`판독실에서 ${nameOf(d.patient_id)} 판독 결과가 들어왔습니다. 순서대로 분석합니다.`); break;
        case 'analysis.started': case 'analysis.progress': case 'analysis.held': case 'analysis.failed': refresh(d.patient_id); break;
        case 'analysis.completed': refresh(d.patient_id); void qc.invalidateQueries({ queryKey: ['analysis'] }); break;
        case 'alert.created':
          refresh(d.patient_id);
          setToasts((t) => [{ key: d.alert.id, patientId: d.patient_id, name: d.name, score: d.score }, ...t.filter((x) => x.patientId !== d.patient_id)]);
          break;
        case 'alert.updated': case 'alert.reminded': case 'alert.escalated':
          refresh(d.patient_id); void qc.invalidateQueries({ queryKey: ['analysis'] });
          if (e.type !== 'alert.updated') snack(e.type === 'alert.reminded' ? '확인하지 않은 알림을 다시 알렸습니다.' : '확인하지 않은 알림을 당직의에게 전달했습니다.');
          break;
        case 'log.created': void qc.invalidateQueries({ queryKey: ['logs'] }); break;
        case 'patients.synced': void qc.invalidateQueries({ queryKey: ['patients'] }); break;
        case 'demo.reset': setToasts([]); void qc.invalidateQueries(); break;
      }
    };
    return connectEvents(onEvent, () => { setToken(null); onLoggedOut(); });
  }, [qc, snack, onLoggedOut]);

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* 저장 불가 */ } }, [dark]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const r = await api<{ added: unknown[] }>('/patients/sync', { method: 'POST' });
      snack(r.added.length ? `병원 전산(EMR)에서 새 담당 환자 ${r.added.length}명을 불러왔습니다. Holter 기록은 판독실에서 들어오면 자동으로 분석합니다.` : '담당 환자 목록이 이미 최신 상태입니다.');
      void qc.invalidateQueries({ queryKey: ['patients'] });
    } catch (e) { snack(e instanceof ApiError ? e.message : '동기화하지 못했습니다.'); }
    setTimeout(() => setSyncing(false), 1300);
  }, [qc, snack]);

  // 시연 보조 단축키 (관리자 + 시연 모드)
  useEffect(() => {
    if (!user || user.role !== 'admin' || !user.demo_mode) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.code === 'KeyD') { e.preventDefault(); setModal((m) => m?.type === 'demo' ? null : { type: 'demo' }); return; }
      const calls: Record<string, [string, string]> = {
        KeyN: ['/admin/demo/arrive', '다음 시연 기록을 받았습니다.'], KeyH: ['/admin/demo/arrive?high=true', '고위험 시연 기록을 받았습니다.'],
        KeyS: [`/admin/demo/arrive?patient=${selectedId ?? ''}`, '선택한 환자의 시연 기록을 받았습니다.'], KeyA: ['/admin/demo/arrive?all=true', '남은 시연 기록을 모두 받았습니다.'],
        KeyT: ['/admin/demo/advance?min=30', '30분이 지난 것으로 처리했습니다.'], KeyR: ['/admin/demo/reset', '처음 상태로 되돌렸습니다.'],
      };
      const call = calls[e.code];
      if (call) { e.preventDefault(); api(call[0], { method: 'POST' }).then(() => snack(call[1])).catch((err) => snack(err.message)); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [user, selectedId, snack]);

  const ui: Ui | null = useMemo(() => user ? ({
    user, selectedId, select, snack, modal, origin, logout, sort, query, setQuery, syncing, sync,
    openModal: (m, from) => {
      const r = from?.getBoundingClientRect();
      setOrigin(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
      setModal(m);
    },
    closeModal: () => setModal(null),
  }) : null, [user, selectedId, select, snack, modal, origin, logout, sort, query, syncing, sync]);

  if (!ui) return null;
  return (
    <UiContext.Provider value={ui}>
      <div className="app">
        <Header dark={dark} toggleDark={() => setDark(!dark)} />
        <div className="layout">
          <Sidebar sort={sort} setSort={setSort} />
          <main className="content">{selectedId ? <Detail id={selectedId} /> : <p className="muted pad">담당 환자를 선택해 주세요.</p>}</main>
        </div>
        <ToastStack toasts={toasts}
          onView={(t) => { select(t.patientId); dismissToast(t.key); }} onDismiss={(t) => dismissToast(t.key)} />
        <Snackbar message={message} />
        {modal?.type === 'search' && <SearchModal />}
        {modal?.type === 'settings' && <SettingsModal />}
        {modal?.type === 'model' && <ModelModal />}
        {modal?.type === 'admin' && <AdminModal tab={modal.tab} />}
        {modal?.type === 'demo' && user?.role === 'admin' && user.demo_mode && <DemoModal />}
        {modal?.type === 'action' && <ActionModal mode={modal.mode} alertId={modal.alertId} patientId={modal.patientId} />}
      </div>
    </UiContext.Provider>
  );
}
