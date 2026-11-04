import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { actText, hm, points, ymd } from '../format';
import type { AnalysisDetail, LogPage, PatientDetail } from '../types';
import { useUi } from '../ui';
import { AnalysisProgress, FailedPanel, HeldPanel, QueueNotice, RecordWaiting } from './Progress';
import { RiskPanel } from './Risk';

function InfoCard({ d, canAct }: { d: PatientDetail; canAct: boolean }) {
  const { openModal } = useUi();
  const a = d.alert;
  return (
    <div className="info">
      <div className="info-row">
        <div>
          <div className="info-name"><b>{d.name}</b><span className="muted">{d.mrn}</span></div>
          <div className="muted info-meta">{d.age}세 · {d.sex === 'M' ? '남' : '여'} · NYHA {d.nyha}{d.next_visit && ` · 다음 외래 ${d.next_visit.slice(5).replace('-', '/')}`}</div>
        </div>
        {canAct && a && a.status !== 'done' && (
          <button className="btn-action" onClick={(e) => openModal({ type: 'action', mode: 'act', alertId: a.id, patientId: d.id }, e.currentTarget)}>조치</button>
        )}
      </div>
      {a && a.status !== 'done' && <p className="muted small">{a.seen ? `알림 확인 ${a.seen_at ? hm(a.seen_at) : ''} · 아직 조치하지 않았습니다` : '확인하지 않은 알림이 있습니다'}</p>}
    </div>
  );
}

