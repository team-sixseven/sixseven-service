import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { ACTS, SKIP_REASONS, actText, hm, points, ymd } from '../format';
import type { Alert, LogPage, ModelInfo, PatientDetail, Settings } from '../types';
import { useUi } from '../ui';
import { Modal } from './Modal';

export function DemoModal() {
  const { selectedId, snack } = useUi();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (path: string) => api(`/admin/demo/${path}`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries(); snack('시연 요청을 처리했습니다.'); },
    onError: (e) => snack(e instanceof ApiError ? e.message : '시연 요청을 처리하지 못했습니다.'),
  });
  const controls = [
    ['다음 판독 결과 수신', 'arrive'], ['고위험 판독 결과 수신', 'arrive?high=true'],
    ['선택 환자 판독 결과 수신', `arrive?patient=${encodeURIComponent(selectedId ?? '')}`],
    ['남은 판독 결과 모두 수신', 'arrive?all=true'], ['30분 경과', 'advance?min=30'],
    ['자동 재생 켜기', 'auto?enabled=true'], ['자동 재생 끄기', 'auto?enabled=false'],
    ['시연 데이터 초기화', 'reset'],
  ];
  return <Modal title="관리자 시연 도구">
    <p className="muted small">가상 환자 데이터로 시연합니다. Shift+D로 열고 닫습니다.</p>
    {controls.map(([label, path]) => <button className="btn-line" key={path} disabled={run.isPending || (path.startsWith('arrive?patient=') && !selectedId)} onClick={() => run.mutate(path)}>{label}</button>)}
  </Modal>;
}

export function SettingsModal() {
  const qc = useQueryClient();
  const { snack, closeModal } = useUi();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const patch = useMutation({
    mutationFn: (body: Partial<Settings>) => api<Settings>('/settings', { method: 'PATCH', body }),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
    onError: (e) => snack(e instanceof ApiError ? e.message : '설정을 저장하지 못했습니다.'),
  });
  const [thr, setThr] = useState<number | null>(null);
  useEffect(() => { if (data && thr === null) setThr(Math.round(data.threshold * 100)); }, [data, thr]);
  if (!data || thr === null) return <Modal title="알림 설정"><p className="muted">불러오는 중…</p></Modal>;
  const ch = data.channels;
  return (
    <Modal title="알림 설정" variant="settings-modal">
      <section className="field">
        <label className="threshold-label" htmlFor="thr"><b>알림 기준</b><b>위험 점수 {thr}점 이상</b></label>
        <input id="thr" type="range" min={20} max={80} step={5} value={thr} onChange={(e) => setThr(+e.target.value)}
          onPointerUp={() => patch.mutate({ threshold: thr / 100 })} onKeyUp={() => patch.mutate({ threshold: thr / 100 })} onBlur={() => patch.mutate({ threshold: thr / 100 })} />
        {Math.abs(thr / 100 - data.performance_threshold) > 1e-6 && <p className="danger-text small">성능 지표는 {Math.round(data.performance_threshold * 100)}점(0.40) 기준입니다. 이 기준에서의 성능은 확인되지 않았습니다.</p>}
      </section>
      <div className="settings-times"><section className="field"><label htmlFor="re">확인하지 않으면 재알림</label>
        <select id="re" value={data.re_min} onChange={(e) => patch.mutate({ re_min: +e.target.value })}>{[15, 30, 60].map((m) => <option key={m} value={m}>{m}분 후</option>)}</select></section>
      <section className="field"><label htmlFor="esc">계속 확인하지 않으면 당직의 전달</label>
        <select id="esc" value={data.esc_min} onChange={(e) => patch.mutate({ esc_min: +e.target.value })}>{[60, 120].map((m) => <option key={m} value={m}>{m}분 후</option>)}</select></section></div>
      <fieldset className="field"><legend>받는 방법</legend>
        {([['app', '휴대폰 앱 알림'], ['web', '업무 화면 알림'], ['sms', '문자 메시지']] as const).map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={ch[k]} onChange={(e) => patch.mutate({ channels: { ...ch, [k]: e.target.checked } })} />{label}</label>))}
      </fieldset>
      <p className="muted small">바꾸면 바로 저장되고 처리 기록에 남습니다. 이미 발송된 알림에는 적용하지 않습니다.</p>
      <div className="modal-actions"><button className="btn-primary" onClick={closeModal}>닫기</button></div>
    </Modal>
  );
}

