# SCD 위험 알림

SCD 위험 알림 구현 설명서 v1.3과 HTML 데모 v2.39를 기준으로 구현한 의료진용 시연 서비스입니다. React·TypeScript 화면과 FastAPI·SQLite API를 사용합니다.

## 실행

```sh
docker compose up --build
```

`http://localhost:8080`에서 접속합니다. 기본 설정은 가상 데이터만 사용하는 시연 모드입니다.

| 역할 | 아이디 | 비밀번호 |
| --- | --- | --- |
| 담당의 | test | 1234 |
| 관리자 | admin | 1234 |
| 당직의 | oncall | 1234 |

로그인 후 8·12·14초에 판독 결과가 들어오며 한 건씩 분석합니다. EMR 동기화 버튼으로 송은희·문상철을 추가하면 약 4.5초 뒤 두 환자와 박민수 재검사 결과가 들어옵니다. 송은희의 Pro-BNP 누락은 계산 보류와 EMR 재확인으로 시연합니다. 로그아웃하면 시연 데이터를 초기화합니다. 시연 데이터는 모든 로그인 세션이 공유합니다.

관리자는 `Shift+D`로 시연 도구를 열 수 있습니다. `Shift+N/H/S/A`는 다음·고위험·선택 환자·전체 판독 수신, `Shift+T`는 30분 경과, `Shift+R`은 초기화입니다. API 문서는 `/api/docs`에 있습니다.

## 개발과 검증

프론트엔드는 `frontend`에서 `npm ci`, `npm run dev`로 실행합니다. API 및 WebSocket 요청은 로컬 8000번 포트로 전달합니다. 빌드 검사는 `npm run build`입니다. Node 버전은 `frontend/package.json`의 engines를 따릅니다.

백엔드는 Python 3.12 이상에서 실행합니다.

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.in
DEMO_MODE=true .venv/bin/uvicorn app.main:app --reload
.venv/bin/python -m unittest discover -s tests -v
```

테스트는 임시 DB에서 보류·재확인, 조치·메모 이력, 과거 검사 읽기 전용, 담당의·당직의 권한, 재알림, 설정 스냅샷 및 실시간 이벤트를 검증합니다.

## 실제 연동이 필요한 부분

제공된 ZIP은 화면 목업이며 실제 학습 모델이 포함되어 있지 않습니다. `backend/app/model.py`의 계수·평균·표준편차는 시연용 임시 값입니다. 설명서의 모델 성능 지표는 참고 값이며 이 임시 계산기의 검증 결과가 아닙니다. 점수는 실제 발생 확률이 아닙니다.

실제 서비스 전환에는 모델 파일·입력 정의·검증 예시, 병원 EMR과 판독실 연동 및 알림 채널 연동이 필요합니다. 현재 앱·문자 발송은 모의 처리입니다. `DEMO_MODE=false`에서는 목업 EMR 조회를 503으로 거절하고, 실제 모델이 준비되지 않은 분석은 실패로 기록합니다. 운영 관리자 생성에는 `ADMIN_PASSWORD` 환경 변수가 필요합니다. 시연 DB와 운영 DB는 별도로 사용해야 합니다.
