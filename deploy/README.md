# GCP VM deployment

Run the frontend, backend and inference API on one Ubuntu 24.04 VM. Inference is CPU logistic regression; no GPU or RunPod is required.

## First deployment

1. Create an `e2-standard-2` VM with a 50 GB persistent disk. Permit SSH through IAP only; do not open 8000/8080 publicly. Enable Docker and Compose. Use a dedicated VM service account with Artifact Registry Reader, without project-wide Editor.
2. Place this repository at `/opt/sixseven-service`. Keep the checkout and environment root-owned. The deployment OS Login service account runs the update through sudo (OS Admin Login); restrict this administrative access to the deployment identity and infrastructure owner.
3. Run `python3 scripts/init_env.py`. The generated `.env` has private permissions, inference authentication and separate random passwords. Check passwords locally; never copy the inference key to the frontend. On an existing database, changing these settings does not rotate existing account passwords.
4. Run `docker compose up --build -d --wait` and `python3 scripts/smoke.py`. The smoke command creates a synthetic analysis; run it on the rehearsal database.
5. Run the official `cloudflared` package as a separate system service, with `cloudflared tunnel --url http://127.0.0.1:8080`. Record the generated URL and test login, WebSocket updates and analysis from another network. A new tunnel creates a new URL. Keep the tunnel independent of application deployment.

## GitHub deployment setup

Create an Artifact Registry Docker repository. Configure Workload Identity Federation for this GitHub repository ID and `refs/heads/main` only. Give the deployment service account repository-scoped Artifact Registry Writer, IAP tunnel access and OS Login access to this VM; grant service-account-user access only to the VM service account if required by OS Login. Do not upload service-account JSON keys.

Set these GitHub `production` environment variables: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ZONE`, `GCP_VM_NAME`, `GCP_ARTIFACT_REPOSITORY`. On the VM configure the gcloud Docker credential helper and put `REGISTRY=<region>-docker.pkg.dev/<project>/<repository>` in `registry.env`. The VM must be able to fetch the public repository through GitHub.

The Deploy GCP workflow runs automatically when application or deployment files change on `main`. It can also be run manually against `main` to redeploy. PRs run CI; main has no duplicate CI workflow. Deployment includes backend/AI checks and the frontend image build. Only the main branch can use the production environment.

`deploy/update.sh` pulls commit-tagged images, takes an online SQLite backup, replaces containers and verifies health. An update failure restores the previous images. Backups are in the database volume and must additionally be copied outside the VM before destructive operations. This flow does not automatically migrate or roll back database schema changes. The initial release has no schema migration.

Do not run `docker compose down -v`. Do not rebuild/restart the tunnel during app deployment. Before the presentation, freeze the tested revision and verify the external URL. Remove cloud resources only after saving required backups.

## 계정별 MUSIC 시연

배포 구성은 `ISOLATED_DEMO=true`를 사용합니다. 수신·분석·자동 재생·설정·알림·조치·초기화는 인증된 계정의 데이터에만 적용됩니다. 같은 계정은 기기 간 상태를 공유합니다. `backend-data` 볼륨의 `workspaces/`와 기존 `service.sqlite3`를 함께 보존하며 배포 전 온라인 백업에 두 종류를 포함합니다. 과거 공용 DB는 삭제하지 않습니다. 백엔드는 단일 프로세스로 실행합니다.
