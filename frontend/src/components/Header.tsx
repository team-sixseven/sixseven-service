import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { AlertIcon, BellIcon, CloseIcon, GearIcon, MoonIcon, PulseIcon, SunIcon, UserIcon } from '../icons';
import { actText, isPending, isUnseen, points, shortStamp } from '../format';
import type { PatientSummary } from '../types';
import { useUi } from '../ui';

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

export function Header({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const { user, select, openModal, logout } = useUi();
  const { data: patients = [] } = useQuery({ queryKey: ['patients'], queryFn: () => api<PatientSummary[]>('/patients') });
  const [inbox, setInbox] = useState(false);
  const [menu, setMenu] = useState(false);
  const closeInbox = () => setInbox(false);
  const closeMenu = () => setMenu(false);
  const inboxRef = useOutside(inbox, closeInbox);
  const menuRef = useOutside(menu, closeMenu);

  const alerts = patients.filter((p) => isPending(p.alert)).sort((a, b) => b.alert!.sent_at.localeCompare(a.alert!.sent_at));
  const archive = patients.filter((p) => p.alert?.status === 'done' && Date.now() - Date.parse(p.alert.sent_at) <= 30 * 86400000)
    .sort((a, b) => b.alert!.sent_at.localeCompare(a.alert!.sent_at));
  const unseen = alerts.filter((p) => isUnseen(p.alert)).length;
  const prevUnseen = useRef(unseen);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (unseen > prevUnseen.current) { setBump(true); setTimeout(() => setBump(false), 900); }
    prevUnseen.current = unseen;
  }, [unseen]);

  return (
    <header className="app-header">
      <div className="brand"><span className="mark"><PulseIcon /></span><span className="brand-text">심장내과 외래 · 심부전 클리닉</span></div>
      <div className="header-actions">
        <button className="icon-btn" onClick={toggleDark} aria-label={dark ? '라이트 모드' : '다크 모드'} data-tip={dark ? '라이트 모드' : '다크 모드'} aria-pressed={dark}>{dark ? <SunIcon /> : <MoonIcon />}</button>
        <div className="anchor" ref={inboxRef}>
          <button className={`icon-btn${bump ? ' bell-ring' : ''}`} onClick={() => { setInbox(!inbox); setMenu(false); }} aria-label={`알림함, 확인 전 ${unseen}건`} data-tip="알림함" aria-expanded={inbox}>
            <BellIcon />{unseen > 0 && <span className={`badge${bump ? ' pop' : ''}`}>{unseen}</span>}
          </button>
          {inbox && (
            <div className="dropdown inbox" role="dialog" aria-label="알림함">
              <div className="dropdown-head"><b>알림함 · 확인 전 {unseen}건</b>
                <button className="icon-btn small" onClick={closeInbox} aria-label="닫기"><CloseIcon /></button></div>
              {alerts.length === 0 && <p className="empty">처리할 알림이 없습니다.</p>}
              {alerts.map((p) => (
                <button key={p.id} className={`inbox-item${isUnseen(p.alert) ? ' unseen' : ''}`} onClick={() => { select(p.id); closeInbox(); }}>
                  <span className="inbox-meta"><span>SCD 위험 알림 · 자동 발송</span><time>{shortStamp(p.alert!.sent_at)}</time></span>
                  <span className="inbox-title"><AlertIcon />{p.name} · 위험 점수 {points(p.latest.score)}점</span>
                  <span className="inbox-preview">Holter 분석 결과를 확인해 주세요.</span>
                  <span className="inbox-state">{isUnseen(p.alert) ? '미확인' : '미조치'}{p.alert!.re >= 2 ? ' · 당직의 전달' : p.alert!.re === 1 ? ' · 재알림' : ''}</span>
                </button>
              ))}
              <div className="inbox-archive-title">지난 알림 · 최근 30일</div>
              {archive.map((p) => <button key={p.id} className="inbox-item archived" onClick={() => { select(p.id); closeInbox(); }}>
                <span className="inbox-meta"><span>SCD 위험 알림 · 자동 발송</span><time>{shortStamp(p.alert!.sent_at)}</time></span>
                <span className="inbox-title"><AlertIcon />{p.name} · 위험 점수 {points(p.latest.score)}점</span>
                <span className="muted small">{actText(p.alert!)}</span>
              </button>)}
            </div>
          )}
        </div>
        <button className="icon-btn" onClick={(e) => openModal({ type: 'settings' }, e.currentTarget)} aria-label="알림 설정" data-tip="알림 설정"><GearIcon /></button>
        <div className="anchor" ref={menuRef}>
          <button className={`icon-btn profile${user.role === 'admin' ? ' admin' : ''}`} onClick={() => { setMenu(!menu); setInbox(false); }} aria-label="계정 메뉴" title="계정" aria-expanded={menu}><UserIcon /></button>
          {menu && (
            <div className="dropdown account" role="menu">
              <div className="account-id"><b>{user.name}</b><span>{user.role === 'attending' ? `담당의 · ${user.dept ?? ''}` : user.role_label}</span></div>
              {user.role === 'admin' && (<>
                <button role="menuitem" onClick={(e) => { closeMenu(); openModal({ type: 'admin', tab: 'model' }, e.currentTarget); }}>모델 설정</button>
                <button role="menuitem" onClick={(e) => { closeMenu(); openModal({ type: 'admin', tab: 'logs' }, e.currentTarget); }}>시스템 처리기록</button>
              </>)}
              <button role="menuitem" onClick={() => { closeMenu(); logout(); }}>로그아웃</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
