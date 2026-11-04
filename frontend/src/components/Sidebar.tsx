import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { FilterIcon, SearchIcon, SyncIcon } from '../icons';
import { chip, isUnseen, points, recentLabel, SORT_LABEL, sortPatients, type SortKey } from '../format';
import type { PatientSummary, QueueState } from '../types';
import { useUi } from '../ui';
import { Modal } from './Modal';

export function recordLine(p: PatientSummary): { text: string; tone?: 'blue' | 'muted' } {
  const l = p.latest;
  switch (l.record_status) {
    case 'waiting': return { text: '기록 대기 · 미수신', tone: 'muted' };
    case 'queued': return { text: `기록 수신 · 분석 대기 ${l.queue_pos ?? ''}번째`, tone: 'blue' };
    case 'analyzing': return { text: '분석 중' };
    case 'held': return { text: l.hold_reason === 'ineligible' ? '모델 대상 아님 · 계산 보류' : `${(l.missing ?? []).join(', ')} 없음 · 계산 보류` };
    case 'failed': return { text: '분석 실패' };
    default: return { text: l.analyzed_at ? `마지막 분석 ${recentLabel(l.analyzed_at)}` : '' };
  }
}

function Tile({ p }: { p: PatientSummary }) {
  const l = p.latest;
  if (l.record_status === 'waiting') return <span className="tile tile-empty">—</span>;
  if (l.record_status === 'queued') return <span className="tile tile-queue">대기</span>;
  if (l.record_status === 'analyzing') return <span className="tile tile-wave" aria-label="분석 중"><i /><i /><i /></span>;
  if (l.record_status === 'held') return <span className="tile tile-held">보류</span>;
  if (l.record_status === 'failed') return <span className="tile tile-held">실패</span>;
  return <span className={`tile${l.band === 'high' ? ' tile-high' : ''}`}>{points(l.score)}</span>;
}

export function PatientRow({ p, selected, onPick, delay, flash }: { p: PatientSummary; selected?: boolean; onPick: () => void; delay?: number; flash?: boolean }) {
  const c = chip(p.alert);
  const line = recordLine(p);
  const pending = !!p.alert && p.alert.status !== 'done';
  return (
    <button className={`prow${selected ? ' selected' : ''}${pending ? ' pending' : ''}${flash ? ' flash' : ''}`} onClick={onPick}
      style={delay != null ? { animationDelay: `${delay}ms` } : undefined} aria-current={selected || undefined}>
      <Tile p={p} />
      <span className="prow-main">
        <span className="prow-name"><b>{p.name}</b>{isUnseen(p.alert) && <i className="dot" aria-label="미확인" />}</span>
        <span className="prow-meta">{p.age}세 {p.sex === 'M' ? '남' : '여'} · NYHA {p.nyha}</span>
        <span className={`prow-line ${line.tone ?? ''}`}>{line.text}</span>
      </span>
      {c && <span className={`chip ${c === '미확인' ? 'chip-solid' : c === '미조치' ? 'chip-line' : 'chip-gray'}`}>{c}</span>}
    </button>
  );
}

