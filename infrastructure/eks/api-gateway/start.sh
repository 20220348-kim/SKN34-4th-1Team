#!/bin/sh
set -eu
umask 077
if [ "${#GOVBIZ_PROXY_SECRET}" -ne 64 ] || ! printf '%s' "$GOVBIZ_PROXY_SECRET" | grep -Eq '^[a-f0-9]{64}$'; then
  echo 'GOVBIZ_PROXY_SECRET must be 64 lowercase hexadecimal characters' >&2
  exit 1
fi
# Dashboard access is opt-in; API-only installations remain usable without it.
if [ -n "${GOVBIZ_ARGO_PROXY_SECRET:-}" ]; then
  if [ "${#GOVBIZ_ARGO_PROXY_SECRET}" -ne 64 ] || ! printf '%s' "$GOVBIZ_ARGO_PROXY_SECRET" | grep -Eq '^[a-f0-9]{64}$'; then
    echo 'GOVBIZ_ARGO_PROXY_SECRET must be 64 lowercase hexadecimal characters' >&2
    exit 1
  fi
  if [ ! -s /etc/govbiz-argocd/tls.crt ]; then
    echo 'The pinned Argo server certificate is required' >&2
    exit 1
  fi
  envsubst '${GOVBIZ_ARGO_PROXY_SECRET}' < /etc/govbiz/argocd.conf.template > /tmp/argocd.conf
else
  printf 'location = /argocd { return 403; }\nlocation /argocd/ { return 403; }\n' > /tmp/argocd.conf
fi
# Langfuse has its own origin credential; an absent secret keeps this route
# closed without affecting the API or Argo dashboard.
if [ -n "${GOVBIZ_LANGFUSE_PROXY_SECRET:-}" ]; then
  if [ "${#GOVBIZ_LANGFUSE_PROXY_SECRET}" -ne 64 ] || ! printf '%s' "$GOVBIZ_LANGFUSE_PROXY_SECRET" | grep -Eq '^[a-f0-9]{64}$'; then
    echo 'GOVBIZ_LANGFUSE_PROXY_SECRET must be 64 lowercase hexadecimal characters' >&2
    exit 1
  fi
  envsubst '${GOVBIZ_LANGFUSE_PROXY_SECRET}' < /etc/govbiz/langfuse.conf.template > /tmp/langfuse.conf
else
  printf 'location = /_langfuse { return 403; }\nlocation ^~ /_langfuse/ { return 403; }\n' > /tmp/langfuse.conf
fi
# Read the Pod DNS address rather than carrying Docker's resolver into EKS.
GOVBIZ_DNS_RESOLVER=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)
export GOVBIZ_DNS_RESOLVER
if ! printf '%s' "$GOVBIZ_DNS_RESOLVER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo 'An IPv4 Pod DNS resolver is required' >&2
  exit 1
fi
envsubst '${GOVBIZ_PROXY_SECRET} ${GOVBIZ_DNS_RESOLVER}' < /etc/govbiz/nginx.conf.template > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
