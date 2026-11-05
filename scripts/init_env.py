"""Create private environment configuration once. Never overwrite existing settings."""
import os
import secrets
from pathlib import Path

path = Path(__file__).resolve().parents[1] / ".env"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as file:
    file.write("WEB_PORT=8080\nDEMO_MODE=true\nPUBLIC_DEMO=true\n")
    for name in ("INFERENCE_API_KEY", "ADMIN_PASSWORD", "ATTENDING_PASSWORD", "ONCALL_PASSWORD"):
        file.write(f"{name}={secrets.token_urlsafe(24)}\n")
print(".env created. Read account passwords locally; do not share the inference key.")
