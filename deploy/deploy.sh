#!/usr/bin/env bash
set -euo pipefail

# Script de deploy do Look Tina, disparado pelo GitHub Actions via SSH com
# forced command no authorized_keys. O cliente não tem shell: o que ele mandar
# em SSH_ORIGINAL_COMMAND é ignorado (só registrado, para auditoria).

readonly LOCK_FILE="/tmp/lookstina-deploy.lock"
readonly REPO_DIR="/root/apps/LOOKSTINA"
readonly SERVICE_NAME="lookstina"

# Trava para não deixar dois deploys se atropelarem
exec 200>"$LOCK_FILE" || exit 1
if ! flock -n 200; then
    echo "[deploy] $(date -Iseconds) ERROR: deploy já em andamento"
    exit 1
fi

log_step() {
    echo "[deploy] $(date -Iseconds) $1"
}

log_step "iniciando deploy do Look Tina"

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
    log_step "ignorando comando do cliente: $SSH_ORIGINAL_COMMAND"
fi

cd "$REPO_DIR" || { log_step "ERROR: não conseguiu acessar $REPO_DIR"; exit 1; }

# ff-only: se houver commit local que não está no remoto, o deploy para em vez
# de criar merge ou descartar trabalho sem querer.
log_step "executando git pull --ff-only origin main"
if ! git pull --ff-only origin main; then
    log_step "ERROR: git pull falhou (commits locais ou conflito)"
    exit 1
fi

COMMIT_HASH=$(git rev-parse --short HEAD)

log_step "iniciando docker compose up -d --build $SERVICE_NAME"
if ! docker compose up -d --build "$SERVICE_NAME"; then
    log_step "ERROR: docker compose falhou"
    exit 1
fi

# O container subir não quer dizer que o app respondeu: o que vale é o health
# check da aplicação. Tenta por até 30s antes de considerar o deploy quebrado.
log_step "aguardando a aplicação responder..."
for _ in $(seq 1 15); do
    # 2>/dev/null: durante os primeiros segundos o curl reclama de conexão
    # recusada, o que é esperado e não deve poluir o log do deploy.
    if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:4001/api/health 2>/dev/null; then
        log_step "aplicação respondeu em /api/health"
        log_step "SUCCESS: deploy concluído com commit $COMMIT_HASH"
        docker image prune -f > /dev/null 2>&1 || true
        exit 0
    fi
    sleep 2
done

log_step "ERROR: aplicação não respondeu em /api/health após 30s"
log_step "status do container: $(docker inspect -f '{{.State.Status}}' "$SERVICE_NAME" 2>/dev/null || echo notfound)"
log_step "últimas linhas do docker logs:"
docker logs --tail 20 "$SERVICE_NAME" 2>&1 | sed 's/^/  /'
exit 1
