// @ts-nocheck
// 클로드 디자인 데모(Main.dc.html)의 화면 로직을 그대로 옮기고, 데이터만 실제 API(/api/*)와 연결한 컴포넌트입니다.
// 데모의 renderVals()는 거의 그대로이며(스타일 문자열·애니메이션 포함), 가짜 데이터/타이머 자리만 서버 데이터로 바꿨습니다.
import { Component } from 'react';
import { api, connectEvents, getToken, setToken, setUnauthorizedHandler } from '../api';
import { DemoView } from './DemoView';
import './demo.css';

const M = 60000;
const ts = (iso) => (iso ? Date.parse(iso) : null);
const HUMAN_ACTORS = ['담당의', '당직의', '관리자'];

export class DemoApp extends Component {
  constructor(props) {
    super(props);
    this._timers = [];
    this.state = this.initialState();
  }

  initialState() {
    return {
      dataMode: "synthetic", signupEnabled: false, signupMode: false, authError: "", booting: !!getToken(), me: null, dark: (function () { try { return window.localStorage.getItem('scdDark') === '1'; } catch (e) { return false; } })(),
      tab: 'board', view: 'main', inboxOpen: false, filter: 'all', sel: null, now: Date.now(), exam: null, memoEdit: null, actEdit: null,
      toast: null, toasts: [], tOut: {}, tSeq: 0, draft: {}, cu: null, alertOver: {},
      apiPatients: [], apiQueue: { analyzing: null, queued: [] }, apiSettings: { threshold: 0.4, re_min: 30, esc_min: 60, channels: { app: true, web: true, sms: false } },
      apiLogs: [], details: {}, analyses: {}, modelInfo: null, loaded: false,
    };
  }

