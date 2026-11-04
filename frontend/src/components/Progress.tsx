import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import { CheckIcon } from '../icons';
import { hm, hoursLabel } from '../format';
import type { PatientDetail, Stage } from '../types';
import { useUi } from '../ui';

export function RecordWaiting() {
  return <div className="card"><div className="waiting-box"><span className="waiting-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg></span><div><b>Holter 기록 대기 · 아직 받지 않음</b><p>이번 Holter 기록이 판독실에서 아직 들어오지 않았습니다. 들어오면 자동으로 분석 대기열에 등록됩니다.</p></div></div></div>;
}
export function QueueNotice({ pos }: { pos?: number }) {
  return <div className="card notice-blue"><b>분석 대기 {pos ?? ''}번째</b><p className="muted">앞의 기록을 분석한 뒤 순서대로 처리합니다.</p></div>;
}
export function FailedPanel({ reason }: { reason: string | null }) {
  return <div className="card"><h3 className="sub-h">분석 실패</h3><p className="danger-text">{reason ?? '알 수 없는 오류'}</p><p className="muted">판독 결과를 다시 받아야 합니다.</p></div>;
}

function infoText(s: Stage, d: PatientDetail): string {
  const i = s.info ?? {};
  switch (s.key) {
    case 'receive': return `${i.received_at ? hm(i.received_at) : ''} 판독실 Holter 판독지 수신 · 기록 시간 ${hoursLabel(i.duration_h ?? 0)}`;
    case 'validate':
      if (i.reason) return `모델 대상이 아닙니다 (${i.reason}) · 점수를 계산하지 않음`;
      return i.missing?.length ? `EMR에 ${i.missing.join(', ')} 값 없음 · 점수 계산 보류` : 'EMR 임상 변수 9개 + 판독 Holter 변수 3개 · 빠진 값 없음 · 대상 조건 확인(기기 이식·심장이식 없음)';
    case 'holter': return `24시간 심실조기수축 ${i.vpb}회 · 심실 커플렛 ${i.couplets}회 · 비지속성 심실빈맥 ${i.nsvt ? '있음' : '없음'}${i.short ? ' · 기록이 20시간보다 짧음' : ''}`;
    case 'score': return '로지스틱 회귀 · 변수 12개로 위험 점수 계산 완료';
    case 'factors': return `변수 12개 중 위험 점수에 영향이 큰 요인 ${i.factor_count ?? ''}개 정리`;
    default: return d.record?.file_name ?? '';
  }
}

function InputsCard({ d }: { d: PatientDetail }) {
  const p = d.inputs_preview;
  if (!p) return null;
  const row = (label: string, items: { name: string; value_text: string | null }[]) => (
    <div className="in-row"><b>{label}</b><span>{items.map((x, k) => (
      <span key={x.name} className="in-item">{k > 0 && ' · '}{x.name} <span className={x.value_text == null ? 'danger-text' : ''}>{x.value_text ?? '없음'}</span></span>
    ))}</span></div>
  );
  return (
    <div className="inputs-card">
      {row('EMR 임상', p.clinical)}
      {row('Holter 판독', p.holter)}
      <div className="in-row"><b>기록 시간</b><span>{hoursLabel(p.duration_h)}</span></div>
      {p.duration_h < 20 && <p className="danger-text small">기록 시간이 20시간보다 짧습니다. 판독지의 횟수가 실제보다 적게 잡혔을 수 있어 위험 점수가 낮게 나올 수 있습니다.</p>}
    </div>
  );
}

export function AnalysisProgress({ d }: { d: PatientDetail }) {
  const stages = d.record?.progress.stages ?? [];
  return (
    <div className="card">
      <h3 className="sub-h">Holter 판독 결과로 위험 점수를 계산하고 있습니다</h3>
      <InputsCard d={d} />
      <ol className="stages">
        {stages.map((s, n) => (
          <li key={s.key} className={`stage ${s.state}`}>
            <span className="stage-mark">{s.state === 'running' ? <span className="spinner dark" /> : s.state === 'done' ? <CheckIcon /> : <i>{n + 1}</i>}</span>
            <span className="stage-body">
              <b>{s.label}</b>
              <span className="stage-info">{s.state === 'wait' ? '대기' : s.state === 'running' ? '진행 중…' : <span className="rise">{infoText(s, d)}</span>}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HeldPanel({ d }: { d: PatientDetail }) {
  const { snack } = useUi();
  const qc = useQueryClient();
  const rec = d.record!;
  const recheck = useMutation({
    mutationFn: () => api<{ status: string; missing: string[] }>(`/records/${rec.id}/recheck`, { method: 'POST' }),
    onSuccess: (r) => {
      snack(r.status === 'queued' ? 'EMR에서 값을 받았습니다. 다시 계산합니다.' : `아직 EMR에 ${r.missing.join(', ')} 값이 없습니다.`);
      void qc.invalidateQueries();
    },
    onError: (e) => snack(e instanceof ApiError ? e.message : '다시 확인하지 못했습니다.'),
  });
  const ineligible = rec.hold_reason === 'ineligible';
  return (
    <div className="card held">
      <h3 className="sub-h">위험 점수 계산 보류</h3>
      <p className="muted">{hm(rec.received_at)} 판독 결과 수신 · {ineligible ? '모델 적용 대상이 아닙니다' : `필수 입력값 ${rec.missing.length}개 없음`}</p>
      <InputsCard d={d} />
      <div className="held-box">
        <div><span className="muted">{ineligible ? '사유' : '빠진 값'}</span><span className="danger-text">{ineligible ? (d.exclusion ?? `NYHA ${d.nyha}`) : rec.missing.map((m) => `${m} (EMR 검사 결과 없음)`).join(', ')}</span></div>
        <div><span className="muted">처리</span><span>{ineligible ? '점수를 계산하지 않았습니다. 담당의가 직접 판단해 주세요.' : '값을 임의로 채우지 않고 계산을 멈췄습니다. EMR에 값이 들어오면 다시 계산합니다.'}</span></div>
      </div>
      {!ineligible && <div className="held-actions"><button className="btn-primary" onClick={() => recheck.mutate()} disabled={recheck.isPending}>EMR 값 다시 확인</button></div>}
    </div>
  );
}
