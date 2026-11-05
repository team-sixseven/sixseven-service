# SCD 위험 알림

SCD 위험 알림 구현 설명서 v1.3과 HTML 데모 v2.39를 기준으로 구현한 의료진용 시연 서비스입니다. React·TypeScript 화면과 FastAPI·SQLite API를 사용합니다.

## 실행

```sh
python3 scripts/init_env.py
docker compose up --build -d --wait
python3 scripts/smoke.py
```

`http://localhost:8080`에서 접속합니다. `.env`는 최초 한 번 생성하며 덮어쓰지 않습니다. 관리자 `admin`, 담당의 `test`, 당직의 `oncall`의 비밀번호는 각각 `.env`의 `ADMIN_PASSWORD`, `ATTENDING_PASSWORD`, `ONCALL_PASSWORD`에서 로컬로 확인합니다. 파일 전체를 공유하지 마세요.

시연 계정을 직접 생성하려면 `.env`에 `ALLOW_SIGNUP=true`를 설정합니다. 로그인 화면의 **계정 만들기**에서 아이디·비밀번호만 입력하면 바로 시작합니다. 새 계정은 담당의 역할이며 공용 시연 대상자의 조회·조치·메모를 체험할 수 있습니다. 관리자 시연 도구·초기화 권한은 주지 않습니다. 모두 같은 시연 데이터를 보므로 다른 사용자의 조치도 반영됩니다. 회원가입은 `DEMO_MODE=true`에서만 열리며, 아이디 3~32자·비밀번호 8~128자를 사용합니다.

기본 로컬 실행은 합성 데이터 모드입니다. 공개 배포는 아래 MUSIC 모드를 사용합니다. **원시 Holter 파형을 분석하거나 실시간 부정맥을 검출하지 않습니다.** 모델은 12개 임상·Holter 판독 수치를 사용하는 로지스틱 회귀이며, GPU가 필요 없습니다.

관리자 계정에서 `Shift+D`로 시연 도구를 열고 기록 수신 또는 자동 재생을 시작합니다. 로그인·로그아웃은 다른 사용자의 시연을 초기화하지 않습니다. 공유 데이터 초기화는 관리자 도구에서 확인 후 실행합니다. API 문서는 `/api/docs`입니다.

프론트·백엔드·AI API는 별도 컨테이너입니다. AI API는 내부망에서만 접근하며 서버 간 인증을 사용합니다. SQLite 데이터는 볼륨에 유지됩니다. 중지는 `docker compose down`이며 `-v`를 붙이지 마세요.

## MUSIC 연구 데이터

팀이 제공한 89명 JSON을 Docker 데이터 볼륨의 `/app/data/music89.json`에 놓고 `MUSIC_DATA_PATH=/app/data/music89.json`으로 실행합니다. 파일은 Git이나 이미지에 포함하지 않습니다. 배포에서는 보호된 `MUSIC_DATA_GZIP_BASE64` 값으로 공급하고 기존 볼륨에 보관합니다.

최초 실행은 모든 AI 계산을 검증하고 SQLite 백업을 만든 뒤 가상 기록을 교체합니다. 계정은 유지하며, 이후 같은 파일로 재시작하면 조치·메모를 보존합니다. 파일 내용이 달라지면 자동 교체하지 않고 오류로 중단합니다. 이전 데이터 복구는 서버를 중지한 상태에서 `data/backups/before-music-*.sqlite3` 백업을 복원하고 MUSIC 모드를 해제한 뒤 진행합니다.

