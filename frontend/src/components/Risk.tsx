import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { InfoIcon } from '../icons';
import { api } from '../api';
import { BAND_LABEL, points, ymd } from '../format';
import type { AnalysisDetail, Exam, Factor } from '../types';
import { useUi } from '../ui';

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 환자·검사를 바꿀 때마다 0에서 목표 값까지 올라가는 숫자 */
function useCountUp(target: number, key: string) {
  const [value, setValue] = useState(reduced() ? target : 0);
  useEffect(() => {
    if (reduced()) { setValue(target); return; }
    let raf = 0;
    const start = performance.now();
    const duration = 550 + Math.min(target, 100) * 6;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      setValue(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    setValue(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, key]);
  return value;
}

function Trend({ exams, current, thr, onPick }: { exams: Exam[]; current: string; thr: number; onPick: (id: string) => void }) {
  const [pulse, setPulse] = useState<string | null>(null);
  const list = [...exams].reverse();
  if (list.length < 2) return <p className="empty-panel">검사가 2건 이상 쌓이면 위험 점수 추이를 그래프로 보여 줍니다.</p>;
  const pts = list.map((e) => Math.round(e.score * 100));
  const t = Math.round(thr * 100);
  const lo = Math.max(0, Math.floor((Math.min(...pts, t) - 5) / 5) * 5);
  const hi = Math.min(100, Math.ceil((Math.max(...pts, t) + 5) / 5) * 5);
  const x = (i: number) => i / (list.length - 1) * 100;
  const y = (v: number) => (hi - v) / Math.max(hi - lo, 1) * 100;
  const path = list.map((_, i) => `${i ? 'L' : 'M'}${x(i) * 10},${y(pts[i]) * 2}`).join(' ');
  return <div className="trend-wrap" aria-label="위험 점수 추이 그래프">
    <div className="trend-chart">
      <span className="trend-axis axis-hi">{hi}점</span><span className="trend-axis axis-lo">{lo}점</span>
      <span className="trend-axis axis-threshold" style={{ top: `calc(${y(t)}% - 9px)` }}>기준 {t}점</span>
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 0H1000M0 100H1000M0 200H1000" className="trend-grid" />
        <path d={`${path} L1000,200 L0,200 Z`} className="trend-area" />
        <path d={`M0,${y(t) * 2}H1000`} className="trend-thr" />
        <path d={path} className="trend-line" />
      </svg>
      {list.map((e, i) => <button key={e.analysis_id} className={`chart-point${e.analysis_id === current ? ' on' : ''}`} style={{ left: `${x(i)}%`, top: `${y(pts[i])}%` }}
        aria-label={`${ymd(e.at)} 위험 점수 ${pts[i]}점${e.latest ? ' (최신)' : ''}`} aria-pressed={e.analysis_id === current}
        data-tip={`${ymd(e.at)} · 위험 점수 ${pts[i]}점${e.latest ? ' · 최신' : ''}`}
        onClick={() => { setPulse(e.analysis_id); setTimeout(() => setPulse(null), 650); onPick(e.analysis_id); }}>
        <span className="chart-value">{pts[i]}점</span>{pulse === e.analysis_id && <span className="chart-ripple" />}<span className="chart-dot" />
      </button>)}
    </div>
    <div className="trend-dates" aria-hidden="true">{list.map((e, i) => <span key={e.analysis_id} style={{ left: `${x(i)}%` }}>{ymd(e.at).slice(5)}</span>)}</div>
  </div>;
}

const barWidth = (c: number) => `${Math.min(Math.abs(c) / 0.3, 1) * 50}%`;

function Bar({ c }: { c: number }) {
  return (
    <span className="fbar" aria-hidden="true">
      <i className="fbar-zero" />
      <i className={`fbar-fill ${c >= 0 ? 'up' : 'down'}`} style={c >= 0 ? { left: '50%', width: barWidth(c) } : { right: '50%', width: barWidth(c) }} />
    </span>
  );
}

function Factors({ factors }: { factors: Factor[] }) {
  return (
    <div className="factors">
      <div className="frow fhead"><span>요인</span><span>이 환자 측정값</span><span className="fscale"><span>← 위험 낮춤</span><b>0</b><span>위험 높임 →</span></span></div>
      {factors.map((f) => {
        const dir = f.contribution >= 0 ? '위험을 높임' : '위험을 낮춤';
        return (
          <div key={f.key} className="frow" tabIndex={0} aria-label={`${f.name}, 측정값 ${f.value_text}, 기여도 ${f.contribution.toFixed(2)}, ${dir}`}>
            <span className="fname">{f.name}{f.group === 'holter' && <small>Holter</small>}</span>
            <span className="fval">{f.value_text}</span>
            <Bar c={f.contribution} />
            <span className="tip" role="tooltip"><b>{f.name}</b><span>측정값 {f.value_text}</span><span>기여도 {f.contribution > 0 ? '+' : ''}{f.contribution.toFixed(2)} · {dir}</span></span>
          </div>
        );
      })}
      <p className="muted small">요인에 마우스를 올리면 상세 정보가 보입니다.</p>
    </div>
  );
}

function Changes({ now, prev }: { now: Factor[]; prev: Factor[] | undefined }) {
  if (!prev) return <p className="empty-panel">직전 검사가 없어 요인 변화를 비교할 수 없습니다.</p>;
  const before = new Map(prev.map((f) => [f.key, f.contribution]));
  const rows = now.map((f) => ({ f, d: f.contribution - (before.get(f.key) ?? 0), b: before.get(f.key) ?? 0 }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 6);
  return (
    <div className="changes">
      <div className="crow chead"><span>요인</span><span className="fscale"><span>← 낮춤</span><span>0</span><span>높임 →</span></span><span>기여도 변화</span></div>
      {rows.map(({ f, d, b }) => (
        <div key={f.key} className="crow">
          <span className="fname">{f.name}{f.group === 'holter' && <small>Holter</small>}</span>
          <span className="cbars"><Bar c={b} /><Bar c={f.contribution} /></span>
          <span className={`cdelta${d > 0.005 ? ' up' : ''}`}>{Math.abs(d) < 0.005 ? '–' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)}`}</span>
        </div>
      ))}
    </div>
  );
}

export function RiskPanel({ analysisId, exams, onPick, isLatest }: { analysisId: string; exams: Exam[]; onPick: (id: string) => void; isLatest: boolean }) {
  const { openModal } = useUi();
  const { data } = useQuery({ queryKey: ['analysis', analysisId], queryFn: () => api<AnalysisDetail>(`/analyses/${analysisId}`) });
  const score = data ? points(data.analysis.score) ?? 0 : 0;
  const shown = useCountUp(score, analysisId);
  if (!data) return <div className="card"><p className="muted">불러오는 중…</p></div>;
  const a = data.analysis;
  const high = a.band === 'high';
  const exam = exams.find((e) => e.analysis_id === analysisId);
  return (
    <div className="card risk" key={analysisId}>
      <h3 className="sub-h">4년 이내 SCD 위험 점수{!isLatest && exam && <span className="sub-note"> · {ymd(exam.at)} 검사 기준</span>}</h3>
      <div className="score-row">
        <span className={`score-num${high ? ' high' : ''}`}>{shown}</span><span className="score-unit">점</span>
        <span className={`band band-${a.band}`}>{BAND_LABEL[a.band]}</span>
        <button className="link model-link" onClick={(e) => openModal({ type: 'model' }, e.currentTarget)}><InfoIcon />모델 정보</button>
      </div>
      <div className="gauge" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="위험 점수">
        <i className={`gauge-fill${high ? ' high' : ''}`} style={{ width: `${shown}%` }} />
        <i className="gauge-thr" style={{ left: `${data.threshold * 100}%` }} title={`알림 기준 ${Math.round(data.threshold * 100)}점`} />
      </div>
      <section className="risk-section" aria-label="위험 점수 추이">
      <div className="section-head"><h3 className="sub-h">위험 점수 추이 <small className="sub-note">검사 {exams.length}건</small></h3><span className="muted small">점을 누르면 그 검사 결과를 봅니다</span></div>
      <Trend exams={exams} current={analysisId} thr={data.threshold} onPick={onPick} />
      </section>
      <section className="risk-section" aria-label="위험 점수에 영향을 준 요인">
      <h3 className="sub-h">위험 점수에 영향을 준 요인 <small className="sub-aside">환자별 변수 기여도(SHAP)</small></h3>
      <Factors factors={a.factors} />
      </section>
      <section className="risk-section" aria-label="요인 변화">
      <div className="section-head"><h3 className="sub-h">요인 변화</h3>{data.previous && <span className="change-legend"><span>직전</span><span>이번</span></span>}</div>
      <Changes now={a.factors} prev={data.previous?.factors} />
      </section>
      <p className="muted small">알림 기준 {Math.round(data.threshold * 100)}점 · {data.disclaimer}</p>
    </div>
  );
}