function ConfusionTable({ c, label }: { c: Record<'tn' | 'fp' | 'fn' | 'tp', number>; label: string }) {
  return <table className="confusion" aria-label={label}>
    <thead><tr><th></th><th className="scd">실제 SCD</th><th>실제 생존</th></tr></thead>
    <tbody>
      <tr><th>고위험예측</th><td className="scd"><b>{c.tp}</b>맞게 찾음</td><td><b>{c.fp}</b>오경보</td></tr>
      <tr><th>그 외</th><td className="scd danger-text"><b>{c.fn}</b>놓침</td><td><b>{c.tn}</b>맞게 제외</td></tr>
    </tbody>
  </table>;
}

export function ModelBody({ info, withNotes }: { info: ModelInfo; withNotes?: boolean }) {
  const { selectedId } = useUi();
  const { data: patient } = useQuery({ queryKey: ['patient', selectedId], queryFn: () => api<PatientDetail>(`/patients/${selectedId}`), enabled: !!selectedId });
  const t = info.performance.test, cv = info.performance.cv;
  return <div className="model-body">
    <section className="model-section">
      <h3 className="sub-h">사용 데이터</h3>
      <p><b>위험 점수</b></p>
      <p>로지스틱 회귀 모델이 변수 {info.variables.length}개(임상 9개 + Holter 판독 요약 3개)로 계산한 0~100점 사이의 점수입니다. 보정하지 않은 값이라 <b>실제 발생 확률이 아닙니다.</b></p>
      <dl className="model-inputs">{(['clinical', 'holter'] as const).map((group) => <div key={group}><dt>{group === 'clinical' ? '임상 9개' : 'Holter 3개'}</dt><dd>{info.variables.filter((v) => v.group === group).map((v) => v.name + (v.unit ? `(${v.unit})` : '')).join(', ')}</dd></div>)}</dl>
      {patient?.analysis && <div className="patient-factors"><b>{patient.name} 환자의 변수 기여도(SHAP) · 위험 점수에 대한 설명</b>{patient.analysis.factors.slice(0, 3).map((f) => <div key={f.key}><span>{f.name} <span className="muted">{f.value_text}</span></span><span>{f.contribution >= 0 ? '+' : ''}{f.contribution.toFixed(2)} · {f.contribution >= 0 ? '위험 높임' : '위험 낮춤'}</span></div>)}</div>}
    </section>
    <section className="model-section">
      <div><h3 className="sub-h">테스트 데이터 성능</h3><p className="muted small">개발에 쓰지 않은 테스트 환자 89명(SCD 10명) · 기준 40점으로 평가 · 모델 팀 결과</p></div>
      <div className="performance-grid">
        <div className="metrics">
          <div className="metric key"><span>Recall (민감도) · 핵심 지표</span><b>{t.recall.toFixed(3)}</b><small>실제 SCD 10명 중 9명 · 놓침 1명</small></div>
          <div className="metric"><span>Precision (양성예측도)</span><b>{t.precision.toFixed(3)}</b><small>알림 43건 중 실제 SCD 9건</small></div>
          <div className="metric"><span>Specificity (특이도)</span><b>{t.specificity.toFixed(3)}</b><small>실제 생존 79명 중 45명</small></div>
          <div className="metric"><span>알림 비율</span><b>{Math.round(t.alert_rate * 100)}%</b><small>89명 중 43명</small></div>
        </div>
        <ConfusionTable c={t.confusion} label="테스트 혼동행렬" />
      </div>
      <div className="metric-details"><span><span className="muted">AUROC</span> <b>{t.auroc.toFixed(3)}</b> <span className="muted">(95% CI {t.auroc_ci[0].toFixed(3)}–{t.auroc_ci[1].toFixed(3)})</span></span><span><span className="muted">AP</span> <b>{t.ap.toFixed(3)}</b></span><span><span className="muted">F1</span> <b>{t.f1.toFixed(3)}</b></span></div>
      <details><summary>교차검증 결과 (개발 데이터 356명 · SCD 40명)</summary>
        <dl className="kv"><dt>AUROC</dt><dd>{cv.auroc.toFixed(3)} ± {cv.auroc_sd.toFixed(3)}</dd><dt>AP</dt><dd>{cv.ap.toFixed(3)} ± {cv.ap_sd.toFixed(3)}</dd><dt>Recall</dt><dd>{cv.recall.toFixed(3)}</dd><dt>Precision</dt><dd>{cv.precision.toFixed(3)}</dd><dt>F1</dt><dd>{cv.f1.toFixed(3)}</dd></dl>
        <ConfusionTable c={cv.confusion} label="교차검증 혼동행렬" />
      </details>
      <p className="muted small">테스트 데이터에 SCD 환자가 10명뿐이라 신뢰구간이 넓습니다. 알림 5건 중 약 4건은 실제 SCD가 아닌 경우입니다.</p>
    </section>
    {withNotes && <section className="model-section"><h3 className="sub-h">모델 정보</h3>
      <dl className="kv"><dt>모델 종류</dt><dd>{info.type}</dd><dt>출력</dt><dd>{info.output}</dd><dt>학습 데이터</dt><dd>{info.training}</dd><dt>쓰면 안 되는 경우</dt><dd>{info.exclusions.join(' · ')}</dd><dt>모델 파일</dt><dd><code>{info.file}</code></dd></dl>
      {info.placeholder && <p className="danger-text small">{info.placeholder_note}</p>}
    </section>}
  </div>;
}

