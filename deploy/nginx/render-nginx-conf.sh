#!/bin/sh
# Renders deploy/nginx/nginx.conf.template -> stdout, substituting only the
# 7 deployment placeholders. All other $-variables in the template are nginx
# runtime variables and are left untouched (envsubst is given an explicit allowlist).
set -eu

: "${AUTH_UPSTREAM:=auth:9000}"
: "${VOICEBOX_PROXY_UPSTREAM:=voicebox-proxy:8002}"
: "${DOC_EXTRACT_UPSTREAM:=doc-extract:8003}"
: "${OLLAMA_UPSTREAM:=host.docker.internal:11434}"
: "${SERVER_NAME:=localhost}"
: "${SSL_CERT_PATH:=/etc/nginx/ssl/localhost.pem}"
: "${SSL_KEY_PATH:=/etc/nginx/ssl/localhost-key.pem}"
export AUTH_UPSTREAM VOICEBOX_PROXY_UPSTREAM DOC_EXTRACT_UPSTREAM OLLAMA_UPSTREAM SERVER_NAME SSL_CERT_PATH SSL_KEY_PATH

TEMPLATE="${1:-"$(dirname "$0")/nginx.conf.template"}"
exec envsubst '${AUTH_UPSTREAM} ${VOICEBOX_PROXY_UPSTREAM} ${DOC_EXTRACT_UPSTREAM} ${OLLAMA_UPSTREAM} ${SERVER_NAME} ${SSL_CERT_PATH} ${SSL_KEY_PATH}' < "$TEMPLATE"