  componentDidMount() {
    var self = this;
    this.applyDark(!!this.state.dark);
    api("/auth/options").then(function (res) { self.setState({ dataMode: res.data_mode, signupEnabled: !!res.signup_enabled }); }).catch(function () {});
    setUnauthorizedHandler(function () { self.resetToLogin(); });
    this._onKey = function (e) {
      if (e.key === 'Escape' && self._esc && self._esc()) { e.preventDefault(); return; }
      var tg = e.target && e.target.tagName;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') return;
      if (!self.state.me || self.state.me.role !== 'admin' || !self.state.me.demo_mode) return;
      var k = e.code;
      if (k === 'KeyD') { self.setState({ demoPanel: !self.state.demoPanel }); e.preventDefault(); }
      else if (k === 'KeyN') { self.demoNext(false); e.preventDefault(); }
      else if (k === 'KeyH') { self.demoNext(true); e.preventDefault(); }
      else if (k === 'KeyS') { self.demoCur(); e.preventDefault(); }
      else if (k === 'KeyT') { self.demoSkip(30); e.preventDefault(); }
      else if (k === 'KeyR') { self.demoReset(); e.preventDefault(); }
      else if (k === 'KeyA') { self.demoAll(); e.preventDefault(); }
    };
    this._onDocDown = function (e) { if (self.state.sbfOpen && !(e.target.closest && e.target.closest('[data-sbf]'))) self.setState({ sbfOpen: false }); if (self.state.acctOpen && !(e.target.closest && e.target.closest('[data-acct]'))) self.closeAnim('acctClosing', { acctOpen: false }); if (self.state.inboxOpen && !self.state.inboxClosing && !(e.target.closest && e.target.closest('[data-inbox]')) && self._closeInbox) self._closeInbox(); };
    document.addEventListener('keydown', this._onKey); document.addEventListener('pointerdown', this._onDocDown, true);
    if (getToken()) {
      api('/me').then(function (me) { self.setState({ me: me, booting: false, appIn: true }); self.startSession(); })
        .catch(function () { setToken(null); self.setState({ booting: false }); });
    } else setTimeout(function () { var el = document.getElementById('lgId'); if (el) el.focus(); }, 60);
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this._onKey); document.removeEventListener('pointerdown', this._onDocDown, true);
    this.stopSession(); this._timers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); this._lockScroll(false);
  }

  componentDidUpdate(prev) { if (prev.sel !== this.state.sel && this.state.me) this.refresh(); }

  // ---------------------------------------------------------------- 세션 · 실시간
  startSession() {
    var self = this;
    this.stopSession();
    api('/model').then(function (m) { self.setState({ modelInfo: m }); }).catch(function () {});
    this.refresh();
    this._ev = connectEvents(function (e) { self.onEvent(e); }, function () { self.resetToLogin(); });
    this._poll = setInterval(function () { self.setState({ now: Date.now() }); self.refresh(); }, 15000);
  }
  stopSession() { if (this._ev) { this._ev(); this._ev = null; } if (this._poll) { clearInterval(this._poll); this._poll = null; } }
  resetToLogin() {
    setToken(null); this.stopSession();
    if (this._cuI) { clearInterval(this._cuI); this._cuI = null; }
    this.setState(Object.assign({}, this.initialState(), { booting: false, dark: this.state.dark, lgErr: false, signupEnabled: this.state.signupEnabled, dataMode: this.state.dataMode }));
    var self = this; setTimeout(function () { var el = document.getElementById('lgId'); if (el) el.focus(); }, 60);
  }
  onEvent(e) {
    var d = e.data || {}, self = this;
    if (e.type === 'alert.created') {
      var ids = [d.patient_id].concat((this.state.toasts || []).filter(function (x) { return x !== d.patient_id; }));
      this.setState({ toast: d.patient_id, toasts: ids, tEv: 'new', tSeq: (this.state.tSeq || 0) + 1 });
      this._timers.push(setTimeout(function () { if (self.state.toast === d.patient_id) self.setState({ toast: null }); }, 4000));
    } else if (e.type === 'demo.reset') this.setState({ toasts: [], toast: null, exam: null, sel: null, alertOver: {} });
    else if (e.type === 'analysis.queued') this.showMsg('판독실에서 ' + this.nameOf(d.patient_id) + ' 판독 결과가 들어왔습니다. 순서대로 분석합니다.');
    else if (e.type === 'alert.reminded') this.showMsg('확인하지 않은 알림을 다시 알렸습니다.');
    else if (e.type === 'alert.escalated') this.showMsg('확인하지 않은 알림을 당직의에게 전달했습니다.');
    this.refresh();
  }
  nameOf(id) { var p = (this.state.apiPatients || []).filter(function (x) { return x.id === id; })[0]; return p ? p.name : '환자'; }
  showMsg(text) {
    var self = this;
    clearTimeout(this._msgA); clearTimeout(this._msgB);
    this.setState({ syncMsg: text, syncMsgOut: false });
    this._msgA = setTimeout(function () { self.setState({ syncMsgOut: true }); }, 2600);
    this._msgB = setTimeout(function () { self.setState({ syncMsg: null, syncMsgOut: false, syncNew: null }); }, 2950);
  }

  // ---------------------------------------------------------------- 서버 데이터 읽기
  refresh() {
    var self = this;
    if (!this.state.me) return Promise.resolve();
    if (this._rf) { this._again = true; return this._rf; }
    this._rf = (async function () {
      do {
        self._again = false;
        try {
          var me = self.state.me, admin = me.role === 'admin';
          var res = await Promise.all([api('/patients'), api('/queue'), api('/settings'), api('/logs?kind=' + (admin ? 'all' : 'human') + '&limit=500')]);
          var pl = res[0], want = {};
          if (self.state.sel) want[self.state.sel] = true;
          pl.forEach(function (p) { if (p.alert && p.alert.status !== 'done') want[p.id] = true; });
          var details = {};
          await Promise.all(Object.keys(want).map(async function (id) { try { details[id] = await api('/patients/' + id); } catch (e) { /* 담당에서 빠진 환자 */ } }));
          var ana = Object.assign({}, self.state.analyses), need = [];
          Object.keys(details).forEach(function (id) { details[id].exams.forEach(function (x) { if (!x.latest && !ana[x.analysis_id]) need.push(x.analysis_id); }); });
          await Promise.all(need.map(async function (aid) { try { ana[aid] = await api('/analyses/' + aid); } catch (e) { /* 무시 */ } }));
          var next = { apiPatients: pl, apiQueue: res[1], apiSettings: res[2], apiLogs: res[3].items, details: details, analyses: ana, loaded: true };
          if (!self.state.sel && pl.length) {
            var first = pl.filter(function (p) { return p.alert && p.alert.status !== 'done'; })[0] || pl[0];
            next.sel = first.id;
          }
          self.setState(next);
        } catch (e) { /* 일시적인 네트워크 오류는 다음 갱신에서 복구 */ }
      } while (self._again);
    })().then(function () { self._rf = null; }, function () { self._rf = null; });
    return this._rf;
  }

  // 서버 데이터를 데모가 쓰던 모양(st)으로 바꿉니다.
  derive() {
    var S = this.state, me = S.me || {}, details = S.details || {}, ana = S.analyses || {}, over = S.alertOver || {};
    var P = [], alerts = {}, rec = {}, held = {}, hist = {};
    (S.apiPatients || []).forEach(function (p) {
      var L = p.latest, det = details[p.id], R = det && det.record;
      var factors = det && det.analysis ? det.analysis.factors.map(function (f) { return [f.name, f.group === 'holter' ? 'Holter' : '임상', f.value_text, f.contribution]; }) : [];
      P.push({ id: p.id, name: p.name, mrn: me.data_mode === "music" ? "" : p.mrn, meta: p.age + '세 ' + (p.sex === 'M' ? '남' : '여') + ' · NYHA ' + p.nyha, next: p.next_visit ? p.next_visit.slice(5).replace('-', '/') + ' 외래' : '—',
        prob: L.score != null ? L.score : 0, f: factors,
        rec: R ? { file: R.file_name, size: 0, dur: R.duration_h, vpb: R.vpb_24h, cpl: R.couplets_24h, nsvt: R.nsvt, miss: R.missing || [] } : null });
      if (L.analyzed_at) rec[p.id] = ts(L.analyzed_at);
      if (L.record_status === 'held') held[p.id] = { at: ts(L.received_at), miss: L.hold_reason === 'ineligible' ? ['모델 적용 대상 조건'] : (L.missing || []) };
      var a = p.alert;
      if (a && a.analysis_id === L.analysis_id) {
        var acts = (a.acts || []).map(function (x) { return x === '기타' && a.other_text ? '기타: ' + a.other_text : x; });
        var o = { id: a.id, sent: ts(a.sent_at), status: a.status, seen: !!a.seen, re: a.re, ackAt: ts(a.ack_at), doneAt: ts(a.done_at), reAt: ts(a.re_at), escAt: ts(a.esc_at),
          acts: acts, skip: !!a.skip, reason: a.reason || '', skipNote: a.skip_note || '', memo: a.memo || '', memoAt: ts(a.memo_at), actAt: ts(a.changed_at), mlP: L.score != null ? Math.round(L.score * 100) : null };
        alerts[p.id] = over[p.id] ? Object.assign({}, o, over[p.id]) : o;
      }
      if (det) {
        hist[p.id] = det.exams.filter(function (x) { return !x.latest; }).map(function (x) {
          var A = ana[x.analysis_id], al = A && A.alert, an = A && A.analysis;
          var act = !al ? '알림 없음' : (al.status !== 'done' ? '조치 전' : (al.skip ? '조치 불필요 · ' + (al.reason || '') : '조치 완료 · ' + (al.acts || []).map(function (s) { return s === '기타' && al.other_text ? '기타: ' + al.other_text : s; }).join(', ')));
          return { t: ts(x.at), prob: x.score, ver: 'v0.1', act: act, memo: al && al.memo ? al.memo : '',
            f: an ? an.factors.map(function (f) { return [f.name, f.group === 'holter' ? 'Holter' : '임상', f.value_text, f.contribution]; }) : [] };
        });
      }
    });
    this._P = P; this._A = alerts;
    var q = S.apiQueue || { analyzing: null, queued: [] }, cfg = S.apiSettings;
    var prog = null;
    if (q.analyzing) {
      var dd = details[q.analyzing.patient_id], stg = dd && dd.record && dd.record.progress && dd.record.progress.stages;
      prog = { id: q.analyzing.patient_id, k: stg ? stg.filter(function (x) { return x.state === 'done'; }).length : 0 };
    }
    var info = S.modelInfo, models = info ? [{ id: 'm1', ver: 'v0.1', file: info.file, at: Date.now(), note: '', applied: true }] : [];
    var logs = (S.apiLogs || []).map(function (l) { return { t: ts(l.t), who: l.actor, pt: l.patient_name || '—', ev: l.text }; }).sort(function (a, b) { return b.t - a.t; });
    return Object.assign({}, S, {
      P: P, alerts: alerts, rec: rec, held: held, hist: hist, logs: logs, prog: prog, analyzing: q.analyzing ? q.analyzing.patient_id : null,
      jobs: q.queued.map(function (x) { return { id: x.patient_id }; }), th: cfg.threshold, reMin: cfg.re_min, escMin: cfg.esc_min, ch: cfg.channels,
      user: me.role ? (me.role === 'admin' ? 'admin' : 'user') : null, models: models, activeModel: 'm1', archive: [], queue: [], next: {}, over: {}, recVer: {}, uploads: {}, added: [], pend: null,
      lastSync: S.lastSync || Date.now(), sortKey: S.sortKey,
    });
  }

  emptyPatient() { return { id: '_', name: '', mrn: '', meta: '', next: '', prob: 0, f: [], rec: null }; }
  patients() { return this._P || []; }
  find(id) { return (this._P || []).filter(function (x) { return x.id === id; })[0]; }

  // ---------------------------------------------------------------- 서버에 쓰기
  saveSettings(patch) {
    var self = this;
    this.setState({ apiSettings: Object.assign({}, this.state.apiSettings, patch) });
    api('/settings', { method: 'PATCH', body: patch }).catch(function (e) { self.showMsg(e.message); }).then(function () { self.refresh(); });
  }
  splitActs(chosen) {
    var acts = [], other = '';
    (chosen || []).forEach(function (s) { if (s.indexOf('기타: ') === 0) { acts.push('기타'); other = s.slice(4); } else acts.push(s); });
    return { acts: acts, other_text: other };
  }
  updAlert(pid, patch) {
    var self = this, a = (this._A || {})[pid];
    if (!a) return;
    var call = null, sp = this.splitActs(patch.acts);
    if (patch.seen === true) call = api('/alerts/' + a.id + '/seen', { method: 'POST' });
    else if (patch.status === 'ack') call = api('/alerts/' + a.id, { method: 'PATCH', body: { status: 'ack' } });
    else if (patch.status === 'new') call = api('/alerts/' + a.id, { method: 'PATCH', body: { status: 'new' } });
    else if (patch.status === 'done' && patch.skip) call = api('/alerts/' + a.id + '/skip', { method: 'POST', body: { reason: patch.reason, note: patch.skipNote || '' } });
    else if (patch.status === 'done') call = api('/alerts/' + a.id + '/actions', { method: 'POST', body: { acts: sp.acts, other_text: sp.other_text, memo: patch.memo || '' } });
    else if (patch.skip !== undefined) call = api('/alerts/' + a.id + '/actions', { method: 'PUT', body: { skip: !!patch.skip, acts: sp.acts, other_text: sp.other_text, reason: patch.reason || null, note: patch.skipNote || '' } });
    else if (patch.memo !== undefined) call = api('/alerts/' + a.id + '/memo', { method: 'PUT', body: { memo: patch.memo } });
    if (!call) return;
    var o = Object.assign({}, this.state.alertOver); o[pid] = Object.assign({}, o[pid], patch); this.setState({ alertOver: o });
    call.catch(function (e) { self.showMsg(e.message); }).then(function () { return self.refresh(); }).then(function () {
      var o2 = Object.assign({}, self.state.alertOver); delete o2[pid]; self.setState({ alertOver: o2 });
    });
  }
  recheck(pid) {
    var self = this, det = this.state.details[pid], r = det && det.record;
    if (!r) return;
    api('/records/' + r.id + '/recheck', { method: 'POST' }).then(function (res) {
      self.showMsg(res.status === 'queued' ? 'EMR에서 값을 받았습니다. 다시 계산합니다.' : '아직 EMR에 ' + (res.missing || []).join(', ') + ' 값이 없습니다.');
      self.refresh();
    }).catch(function (e) { self.showMsg(e.message); });
  }
  sync() {
    var self = this;
    if (this.state.syncing) return;
    this.setState({ syncing: true });
    api('/patients/sync', { method: 'POST' }).then(function (r) {
      var n = r.added.length;
      self.setState({ lastSync: Date.now(), syncNew: r.added.map(function (x) { return x.id; }) });
      self._timers.push(setTimeout(function () {
        self.setState({ syncing: false });
        self.showMsg(n ? '병원 전산(EMR)에서 새 담당 환자 ' + n + '명을 불러왔습니다. Holter 기록은 판독실에서 들어오면 자동으로 분석합니다.' : '담당 환자 목록이 이미 최신 상태입니다.');
        self.refresh();
      }, 1300));
    }).catch(function (e) { self.setState({ syncing: false }); self.showMsg(e.message); });
  }
  demoCall(path, text) { var self = this; api(path, { method: 'POST' }).then(function () { self.showMsg(text); self.refresh(); }).catch(function (e) { self.showMsg(e.message); }); }
  demoNext(high) { this.demoCall('/admin/demo/arrive' + (high ? '?high=true' : ''), high ? '고위험 시연 기록을 받았습니다.' : '다음 시연 기록을 받았습니다.'); }
  demoCur() { this.demoCall('/admin/demo/arrive?patient=' + encodeURIComponent(this.state.sel || ''), '선택한 환자의 시연 기록을 받았습니다.'); }
  demoAll() { this.demoCall('/admin/demo/arrive?all=true', '남은 시연 기록을 모두 받았습니다.'); }
  demoSkip(min) { this.demoCall('/admin/demo/advance?min=' + min, min + '분이 지난 것으로 처리했습니다.'); }
  demoReset() { if (!window.confirm('모든 접속자의 시연 데이터를 초기화할까요?')) return; this.demoCall('/admin/demo/reset', '처음 상태로 되돌렸습니다.'); }
  demoAuto(on) { this.setState({ demoAuto: !!on }); this.demoCall('/admin/demo/auto?enabled=' + (on ? 'true' : 'false'), on ? '자동 재생을 켰습니다.' : '자동 재생을 껐습니다.'); }

  // ---------------------------------------------------------------- 로그인 · 로그아웃
  doLogin() {
    var idEl = document.getElementById('lgId'), pwEl = document.getElementById('lgPw');
    var id = ((idEl && idEl.value) || '').trim(), pw = (pwEl && pwEl.value) || '', self = this;
    if (this.state.lgBusy) return;
    this.setState({ lgBusy: true, lgErr: false, authError: "" });
    var t0 = Date.now();
    api(this.state.signupMode ? '/auth/signup' : '/auth/login', { method: 'POST', body: { username: id, password: pw } }).then(function (res) {
      setToken(res.token);
      var wait = Math.max(0, 700 - (Date.now() - t0));
      setTimeout(function () { self.setState({ lgLeave: true }); }, wait);
      setTimeout(function () {
        self.setState({ me: res.user, lgErr: false, acctOpen: false, lgBusy: false, lgLeave: false, appIn: true });
        self.startSession();
      }, wait + 280);
    }).catch(function (error) {
      self.setState({ lgErr: true, lgBusy: false, authError: error.message });
      if (pwEl) { pwEl.value = ''; pwEl.focus(); }
    });
  }
  doLogout() {
    var self = this;
    api('/auth/logout', { method: 'POST' }).catch(function () {}).then(function () { self.resetToLogin(); });
  }

  render() {
    if (this.state.booting) return null;
    return <DemoView v={this.renderVals()} />;
  }

  markSeen(id) {
    var a = (this._A || {})[id], p = this.find(id), T = Date.now();
    if (!a || !p || a.status !== 'new' || a.seen) return;
    this.updAlert(id, { seen: true, seenAt: T }, []);
  }
  countUp(id, pctO) {
    this.markSeen(id);
    var self = this, st = this.derive(), p = this.find(id);
    if (!p || st.analyzing === id) return;
    if (pctO == null && st.rec[id] == null) return;
    if (this._cuI) clearInterval(this._cuI);
    var pct = pctO != null ? pctO : Math.round(p.prob * 100), c0 = Date.now();
    this.setState({ cu: { id: id, v: 0 } });
    this._cuI = setInterval(function () {
      var k = Math.min(1, (Date.now() - c0) / 550);
      self.setState({ cu: { id: id, v: Math.round(pct * (1 - Math.pow(1 - k, 3))) } });
      if (k >= 1) { clearInterval(self._cuI); self._cuI = null; self.setState({ cu: null }); }
    }, 16);
    this._timers.push(this._cuI);
  }
  _lockScroll(on) {
    if (on === !!this._locked) return;
    this._locked = on;
    var de = document.documentElement, b = document.body;
    if (on) {
      var sw = window.innerWidth - de.clientWidth;
      this._prevOv = de.style.overflow; this._prevPad = b.style.paddingRight;
      de.style.overflow = 'hidden';
      if (sw > 0) b.style.paddingRight = sw + 'px';
    } else {
      de.style.overflow = this._prevOv || ''; b.style.paddingRight = this._prevPad || '';
    }
  }
  _fxEl(el) {
    try { var r = el.getBoundingClientRect(); return '--dx: ' + Math.round(r.left + r.width / 2 - window.innerWidth / 2) + 'px; --dy: ' + Math.round(r.top + r.height / 2 - window.innerHeight / 2) + 'px;'; } catch (e) { return '--dx: 0px; --dy: -120px;'; }
  }
  _fxToLog() {
    try { var b = document.querySelector('section[aria-label="의료진 조치 기록"]').getBoundingClientRect(); return '--dx: ' + Math.round(b.left + b.width / 2 - window.innerWidth / 2) + 'px; --dy: ' + Math.round(b.top + Math.min(60, b.height / 2) - window.innerHeight / 2) + 'px;'; } catch (e) { return null; }
  }
  _edClose(done, fn) {
    var self = this;
    if (this.state.edClosing) return;
    this.setState({ edClosing: true, edDone: done, edFx: done ? (this._fxToLog() || this.state.edFx) : this.state.edFx });
    this._timers.push(setTimeout(function () { self.setState({ edClosing: false, edDone: false }); fn(); }, done ? 300 : 230));
  }
  _toLogOrigin() {
    try {
      var dlg = document.querySelector('section[aria-label="조치 입력"]'), lg = document.querySelector('section[aria-label="의료진 조치 기록"]');
      if (!dlg || !lg) return null;
      var a = dlg.getBoundingClientRect(), b = lg.getBoundingClientRect();
      return Math.round(b.left + b.width / 2 - a.left) + 'px ' + Math.round(b.top + Math.min(60, b.height / 2) - a.top) + 'px';
    } catch (e) { return null; }
  }
  closeAnim(flag, done) {
    var self = this;
    if (this.state[flag]) return;
    var o = {}; o[flag] = true; this.setState(o);
    this._timers.push(setTimeout(function () { var d = Object.assign({}, done); d[flag] = false; self.setState(d); }, 200));
  }
  valData() {
    return [[0.81, 1], [0.69, 1], [0.61, 1], [0.57, 0], [0.46, 1], [0.33, 0], [0.26, 0], [0.19, 0], [0.11, 0], [0.06, 0]];
  }
  applyDark(on) { try { document.documentElement.classList.toggle('dark', !!on); } catch (e) {} }
  _tLeft(id) { return (this.state.toasts || []).filter(function (t) { return t !== id; }); }
  _tClose(id) {
    // 알림 팝업 닫기: 눌린 팝업만 오른쪽으로 빠지고, 아래 팝업들이 위로 올라옵니다.
    var self = this; if ((this.state.tOut || {})[id] || (this.state.toasts || []).indexOf(id) < 0) return;
    var o = Object.assign({}, this.state.tOut); o[id] = true; this.setState({ tOut: o });
    this._timers.push(setTimeout(function () { var o2 = Object.assign({}, self.state.tOut); delete o2[id];
      self.setState({ tOut: o2, toasts: self._tLeft(id), tEv: 'up', tUp: self._tBelow(id), tUpSeq: (self.state.tUpSeq || 0) + 1, toast: self.state.toast === id ? null : self.state.toast }); }, 380));
  }
  _tBelow(id) { var l = this.state.toasts || [], i = l.indexOf(id); return i < 0 ? [] : l.slice(i + 1); }
  actSum(a) {
    if (!a) return '알림 없음';
    if (a.status !== 'done') return '조치 전';
    return a.skip ? '조치 불필요 · ' + a.reason : '조치 완료 · ' + (a.acts || []).join(', ');
  }

  renderVals() {
    var self = this;
    this._cl = {
      inbox: function () { if (!self.state.inboxOpen || self.state.inboxClosing) return; self.setState({ inboxClosing: true }); self._timers.push(setTimeout(function () { self.setState({ inboxOpen: false, inboxClosing: false }); }, 230)); },
      model: function () { self.closeAnim('modelClosing', { modelOpen: false }); },
      set: function () { self.closeAnim('setClosing', { setOpen: false }); },
      add: function () { self.closeAnim('addClosing', { addOpen: false }); },
      admin: function () { self.closeAnim('adminClosing', { adminOpen: false }); },
      sbs: function () { self.closeAnim('sbsClosing', { sbsOpen: false }); }
    };
    this._closeInbox = this._cl.inbox;
    this._esc = function () {
      var S = self.state;
      if (self._edEsc && !S.edClosing) { self._edEsc(); return true; }
      if (self._ackEsc && !S.ackClosing) { self._ackEsc(); return true; }
      if (S.sbsOpen && !S.sbsClosing) { self._cl.sbs(); return true; }
      if (S.addOpen && !S.addClosing) { self._cl.add(); return true; }
      if (S.modelOpen && !S.modelClosing) { self._cl.model(); return true; }
      if (S.adminOpen && !S.adminClosing) { self._cl.admin(); return true; }
      if (S.setOpen && !S.setClosing) { self._cl.set(); return true; }
      if (S.acctOpen) { self.closeAnim('acctClosing', { acctOpen: false }); return true; }
      if (S.inboxOpen && !S.inboxClosing) { self._cl.inbox(); return true; }
      if (S.sbfOpen) { self.setState({ sbfOpen: false }); return true; }
      return false;
    };
    var st = this.derive(), th = Number(st.th), now = Date.now();
    var P = st.P;
    var jobIdx = {}; (st.jobs || []).forEach(function (j, i) { jobIdx[j.id] = i + 1; });
    this._lockScroll(!!(st.actEdit || st.memoEdit || ((st.alerts || {})[st.sel] || {}).status === 'ack' || st.sbsOpen || st.addOpen || st.modelOpen || st.setOpen || (st.adminOpen && st.user === 'admin')));
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function fmt(t) {
      var d = new Date(t), n = new Date(now), hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
      if (d.toDateString() === n.toDateString()) return hm;
      var y = new Date(now - 86400000);
      if (d.toDateString() === y.toDateString()) return '어제 ' + hm;
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    }
    var nd = new Date(now), wd = ['일', '월', '화', '수', '목', '금', '토'][nd.getDay()];
    var today = pad(nd.getMonth() + 1) + '.' + pad(nd.getDate()) + ' (' + wd + ') ' + pad(nd.getHours()) + ':' + pad(nd.getMinutes());
    var thPct = Math.round(th * 100);
    var band = function (v) { return v >= th ? '고위험' : (v >= 0.2 ? '중간' : '낮음'); };
    var statusText = { 'new': '조치 전 · 미확인', ack: '조치 전 · 확인함', done: '조치 완료' };
    var escText = function (a) { return a.re >= 2 ? '당직의에게 전달됨' : (a.re === 1 ? '재알림 보냄' : ''); };
    var newCount = Object.keys(st.alerts).filter(function (k) { return st.alerts[k].status === 'new' && !st.alerts[k].seen; }).length;
    var tabDefs = [['board', '담당 환자']];
    var tabs = tabDefs.map(function (t) {
      var on = st.tab === t[0];
      return { label: t[1], on: on, isBoard: t[0] === 'board', isLog: t[0] === 'log',
        style: 'min-height: 44px; padding: 8px 14px; border: none; border-bottom: 2px solid ' + (on ? '#16191F' : 'transparent') + '; margin-bottom: -1px; background: transparent; color: ' + (on ? '#16191F' : '#646B78') + '; font-size: 18px; font-weight: ' + (on ? '600' : '400') + '; cursor: pointer; white-space: nowrap;',
        pick: function () { self.setState({ tab: t[0] }); } };
    });
    var pick = function (id) { return function () { self.setState({ sel: id, toast: null, toasts: self._tLeft(id), tEv: 'up', tUp: self._tBelow(id), tUpSeq: (self.state.tUpSeq || 0) + 1, logAll: false }); self.countUp(id); }; };
    var rowBase = 'width: 100%; border: none; border-bottom: 1px solid #F0F2F5; cursor: pointer; color: #16191F; font-size: 18px; text-align: left; ';
    var inbox = Object.keys(st.alerts).map(function (id) { return { a: st.alerts[id], p: self.find(id) }; })
      .sort(function (x, y) { var nx = x.a.status === 'new' ? 1 : 0, ny = y.a.status === 'new' ? 1 : 0; if (nx !== ny) return ny - nx; return y.a.sent - x.a.sent; })
      .map(function (x) {
        var on = x.p.id === st.sel, isNew = x.a.status === 'new' && !x.a.seen;
        var ups = x.p.f.filter(function (f) { return f[3] > 0; }).map(function (f) { return f[0]; });
        return { name: x.p.name, pct: Math.round(x.p.prob * 100) + '', status: x.a.skip ? '조치 불필요 · 의료진 판단' : statusText[x.a.status], esc: escText(x.a), hasEsc: isNew && x.a.re > 0,
          time: fmt(x.a.sent), isNew: isNew,
          preview: '24시간 Holter 분석 결과 고위험입니다. 주요 요인: ' + (ups.join(', ') || '—'),
          pick: function () { self.setState({ sel: x.p.id, inboxOpen: false, view: 'main', toast: null, toasts: self._tLeft(x.p.id), tEv: 'up', tUp: self._tBelow(x.p.id), tUpSeq: (self.state.tUpSeq || 0) + 1 }); self.countUp(x.p.id); },
          titleStyle: 'font-size: 18px; font-weight: ' + (isNew ? '700' : '500') + ';',
          statusStyle: 'font-size: 16px; ' + (x.a.status !== 'done' ? 'color: #B42318; font-weight: 600;' : 'color: #646B78;'),
          style: rowBase + 'display: flex; flex-direction: column; gap: 2px; padding: 12px 16px; ' + (x.a.status !== 'done' ? 'box-shadow: inset 3px 0 0 #B42318; background: ' + (on ? '#F8E6E4' : '#FDF3F2') + ';' : 'background: ' + (on ? '#F3F4F6' : '#FFFFFF') + ';') };
      });
    var stateOf = function (x) {
      if (st.analyzing === x.id) return 'analyzing';
      if (st.rec[x.id] == null) return jobIdx[x.id] ? 'waiting' : ((st.held || {})[x.id] ? 'held' : 'queued');
      return 'done';
    };
    var sortKey = st.sortKey || 'prio';
    var filters = [['prio', '조치 우선'], ['risk', '위험 점수 높은 순'], ['recent', '최신순'], ['name', '이름순']].map(function (f) {
      var on = sortKey === f[0];
      return { label: f[1], on: on, aria: on ? 'true' : 'false', pick: function () { self.setState({ sortKey: f[0], sbfOpen: false, sortTick: (self.state.sortTick || 0) + 1 }); },
        style: 'display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 38px; padding: 4px 14px; border: none; border-radius: 10px; font-size: 17px; text-align: left; white-space: nowrap; cursor: pointer; ' + (on ? 'background: #F0F2F5; color: #16191F; font-weight: 600;' : 'background: transparent; color: #16191F; font-weight: 400;') };
    });
    var sbQ = st.sbQ || '', sq = sbQ.trim().toLowerCase();
    var VK = 'prob', vOf = function (x) { return x[VK] != null ? x[VK] : 0; };
    var probOf = function (x) { return stateOf(x) === 'done' ? vOf(x) : -1; };
    var rank = function (x) {
      var al = st.alerts[x.id];
      if (al && al.status === 'new' && !al.seen) return 0;
      if (al && al.status !== 'done') return 1;
      return stateOf(x) === 'done' ? 2 : 3;
    };
    var board = P.filter(function (x) { return !sq || (x.name + ' ' + (x.mrn || '')).toLowerCase().indexOf(sq) >= 0; }).sort(function (a, b) {
      if (sortKey === 'risk') return probOf(b) - probOf(a);
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'ko');
      if (sortKey === 'recent') {
        var ta = st.rec[a.id], tb = st.rec[b.id];
        if (ta == null && tb == null) return b.prob - a.prob;
        if (ta == null) return 1; if (tb == null) return -1;
        return tb - ta;
      }
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return b.prob - a.prob;
    }).map(function (x, ix) {
      var s = stateOf(x), on = x.id === st.sel, a = st.alerts[x.id], hi = s === 'done' && vOf(x) >= th;
      var pend = !!a && a.status !== 'done', isNew = !!a && a.status === 'new' && !a.seen;
      return { name: x.name, mrn: x.mrn || '', meta: x.meta, pick: pick(x.id), hasDot: isNew, cur: on ? 'true' : 'false',
        tileU: s === 'done', tile: s === 'done' ? Math.round(vOf(x) * 100) + '' : (s === 'waiting' ? '대기' : (s === 'held' ? '보류' : '—')), isAna: s === 'analyzing', notAna: s !== 'analyzing',
        tileStyle: 'position: relative; width: 52px; height: 52px; flex-shrink: 0; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; ' + (hi ? 'background: #FDECEA; color: #B42318;' : (s === 'done' ? 'background: #F0F2F5; color: #16191F;' : (s === 'analyzing' ? 'background: #F0F2F5; color: #16191F;' : (s === 'waiting' ? 'background: #EAF1FB; color: #2F5E97; font-size: 15px; box-shadow: inset 0 0 0 1px #C9DAF1;' : s === 'held' ? 'background: #F7F8FA; color: #646B78; font-size: 15px; box-shadow: inset 0 0 0 1px #D5D9E0;' : 'background: #FFFFFF; color: #B8BEC8; box-shadow: inset 0 0 0 1px #E4E7EC; border: 1px dashed #D5D9E0; box-sizing: border-box;')))),
        chip: a ? (a.status === 'done' ? (a.skip ? '불필요' : '완료') : (isNew ? '미확인' : '미조치')) : '',
        chipStyle: 'flex-shrink: 0; align-self: center; font-size: 15px; font-weight: 600; white-space: nowrap; border-radius: 999px; padding: 3px 9px; ' + (!a ? 'display: none;' : (isNew ? 'background: #B42318; color: #FFFFFF;' : (pend ? 'background: #FFFFFF; color: #B42318; box-shadow: inset 0 0 0 1px #E8B4AE;' : 'background: #F0F2F5; color: #646B78;'))),
        holter: s === 'done' ? fmt(st.rec[x.id]) + (jobIdx[x.id] ? ' · 새 기록 대기' : '') : (s === 'analyzing' ? '분석 중' : (s === 'waiting' ? '기록 수신 · 분석 대기 ' + jobIdx[x.id] + '번째' : (s === 'held' ? '계산 보류 · ' + ((st.held || {})[x.id].miss || []).join(', ') + ' 없음' : '기록 대기 · 미수신'))),
        holterStyle: 'font-size: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; ' + (s === 'waiting' ? 'color: #2F5E97; font-weight: 600;' : s === 'held' ? 'color: #646B78; font-weight: 600;' : (s === 'analyzing' ? 'color: #16191F; font-weight: 600;' : 'color: #8A919E;')),
        risk: s === 'done' ? Math.round(vOf(x) * 100) + '점' : '—',
        riskStyle: 'text-align: right; font-size: 23px; line-height: 1.2; font-variant-numeric: tabular-nums; font-weight: ' + (hi ? '700' : '500') + '; color: ' + (hi ? '#B42318' : '#16191F') + ';',
        flash: (st.toast === x.id ? 'row-flash' : ((st.syncNew || []).indexOf(x.id) >= 0 ? 'row-new' : '')) + (st.sortTick ? (st.sortTick % 2 ? ' rs-a' : ' rs-b') : ''),
        delay: st.sortTick ? 'animation-delay: ' + Math.min(ix, 10) * 28 + 'ms; ' : '',
        alert: a ? (a.status === 'done' ? (a.skip ? '조치 불필요' : '조치 완료') : (a.status === 'new' ? '조치 전 · 미확인' : '조치 전')) : '—',
        alertStyle: 'font-size: 17px; ' + (a && a.status !== 'done' ? 'color: #B42318; font-weight: 600;' : 'color: #646B78;'),
        style: (st.sortTick ? 'animation-delay: ' + Math.min(ix, 10) * 28 + 'ms; ' : '') + rowBase + 'display: flex; align-items: center; gap: 12px; padding: 10px; border-bottom: none; border-radius: 12px; ' + (on ? 'background: #E9EBEF;' : (pend ? 'background: #FFF7F6;' : 'background: transparent;')) + ' transition: background-color .12s;' };
    });
    var logPt = st.logPt || 'all', logWho = st.logWho || 'all';
    var HUMAN = ['담당의', '당직의', '관리자'], logKind = st.logKind || 'human';
    var logQ = st.logQ || '', q = logQ.trim().toLowerCase();
    var mrnOf = {}; P.forEach(function (x) { mrnOf[x.name] = x.mrn; });
    var logs = st.logs.filter(function (l) {
      if ((HUMAN.indexOf(l.who) >= 0) !== (logKind === 'human')) return false;
      if (!((logPt === 'all' || l.pt === logPt) && (logWho === 'all' || l.who === logWho))) return false;
      if (!q) return true;
      return (l.pt + ' ' + (mrnOf[l.pt] || '') + ' ' + l.who + ' ' + l.ev).toLowerCase().indexOf(q) >= 0;
    })
      .map(function (l) {
        var tgt = P.filter(function (x) { return x.name === l.pt; })[0];
        var selName = (self.find(st.sel) || {}).name, isSel = !!tgt && l.pt === selName;
        var pendA = tgt && st.alerts[tgt.id] && st.alerts[tgt.id].status !== 'done';
        return { t: fmt(l.t), who: l.who, pt: l.pt, ev: l.ev, isPt: !!tgt, noPt: !tgt,
          ptStyle: 'padding: 0; border: none; background: transparent; font-size: 17px; font-weight: 600; text-align: left; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; ' + (pendA ? 'color: #B42318; text-decoration-color: #E8B4AE;' : 'color: #16191F; text-decoration-color: #B8BEC8;'),
          rowStyle: 'display: grid; grid-template-columns: 84px 60px 64px minmax(0, 1fr); gap: 10px; padding: 10px 16px; border-bottom: 1px solid #F0F2F5; font-size: 17px; ' + (pendA ? 'box-shadow: inset 3px 0 0 #B42318; background: ' + (isSel ? '#F8E6E4' : '#FDF3F2') + ';' : 'background: ' + (isSel ? '#F3F4F6' : '#FFFFFF') + ';'),
          pick: function () { if (tgt) self.setState({ sel: tgt.id, toast: null, toasts: self._tLeft(tgt.id), tEv: 'up', tUp: self._tBelow(tgt.id), tUpSeq: (self.state.tUpSeq || 0) + 1 }); } };
      });
    var ptOpts = [{ v: 'all', label: '전체 환자' }].concat(P.map(function (x) { return { v: x.name, label: x.name + ' (' + x.mrn + ')' }; }));
    var whoSeen = {}; st.logs.forEach(function (l) { whoSeen[l.who] = true; });
    var admq = (st.admQ || '').trim().toLowerCase();
    var sysAll = st.logs.filter(function (l) { return HUMAN.indexOf(l.who) < 0; });
    var sysLogs = sysAll.filter(function (l) { return !admq || (l.pt + ' ' + (mrnOf[l.pt] || '') + ' ' + l.who + ' ' + l.ev).toLowerCase().indexOf(admq) >= 0; })
      .map(function (l) { return { t: fmt(l.t), who: l.who, pt: l.pt, ev: l.ev }; });
    var whoOpts = [{ v: 'all', label: '전체' }].concat((logKind === 'human' ? ['담당의', '당직의', '관리자'] : ['판독실', '시스템']).filter(function (w) { return whoSeen[w] || w === '담당의' || w === '시스템'; }).map(function (w) { return { v: w, label: w }; }));
    var V = this.valData(), tp = 0, fp = 0, fn = 0, tn = 0;
    var vrows = V.map(function (v, i) {
      var pred = v[0] >= th ? 1 : 0, ok = pred === v[1];
      if (pred && v[1]) tp++; else if (pred) fp++; else if (v[1]) fn++; else tn++;
      return { label: '검증 ' + pad(i + 1), pct: Math.round(v[0] * 100), pred: pred ? '고위험' : '—', actual: v[1] ? 'SCD' : '생존',
        judge: ok ? '일치' : (v[1] ? '놓침' : '오경보'),
        judgeStyle: 'color: ' + (ok ? '#646B78' : '#B42318') + '; font-weight: ' + (ok ? '400' : '600') + ';' };
    });
    var pc = function (a, c) { return c ? Math.round(a / c * 100) + '%' : '—'; };

    var p = this.find(st.sel) || P[0] || this.emptyPatient(), ps = stateOf(p), a = st.alerts[p.id], isHi = p.prob >= th;
    var pid = p.id, recT = st.rec[pid], exams = [], hl = ((st.hist || {})[pid] || []).slice().sort(function (x, y) { return y.t - x.t; });
    if (recT != null) exams.push({ cur: true, t: recT, prob: p.prob, f: p.f, ver: (st.recVer || {})[pid] || 'v0.1', act: this.actSum(a) });
    hl.forEach(function (h, i) { exams.push(Object.assign({ hi: i }, h)); });
    var ex = st.exam && st.exam.pid === pid ? hl[st.exam.i] : null, viewPast = !!ex;
    if (ps === 'analyzing' && st.next && st.next[pid]) { p = Object.assign({}, p, st.next[pid]); a = null; }
    if (viewPast) { p = Object.assign({}, p, { prob: ex.prob, f: ex.f }); a = null; ps = 'done'; recT = ex.t; isHi = p.prob >= th; }
    var examRows = exams.map(function (e, k) {
      var older = exams[k + 1], ev0 = e[VK] || 0, diff = older ? Math.round(ev0 * 100) - Math.round((older[VK] || 0) * 100) : null;
      var on = e.cur ? !viewPast : (viewPast && st.exam.i === e.hi), d = new Date(e.t), hiE = ev0 >= th;
      return { date: (d.getFullYear()) + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()), time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
        pct: Math.round(ev0 * 100) + '', diffU: diff != null && diff !== 0, tag: e.cur ? '최신' : '', isCur: !!e.cur,
        diff: diff == null ? (self.state.me?.data_mode === 'music' ? '첫 분석' : '첫 검사') : (diff > 0 ? '▲ ' + diff : (diff < 0 ? '▼ ' + (-diff) : '변화 없음')),
        diffStyle: 'min-width: 0; font-size: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; color: ' + (diff > 0 ? '#B42318' : '#646B78') + ';',
        ver: e.ver, act: e.act, aria: on ? 'true' : 'false',
        gap: older ? (function () { var dd = Math.round((e.t - older.t) / 86400000); return dd <= 0 ? '당일' : dd + '일 후'; })() : '—',
        gapStyle: 'min-width: 0; font-size: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; color: #646B78;',
        top: (function () { var t = (e.f || []).filter(function (x) { return x[3] > 0; }).sort(function (a, b) { return b[3] - a[3]; })[0]; return t ? t[0] : '—'; })(),
        topTip: (function () { var t = (e.f || []).filter(function (x) { return x[3] > 0; }).sort(function (a, b) { return b[3] - a[3]; })[0]; return t ? t[0] + ' · ' + t[2] + ' · 기여도 +' + t[3].toFixed(2) : ''; })(),
        topStyle: 'min-width: 0; font-size: 16px; color: #16191F; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
        pctStyle: 'font-size: 18px; font-weight: 400; font-variant-numeric: tabular-nums; color: ' + (hiE ? '#B42318' : '#16191F') + ';',
        pick: function () { var back = e.cur || (viewPast && st.exam.i === e.hi), vk = 'prob', curP = exams.length && exams[0].cur ? exams[0][vk] : null; self.setState({ exam: back ? null : { pid: pid, i: e.hi }, seg: null, memoEdit: null, actEdit: null, logAll: false, trTick: (self.state.trTick || 0) + 1 }); self.countUp(pid, back ? (curP == null ? null : Math.round(curP * 100)) : Math.round((e[vk] || 0) * 100)); },
        style: 'display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 8px 12px; border-radius: 8px; text-align: left; cursor: pointer; color: #16191F; font-size: 17px; ' + 'border: 1px solid transparent; background: ' + (e.cur ? (on ? '#E3ECF8' : '#F1F5FB') : (on ? '#E9EBEF' : 'transparent')) + ';' };
    });
    var exCur = viewPast ? exams.filter(function (e) { return e.hi === st.exam.i; })[0] : null;
    var exRef = viewPast ? exCur : (exams[0] && exams[0].cur ? exams[0] : null);
    var periodOn = !!exRef && !st.logAll, pStart = exRef ? exRef.t : 0, pEnd = Infinity;
    if (exRef) exams.forEach(function (e) { if (e.t > pStart && e.t < pEnd) pEnd = e.t; });
    var hhList = st.logs.filter(function (l) { return l.pt === p.name && ['담당의', '당직의', '관리자'].indexOf(l.who) >= 0 && (!periodOn || (l.t >= pStart && l.t < pEnd)); });
    var ymd = function (t) { var q = new Date(t); return q.getFullYear() + '.' + pad(q.getMonth() + 1) + '.' + pad(q.getDate()); };
    var selK = 0; exams.forEach(function (e, k) { if (viewPast ? e.hi === st.exam.i : e.cur) selK = k; });
    var asc = exams.slice().reverse(), nE = asc.length;
    var vals = [th * 100]; asc.forEach(function (e) { if (e.prob != null) vals.push(e.prob * 100); });
    var yLo = Math.max(0, Math.floor((Math.min.apply(null, vals) - 6) / 5) * 5), yHi = Math.min(100, Math.ceil((Math.max.apply(null, vals) + 6) / 5) * 5);
    if (yHi - yLo < 30) { var mid = (yHi + yLo) / 2; yLo = Math.max(0, Math.round((mid - 15) / 5) * 5); yHi = Math.min(100, yLo + 30); }
    var yOf = function (v) { return (yHi - v * 100) / (yHi - yLo) * 100; };
    var thY = (yOf(th) * 2).toFixed(1);
    var mkTr = function (key, withTh) {
    var tr = { n: nE, ok: nE >= 2, none: nE < 2, pts: [], d: '', area: '', thPath: 'M0 ' + thY + 'H1000', thLbl: '기준 ' + Math.round(th * 100),
      thLblStyle: 'position: absolute; left: -72px; width: 62px; text-align: right; top: calc(' + yOf(th).toFixed(2) + '% - 9px); font-size: 15px; font-weight: 600; color: #B42318; font-variant-numeric: tabular-nums; white-space: nowrap;' };
    asc.forEach(function (e, i) {
      var x = nE === 1 ? 50 : 4 + 92 * i / (nE - 1), y = yOf(e[key] || 0), k = nE - 1 - i, on = k === selK, hiE = (e[key] || 0) >= th, c = hiE ? '#B42318' : '#16191F', q = new Date(e.t);
      tr.d += (i ? ' L' : 'M') + (x * 10).toFixed(1) + ' ' + (y * 2).toFixed(1);
      tr.pts.push({ tipPos: x > 70 ? 'r' : (x < 30 ? 'l' : ''), on: on ? 'true' : 'false', pct: Math.round((e[key] || 0) * 100) + '', label: (q.getMonth() + 1) + '/' + q.getDate(),
        tip: ymd(e.t) + ' · 위험 점수 ' + Math.round((e[key] || 0) * 100) + '점' + (e.cur ? ' · 최신' : ''), aria: ymd(e.t) + ' 검사, 위험 점수 ' + Math.round((e[key] || 0) * 100) + '점' + (e.cur ? ', 최신' : ''),
        pick: function () { var back = e.cur || (viewPast && st.exam.i === e.hi), vk = 'prob', curP = exams.length && exams[0].cur ? exams[0][vk] : null; self.setState({ exam: back ? null : { pid: pid, i: e.hi }, seg: null, memoEdit: null, actEdit: null, logAll: false, trTick: (self.state.trTick || 0) + 1 }); self.countUp(pid, back ? (curP == null ? null : Math.round(curP * 100)) : Math.round((e[key] || 0) * 100)); },
        popCls: on && st.trTick ? ((st.trTick % 2) ? 'trp-a' : 'trp-b') : '', ringCls: on && st.trTick ? ('trr ' + ((st.trTick % 2) ? 'trr-a' : 'trr-b')) : 'trr-off',
        style: 'position: absolute; left: calc(' + x.toFixed(2) + '% - 16px); top: calc(' + y.toFixed(2) + '% - 16px); width: 32px; height: 32px; padding: 0; border: none; border-radius: 50%; background: transparent; color: ' + c + '; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2;',
        dot: 'display: block; border-radius: 50%; width: ' + (on ? 14 : 10) + 'px; height: ' + (on ? 14 : 10) + 'px; background: ' + c + '; box-shadow: ' + (on ? '0 0 0 3px #FFFFFF, 0 0 0 5px ' + c : '0 0 0 2px #FFFFFF') + ';',
        lblStyle: 'position: absolute; bottom: calc(100% - 4px); left: 50%; transform: translateX(-50%); font-size: 15px; font-weight: ' + (on ? '700' : '500') + '; color: ' + c + '; white-space: nowrap; font-variant-numeric: tabular-nums; pointer-events: none;',
        xStyle: 'position: absolute; left: ' + x.toFixed(2) + '%; transform: translateX(-50%); font-size: 15px; white-space: nowrap; font-variant-numeric: tabular-nums; color: ' + (on ? '#16191F' : '#646B78') + '; font-weight: ' + (on ? '600' : '400') + ';' });
    });
    if (nE >= 2) tr.area = tr.d + ' L960 200 L40 200 Z';
    if (!withTh) { tr.thPath = ''; tr.thLbl = ''; }
    return tr; };
    var tr = mkTr('prob', true);
    tr.yHi = yHi + ''; tr.yLo = yLo + ''; tr.yMid = 'top: calc(50% - 9px)'; tr.yMidT = Math.round((yHi + yLo) / 2) + '점';
    var curE = exams[selK], prevE = exams[selK + 1];
    var cmp = { ok: !!(curE && prevE && curE.f && prevE.f), rows: [], sub: prevE ? '직전 검사(' + ymd(prevE.t) + ') 대비' : '직전 검사 대비' };
    cmp.none = !cmp.ok;
    var cbar = function (v, col) { var wv = Math.min(50, Math.abs(v) / 0.3 * 50); return 'position: absolute; top: 0; bottom: 0; border-radius: 2px; ' + (v > 0 ? 'left: 50%;' : 'right: 50%;') + ' width: ' + wv.toFixed(1) + '%; background: ' + col + ';'; };
    if (cmp.ok) curE.f.slice(0, 3).forEach(function (x) {
      var pv = prevE.f.filter(function (y) { return y[0] === x[0]; })[0], a1 = pv ? pv[3] : null, df = a1 == null ? null : Math.round((x[3] - a1) * 100) / 100;
      var sg = function (v) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(2); };
      cmp.rows.push({ name: x[0], src: (x[1] === '임상' ? '' : x[1] + ' · ') + x[2],
        prevBar: a1 == null ? 'display: none;' : cbar(a1, '#C9CED6'), curBar: cbar(x[3], x[3] > 0 ? '#16191F' : '#8A919E'),
        delta: df == null ? '새 요인' : (df > 0 ? '▲ ' + sg(df) : (df < 0 ? '▼ ' + sg(df) : '변화 없음')),
        deltaStyle: 'font-size: 16px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; color: ' + (df > 0 ? '#B42318' : '#646B78') + '; font-weight: ' + (df > 0 ? '600' : '400') + ';',
        aria: x[0] + ', 직전 기여도 ' + (a1 == null ? '없음' : sg(a1)) + ', 이번 기여도 ' + sg(x[3]) });
    });
    var optDefs = ['외래 일정 앞당김', 'ICD 평가 의뢰', '추가 검사 (심장초음파 등)', '약물 조정 검토', '경과 관찰', '기타'];
    var draft = st.draft[p.id] || { acts: {}, memo: '' };
    var setDraft = function (patch) { var all = Object.assign({}, self.state.draft); all[p.id] = Object.assign({}, all[p.id] || { acts: {}, memo: '' }, patch); self.setState({ draft: all }); };
    var otherText = (draft.other || '').trim();
    var chosen = optDefs.filter(function (o) { return draft.acts[o]; }).map(function (o) { return o === '기타' ? '기타: ' + otherText : o; });
    var canDone = chosen.length > 0 && !(draft.acts['기타'] && !otherText);
    var skipReasons = ['임상적으로 위험이 낮다고 판단', '이미 관련 조치 중 (약물 조정 등)', '심전도 기록 품질 문제 (잡음·탈락)', '기타'];
    var canSkip = !!draft.reason && !(draft.reason === '기타' && !(draft.skipNote || '').trim());
    var ae = st.actEdit && st.actEdit.pid === p.id ? st.actEdit : null;
    var setAe = function (patch) { self.setState({ actEdit: Object.assign({}, self.state.actEdit, patch) }); };
    var aeOther = ae ? (ae.other || '').trim() : '';
    var aeChosen = ae ? optDefs.filter(function (o) { return ae.acts[o]; }).map(function (o) { return o === '기타' ? '기타: ' + aeOther : o; }) : [];
    var aeSkip = !!ae && ae.mode === 'skip';
    var aeOk = !!ae && (aeSkip ? (!!ae.reason && !(ae.reason === '기타' && !(ae.skipNote || '').trim())) : (aeChosen.length > 0 && !(ae.acts['기타'] && !aeOther)));
    var mlP = Math.round(p.prob * 100), basisTxt = ' (당시 위험 점수 ' + mlP + '점' + ')';
    var actSummary = function (skip, acts, reason, note) { return skip ? '조치 불필요(' + reason + (note ? ', ' + note : '') + ')' : (acts || []).join(', '); };
    var trail = [];
    if (a) {
      trail.push({ t: fmt(a.sent), ev: '알림' });
      if (a.reAt != null) trail.push({ t: fmt(a.reAt), ev: '재알림' });
      if (a.escAt != null) trail.push({ t: fmt(a.escAt), ev: '당직의 전달' });
      if (a.ackAt != null) trail.push({ t: fmt(a.ackAt), ev: '확인' });
      if (a.doneAt != null) trail.push({ t: fmt(a.doneAt), ev: a.skip ? '조치 불필요' : '조치 완료' });
    }
    var analyzed = ps === 'done';
    // 업로드 → 분석 진행 → 결과(발표 시연 흐름)
    var amVer = ((st.models || []).filter(function (x) { return x.id === st.activeModel; })[0] || { ver: '' }).ver;
    var sizeText = function (b) { return b >= 1e6 ? (b / 1e6).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1e3)) + 'KB'; };
    var upInfo = viewPast ? null : (st.uploads || {})[p.id], R = p.rec;
    var progK = st.prog && st.prog.id === p.id ? st.prog.k : (analyzed ? 5 : 0);
    var MIN_DUR = 20, durH = R ? (R.dur || 24) : 24, durShort = !!R && durH < MIN_DUR;
    var durText = Math.floor(durH) + '시간' + (Math.round((durH % 1) * 60) ? ' ' + Math.round((durH % 1) * 60) + '분' : '');
    if (self.state.me?.data_mode === 'music') durText = '자료 미제공';
    var vpbN = R ? (R.vpb != null ? R.vpb : Math.round(R.pvc * 24)) : 0;
    var stageDefs = R ? [
      ['판독 결과 수신', (upInfo ? fmt(upInfo.at) + ' ' : '') + '판독실 Holter 판독지 수신 · 기록 시간 ' + durText],
      ['입력값 확인', R.miss && R.miss.length ? 'EMR에 ' + R.miss.join(', ') + ' 값 없음 · 점수 계산 보류' : 'EMR 임상 변수 9개 + 판독 Holter 변수 3개 · 빠진 값 없음 · 대상 조건 확인(기기 이식·심장이식 없음)'],
      ['Holter 지표 확인', '24시간 심실조기수축 ' + vpbN.toLocaleString('ko-KR') + '회 · 심실 커플렛 ' + (R.cpl || 0) + '회 · 비지속성 심실빈맥 ' + (R.nsvt ? '있음' : '없음') + (durShort ? ' · 기록이 ' + MIN_DUR + '시간보다 짧음' : '')],
      ['위험 점수 계산', amVer + ' (로지스틱 회귀 · 변수 12개)로 위험 점수 계산 완료'],
      ['변수 기여도 정리', '변수 12개 중 위험 점수에 영향이 큰 요인 ' + Math.min(3, p.f.length) + '개 정리']
    ] : [];
    var pg = {
      file: upInfo ? upInfo.file : '', modelText: '모델 ' + amVer, doneCount: progK,
      meta: R && upInfo ? 'Holter 판독지 · ' + sizeText(upInfo.size) + ' · ' + fmt(upInfo.at) + ' 수신' : '',
      emr: (p.meta || '') + ' 등 9개 · ' + (R && R.miss && R.miss.length ? R.miss.join(', ') + ' 없음' : '빠진 값 없음'),
      hol: R ? '심실조기수축 ' + vpbN.toLocaleString('ko-KR') + '회 · 커플렛 ' + (R.cpl || 0) + '회 · NSVT ' + (R.nsvt ? '있음' : '없음') : '',
      durText: durText, short: durShort,
      durStyle: 'min-width: 0; ' + (durShort ? 'color: #B42318; font-weight: 600;' : 'color: #16191F;'),
      shortText: '기록 시간이 ' + MIN_DUR + '시간보다 짧습니다. 판독지의 횟수가 실제보다 적게 잡혔을 수 있어 위험 점수가 낮게 나올 수 있습니다.',
      stages: stageDefs.map(function (sd, k) {
        var stt = k < progK ? 'done' : (k === progK ? 'running' : 'wait');
        return { label: sd[0], info: sd[1], done: stt === 'done', running: stt === 'running', icCls: 'stage-ic ' + stt,
          stateText: { done: '완료', running: '진행 중', wait: '대기' }[stt],
          infoText: stt === 'done' ? sd[1] : (stt === 'running' ? '진행 중…' : '대기'), infoTip: stt === 'done' ? sd[1] : '', infoCls: stt === 'done' ? 'stage-info' : '',
          infoStyle: 'display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; height: 2.9em; line-height: 1.45; font-size: 17px; font-variant-numeric: tabular-nums; color: ' + (stt === 'wait' ? '#B8BEC8' : '#646B78') + ';',
          labelStyle: 'font-size: 18px; ' + (stt === 'running' ? 'font-weight: 600; color: #16191F;' : (stt === 'wait' ? 'color: #8A919E;' : 'color: #16191F;')) };
      })
    };
    var upl = st.upl && st.upl.id === p.id ? st.upl : null, upFile = st.upFile && st.upFile.id === p.id ? st.upFile : null;
    var upErr = st.upErr && st.upErr.id === p.id ? st.upErr.msg : '';
    var pickFile = function (f) {
      if (!f) return;
      if (!/\.(xml|json)$/i.test(f.name)) { self.setState({ upErr: { id: p.id, msg: 'Holter 판독 결과 파일(.xml, .json)만 올릴 수 있습니다.' }, upOver: false }); return; }
      self.setState({ upFile: { id: p.id, name: f.name, size: f.size }, upErr: null, upOver: false });
    };
    var up = {
      busy: !!upl, idle: !upl, step: upl ? upl.file + ' 올리는 중' : '', pct: upl ? Math.round(upl.r * 100) : 0,
      barStyle: 'position: absolute; left: 0; top: 0; bottom: 0; background: #16191F; width: ' + (upl ? Math.round(upl.r * 100) : 0) + '%;',
      dropCls: 'drop' + (st.upOver ? ' over' : ''),
      dropTitle: upFile ? upFile.name : '파일을 여기에 끌어 놓거나 눌러서 고르세요',
      dropSub: upFile ? sizeText(upFile.size) + ' · 다른 파일을 고르려면 누르세요' : 'Holter 판독 결과 (.xml, .json)',
      hasFile: !!upFile, hasSample: !!R, noSample: !R,
      sampleName: R ? R.file : '', sampleSize: R ? sizeText(R.size) : '',
      hasErr: !!upErr, err: upErr,
      onFile: function (e) { pickFile(e.target.files && e.target.files[0]); try { e.target.value = ''; } catch (err) {} },
      dragOver: function (e) { e.preventDefault(); if (!self.state.upOver) self.setState({ upOver: true }); },
      dragLeave: function () { if (self.state.upOver) self.setState({ upOver: false }); },
      drop: function (e) { e.preventDefault(); pickFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); },
      sendFile: function () { if (upFile) self.upload(p.id, upFile.name); },
      sendSample: function () { if (R) self.upload(p.id, R.file); }
    };
    var counting = !!(st.cu && st.cu.id === p.id), shown = counting ? st.cu.v : Math.round(p.prob * 100);
    var hiK = Math.max(0, Math.min(1, shown / Math.max(1, Math.round(p.prob * 100)))), hiK2 = hiK * hiK;
    var hiMix = 'rgb(' + Math.round(22 + (180 - 22) * hiK2) + ', ' + Math.round(25 + (35 - 25) * hiK2) + ', ' + Math.round(31 + (24 - 31) * hiK2) + ')';
    var d = {
      name: p.name, mrn: p.mrn, meta: p.meta, next: p.next, analyzed: analyzed, pending: !analyzed,
      tr: tr, cmp: cmp, mlOn: analyzed,
      gaugeStyle: 'position: relative; height: 6px; border-radius: 3px; background: #EEF0F3;',
      isQueued: ps === 'queued', isAnalyzing: ps === 'analyzing', isWaiting: ps === 'waiting', isHeld: ps === 'held',
      heldText: ps === 'held' ? (function () { var h = st.held[pid]; return fmt(h.at) + ' 판독 결과는 받았지만 EMR에 ' + h.miss.join(', ') + ' 값이 없어 위험 점수를 계산하지 않았습니다. 모델은 빠진 값을 추정하지 않습니다. 검사 결과가 EMR에 들어오면 다시 계산합니다.'; })() : '',
      heldTitle: '', heldSub: ps === 'held' ? fmt(st.held[pid].at) + ' 판독 결과 수신 · 필수 입력값 ' + st.held[pid].miss.length + '개 없음' : '', heldMiss: ps === 'held' ? st.held[pid].miss.map(function (m) { return m + ' (EMR 검사 결과 없음)'; }).join(', ') : '', recheck: function () { self.recheck(pid); },
      waitNo: (jobIdx[pid] || 1) + '', waitText: (function () { var u = (st.uploads || {})[pid]; return (u ? fmt(u.at) + ' 판독실에서 받은 기록입니다. ' : '') + '분석 대기열 ' + (jobIdx[pid] || 1) + '번째 · 앞선 기록의 분석이 끝나면 자동으로 분석합니다.'; })(),
      reWait: !viewPast && ps === 'done' && !!jobIdx[pid], reWaitText: '새 Holter 기록이 들어와 분석 대기열 ' + (jobIdx[pid] || 1) + '번째입니다. 아래는 이전 검사 결과입니다.',
      hasExams: exams.length > 0, examRows: examRows, examCount: exams.length + '건',
      viewPast: viewPast, pastText: exCur ? (function () { var dd = new Date(exCur.t); return dd.getFullYear() + '.' + pad(dd.getMonth() + 1) + '.' + pad(dd.getDate()) + ' ' + pad(dd.getHours()) + ':' + pad(dd.getMinutes()) + ' 검사 · 모델 ' + exCur.ver; })() : '',
      pastAct: exCur ? '당시 처리: ' + exCur.act : '',
      pastActLabel: !exCur ? '' : (exCur.act.indexOf('조치 불필요') === 0 ? '조치 불필요 · 사유' : (exCur.act.indexOf('조치 완료') === 0 ? '조치' : '처리')),
      pastActText: !exCur ? '' : (exCur.act.indexOf(' · ') > 0 ? exCur.act.slice(exCur.act.indexOf(' · ') + 3) : (exCur.act === '알림 없음' ? '알림 없음 (알림 기준 미만)' : exCur.act)),
      pastMemo: exCur && exCur.memo ? exCur.memo : '메모 없음',
      pastMemoStyle: 'white-space: pre-wrap; min-width: 0; display: block; font-size: 18px; line-height: 1.55; color: ' + (exCur && exCur.memo ? '#16191F' : '#8A919E') + ';', pastShort: exCur ? (function () { var dd = new Date(exCur.t); return dd.getFullYear() + '.' + pad(dd.getMonth() + 1) + '.' + pad(dd.getDate()) + ' ' + pad(dd.getHours()) + ':' + pad(dd.getMinutes()); })() : '',
      backLatest: function () { self.setState({ exam: null, seg: null }); }, backLabel: st.rec[pid] != null ? '최신 검사로 돌아가기' : '과거 검사 닫기',
      hasInput: analyzed && !!upInfo && !!R, inFile: upInfo ? upInfo.file : '',
      inMeta: R && upInfo ? 'Holter 판독지 · 기록 시간 ' + durText + ' · 모델 ' + amVer : '',
      pctShown: shown + '점', pctNum: shown + '', bandCls: counting ? '' : 'count-in',
      pendingText: ps === 'analyzing' ? 'Holter 기록을 분석하고 있습니다.' : '다음 Holter 기록이 병원 시스템에 들어오면 자동으로 분석합니다.',
      holter: analyzed ? '24시간 Holter · ' + fmt(recT) + ' 분석' : '',
      holterShort: analyzed ? fmt(recT) : '', holterTip: analyzed ? (self.state.me?.data_mode === 'music' ? 'MUSIC 모델 위험 점수 · 서비스 분석 시각 ' : '4년 이내 SCD 위험 점수 · 24시간 Holter 기록 · ') + fmt(recT) + ' 분석' : '',
      pct: Math.round(p.prob * 100) + '', bandLabel: band(p.prob),
      pctStyle: 'font-size: 44px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; color: ' + (isHi ? hiMix : '#16191F') + ';',
      bandStyle: 'position: relative; top: -.1em; font-size: 18px; font-weight: 600; color: ' + (isHi ? '#B42318' : '#646B78') + '; visibility: ' + (counting ? 'hidden' : 'visible') + ';',
      barFill: 'position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; width: ' + shown + '%; background: ' + (isHi ? hiMix : '#8A919E') + ';',
      thTick: 'position: absolute; top: -4px; width: 2px; height: 14px; background: #16191F; left: calc(' + thPct + '% - 1px);',
      factors: p.f.slice(0, 3).map(function (x) {
        var up = x[3] > 0, mag = Math.abs(x[3]), wpct = Math.min(50, mag / 0.3 * 50);
        var refs = [['LVEF', '50% 이상'], ['Pro-BNP', '125 ng/L 미만'], ['eGFR', '60 이상'], ['비지속성 심실빈맥', '없음'], ['NYHA', 'I (증상 없음)']];
        var ref = '—'; refs.forEach(function (r) { if (x[0].indexOf(r[0]) >= 0) ref = r[1]; });
        return { name: x[0], src: x[1], hasSrc: x[1] !== '임상', val: x[2], ref: ref, meta: x[1] + ' · ' + x[2],
          valStyle: 'font-size: 18px; font-weight: 400; font-variant-numeric: tabular-nums; color: ' + (up ? '#16191F' : '#646B78') + ';',
          tip: '기준 ' + (ref === '—' ? '없음' : ref) + ' · 기여도 ' + (up ? '+' : '−') + mag.toFixed(2),
          refText: ref === '—' ? '정해진 기준 없음' : ref, dirText: up ? '위험을 높임' : '위험을 낮춤', srcText: x[1] + ' 정보 · 선형 모델 기여도(log-odds)', popEffStyle: 'color: ' + (up ? '#F4A49B' : '#FFFFFF') + ';', popEffStyleLight: 'white-space: nowrap; font-variant-numeric: tabular-nums; color: ' + (up ? '#B42318' : '#646B78') + ';',
          aria: x[0] + ', ' + x[2] + ', 참고 기준 ' + (ref === '—' ? '없음' : ref) + ', 기여도 ' + (up ? '+' : '−') + mag.toFixed(2),
          bar: 'position: absolute; top: 3px; bottom: 3px; border-radius: 2px; ' + (up ? 'left: 50%; background: #16191F;' : 'right: 50%; background: #B8BEC8;') + ' width: ' + wpct.toFixed(1) + '%;',
          eff: (up ? '+' : '−') + mag.toFixed(2),
          effStyle: 'font-size: 18px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: ' + (up ? '700' : '400') + '; color: ' + (up ? '#16191F' : '#646B78') + ';' };
      }),
      hasAlert: !!a, noAlert: !a, trail: trail,
      isNew: !!a && a.status === 'new', isAck: !!a && a.status === 'ack', isDone: !!a && a.status === 'done',
      doneActs: a && a.acts ? a.acts.join(', ') : '',
      doneLabel: a && a.skip ? '조치 불필요 · 사유' : '조치',
      doneText: a && a.skip ? a.reason + (a.skipNote ? ' (' + a.skipNote + ')' : '') : (a && a.acts && a.acts.length ? a.acts.join(', ') : '—'),
      actEditing: !!ae, actView: true, hasBasis: !!(a && a.mlP != null), doneBasis: a && a.mlP != null ? '판단 당시 위험 점수 ' + a.mlP : '',
      actEdited: !!(a && a.actAt), actEditedAt: a && a.actAt ? fmt(a.actAt) : '',
      editAct: function (ev0) { var acts = {}, other = ''; ((a && a.acts) || []).forEach(function (s) { if (s.indexOf('기타: ') === 0) { acts['기타'] = true; other = s.slice(4); } else acts[s] = true; }); self.setState({ edFx: self._fxEl(ev0 && ev0.currentTarget), edClosing: false, edDone: false, memoEdit: null, actEdit: { pid: p.id, mode: a && a.skip ? 'skip' : 'act', acts: acts, other: other, reason: (a && a.reason) || '', skipNote: (a && a.skipNote) || '' } }); },
      aeIsAct: !!ae && !aeSkip, aeIsSkip: aeSkip,
      aeModeAct: function () { setAe({ mode: 'act' }); }, aeModeSkip: function () { setAe({ mode: 'skip' }); },
      aeOpts: optDefs.map(function (o) { return { label: o, checked: !!(ae && ae.acts[o]), toggle: function () { var acts = Object.assign({}, self.state.actEdit.acts); acts[o] = !acts[o]; setAe({ acts: acts }); } }; }),
      aeOtherOn: !!(ae && ae.acts['기타']), aeOtherText: ae ? ae.other || '' : '', aeSetOther: function (e) { setAe({ other: e.target.value }); },
      aeReasons: skipReasons.map(function (r) { return { label: r, checked: !!ae && ae.reason === r, pick: function () { setAe({ reason: r }); } }; }),
      aeSkipNote: ae ? ae.skipNote || '' : '', aeSetSkipNote: function (e) { setAe({ skipNote: e.target.value }); },
      aeSkipNoteLabel: ae && ae.reason === '기타' ? '설명 (필수)' : '설명 (선택)',
      aeInvalid: !aeOk,
      aeSaveStyle: 'min-height: 32px; padding: 2px 16px; border-radius: 6px; font-size: 16px; ' + (aeOk ? 'border: 1px solid #16191F; background: #16191F; color: #FFFFFF; cursor: pointer;' : 'border: 1px solid #E4E7EC; background: #F7F8FA; color: #8A919E;'),
      cancelAct: function () { self._edClose(false, function () { self.setState({ actEdit: null }); }); },
      saveAct: function () {
        if (!aeOk || !a) return;
        var T = Date.now(), note = aeSkip ? (ae.skipNote || '').trim() : '';
        var before = actSummary(!!a.skip, a.acts, a.reason, a.skipNote), after = actSummary(aeSkip, aeChosen, ae.reason, note);
        if (before === after) { self._edClose(false, function () { self.setState({ actEdit: null }); }); return; }
        self._edClose(true, function () { self.updAlert(p.id, aeSkip ? { skip: true, acts: [], reason: ae.reason, skipNote: note, actAt: T, mlP: mlP } : { skip: false, acts: aeChosen, reason: '', skipNote: '', actAt: T, mlP: mlP }, { t: T, who: '담당의', pt: p.name, ev: '조치 변경 · ' + before + ' → ' + after + basisTxt });
        self.setState({ actEdit: null, logPulse: (self.state.logPulse || 0) + 1 }); });
      },
      memoBody: a && a.memo ? a.memo : '메모 없음',
      memoBodyStyle: 'white-space: pre-wrap; min-width: 0; display: block; font-size: 18px; line-height: 1.55; ' + (a && a.memo ? 'color: #16191F;' : 'color: #8A919E;'),
      doneLine: a && a.skip ? '조치하지 않음 · ' + a.reason + (a.skipNote ? ' (' + a.skipNote + ')' : '') : '조치: ' + (a && a.acts ? a.acts.join(', ') : ''),
      isActMode: (draft.mode || 'act') === 'act', isSkipMode: draft.mode === 'skip',
      modeAct: function () { setDraft({ mode: 'act' }); }, modeSkip: function () { setDraft({ mode: 'skip' }); },
      actTabStyle: 'min-height: 44px; padding: 8px 6px; margin-bottom: -1px; border: none; border-bottom: 2px solid ' + ((draft.mode || 'act') === 'act' ? '#16191F' : 'transparent') + '; background: transparent; font-size: 18px; cursor: pointer; color: ' + ((draft.mode || 'act') === 'act' ? '#16191F; font-weight: 600;' : '#646B78;'),
      skipTabStyle: 'min-height: 44px; padding: 8px 6px; margin: 0 0 -1px 14px; border: none; border-bottom: 2px solid ' + (draft.mode === 'skip' ? '#16191F' : 'transparent') + '; background: transparent; font-size: 18px; cursor: pointer; color: ' + (draft.mode === 'skip' ? '#16191F; font-weight: 600;' : '#646B78;'),
      reasons: skipReasons.map(function (r) { return { label: r, checked: draft.reason === r, pick: function () { setDraft({ reason: r }); } }; }),
      skipNote: draft.skipNote || '', setSkipNote: function (e) { setDraft({ skipNote: e.target.value }); },
      skipNoteLabel: draft.reason === '기타' ? '설명 (필수)' : '설명 (선택)',
      noSkip: !canSkip,
      skipStyle: 'min-height: 44px; padding: 8px 20px; border-radius: 8px; font-size: 18px; font-weight: 600; ' + (canSkip ? 'border: 1px solid #16191F; background: #FFFFFF; color: #16191F; cursor: pointer;' : 'border: 1px solid #E4E7EC; background: #F7F8FA; color: #8A919E;'),
      skip: function () {
        if (!canSkip || self.state.ackClosing) return;
        self.setState({ ackClosing: true, ackDone: true, ackFx: self._fxToLog() || self.state.ackFx }); self._timers.push(setTimeout(function () { self.setState({ ackClosing: false });
        var T = Date.now(), note = (draft.skipNote || '').trim();
        self.updAlert(p.id, { status: 'done', skip: true, doneAt: T, reason: draft.reason, skipNote: note, acts: [], memo: '', mlP: mlP }, { t: T, who: '담당의', pt: p.name, ev: '조치 불필요 · ' + draft.reason + (note ? ' (' + note + ')' : '') + basisTxt }); self.setState({ logPulse: (self.state.logPulse || 0) + 1, logAll: false }); }, 300));
      }, memo: a && a.status === 'done' ? a.memo : draft.memo, hasMemo: !!(a && a.memo),
      opts: optDefs.map(function (o) { return { label: o, checked: !!draft.acts[o], toggle: function () { var acts = Object.assign({}, draft.acts); acts[o] = !acts[o]; setDraft({ acts: acts }); } }; }),
      setMemo: function (e) { setDraft({ memo: e.target.value }); },
      noActs: !canDone,
      otherOn: !!draft.acts['기타'], otherText: draft.other || '',
      setOther: function (e) { setDraft({ other: e.target.value }); },
      completeStyle: 'min-height: 44px; padding: 8px 20px; border-radius: 8px; font-size: 18px; font-weight: 600; ' + (canDone ? 'border: 1px solid #16191F; background: #16191F; color: #FFFFFF; cursor: pointer;' : 'border: 1px solid #E4E7EC; background: #F7F8FA; color: #8A919E;'),
      ackWrapStyle: 'display: flex; flex-direction: column; overflow: hidden; ' + (st.ackClosing ? 'animation: ackClose .22s cubic-bezier(.4,0,.6,1) both' : 'animation: ackOpen .34s cubic-bezier(.22,.61,.36,1) both'),
      cancelAck: function () { if (self.state.ackClosing) return; self.setState({ ackClosing: true }); self.setState({ ackDone: false }); self._timers.push(setTimeout(function () { self.setState({ ackClosing: false }); self.updAlert(p.id, { status: 'new', ackAt: null }, []); }, 230)); },
      ack: function (e) {
        var T = Date.now();
        self.setState({ ackFx: self._fxEl(e && e.currentTarget), ackClosing: false, ackDone: false });
        self.updAlert(p.id, { status: 'ack', ackAt: T }, []);
      },
      ackOv: st.ackClosing ? 'ov-out' : 'ov-in', ackDlg: st.ackClosing ? (st.ackDone ? 'mdl-done' : 'mdl-out') : 'mdl-in',
      ackDlgStyle: 'width: 100%; max-width: 640px; max-height: calc(100vh - 40px); overflow-y: auto; overscroll-behavior: contain; background: #FFFFFF; border-radius: 16px; box-shadow: 0 20px 48px rgba(22, 25, 31, 0.18); display: flex; flex-direction: column; box-sizing: border-box; ' + (st.ackFx || ''),
      edOv: st.edClosing ? 'ov-out' : 'ov-in', edDlg: st.edClosing ? (st.edDone ? 'mdl-done' : 'mdl-out') : 'mdl-in',
      edDlgStyle: 'width: 100%; max-width: 600px; max-height: calc(100vh - 40px); overflow-y: auto; overscroll-behavior: contain; background: #FFFFFF; border-radius: 16px; box-shadow: 0 20px 48px rgba(22, 25, 31, 0.18); display: flex; flex-direction: column; box-sizing: border-box; ' + (st.edFx || ''),
      edEscFn: function () { if (self._edEsc) self._edEsc(); },
      ovClickEd: function (e) { if (self._ovDown && e.target === e.currentTarget && self._edEsc) self._edEsc(); self._ovDown = false; },
      ovClickAck: function (e) { if (self._ovDown && e.target === e.currentTarget && self._ackEsc) self._ackEsc(); self._ovDown = false; },
      alertTitle: a && a.status === 'done' ? (a.skip ? '조치 불필요' : '조치 완료') : '조치 필요',
      pendingIcon: !!a && a.status !== 'done', doneIcon: !!a && a.status === 'done',
      hasPanel: !!a && (st.histOpen === p.id || a.status === 'done'),
      alertChip: 'display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 8px; box-sizing: border-box; ' + (a && a.status !== 'done' ? 'border: 1px solid #F2D4D0; background: #FDF3F2;' : 'border: 1px solid #E4E7EC; background: #FFFFFF;'),
      memoEditing: !!(st.memoEdit && st.memoEdit.pid === p.id), memoView: true,
      memoText: a && a.memo ? '메모: ' + a.memo : '메모 없음', memoBtnText: a && a.memo ? '메모 수정' : '메모 추가',
      memoEdited: !!(a && a.memoAt), memoEditedAt: a && a.memoAt ? fmt(a.memoAt) : '',
      memoDraft: st.memoEdit && st.memoEdit.pid === p.id ? st.memoEdit.text : '',
      editMemo: function (ev0) { self.setState({ edFx: self._fxEl(ev0 && ev0.currentTarget), edClosing: false, edDone: false, actEdit: null, memoEdit: { pid: p.id, text: (a && a.memo) || '' } }); },
      setMemoDraft: function (e) { self.setState({ memoEdit: { pid: p.id, text: e.target.value } }); },
      cancelMemo: function () { self._edClose(false, function () { self.setState({ memoEdit: null }); }); },
      saveMemo: function () {
        var text = (self.state.memoEdit && self.state.memoEdit.text || '').trim(), T = Date.now();
        if (text === ((a && a.memo) || '')) { self._edClose(false, function () { self.setState({ memoEdit: null }); }); return; }
        var old = (a && a.memo) || '', ev2 = !old ? '메모 추가 · ' + text : (!text ? '메모 삭제 · 이전: ' + old : '메모 수정 · ' + old + ' → ' + text);
        self._edClose(true, function () { self.updAlert(p.id, { memo: text, memoAt: T }, { t: T, who: '담당의', pt: p.name, ev: ev2 }); self.setState({ memoEdit: null, logPulse: (self.state.logPulse || 0) + 1 }); });
      },
      alertTitleStyle: 'font-size: 19px; font-weight: 600; color: ' + (a && a.status === 'done' ? '#16191F' : '#B42318') + ';',
      alertSub: trail.map(function (x) { return x.ev + ' ' + x.t; }).join(' · '),
      histOpen: st.histOpen === p.id,
      histCls: st.histClosing ? 'hist-out' : 'hist-in',
      toggleHist: function () {
        var S = self.state;
        if (S.histOpen === p.id) {
          if (S.histClosing) return;
          self.setState({ histClosing: true });
          self._timers.push(setTimeout(function () { if (self.state.histClosing) self.setState({ histOpen: null, histClosing: false }); }, 260));
        } else self.setState({ histOpen: p.id, histClosing: false });
      },
      histBtnStyle: 'width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer; ' + (st.histOpen === p.id ? 'border: 1px solid #D5D9E0; background: #FFFFFF;' : 'border: 1px solid transparent; background: transparent;'),
      histHuman: hhList.map(function (l) { return { t: fmt(l.t), who: l.who, ev: l.ev }; }),
      histHumanEmpty: !hhList.length, histEmptyText: periodOn ? (self.state.me?.data_mode === 'music' ? '아직 시연 조치 기록이 없습니다.' : '이 검사 기간의 의료진 기록이 없습니다.') : '아직 의료진 기록이 없습니다.',
      hasExRef: !!exRef, logPulseCls: st.logPulse ? (st.logPulse % 2 ? 'lp-a' : 'lp-b') : '',
      logScope: periodOn ? (function () { var dd = new Date(exRef.t); return dd.getFullYear() + '.' + pad(dd.getMonth() + 1) + '.' + pad(dd.getDate()) + (self.state.me?.data_mode === 'music' ? ' 서비스 분석' : ' 검사 기간') + (exRef.cur ? ' (최신)' : ''); })() : (exRef ? '전체' : ''),
      logAllLbl: periodOn ? '전체 기록 보기' : '이 검사 기간만 보기',
      toggleLogAll: function () { self.setState({ logAll: !self.state.logAll }); },
      histSys: st.logs.filter(function (l) { return l.pt === p.name && HUMAN.indexOf(l.who) < 0; }).map(function (l) { return { t: fmt(l.t), who: l.who, ev: l.ev }; }),
      alertBox: 'display: flex; flex-direction: column; flex-shrink: 0; border-radius: 10px; overflow: hidden; background: #FFFFFF; ' + (a && a.status !== 'done' ? 'border: 1px solid #F2D4D0; border-left: 3px solid #B42318;' : 'border: 1px solid #E4E7EC;'),
      alertMeta: !a ? '' : (a.status === 'new' ? '고위험 알림 ' + fmt(a.sent) + ' · 아직 확인하지 않음' + (a.re >= 2 ? ' · 당직의 전달됨' : (a.re === 1 ? ' · 재알림 보냄' : '')) : (a.status === 'ack' ? '확인 ' + fmt(a.ackAt) + ' · 조치 내용을 입력해 주세요' : '처리 ' + fmt(a.doneAt))),
      complete: function () {
        if (!canDone || self.state.ackClosing) return;
        self.setState({ ackClosing: true, ackDone: true, ackFx: self._fxToLog() || self.state.ackFx }); self._timers.push(setTimeout(function () { self.setState({ ackClosing: false });
        var T = Date.now();
        var m0 = (draft.memo || '').trim(), le = [{ t: T, who: '담당의', pt: p.name, ev: '조치 완료 · ' + chosen.join(', ') + basisTxt }];
        if (m0) le.push({ t: T + 1, who: '담당의', pt: p.name, ev: '메모 추가 · ' + m0 });
        self.updAlert(p.id, { status: 'done', doneAt: T, acts: chosen, memo: m0, mlP: mlP }, le); self.setState({ logPulse: (self.state.logPulse || 0) + 1, logAll: false }); }, 300));
      }
    };
    this._ackEsc = d.isAck ? d.cancelAck : null;
    this._edEsc = d.actEditing ? d.cancelAct : (d.memoEditing ? d.cancelMemo : null);
    var chDefs = [['app', '휴대폰 앱 알림'], ['web', '업무 화면 알림'], ['sms', '문자 메시지']];
    var channels = chDefs.map(function (c) { return { label: c[1], checked: !!st.ch[c[0]], toggle: function () {
      var cur = self.state.apiSettings.channels, nx = Object.assign({}, cur); nx[c[0]] = !cur[c[0]]; self.saveSettings({ channels: nx });
    } }; });
    var toastP = st.toast ? this.find(st.toast) : null, tIds = (st.toasts || []).filter(function (id) { return !!self.find(id); });
    var tSub = (function () { var c = st.ch, o = []; if (c.app) o.push('휴대폰 앱'); if (c.sms) o.push('문자'); return 'Holter 분석이 끝났습니다.' + (o.length ? ' ' + o.join('·') + (o[o.length - 1] === '문자' ? '로도' : '으로도') + ' 발송했습니다.' : ''); })();
    return {
      today: today, tabs: tabs, thPct: thPct, thTxt: Math.round(th * 100) + '', thDiff: Math.abs(th - 0.4) > 0.001, th: th, reMin: String(st.reMin), escMin: String(st.escMin),
      listCls: st.tab === 'board' ? 'sb' : '',
      sbOpen: st.sbCol ? 'false' : 'true', sbTip: st.sbCol ? '환자 목록 펼치기' : '환자 목록 접기', sbChevCls: st.sbCol ? 'sb-chev-r' : '',
      toggleSb: function () { self.setState({ sbCol: !self.state.sbCol }); },
      listStyle: st.tab === 'board'
        ? 'flex: 0 0 340px; width: 340px; min-width: 0; position: sticky; top: 73px; height: calc(100vh - 73px); margin: -16px 0 0 -32px; display: flex; flex-direction: column; overflow: hidden; background: #FFFFFF; border-right: 1px solid #E4E7EC; box-sizing: border-box'
        : 'flex: 2 1 480px; min-width: 0; background: #FFFFFF; border: 1px solid #E4E7EC; border-radius: 10px; box-sizing: border-box',
      loggedIn: !!st.user, loggedOut: !st.user, isAdmin: st.user === 'admin', lgErr: !!st.lgErr, authError: st.authError, signupMode: !!st.signupMode, musicMode: self.state.me?.data_mode === "music" || self.state.dataMode === "music", signupEnabled: !!st.signupEnabled,
      toggleSignup: function () { if (!st.lgBusy) self.setState({ signupMode: !st.signupMode, lgErr: false, authError: "" }); },
      darkOn: !!st.dark, darkOff: !st.dark, darkAria: st.dark ? 'true' : 'false', darkTip: st.dark ? '라이트 모드' : '다크 모드',
      toggleDark: function () { var d = !self.state.dark; try { window.localStorage.setItem('scdDark', d ? '1' : '0'); } catch (e) {} self.applyDark(d); self.setState({ dark: d }); },
      lgBusy: !!st.lgBusy, lgBtnText: st.lgBusy ? (st.signupMode ? '계정 생성 중…' : '로그인 중…') : (st.signupMode ? '계정 만들고 시작하기' : '로그인'), lgOutCls: st.lgLeave ? 'lg-out' : '', appInCls: st.appIn ? 'app-in' : '',
      lgKey: function (e) { if (e && e.key === 'Enter') self.doLogin(); },
      doLogin: function () { self.doLogin(); },
      doLogout: function () { self.doLogout(); },
      acctOpen: !!st.acctOpen, acctAria: st.acctOpen ? 'true' : 'false',
      toggleAcct: function () { if (self.state.acctClosing) return; if (self.state.acctOpen) { self.closeAnim('acctClosing', { acctOpen: false }); } else { self.setState({ acctOpen: true, inboxOpen: false, sbfOpen: false }); } },
      acctAnim: st.acctClosing ? 'inbox-close' : 'inbox-open',
      acctName: (st.me || {}).username || '', acctRole: (st.me || {}).role === 'attending' ? '담당의 · ' + ((st.me || {}).dept || '') : ((st.me || {}).role_label || ''),
      acctIcon: st.user === 'admin' ? '#FFFFFF' : '#16191F',
      acctBtnStyle: 'width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid ' + (st.acctOpen ? '#16191F' : (st.user === 'admin' ? '#16191F' : '#EEF0F3')) + '; background: ' + (st.user === 'admin' ? '#16191F' : '#EEF0F3') + ';',
      isAdminOpen: !!st.adminOpen && st.user === 'admin', adminOv: st.adminClosing ? 'ov-out' : 'ov-in', adminDlg: st.adminClosing ? 'dlg-out' : 'dlg-in',
      openAdminModel: function () { self.setState({ adminOpen: true, adminClosing: false, adminTab: 'model', acctOpen: false }); },
      openAdminLog: function () { self.setState({ adminOpen: true, adminClosing: false, adminTab: 'log', acctOpen: false }); },
      closeAdmin: function () { self._cl.admin(); },
      ovClickAdmin: function (e) { if (self._ovDown && e.target === e.currentTarget) self._cl.admin(); self._ovDown = false; },
      admIsModel: (st.adminTab || 'model') === 'model', admIsLog: st.adminTab === 'log',
      admTabs: [['model', '모델 설정'], ['log', '시스템 처리기록']].map(function (t) {
        var on = (st.adminTab || 'model') === t[0];
        return { label: t[1], aria: on ? 'true' : 'false', pick: function () { self.setState({ adminTab: t[0] }); },
          style: 'min-height: 42px; padding: 8px 2px; margin-bottom: -1px; border: none; border-bottom: 2px solid ' + (on ? '#16191F' : 'transparent') + '; background: transparent; font-size: 18px; cursor: pointer; color: ' + (on ? '#16191F; font-weight: 600;' : '#646B78;') };
      }),
      admQ: st.admQ || '', setAdmQ: function (e) { self.setState({ admQ: e.target.value }); },
      sysLogs: sysLogs, sysCount: sysAll.length, sysEmpty: sysLogs.length === 0,
      withDetail: st.view === 'main', isBoard: st.tab === 'board', isLog: st.tab === 'log', isModel: !!st.modelOpen, isSet: !!st.setOpen,
      inboxOpen: !!st.inboxOpen, newCount: newCount, hasNew: newCount > 0,
      badgeCls: newCount % 2 ? 'badge-a' : 'badge-b',
      mailCls: st.toast ? (newCount % 2 ? 'ring-a' : 'ring-b') : '',
      inboxAnim: st.inboxClosing ? 'inbox-close' : 'inbox-open',
      toggleInbox: function () {
        if (!self.state.inboxOpen) { self.setState({ inboxOpen: true, inboxClosing: false }); return; }
        if (self.state.inboxClosing) return;
        self.setState({ inboxClosing: true });
        self._timers.push(setTimeout(function () { self.setState({ inboxOpen: false, inboxClosing: false }); }, 230));
      },
      openModel: function () { self.setState({ modelOpen: true, modelClosing: false, inboxOpen: false }); },
      am: (function () { var ms = st.models || []; return ms.filter(function (x) { return x.id === st.activeModel; })[0] || ms[0] || { ver: '', file: '' }; })(),
      valVer: 'v0.1', valStale: (st.models || []).some(function (x) { return x.id === st.activeModel && x.ver !== 'v0.1'; }),
      models: (st.models || []).slice().reverse().map(function (x) {
        var active = x.id === st.activeModel;
        return { ver: x.ver, file: x.file, active: active, canApply: !active,
          meta: fmt(x.at) + ' 등록' + (x.note ? ' · ' + x.note : '') + (active ? '' : (x.applied ? ' · 이전 버전' : ' · 적용 전')),
          apply: function () {
            var T = Date.now(), cur = (self.state.models || []).filter(function (y) { return y.id === self.state.activeModel; })[0];
            var ms = (self.state.models || []).map(function (y) { return y.id === x.id ? Object.assign({}, y, { applied: true }) : y; });
            self.setState({ models: ms, activeModel: x.id, logs: self.log({ t: T, who: '관리자', pt: '—', ev: '모델 적용 · ' + (cur ? cur.ver : '') + ' → ' + x.ver }) });
          } };
      }),
      noPend: !st.pend, hasPend: !!st.pend,
      pend: st.pend ? Object.assign({}, st.pend, { sizeText: st.pend.size > 1048576 ? (st.pend.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(st.pend.size / 1024)) + ' KB' }) : { file: '', sizeText: '', ver: '', note: '' },
      onModelFile: function (e) {
        var f = e.target.files && e.target.files[0]; if (!f) return;
        var n = (self.state.models || []).length;
        self.setState({ pend: { file: f.name, size: f.size, ver: 'v0.' + (n + 1), note: '' } });
        try { e.target.value = ''; } catch (err) {}
      },
      setPendVer: function (e) { self.setState({ pend: Object.assign({}, self.state.pend, { ver: e.target.value }) }); },
      setPendNote: function (e) { self.setState({ pend: Object.assign({}, self.state.pend, { note: e.target.value }) }); },
      cancelPend: function () { self.setState({ pend: null }); },
      pendInvalid: !st.pend || !String(st.pend.ver || '').trim(),
      registerStyle: 'min-height: 36px; padding: 4px 16px; border-radius: 6px; font-size: 17px; font-weight: 600; ' + (st.pend && String(st.pend.ver || '').trim() ? 'border: 1px solid #16191F; background: #16191F; color: #FFFFFF; cursor: pointer;' : 'border: 1px solid #E4E7EC; background: #F7F8FA; color: #8A919E;'),
      registerModel: function () {
        var pd = self.state.pend; if (!pd || !String(pd.ver).trim()) return;
        var T = Date.now(), ms = (self.state.models || []).concat([{ id: 'm' + T, ver: String(pd.ver).trim(), file: pd.file, at: T, note: String(pd.note || '').trim() }]);
        self.setState({ models: ms, pend: null, logs: self.log({ t: T, who: '관리자', pt: '—', ev: '모델 등록 · ' + String(pd.ver).trim() + ' (' + pd.file + ')' }) });
      },
      closeModel: function () { self.closeAnim('modelClosing', { modelOpen: false }); },
      openSet: function () { self.setState({ setOpen: true, setClosing: false, inboxOpen: false }); },
      closeSet: function () { self.closeAnim('setClosing', { setOpen: false }); },
      modelOv: st.modelClosing ? 'ov-out' : 'ov-in', modelDlg: st.modelClosing ? 'dlg-out' : 'dlg-in',
      setOv: st.setClosing ? 'ov-out' : 'ov-in', setDlg: st.setClosing ? 'dlg-out' : 'dlg-in',
      addOv: st.addClosing ? 'ov-out' : 'ov-in', addDlg: st.addClosing ? 'dlg-out' : 'dlg-in',
      goMain: function () { self.setState({ view: 'main' }); },
      modelBtnStyle: 'min-height: 40px; padding: 4px 12px; border-radius: 6px; font-size: 17px; cursor: pointer; ' + (st.view === 'model' ? 'border: 1px solid #16191F; background: #16191F; color: #FFFFFF;' : 'border: 1px solid transparent; background: transparent; color: #16191F;'),
      inboxBtnStyle: 'position: relative; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; ' + (st.inboxOpen ? 'border: 1px solid #E4E7EC; background: #F3F4F6;' : 'border: 1px solid transparent; background: transparent;'),
      setBtnStyle: 'width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; ' + (st.setOpen ? 'border: 1px solid #E4E7EC; background: #F3F4F6;' : 'border: 1px solid transparent; background: transparent;'),
      inbox: inbox, inboxEmpty: inbox.length === 0,
      fbTotal: Object.keys(st.alerts).filter(function (k) { return st.alerts[k].status === 'done'; }).length + (st.archive || []).length,
      fbSkip: Object.keys(st.alerts).filter(function (k) { return st.alerts[k].skip; }).length + (st.archive || []).filter(function (x) { return x.skip; }).length,
      archive: (st.archive || []).map(function (x) { var pp = self.find(x.pid); return { name: pp.name, pct: x.pct + '', time: fmt(x.t), acts: x.acts,
        pick: function () { self.setState({ sel: x.pid, inboxOpen: false, view: 'main', toast: null, toasts: self._tLeft(x.pid), tEv: 'up', tUp: self._tBelow(x.pid), tUpSeq: (self.state.tUpSeq || 0) + 1 }); self.countUp(x.pid); } }; }), filters: filters, board: board, boardEmpty: board.length === 0, nPatients: P.length,
      sortLbl: (filters.filter(function (f) { return f.on; })[0] || {}).label || '', sortDef: sortKey === 'prio', sortCapCls: st.sortTick ? (st.sortTick % 2 ? 'cap-a' : 'cap-b') : '',
      sbQ: sbQ, setSbQ: function (e) { self.setState({ sbQ: e.target.value }); },
      sbfOpen: !!st.sbfOpen, toggleSbf: function () { self.setState({ sbfOpen: !self.state.sbfOpen }); },
      sbfAria: st.sbfOpen ? 'true' : 'false',
      sbDirty: sortKey !== 'prio' || !!sq, sbClean: !(sortKey !== 'prio' || !!sq),
      resetSb: function () { self.setState({ sortKey: 'prio', sbQ: '', sbsOpen: false, sbfOpen: false, sortTick: (self.state.sortTick || 0) + 1 }); },
      resetItemStyle: 'display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 4px 12px; border: none; border-radius: 10px; background: transparent; font-size: 17px; text-align: left; ' + (sortKey !== 'prio' || sq ? 'color: #B42318; cursor: pointer;' : 'color: #8A919E; cursor: default;'),
      doSync: function () { self.sync(); }, syncCls: st.syncing ? 'sync-spin' : '', syncAria: st.syncing ? 'true' : 'false',
      syncTip: st.syncing ? '동기화 중…' : '환자 목록 동기화 · 마지막 ' + (function (d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); })(new Date(st.lastSync || st.now || Date.now())),
      hasSyncMsg: !!st.syncMsg, syncMsg: st.syncMsg || '', syncMsgCls: st.syncMsgOut ? 'snack-out' : 'snack-in',
      sbfBtnStyle: 'width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 12px; cursor: pointer; ' + (st.sbfOpen ? 'border: 1px solid #16191F; background: #FFFFFF;' : 'border: 1px solid #E4E7EC; background: #FFFFFF;'),
      sbsHidden: (st.sbsOpen || sbQ) ? 'false' : 'true',
      sbsWrapStyle: 'display: grid; transition: grid-template-rows .26s ease, opacity .2s ease, margin .26s ease' + ((st.sbsOpen || sbQ) ? '; grid-template-rows: 1fr; opacity: 1; margin: -3px -3px -3px; visibility: visible' : ', visibility 0s linear .26s; grid-template-rows: 0fr; opacity: 0; margin: -14px -3px 0; visibility: hidden'),
      sbsOpen: !!st.sbsOpen, sbsAria: st.sbsOpen ? 'true' : 'false',
      qBusy: !!st.analyzing || (st.jobs || []).length > 0,
      qText: (st.analyzing ? (this.find(st.analyzing) || { name: '' }).name + ' 분석 중' : '분석 준비 중') + ((st.jobs || []).length ? ' · 대기 ' + st.jobs.length + '건' : ''),
      toggleSbs: function () { if (self.state.sbsClosing) return; self.setState({ sbsOpen: true, sbfOpen: false }); setTimeout(function () { var el = document.getElementById('sbq'); if (el) el.focus(); }, 60); },
      closeSbs: function () { self._cl.sbs(); },
      ovClickSbs: function (e) { if (self._ovDown && e.target === e.currentTarget) self._cl.sbs(); self._ovDown = false; },
      sbsOv: st.sbsClosing ? 'ov-out' : 'ov-in', sbsDlg: st.sbsClosing ? 'dlg-out' : 'dlg-in',
      searchRows: board.map(function (r) { return { name: r.name, mrn: r.mrn, meta: r.meta, pick: function () { r.pick(); self._cl.sbs(); } }; }),
      searchCountText: sq ? '검색 결과 ' + board.length + '명' : '전체 환자 ' + board.length + '명',
      sbsBtnStyle: 'width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 12px; cursor: pointer; ' + ((st.sbsOpen || sbQ) ? 'border: 1px solid #16191F; background: #FFFFFF;' : 'border: 1px solid #E4E7EC; background: #FFFFFF;'), logs: logs,
      kindTabs: [['human', '의료진 조치 기록'], ['system', '시스템 기록']].map(function (k) {
        var on = logKind === k[0], cnt = st.logs.filter(function (l) { return (HUMAN.indexOf(l.who) >= 0) === (k[0] === 'human'); }).length;
        return { label: k[1], on: on, count: cnt, pick: function () { self.setState({ logKind: k[0], logWho: 'all' }); },
          style: 'min-height: 42px; padding: 8px 2px; margin-bottom: -1px; border: none; border-bottom: 2px solid ' + (on ? '#16191F' : 'transparent') + '; background: transparent; font-size: 17px; cursor: pointer; color: ' + (on ? '#16191F; font-weight: 600;' : '#646B78;') };
      }),
      logCount: logs.length, logEmpty: logs.length === 0, logPt: logPt, logWho: logWho, ptOpts: ptOpts, whoOpts: whoOpts,
      logFiltered: logPt !== 'all' || logWho !== 'all',
      activeCount: (logPt !== 'all' ? 1 : 0) + (logWho !== 'all' ? 1 : 0),
      logQ: logQ, setLogQ: function (e) { self.setState({ logQ: e.target.value }); },
      logFilterOpen: !!st.logFilterOpen, toggleLogFilter: function () { self.setState({ logFilterOpen: !self.state.logFilterOpen }); },
      filterBtnStyle: 'display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 2px 12px; border-radius: 6px; font-size: 17px; cursor: pointer; white-space: nowrap; ' + (st.logFilterOpen || logPt !== 'all' || logWho !== 'all' ? 'border: 1px solid #16191F; background: #16191F; color: #FFFFFF;' : 'border: 1px solid #E4E7EC; background: #FFFFFF; color: #16191F;'),
      setLogPt: function (e) { self.setState({ logPt: e.target.value }); },
      setLogWho: function (e) { self.setState({ logWho: e.target.value }); },
      clearLog: function () { self.setState({ logPt: 'all', logWho: 'all' }); },
      vrows: vrows, nVal: V.length, tp: tp, fp: fp, fn: fn, tn: tn, nPos: tp + fn, nNeg: tn + fp, nAlert: tp + fp,
      sens: pc(tp, tp + fn), ppv: pc(tp, tp + fp), spec: pc(tn, tn + fp), alertRate: pc(tp + fp, V.length), per100: Math.round((tp + fp) / V.length * 100),
      setTh: function (e) { var v = Math.round(Number(e.target.value) * 100) / 100; if (Math.round(v * 100) === Math.round(Number(self.state.apiSettings.threshold) * 100)) return; self.saveSettings({ threshold: v }); },
      setRe: function (e) { self.saveSettings({ re_min: Number(e.target.value) }); },
      setEsc: function (e) { self.saveSettings({ esc_min: Number(e.target.value) }); },
      channels: channels,
      d: d, up: up, pg: pg,
      addOpen: !!st.addOpen, addQ: st.addQ || '', addErr: st.addErr || '', hasAddErr: !!st.addErr,
      hasAddResult: !!st.addResult, ar: st.addResult ? Object.assign({}, st.addResult, { lvef: 'LVEF ' + st.addResult.lvef }) : { name: '', mrn: '', ageSex: '', dx: '', lvef: '', last: '', next: '' },
      openAdd: function () { self.setState({ addOpen: true, addClosing: false, addQ: '', addErr: '', addResult: null }); },
      closeAdd: function () { self.closeAnim('addClosing', { addOpen: false }); },
      setAddQ: function (e) { self.setState({ addQ: e.target.value, addErr: '', addResult: null }); },
      addKey: function (e) { if (e.key === 'Enter') self.lookup(); },
      lookup: function () { self.lookup(); },
      lookupDisabled: !(st.addQ || '').trim() || !!st.addLoading,
      lookupText: st.addLoading ? '조회 중…' : '조회',
      lookupStyle: 'min-height: 44px; padding: 4px 18px; border-radius: 8px; font-size: 18px; font-weight: 600; white-space: nowrap; ' + ((st.addQ || '').trim() && !st.addLoading ? 'border: 1px solid #16191F; background: #16191F; color: #FFFFFF; cursor: pointer;' : 'border: 1px solid #E4E7EC; background: #F7F8FA; color: #8A919E;'),
      confirmAdd: function () {
        var r = self.state.addResult; if (!r) return;
        var np = { id: 'n' + r.mrn.replace(/-/g, ''), name: r.name, mrn: r.mrn, meta: r.ageSex + ' · NYHA ' + r.nyha, next: r.next, prob: 0, f: [] };
        var T = Date.now();
        self.setState({ added: (self.state.added || []).concat([np]), addOpen: false, addResult: null, addQ: '', sel: np.id, tab: 'board', filter: 'all',
          logs: self.log({ t: T, who: '담당의', pt: r.name, ev: '담당 환자 추가 · 병원 전산에서 정보 불러옴' }) });
      },
      hasToast: tIds.length > 0, toastMore: tIds.length > 3, toastMoreText: '고위험 알림 ' + (tIds.length - 3) + '건 더 · 알림함에서 확인',
      toastList: tIds.slice(0, 3).map(function (id, k) { var tp = self.find(id), gone = !!(st.tOut || {})[id];
        return { name: tp.name, pct: Math.round(tp.prob * 100) + '', sub: tSub,
          cls: gone ? 'toast-out' : (st.tEv === 'up' ? ((st.tUp || []).indexOf(id) >= 0 ? ((st.tUpSeq || 0) % 2 ? 'toast-up-a' : 'toast-up-b') : '') : (k === 0 ? ((st.tSeq || 0) % 2 ? 'toast-in' : 'toast-in-b') : 'toast-q')),
          open: function () { self.setState({ sel: id, view: 'main' }); self.countUp(id); self._tClose(id); },
          close: function () { self._tClose(id); } }; }),
      toast: toastP ? { name: toastP.name, pct: Math.round(toastP.prob * 100) + '' } : { name: '', pct: '' },
      openToast: function () { var id = self.state.toast; self.setState({ sel: id, toast: null, view: 'main' }); self.countUp(id); },
      toastSub: (function () { var c = st.ch, o = []; if (c.app) o.push('휴대폰 앱'); if (c.sms) o.push('문자'); return 'Holter 분석이 끝났습니다.' + (o.length ? ' ' + o.join('·') + (o[o.length - 1] === '문자' ? '로도' : '으로도') + ' 발송했습니다.' : ''); })(),
      toastCls: st.toastOut ? 'toast-out' : 'toast-in',
      dm: (function () {
        return { open: !!st.demoPanel, auto: st.demoAuto === true, queueText: '서버가 남은 시연 기록을 순서대로 넣습니다',
          noNext: false, noHigh: false, noAll: false, noCur: false, all: function () { self.demoAll(); }, next: function () { self.demoNext(false); }, high: function () { self.demoNext(true); },
          followup: function () { self.demoCall('/admin/demo/followup', '추이 시연용 후속 기록을 수신했습니다.'); }, cur: function () { self.demoCur(); }, skip: function () { self.demoSkip(30); }, reset: function () { self.demoReset(); },
          toggleAuto: function (e) { self.demoAuto(e.target.checked); }, close: function () { self.setState({ demoPanel: false }); },
          btn: 'min-height: 32px; padding: 2px 12px; border: 1px solid #D5D9E0; background: #FFFFFF; color: #16191F; font-size: 17px; cursor: pointer; text-align: left;',
          kbd: 'font: 500 12px/1 ui-monospace, monospace; color: #646B78; border: 1px solid #E4E7EC; border-radius: 4px; padding: 3px 5px; background: #F7F8FA;' };
      })(),
      closeToast: function () { if (self.state.toastOut) return; self.setState({ toastOut: true }); self._timers.push(setTimeout(function () { self.setState({ toast: null, toastOut: false }); }, 400)); },
      ovDown: function (e) { self._ovDown = e.target === e.currentTarget; },
      ovClickModel: function (e) { if (self._ovDown && e.target === e.currentTarget) self._cl.model(); self._ovDown = false; },
      ovClickSet: function (e) { if (self._ovDown && e.target === e.currentTarget) self._cl.set(); self._ovDown = false; },
      ovClickAdd: function (e) { if (self._ovDown && e.target === e.currentTarget) self._cl.add(); self._ovDown = false; }
    };
  }

}
