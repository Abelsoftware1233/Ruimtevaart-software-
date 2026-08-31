#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Zonnestelsel app (melkweg.abelsoftware123.com)
#
# Zet de app neer in /opt/melkweg, maakt een Python venv aan, installeert
# Flask, en registreert + start een systemd-service die op poort 3333 draait.
# Nginx (reverse proxy + TLS) wordt hier bewust NIET opgezet — dat regel je zelf.
#
# Gebruik:
#   sudo ./deploy.sh
#
# Herhaald draaien is veilig (idempotent): update van code, herinstalleren
# van deps, en een restart van de service.
# =============================================================================
set -euo pipefail

APP_NAME="melkweg"
APP_DIR="/opt/${APP_NAME}"
VENV_DIR="${APP_DIR}/venv"
SERVICE_NAME="${APP_NAME}.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
APP_PORT=3333
RUN_USER="${SUDO_USER:-$(whoami)}"

# Map waar dit script vandaan draait (verwacht app.py, index.html, script.js hiernaast)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Zonnestelsel app deployen als '${APP_NAME}' op poort ${APP_PORT}"

if [ "$EUID" -ne 0 ]; then
  echo "Dit script heeft root nodig (voor /opt en systemd). Draai met: sudo ./deploy.sh"
  exit 1
fi

# -----------------------------------------------------------------------------
# 1. Applicatiebestanden plaatsen
# -----------------------------------------------------------------------------
echo "==> Bestanden kopiëren naar ${APP_DIR}"
mkdir -p "${APP_DIR}"

for f in app.py index.html script.js; do
  if [ ! -f "${SCRIPT_DIR}/${f}" ]; then
    echo "FOUT: ${f} niet gevonden naast deploy.sh (verwacht in ${SCRIPT_DIR})"
    exit 1
  fi
  cp "${SCRIPT_DIR}/${f}" "${APP_DIR}/${f}"
done

# -----------------------------------------------------------------------------
# 2. Python venv + dependencies
# -----------------------------------------------------------------------------
echo "==> Virtuele omgeving aanmaken/updaten in ${VENV_DIR}"
if [ ! -d "${VENV_DIR}" ]; then
  python3 -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/pip" install --upgrade pip --quiet
"${VENV_DIR}/bin/pip" install flask --quiet

# -----------------------------------------------------------------------------
# 3. Eigenaarschap zetten (niet als root laten draaien)
# -----------------------------------------------------------------------------
echo "==> Eigenaarschap instellen op gebruiker '${RUN_USER}'"
chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

# -----------------------------------------------------------------------------
# 4. systemd service schrijven
# -----------------------------------------------------------------------------
echo "==> systemd-service schrijven naar ${SERVICE_FILE}"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Zonnestelsel live 3D-visualisatie (melkweg.abelsoftware123.com)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${VENV_DIR}/bin/python3 ${APP_DIR}/app.py
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1

# lichte hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

# -----------------------------------------------------------------------------
# 5. Service (her)laden, inschakelen, (her)starten
# -----------------------------------------------------------------------------
echo "==> systemd herladen en service starten"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

sleep 1
systemctl --no-pager status "${SERVICE_NAME}" || true

echo ""
echo "==> Klaar."
echo "    App draait lokaal op: http://127.0.0.1:${APP_PORT}"
echo "    Logs bekijken:        journalctl -u ${SERVICE_NAME} -f"
echo "    Herstarten:           sudo systemctl restart ${SERVICE_NAME}"
echo "    Stoppen:              sudo systemctl stop ${SERVICE_NAME}"
echo ""
echo "    Nginx reverse proxy + TLS voor melkweg.abelsoftware123.com regel je zelf,"
echo "    wijzend naar 127.0.0.1:${APP_PORT}."
