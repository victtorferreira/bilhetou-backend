#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

domain="${1:-}"
if [[ ${#domain} -gt 253 || ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ || "$domain" != *.* || "$domain" == *..* ]]; then
  echo 'Uso: bash init.sh waha.seudominio.com (somente domínio, sem https:// ou caminho).' >&2
  exit 1
fi
if [[ -e .env ]]; then
  echo '.env já existe. Arquivo preservado; edite-o manualmente se necessário.' >&2
  exit 1
fi
command -v openssl >/dev/null
umask 077
# Noclobber also prevents overwriting a file created concurrently.
set -o noclobber
{
  printf 'WAHA_HOST=%s\n' "$domain"
  printf 'WAHA_IMAGE=devlikeapro/waha:latest\n'
  printf 'WAHA_API_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'WAHA_DASHBOARD_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'WAHA_SWAGGER_PASSWORD=%s\n' "$(openssl rand -hex 32)"
} > .env
echo 'Configuração criada em .env com permissão restrita. Guarde os segredos no seu gerenciador de senhas.'
echo 'Próximo passo: sudo docker compose config --quiet'