export function Sidebar({ sort, setSort }: { sort: SortKey; setSort: (s: SortKey) => void }) {
  const { selectedId, select, openModal, query, setQuery, sync, syncing } = useUi();
  const { data: patients = [] } = useQuery({ queryKey: ['patients'], queryFn: () => api<PatientSummary[]>('/patients') });
  const { data: queue } = useQuery({ queryKey: ['queue'], queryFn: () => api<QueueState>('/queue') });
  const [menu, setMenu] = useState(false);
  const [stagger, setStagger] = useState(0);
  const [flashing, setFlashing] = useState<Record<string, boolean>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const defaultState = sort === 'action' && !query;

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // 새 알림이 오면 그 행이 붉게 한 번 깜박입니다.
  useEffect(() => {
    const unseenIds = new Set(patients.filter((p) => isUnseen(p.alert)).map((p) => p.id));
    if (seen.current) {
      const fresh = [...unseenIds].filter((id) => !seen.current!.has(id));
      if (fresh.length) { setFlashing((f) => ({ ...f, ...Object.fromEntries(fresh.map((id) => [id, true])) })); setTimeout(() => setFlashing({}), 1500); }
    }
    seen.current = unseenIds;
  }, [patients]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? patients.filter((p) => p.name.toLowerCase().includes(q) || p.mrn.includes(q)) : patients;
    return sortPatients(filtered, sort);
  }, [patients, query, sort]);

  const pick = (s: SortKey) => { setSort(s); setStagger((n) => n + 1); setMenu(false); };
  const reset = () => { setSort('action'); setQuery(''); setStagger((n) => n + 1); setMenu(false); };

  return (
    <aside className="sidebar" aria-label="담당 환자">
      <div className="sidebar-head">
        <h2>담당 환자</h2>
        <div className="sidebar-tools">
          <button className="tool-btn" onClick={(e) => openModal({ type: 'search' }, e.currentTarget)} aria-label="환자 검색" title="환자 검색"><SearchIcon /></button>
          <div className="anchor" ref={menuRef}>
            <button className="tool-btn" onClick={() => setMenu(!menu)} aria-label="정렬·필터" title="정렬·필터" aria-expanded={menu}><FilterIcon /></button>
            {menu && (
              <div className="dropdown filter-menu" role="menu">
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <button key={k} role="menuitemradio" aria-checked={sort === k} className={sort === k ? 'on' : ''} onClick={() => pick(k)}>{SORT_LABEL[k]}</button>
                ))}
                <hr /><button role="menuitem" disabled={defaultState} onClick={reset}>필터 초기화</button>
              </div>
            )}
          </div>
          <button className={`tool-btn${syncing ? ' spin' : ''}`} onClick={sync} disabled={syncing} aria-label="EMR 동기화" title="EMR 담당 환자 동기화"><SyncIcon /></button>
        </div>
      </div>
      <div key={stagger} className={`sort-line${stagger ? ' hl' : ''}`}>정렬 · {SORT_LABEL[sort]}{query && ` · “${query}”`}</div>
      {queue && (queue.analyzing || queue.queued.length > 0) && (
        <div className="queue-line" role="status">분석 대기열 · {queue.analyzing ? `${queue.analyzing.name} 분석 중` : '대기 중'} · 대기 {queue.queued.length}건</div>
      )}
      <div className="plist" key={`list-${stagger}`}>
        {list.map((p, i) => (
          <PatientRow key={p.id} p={p} selected={p.id === selectedId} onPick={() => select(p.id)} delay={stagger ? Math.min(i, 9) * 28 : undefined} flash={flashing[p.id]} />
        ))}
        {list.length === 0 && <p className="empty">{patients.length ? '검색 결과가 없습니다.' : '담당 환자가 없습니다. 동기화 버튼을 눌러 주세요.'}</p>}
      </div>
    </aside>
  );
}

export function SearchModal() {
  const { query, setQuery, select, closeModal } = useUi();
  const { data: patients = [] } = useQuery({ queryKey: ['patients'], queryFn: () => api<PatientSummary[]>('/patients') });
  const q = query.trim().toLowerCase();
  const hits = patients.filter((p) => !q || p.name.toLowerCase().includes(q) || p.mrn.includes(q));
  return (
    <Modal title="검색" label="환자 검색" variant="search-modal">
      <input autoFocus className="search-input" placeholder="이름 또는 등록번호" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="이름 또는 등록번호" />
      <div className="search-list">
        {hits.map((p) => (
          <button key={p.id} className="search-item" onClick={() => { select(p.id); closeModal(); }}>
            <b>{p.name}</b><span>{p.mrn} · {p.age}세 {p.sex === 'M' ? '남' : '여'}</span>
          </button>
        ))}
        {hits.length === 0 && <p className="empty">검색 결과가 없습니다.</p>}
      </div>
    </Modal>
  );
}
