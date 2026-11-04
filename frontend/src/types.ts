export type Role = 'attending' | 'oncall' | 'admin';
export interface User { id: string; username: string; name: string; role: Role; role_label: string; dept: string | null; demo_mode: boolean }

export type RecordStatus = 'waiting' | 'queued' | 'analyzing' | 'held' | 'done' | 'failed';
export type Band = 'high' | 'mid' | 'low';

export interface Alert {
  id: string; analysis_id: string; patient_id: string; status: 'new' | 'ack' | 'done'; seen: boolean;
  seen_at: string | null; sent_at: string; done_at: string | null; re: number; channels: string[]; skip: boolean;
  reason: string | null; skip_note: string | null; acts: string[]; other_text: string | null;
  memo: string | null; memo_at: string | null; changed_at: string | null;
}
export interface Latest {
  analysis_id: string | null; score: number | null; band: Band | null; analyzed_at: string | null;
  record_status: RecordStatus; record_id?: string; duration_h?: number; short?: boolean; received_at?: string;
  file_name?: string; missing?: string[]; hold_reason?: string | null; queue_pos?: number;
}
export interface PatientSummary {
  id: string; mrn: string; name: string; age: number; sex: 'M' | 'F'; nyha: string; dx: string | null;
  next_visit: string | null; exclusion: string | null; latest: Latest; alert: Alert | null;
}
export interface Factor { key: string; name: string; group: 'clinical' | 'holter'; value_text: string; contribution: number; rank: number }
export interface Analysis { id: string; score: number; band: Band; analyzed_at: string; inputs: Record<string, number>; factors: Factor[] }
export interface Exam { analysis_id: string; at: string; score: number; band: Band; delta: number | null; gap_days: number | null; top_factor: string | null; top_factor_detail: string | null; latest: boolean }
export interface Stage { key: string; label: string; state: 'wait' | 'running' | 'done' | 'held' | 'failed'; info?: Record<string, any> }
export interface HolterRecord {
  id: string; status: RecordStatus; file_name: string; received_at: string; duration_h: number; short: boolean;
  vpb_24h: number; couplets_24h: number; nsvt: boolean; missing: string[]; hold_reason: string | null;
  fail_reason: string | null; queue_pos?: number; progress: { stages?: Stage[] };
}
export interface InputRow { key: string; name: string; group: string; value_text: string | null }
export interface PatientDetail extends PatientSummary {
  record_status: RecordStatus; record: HolterRecord | null; analysis: Analysis | null; exams: Exam[];
  threshold: number; disclaimer: string; inputs_preview: { clinical: InputRow[]; holter: InputRow[]; duration_h: number } | null;
}
export interface AnalysisDetail { analysis: Analysis; previous: Analysis | null; alert: Alert | null; threshold: number; disclaimer: string }
export interface Settings { threshold: number; re_min: number; esc_min: number; channels: { app: boolean; web: boolean; sms: boolean }; performance_threshold: number }
export interface QueueState { analyzing: { id: string; patient_id: string; name: string } | null; queued: { id: string; patient_id: string; name: string; pos: number }[] }
export interface LogItem { id: number; t: string; actor: string; kind: 'human' | 'system'; patient_id: string | null; patient_name: string | null; patient_mrn: string | null; alert_id: string | null; analysis_id: string | null; event: string; text: string }
export interface LogPage { items: LogItem[]; next_cursor: number | null }
export interface ModelInfo {
  placeholder: boolean; placeholder_note: string; type: string; file: string; output: string; description: string;
  variables: { key: string; name: string; group: string; unit: string; source: string }[]; training: string; exclusions: string[];
  threshold_basis: number; disclaimer: string;
  performance: {
    test: { label: string; auroc: number; auroc_ci: [number, number]; ap: number; recall: number; precision: number; f1: number; specificity: number; alert_rate: number; confusion: Record<'tn' | 'fp' | 'fn' | 'tp', number> };
    cv: { label: string; auroc: number; auroc_sd: number; ap: number; ap_sd: number; recall: number; precision: number; f1: number; confusion: Record<'tn' | 'fp' | 'fn' | 'tp', number> };
  };
}
export interface ServerEvent { type: string; at: string; data: any }
