"""Versioned MUSIC research-data import. Dataset files are supplied outside Git."""
import hashlib
import json
import math
import os
import re
import sqlite3
from pathlib import Path

from . import inference_client, model, pipeline, service
from .database import connect, get_settings, iso


def enabled():
    return bool(os.environ.get('MUSIC_DATA_PATH'))


def load_rows(path):
    rows = json.loads(Path(path).read_text())
    if not isinstance(rows, list) or len(rows) != 89:
        raise ValueError('MUSIC dataset must contain 89 rows')
    ids = set()
    for r in rows:
        pid = r.get('demo_id')
        if not isinstance(pid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', pid) or pid in ids:
            raise ValueError('Invalid or duplicate demo_id')
        ids.add(pid)
        for v in model.VARIABLES:
            x = r.get(v['column'])
            if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
                raise ValueError('Missing or non-finite model input')
        if r.get('SCD_actual') not in (0, 1) or r.get('expected_high_risk') not in (0, 1):
            raise ValueError('Invalid outcome or expected classification')
        score = r.get('expected_score')
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError('Invalid expected score')
        # Also validate categorical/range constraints before changing the database.
        inputs = {v['key']: r[v['column']] for v in model.VARIABLES}
        if any(inputs[k] not in (0, 1) for k in ('sex_male', 'ischemic', 'prior_mi', 'nsvt')) or inputs['nyha'] not in (2, 3):
            raise ValueError('Invalid categorical input')
        if any(x < 0 for x in inputs.values()) or inputs['lvef'] > 100:
            raise ValueError('Invalid input range')
    if sum(r['SCD_actual'] for r in rows) != 10 or sum(r['expected_high_risk'] for r in rows) != 28:
        raise ValueError('Unexpected MUSIC cohort totals')
    return rows


def initialize():
    path = Path(os.environ['MUSIC_DATA_PATH'])
    rows = load_rows(path)
    version = hashlib.sha256(path.read_bytes()).hexdigest()
    with connect() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS music_imports(version TEXT PRIMARY KEY, imported_at TEXT NOT NULL)')
        conn.execute('CREATE TABLE IF NOT EXISTS music_outcomes(patient_id TEXT PRIMARY KEY REFERENCES patients(id), scd INTEGER NOT NULL)')
        previous = conn.execute('SELECT version FROM music_imports').fetchone()
        if previous:
            if previous['version'] != version:
                raise RuntimeError('MUSIC dataset changed: an explicit reviewed migration is required')
            return
    # Never substitute local predictions or the supplied expected scores.
    predictions = []
    for row in rows:
        inputs = {v['key']: row[v['column']] for v in model.VARIABLES}
        result = inference_client._predict(inputs)
        if abs(result['score'] - row['expected_score']) > 0.00005 or (result['score'] >= .5) != bool(row['expected_high_risk']):
            raise ValueError('MUSIC expected prediction mismatch')
        predictions.append((row, inputs, result))
    with connect() as conn:
        backup = path.parent / 'backups'
        backup.mkdir(exist_ok=True)
        dest = backup / ('before-music-' + iso().replace(':', '-') + '.sqlite3')
        with sqlite3.connect(dest) as target:
            conn.backup(target)
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute('DROP TRIGGER IF EXISTS audit_logs_no_delete')
            for table in ('music_outcomes', 'audit_logs', 'alerts', 'factors', 'analyses', 'report_inputs', 'holter_reports', 'clinical_values', 'patients'):
                conn.execute(f'DELETE FROM {table}')
            conn.execute("CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END")
            conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('threshold','0.5')")
            settings = get_settings(conn)
            stamp = iso()
            for seq, (row, inputs, result) in enumerate(predictions):
                pid = row['demo_id']
                conn.execute('INSERT INTO patients(id,mrn,name,age,sex,nyha,dx,attending_id,seq) VALUES (?,?,?,?,?,?,?,?,?)',
                             (pid,pid,pid,row['Age'],'M' if inputs['sex_male'] else 'F', {2:'II',3:'III'}[inputs['nyha']],None,'u-test',seq))
                for key in model.CLINICAL_KEYS:
                    conn.execute('INSERT INTO clinical_values VALUES (?,?,?,?,?)',(pid,key,inputs[key],stamp,'MUSIC CSV'))
                rid = 'music-' + pid
                # Duration is not supplied; zero is an internal sentinel, never displayed as a measured duration.
                conn.execute('INSERT INTO holter_reports(id,patient_id,file_name,received_at,source,duration_h,vpb_24h,couplets_24h,nsvt,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
                             (rid,pid,'MUSIC CSV',stamp,'MUSIC CSV',0,inputs['vpb_24h'],inputs['couplets_24h'],inputs['nsvt'],'done'))
                saved = pipeline.save_analysis(conn, {'id':rid}, {'id':pid}, inputs,result,when=stamp,settings=settings)
                conn.execute('INSERT INTO music_outcomes VALUES (?,?)',(pid,row['SCD_actual']))
                if result['score'] >= .5:
                    service.create_alert(conn,saved['id'],pid,result['score'],settings,sent_at=stamp)
            service.add_log(conn, '시스템', 'system', 'music.imported', 'MUSIC 연구 데이터 89명 가져오기 완료')
            conn.execute('INSERT INTO music_imports VALUES (?,?)',(version,stamp))
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def outcome(conn, patient_id):
    row = conn.execute('SELECT scd FROM music_outcomes WHERE patient_id=?',(patient_id,)).fetchone()
    return None if row is None else {'scd_actual': row['scd'], 'source': 'MUSIC follow-up outcome'}


def delivery_order():
    """Replay reception order; expected class only selects examples, never supplies predictions."""
    rows = load_rows(os.environ['MUSIC_DATA_PATH'])
    low = sorted((r for r in rows if not r['expected_high_risk']), key=lambda r:r['expected_score'])
    high = sorted((r for r in rows if r['expected_high_risk']), key=lambda r:-r['expected_score'])
    first = [low[0], high[0]]
    return first + [r for r in rows if r not in first]


def pending(conn):
    return [r['demo_id'] for r in delivery_order() if not conn.execute(
        'SELECT 1 FROM holter_reports WHERE patient_id=?', (r['demo_id'],)).fetchone()]


def arrive(conn, patient_id):
    # Serialize the eligibility check and insert to prevent manual/autoplay races.
    conn.execute('BEGIN IMMEDIATE')
    try:
        if conn.execute('SELECT 1 FROM holter_reports WHERE patient_id=?',(patient_id,)).fetchone():
            conn.rollback()
            return None
        row = next((r for r in delivery_order() if r['demo_id']==patient_id), None)
        patient = conn.execute('SELECT * FROM patients WHERE id=? AND active=1',(patient_id,)).fetchone()
        if row is None or patient is None:
            conn.rollback()
            return None
        result = pipeline.ingest_report(conn, patient, 'MUSIC CSV', 0,
            row['Holter ventricular premature beats in 24h'], row['Holter ventricular couplets'],
            row['Holter NSVT (yes=1)'], file_uri='music:'+patient_id)
        conn.commit()
        pipeline.wake()
        return result
    except Exception:
        conn.rollback()
        raise


def reset_reception(conn):
    """Admin-confirmed replay reset: keep accounts, clinical values and cohort identity."""
    folder = Path(os.environ['MUSIC_DATA_PATH']).parent/'backups'
    folder.mkdir(exist_ok=True)
    with sqlite3.connect(folder/('before-replay-'+iso().replace(':','-')+'.sqlite3')) as target:
        conn.backup(target)
    conn.execute('BEGIN IMMEDIATE')
    try:
        conn.execute('DROP TRIGGER IF EXISTS audit_logs_no_delete')
        for table in ('audit_logs','alerts','factors','analyses','report_inputs','holter_reports'):
            conn.execute(f'DELETE FROM {table}')
        conn.execute("CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END")
        service.add_log(conn,'관리자','system','music.replay.reset','MUSIC 기록 수신 시연 초기화')
        conn.commit()
    except Exception:
        conn.rollback()
        raise


SYNTHETIC_FOLLOWUP_URI = 'synthetic-followup:T34:v1'


def add_synthetic_followup(conn):
    """One illustrative input snapshot; not a MUSIC observation or treatment outcome."""
    conn.execute('BEGIN IMMEDIATE')
    try:
        if conn.execute('SELECT 1 FROM holter_reports WHERE file_uri=?',(SYNTHETIC_FOLLOWUP_URI,)).fetchone():
            raise service.AlertError(409,'추이 시연용 후속 기록은 이미 수신했습니다.')
        baseline = conn.execute("SELECT a.* FROM analyses a JOIN holter_reports r ON r.id=a.report_id WHERE a.patient_id='T34' AND r.file_uri IS NOT ? ORDER BY a.rowid DESC LIMIT 1",(SYNTHETIC_FOLLOWUP_URI,)).fetchone()
        if baseline is None:
            raise service.AlertError(409,'T34의 첫 분석이 완료된 뒤 실행해 주세요.')
        patient = conn.execute("SELECT * FROM patients WHERE id='T34'").fetchone()
        inputs = json.loads(baseline['inputs'])
        inputs.update(nyha=2,lvef=60,la_size=32,egfr=75,probnp=50,vpb_24h=0,couplets_24h=0,nsvt=0)
        result = pipeline.ingest_report(conn,patient,'후속 검사',0,0,0,0,
            file_uri=SYNTHETIC_FOLLOWUP_URI,source='가상 후속 검사',input_snapshot=inputs)
        service.add_log(conn,'관리자','system','synthetic.followup.received',
                        '추이 시연용 가상 입력 수신 · 실제 MUSIC 후속 관찰이나 치료 효과가 아님','T34')
        conn.commit()
        pipeline.wake()
        return result
    except Exception:
        conn.rollback()
        raise
