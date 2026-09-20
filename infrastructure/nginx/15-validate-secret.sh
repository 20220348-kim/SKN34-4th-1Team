#!/bin/sh
set -eu
# envsubst가 Nginx 설정에 넣는 비밀값은 설정 구문을 주입할 수 없는 32-byte hex로 제한한다.
proxy_secret=${GOVBIZ_PROXY_SECRET:-}
if [ "${#proxy_secret}" -ne 64 ] || ! printf '%s' "$proxy_secret" | grep -Eq '^[a-f0-9]{64}$'; then
  echo 'GOVBIZ_PROXY_SECRET must be 64 lowercase hexadecimal characters' >&2
  exit 1
fi
