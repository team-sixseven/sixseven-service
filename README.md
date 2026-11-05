# SCD 위험 알림

SCD 위험 알림 구현 설명서 v1.3과 HTML 데모 v2.39를 기준으로 구현한 의료진용 시연 서비스입니다. React·TypeScript 화면과 FastAPI·SQLite API를 사용합니다.

## 실행

```sh
python3 scripts/init_env.py
docker compose up --build -d --wait
python3 scripts/smoke.py
```

`http://localhost:8080`에서 접속합니다. `.env`는 최초 한 번 생성하며 덮어쓰지 않습니다. 관리자 `admin`, 담당의 `test`, 당직의 `oncall`의 비밀번호는 각각 `.env`의 `ADMIN_PASSWORD`, `ATTENDING_PASSWORD`, `ONCALL_PASSWORD`에서 로컬로 확인합니다. 파일 전체를 공유하지 마세요.

시연 계정을 직접 생성하려면 `.env`에 `ALLOW_SIGNUP=true`를 설정합니다. 로그인 화면의 **계정 만들기**에서 아이디·비밀번호만 입력하면 바로 시작합니다. 새 계정은 담당의 역할이며 공용 가상 환자의 조회·조치·메모를 체험할 수 있습니다. 관리자 시연 도구·초기화 권한은 주지 않습니다. 모두 같은 시연 데이터를 보므로 다른 사용자의 조치도 반영됩니다. 회원가입은 `DEMO_MODE=true`에서만 열리며, 아이디 3~32자·비밀번호 8~128자를 사용합니다.

가상 환자·판독 수치를 실제 모델 API로 계산하는 시연 모드입니다. **원시 Holter 파형을 분석하거나 실시간 부정맥을 검출하지 않습니다.** 모델은 12개 임상·Holter 판독 수치를 사용하는 로지스틱 회귀이며, GPU가 필요 없습니다.

관리자 계정에서 `Shift+D`로 시연 도구를 열고 기록 수신 또는 자동 재생을 시작합니다. 로그인·로그아웃은 다른 사용자의 시연을 초기화하지 않습니다. 공유 데이터 초기화는 관리자 도구에서 확인 후 실행합니다. API 문서는 `/api/docs`입니다.

프론트·백엔드·AI API는 별도 컨테이너입니다. AI API는 내부망에서만 접근하며 서버 간 인증을 사용합니다. SQLite 데이터는 볼륨에 유지됩니다. 중지는 `docker compose down`이며 `-v`를 붙이지 마세요.

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

`inference/model.json`은 전달받은 모델의 계수·변환·표준화 통계입니다. AI API는 이를 순수 Python으로 실행하며 입력 오류를 거절합니다. 실제 분석에서 AI 서버가 실패하면 실패로 기록하고 로컬 계산기로 대체하지 않습니다. 초기 시연 기록 생성에만 서비스의 로컬 계산을 사용합니다.

점수는 보정되지 않은 0~1 값이며 실제 SCD 발생 확률이 아닙니다. 알림 기준은 서비스 설정의 0.40을 기본으로 사용합니다. 변수 기여도는 변환된 학습 평균을 기준으로 한 log-odds 기여도입니다. 화면의 테스트 성능은 전달받은 학습팀 자료이며 이번 배포 검증으로 새로 산출한 지표가 아닙니다.

원본 모델과 수치 비교는 별도 검증 환경에서 `python scripts/verify_model.py <모델ZIP경로>`로 실행합니다. 이 명령은 신뢰하는 팀 모델 파일만 사용해야 하며 joblib·numpy·pandas·scikit-learn(원본 버전)이 필요합니다. 모델 ZIP과 환자 데이터는 Git에 올리지 않습니다.

실제 병원 EMR·판독실·문자 발송 연동은 포함되지 않습니다. 공개 시연도 가상 데이터만 사용합니다.

## 배포

[GCP 설치·자동 배포 설정](deploy/README.md)을 참고하세요. 서비스·AI·배포 설정이 main에 반영되면 자동 배포됩니다. 문서만 바꾸면 배포하지 않습니다. GitHub Actions에서 수동 재배포도 가능합니다.