function Exams({ d, current, onPick }: { d: PatientDetail; current: string | null; onPick: (id: string | null) => void }) {
  return (
    <section className="exams" aria-label="검사 이력">
      <h3 className="sub-h">검사 이력 <span className="sub-note">{d.exams.length}건</span></h3>
      {d.exams.length === 0 ? <p className="muted">아직 분석된 검사가 없습니다.</p> : (
        <table>
          <thead><tr><th>검사 일시</th><th>위험 점수</th><th>직전 대비</th><th>검사 간격</th><th>주요 요인</th></tr></thead>
          <tbody>
            {d.exams.map((e) => {
              const on = e.analysis_id === (current ?? d.exams[0].analysis_id);
              const delta = e.delta == null ? '–' : Math.round(e.delta * 100) === 0 ? '–' : `${e.delta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(e.delta * 100))}점`;
              return (
                <tr key={e.analysis_id} className={`${e.latest ? 'latest' : ''}${on ? ' on' : ''}`} tabIndex={0} aria-selected={on}
                  onClick={() => onPick(e.latest || on ? null : e.analysis_id)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') onPick(e.latest || on ? null : e.analysis_id); }}>
                  <td><span className="exam-date">{ymd(e.at)}</span><small className="exam-time">{hm(e.at)}</small></td>
                  <td className={`n${e.band === 'high' ? ' up' : ''}`}>{points(e.score)}점</td>
                  <td className={`n${e.delta != null && e.delta > 0 ? ' up' : ''}`}>{delta}</td>
                  <td className="n">{e.gap_days == null ? '–' : `${e.gap_days}일`}</td>
                  <td className="ellipsis" title={e.top_factor_detail ?? e.top_factor ?? ''}>{e.top_factor ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ClinicalLog({ d, analysisId, editable }: { d: PatientDetail; analysisId: string | null; editable: boolean }) {
  const { openModal } = useUi();
  const [all, setAll] = useState(false);
  const { data: detail } = useQuery({ queryKey: ['analysis', analysisId], queryFn: () => api<AnalysisDetail>(`/analyses/${analysisId}`), enabled: !!analysisId });
  const alert = detail?.alert ?? null;
  const { data: logs } = useQuery({
    queryKey: ['logs', 'human', d.id, all ? 'all' : analysisId],
    queryFn: () => api<LogPage>(`/logs?kind=human&patient=${d.id}${!all && analysisId ? `&analysis=${analysisId}` : ''}`),
  });
  return (
    <div className="card clog">
      <div className="clog-head"><h3 className="sub-h">의료진 조치 기록 <span className="sub-note">{all ? '전체 기록' : '검사 기간'}{!all && d.exams[0]?.analysis_id === analysisId ? ' (최신)' : ''}</span></h3>
        <button className="link" onClick={() => setAll(!all)}>{all ? '이 검사 기간만 보기' : '전체 기록 보기'}</button></div>
      <div className="clog-summary">
        {!alert ? <p className="muted">이 검사는 알림 기준 미만이라 알림이 없습니다.</p>
          : alert.status !== 'done' ? <p className="muted">아직 조치하지 않았습니다.</p>
          : (<>
            <div className="summary-row"><span className="summary-label">{alert.skip ? '조치 불필요' : '조치 완료'}</span><div><p>{actText(alert)}</p>{alert.changed_at && <span className="muted small">변경됨 {hm(alert.changed_at)}</span>}</div>
              {editable && <button className="link" onClick={(e) => openModal({ type: 'action', mode: 'change', alertId: alert.id, patientId: d.id }, e.currentTarget)}>조치 수정</button>}</div>
            <div className="summary-row"><span className="summary-label">메모</span><div><p className={!alert.memo ? 'muted' : ''}>{alert.memo || '없음'}</p>{alert.memo && alert.memo_at && <span className="muted small">수정됨 {hm(alert.memo_at)}</span>}</div>
              {editable && <button className="link" onClick={(e) => openModal({ type: 'action', mode: 'memo', alertId: alert.id, patientId: d.id }, e.currentTarget)}>{alert.memo ? '메모 수정' : '메모 추가'}</button>}</div>
          </>)}
      </div>
      <ul className="loglist">
        {(logs?.items ?? []).map((l) => (<li key={l.id}><time>{ymd(l.t).slice(5)} {hm(l.t)}</time><span className="actor">{l.actor}</span><span>{l.text}</span></li>))}
        {logs && logs.items.length === 0 && <li className="muted">기록이 없습니다.</li>}
      </ul>
    </div>
  );
}

export function PatientView({ id }: { id: string }) {
  const { user } = useUi();
  const qc = useQueryClient();
  const [examId, setExamId] = useState<string | null>(null);
  const { data: d, error } = useQuery({ queryKey: ['patient', id], queryFn: () => api<PatientDetail>(`/patients/${id}`) });
  const seenFor = useRef<string | null>(null);

  useEffect(() => setExamId(null), [id]);
  // 환자 상세를 열면 미확인 알림이 '확인' 처리됩니다.
  useEffect(() => {
    const a = d?.alert;
    if (a && a.status === 'new' && !a.seen && seenFor.current !== a.id) {
      seenFor.current = a.id;
      void api(`/alerts/${a.id}/seen`, { method: 'POST' }).then(() => {
        void qc.invalidateQueries({ queryKey: ['patients'] });
        void qc.invalidateQueries({ queryKey: ['patient', id] });
      }).catch(() => { seenFor.current = null; });
    }
  }, [d?.alert, qc, id]);

  if (error) return <div className="detail"><div className="card"><p className="danger-text">환자 정보를 불러오지 못했습니다.</p></div></div>;
  if (!d) return <div className="detail"><div className="card"><p className="muted">불러오는 중…</p></div></div>;

  const latestId = d.exams[0]?.analysis_id ?? null;
  const viewingOld = !!examId && examId !== latestId;
  const analysisId = viewingOld ? examId : latestId;
  const canAct = user.role !== 'oncall' || (d.alert?.re ?? 0) >= 2;
  const rs = d.record_status;

  let right;
  if (viewingOld) right = <RiskPanel analysisId={examId!} exams={d.exams} onPick={(x) => setExamId(x === latestId ? null : x)} isLatest={false} />;
  else if (rs === 'queued') right = <QueueNotice pos={d.record?.queue_pos} />;
  else if (rs === 'analyzing') right = <AnalysisProgress d={d} />;
  else if (rs === 'held') right = <HeldPanel d={d} />;
  else if (rs === 'failed') right = <FailedPanel reason={d.record?.fail_reason ?? null} />;
  else if (rs === 'waiting' || !latestId) right = <RecordWaiting />;
  else right = <RiskPanel analysisId={latestId} exams={d.exams} onPick={(x) => setExamId(x === latestId ? null : x)} isLatest />;

  return (
    <div className="detail" key={id}>
      <div className="detail-left">
        <div className="card patient-card">
        <InfoCard d={d} canAct={canAct && !viewingOld} />
        <Exams d={d} current={examId} onPick={setExamId} />
        </div>
        <ClinicalLog key={`${id}-${analysisId}`} d={d} analysisId={analysisId} editable={canAct && !viewingOld} />
      </div>
      <div className="detail-right">{right}</div>
    </div>
  );
}