export function ModelModal() {
  const { data } = useQuery({ queryKey: ['model'], queryFn: () => api<ModelInfo>('/model') });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
  const off = settings && Math.abs(settings.threshold - settings.performance_threshold) > 1e-6;
  return (
    <Modal title="모델 설명 · 성능" wide label="모델 설명과 성능" variant="model-modal">
      {off && <p className="danger-text small">성능 지표는 0.40 기준입니다. 현재 알림 기준은 {Math.round(settings!.threshold * 100)}점입니다.</p>}
      {data ? <ModelBody info={data} /> : <p className="muted">불러오는 중…</p>}
    </Modal>
  );
}

export function AdminModal({ tab: first }: { tab: 'model' | 'logs' }) {
  const [tab, setTab] = useState(first);
  const [q, setQ] = useState('');
  const { data: info } = useQuery({ queryKey: ['model'], queryFn: () => api<ModelInfo>('/model') });
  const { data: logs } = useQuery({
    queryKey: ['logs', 'system', q], enabled: tab === 'logs',
    queryFn: () => api<LogPage>(`/logs?kind=system&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  return (
    <Modal title="관리자" wide variant="admin-modal">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>모델 설정</button>
        <button role="tab" aria-selected={tab === 'logs'} onClick={() => setTab('logs')}>시스템 처리기록</button>
      </div>
      {tab === 'model' && (info ? <ModelBody info={info} withNotes /> : <p className="muted">불러오는 중…</p>)}
      {tab === 'logs' && (<>
        <div className="logs-head"><b>시스템 처리기록 {logs?.items.length ?? 0}건</b><span className="muted small">최근 순 · 수정할 수 없음</span></div>
        <input className="search-input" placeholder="환자 이름, 등록번호, 내용" value={q} onChange={(e) => setQ(e.target.value)} aria-label="처리기록 검색" />
        <ul className="loglist big">
          {(logs?.items ?? []).map((l) => (<li key={l.id}><time>{ymd(l.t).slice(5)} {hm(l.t)}</time><span className="actor">{l.actor}</span><span className="who">{l.patient_name ?? '–'}</span><span>{l.text}</span></li>))}
        </ul>
      </>)}
    </Modal>
  );
}

export function ActionModal({ mode, alertId, patientId }: { mode: 'act' | 'change' | 'memo'; alertId: string; patientId: string }) {
  const qc = useQueryClient();
  const { closeModal, snack } = useUi();
  const detail = qc.getQueryData<PatientDetail>(['patient', patientId]);
  const [alert, setAlert] = useState<Alert | null>(detail?.alert?.id === alertId ? detail.alert : null);
  const saved = useRef(false);
  const [tab, setTab] = useState<'act' | 'skip'>(alert?.skip && mode === 'change' ? 'skip' : 'act');
  const [acts, setActs] = useState<string[]>(mode === 'change' && alert && !alert.skip ? alert.acts : []);
  const [other, setOther] = useState(alert?.other_text ?? '');
  const [reason, setReason] = useState(alert?.reason ?? '');
  const [note, setNote] = useState(alert?.skip_note ?? '');
  const [memo, setMemo] = useState(alert?.memo ?? '');
  const [error, setError] = useState('');

  // 조치 시작: 알림을 'ack'로. 저장 없이 닫으면 '미조치'로 되돌립니다(기록 없음).
  useEffect(() => {
    if (mode !== 'act') return;
    void api<Alert>(`/alerts/${alertId}`, { method: 'PATCH', body: { status: 'ack' } }).then(setAlert).catch(() => {});
    return () => { if (!saved.current) void api(`/alerts/${alertId}`, { method: 'PATCH', body: { status: 'new' } }).then(() => qc.invalidateQueries({ queryKey: ['patients'] })).catch(() => {}); };
  }, [alertId, mode, qc]);

  const done = (message: string) => {
    saved.current = true;
    void qc.invalidateQueries();
    snack(message);
    closeModal();
  };
  const run = useMutation({
    mutationFn: async () => {
      if (mode === 'memo') return api(`/alerts/${alertId}/memo`, { method: 'PUT', body: { memo } });
      const skip = tab === 'skip';
      if (mode === 'change') return api(`/alerts/${alertId}/actions`, { method: 'PUT', body: { skip, acts, other_text: other, reason, note } });
      return skip ? api(`/alerts/${alertId}/skip`, { method: 'POST', body: { reason, note } })
        : api(`/alerts/${alertId}/actions`, { method: 'POST', body: { acts, other_text: other, memo } });
    },
    onSuccess: () => done(mode === 'memo' ? '메모를 저장했습니다.' : mode === 'change' ? '조치를 수정했습니다.' : tab === 'skip' ? '조치 불필요로 기록했습니다.' : '조치를 기록했습니다.'),
    onError: (e) => setError(e instanceof ApiError ? e.message : '저장하지 못했습니다.'),
  });
  const toggle = (a: string) => setActs((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]));
  const valid = mode === 'memo' ? true : tab === 'act' ? acts.length > 0 && (!acts.includes('기타') || other.trim()) : !!reason && (reason !== '기타' || note.trim());
  const score = detail ? points(detail.analysis?.score) : null;
  const title = mode === 'memo' ? (alert?.memo ? '메모 수정' : '메모 추가') : mode === 'change' ? '조치 수정' : '조치 입력';

  return (
    <Modal title={title} label={title} onClose={closeModal} variant={`action-modal ${mode === 'act' ? 'action-new' : ''}`}>
      {detail && <p className="muted action-sum"><b className="plain">{detail.name}</b> · {detail.mrn}{score != null && ` · 위험 점수 ${score}점`}</p>}
      {mode === 'change' && alert && <p className="muted small">현재: {actText(alert)}</p>}
      {mode === 'memo' ? (
        <label className="field">메모<textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={4} maxLength={1000} placeholder="비우고 저장하면 메모가 삭제됩니다" /></label>
      ) : (<>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'act'} onClick={() => setTab('act')}>조치함</button>
          <button role="tab" aria-selected={tab === 'skip'} onClick={() => setTab('skip')}>조치 불필요</button>
        </div>
        {tab === 'act' ? (<>
          <div className="choices">{ACTS.map((a) => <label key={a} className="check"><input type="checkbox" checked={acts.includes(a)} onChange={() => toggle(a)} />{a}</label>)}</div>
          {acts.includes('기타') && <input className="text-in" value={other} onChange={(e) => setOther(e.target.value)} placeholder="기타 내용 (필수)" maxLength={200} aria-label="기타 내용" />}
          {mode === 'act' && <label className="field">메모 (선택)<textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} maxLength={1000} /></label>}
        </>) : (<>
          <div className="choices">{SKIP_REASONS.map((r) => <label key={r} className="check"><input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />{r}</label>)}</div>
          {reason === '기타' && <input className="text-in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="기타 내용 (필수)" maxLength={200} aria-label="기타 내용" />}
          <p className="muted small">이 판단은 처리 기록에 남고 모델 오경보 점검 자료로 쓰입니다.</p>
        </>)}
      </>)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={closeModal}>닫기</button>
        <button className="btn-primary" disabled={!valid || run.isPending} onClick={() => { setError(''); run.mutate(); }}>
          {mode === 'memo' ? '저장' : tab === 'skip' ? '조치 불필요로 처리' : mode === 'change' ? '수정 저장' : '조치 완료'}
        </button>
      </div>
    </Modal>
  );
}

