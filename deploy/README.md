# GCP VM deployment

Run the frontend, backend and inference API on one Ubuntu 24.04 VM. Inference is CPU logistic regression; no GPU or RunPod is required.

## First deployment

1. Create an `e2-standard-2` VM with a 50 GB persistent disk. Permit SSH through IAP only; do not open 8000/8080 publicly. Enable Docker and Compose. Use a dedicated VM service account with Artifact Registry Reader, without project-wide Editor.
2. Place this repository at `/opt/sixseven-service`. The deployment OS Login user must own that directory and be allowed to run Docker. Docker access is equivalent to administrative access: restrict it to the deployment identity and infrastructure owner.
3. Run `python3 scripts/init_env.py`. The generated `.env` has private permissions, inference authentication and separate random passwords. Check passwords locally; never copy the inference key to the frontend. On an existing database, changing these settings does not rotate existing account passwords.
4. Run `docker compose up --build -d --wait` and `python3 scripts/smoke.py`. The smoke command creates a synthetic analysis; run it on the rehearsal database.
5. Run the official `cloudflared` package as a separate system service, with `cloudflared tunnel --url http://127.0.0.1:8080`. Record the generated URL and test login, WebSocket updates and analysis from another network. A new tunnel creates a new URL. Keep the tunnel independent of application deployment.

## GitHub deployment setup

Create an Artifact Registry Docker repository. Configure Workload Identity Federation for this GitHub repository ID and `refs/heads/main` only. Give the deployment service account repository-scoped Artifact Registry Writer, IAP tunnel access and OS Login access to this VM; grant service-account-user access only to the VM service account if required by OS Login. Do not upload service-account JSON keys.

Set these GitHub `production` environment variables: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ZONE`, `GCP_VM_NAME`, `GCP_ARTIFACT_REPOSITORY`. On the VM configure the gcloud Docker credential helper and put `REGISTRY=<region>-docker.pkg.dev/<project>/<repository>` in `registry.env`. The VM must be able to fetch the public repository through GitHub.

The Deploy GCP workflow is manual until the first cloud rollout is verified. Run it against `main`. After one successful rollout and rollback rehearsal, add a `push: branches: [main]` trigger; remove the duplicate main-push check from CI and keep CI on PRs. Deployment includes its own backend/AI checks and frontend image build.

`deploy/update.sh` pulls commit-tagged images, takes an online SQLite backup, replaces containers and verifies health. An update failure restores the previous images. Backups are in the database volume and must additionally be copied outside the VM before destructive operations. This flow does not automatically migrate or roll back database schema changes. The initial release has no schema migration.

Do not run `docker compose down -v`. Do not rebuild/restart the tunnel during app deployment. Before the presentation, freeze the tested revision and verify the external URL. Remove cloud resources only after saving required backups.
