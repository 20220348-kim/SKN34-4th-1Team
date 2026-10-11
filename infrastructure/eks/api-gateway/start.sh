#!/bin/sh
set -eu
umask 077
if [ "${#GOVBIZ_PROXY_SECRET}" -ne 64 ] || ! printf '%s' "$GOVBIZ_PROXY_SECRET" | grep -Eq '^[a-f0-9]{64}$'; then
  echo 'GOVBIZ_PROXY_SECRET must be 64 lowercase hexadecimal characters' >&2
  exit 1
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