기존 화면과 버튼을 유지하고 대상자 데이터만 교체합니다. 각 대상자는 익명 ID와 한 번의 서비스 분석만 가지며, 과거 검사·외래 일정은 임의 생성하지 않습니다. 실제 SCD 정답은 화면에 표시하지 않으며 모델 입력에 포함하지 않습니다. 조치·메모는 체험자가 작성한 시연 기록이고 고위험 대상자에서 사용합니다. MUSIC 모드에서는 EMR 동기화와 합성 값 보완을 사용하지 않습니다. 관리자 `Shift+D` → 초기화(확인 필요)로 검사 수신 대기 상태를 만든 뒤, 기록 수신·자동 재생을 시작합니다. 자동 재생은 저위험 예시, 고위험 예시 순으로 8초 뒤부터 15초 간격으로 실제 MUSIC 요약값을 보냅니다. 기존 분석 대기열이 AI 서버를 호출하고 50점 이상이면 알림을 생성합니다. 단계 표시는 기존 표시 시간을 포함하며 모델 계산 시간 자체를 의미하지 않습니다. 중복 수신은 무시합니다. 초기화 전 백업하며 계정·환자·입력값은 유지합니다. 재배포·로그인은 시연을 초기화하지 않습니다.

출처: Martin-Yebra, A., Martínez, J. P., & Laguna, P. (2025). [MUSIC v1.0.1](https://doi.org/10.13026/z3m7-rf58), PhysioNet. [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). 원자료에서 팀이 89명을 발췌하고 열 가공·예측값을 추가했습니다. 가공 데이터는 `/api/research-data/download`에서 받을 수 있습니다. 원저자나 PhysioNet의 공식 서비스·승인을 의미하지 않으며 데이터와 서비스에는 보증이 없습니다.

## 개발과 검증

프론트엔드는 `frontend`에서 `npm ci`, `npm run dev`로 실행합니다. API 및 WebSocket 요청은 로컬 8000번 포트로 전달합니다. 빌드 검사는 `npm run build`입니다. Node 버전은 `frontend/package.json`의 engines를 따릅니다.

백엔드는 Python 3.12 이상에서 실행합니다.

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.in pytest
# 실제 분석은 Compose의 AI 서버와 연결 설정이 필요합니다.
DEMO_MODE=true .venv/bin/uvicorn app.main:app --reload
.venv/bin/python -m pytest tests -q
```

테스트는 임시 DB에서 보류·재확인, 조치·메모 이력, 과거 검사 읽기 전용, 담당의·당직의 권한, 재알림, 설정 스냅샷 및 실시간 이벤트를 검증합니다.

## 모델과 서비스 연결

`inference/model.json`은 전달받은 모델의 계수·변환·표준화 통계입니다. AI API는 이를 순수 Python으로 실행하며 입력 오류를 거절합니다. 실제 분석에서 AI 서버가 실패하면 실패로 기록하고 로컬 계산기로 대체하지 않습니다. 합성 데이터 초기 기록에만 로컬 계산을 사용합니다. MUSIC의 89명은 초기 가져오기에서도 AI 서버를 호출합니다.

점수는 보정되지 않은 0~1 값이며 실제 SCD 발생 확률이 아닙니다. 합성 데이터의 알림 기준은 0.40이며, MUSIC 데이터 가져오기는 0.50으로 설정합니다. 변수 기여도는 변환된 학습 평균을 기준으로 한 log-odds 기여도입니다. 화면의 테스트 성능은 전달받은 학습팀 자료이며 이번 배포 검증으로 새로 산출한 지표가 아닙니다.

원본 모델과 수치 비교는 별도 검증 환경에서 `python scripts/verify_model.py <모델ZIP경로>`로 실행합니다. 이 명령은 신뢰하는 팀 모델 파일만 사용해야 하며 joblib·numpy·pandas·scikit-learn(원본 버전)이 필요합니다. 모델 ZIP과 환자 데이터는 Git에 올리지 않습니다.

실제 병원 EMR·판독실·문자 발송 연동은 포함되지 않습니다. 공개 배포는 MUSIC 연구 데이터 89명을 사용합니다. 실제 진료 시스템은 아닙니다.

## 배포

[GCP 설치·자동 배포 설정](deploy/README.md)을 참고하세요. 서비스·AI·배포 설정이 main에 반영되면 자동 배포됩니다. 문서만 바꾸면 배포하지 않습니다. GitHub Actions에서 수동 재배포도 가능합니다.
