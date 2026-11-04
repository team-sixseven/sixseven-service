import type { Alert, Band, PatientSummary } from './types';

export const points = (score: number | null | undefined) => (score == null ? null : Math.round(score * 100));
export const BAND_LABEL: Record<Band, string> = { high: '고위험', mid: '중간', low: '낮음' };

const pad = (n: number) => String(n).padStart(2, '0');
export const hm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const ymd = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
export const stamp = (iso: string) => `${ymd(iso)} ${hm(iso)}`;
export const shortStamp = (iso: string) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm(iso)}`; };
export function recentLabel(iso: string) {
  const d = new Date(iso), n = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  return diff === 0 ? hm(iso) : diff === 1 ? `어제 ${hm(iso)}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}
export const hoursLabel = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`; };

export type Chip = '미확인' | '미조치' | '완료' | '불필요' | null;
export function chip(a: Alert | null): Chip {
  if (!a) return null;
  if (a.status === 'done') return a.skip ? '불필요' : '완료';
  return a.status === 'new' && !a.seen ? '미확인' : '미조치';
}
export const isUnseen = (a: Alert | null) => !!a && a.status === 'new' && !a.seen;
export const isPending = (a: Alert | null) => !!a && a.status !== 'done';

export type SortKey = 'action' | 'risk' | 'recent' | 'name';
export const SORT_LABEL: Record<SortKey, string> = { action: '조치 우선', risk: '위험 점수 높은 순', recent: '최신순', name: '이름순' };

export function sortPatients(list: PatientSummary[], sort: SortKey): PatientSummary[] {
  const rank = (p: PatientSummary) => (isUnseen(p.alert) ? 0 : isPending(p.alert) ? 1 : p.latest.analyzed_at ? 2 : 3);
  const score = (p: PatientSummary) => (p.latest.analyzed_at ? (p.latest.score ?? -1) : -1);
  const at = (p: PatientSummary) => (p.latest.analyzed_at ? Date.parse(p.latest.analyzed_at) : -Infinity);
  return [...list].sort((a, b) =>
    sort === 'risk' ? score(b) - score(a)
    : sort === 'name' ? a.name.localeCompare(b.name, 'ko')
    : sort === 'recent' ? at(b) - at(a)
    : rank(a) - rank(b) || score(b) - score(a));
}

export const ACTS = ['외래 일정 앞당김', 'ICD 평가 의뢰', '추가 검사(심장초음파 등)', '약물 조정 검토', '경과 관찰', '기타'];
export const SKIP_REASONS = ['임상적으로 위험이 낮다고 판단', '이미 관련 조치 중(약물 조정 등)', '심전도 기록 품질 문제(잡음·탈락)', '기타'];
export const actText = (a: Alert) => a.skip
  ? `조치 불필요 · ${a.reason ?? ''}${a.skip_note ? ` (${a.skip_note})` : ''}`
  : a.acts.map((x) => (x === '기타' && a.other_text ? `기타(${a.other_text})` : x)).join(', ');
