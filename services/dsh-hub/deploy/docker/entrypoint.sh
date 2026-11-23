#!/bin/sh
# dsh-hub container entrypoint.
#
#   (no args)            first start: create a self-signed CA + server cert and hub.json
#                        if they do not exist yet, copy the CA to /out, then start the hub
#   <args>               run the hub CLI instead, e.g. `controller add dsh-local`
#
# Environment:
#   DSH_HOME       /data (state dir = /data/agent-hub)
#   HUB_TLS_SAN    subjectAltName of the generated server cert
#                  (default DNS:hub,DNS:localhost,IP:127.0.0.1)
#   HUB_ALLOW      comma-separated allow list written into a NEW hub.json
#                  (empty = no IP restriction; tokens are still required)
# Existing files are never overwritten: delete them (or the volume) to regenerate.
set -eu

: "${DSH_HOME:=/data}"
HUB_DIR="$DSH_HOME/agent-hub"
TLS_DIR="$HUB_DIR/tls"

if [ "$#" -gt 0 ]; then
  exec node /app/server.mjs "$@"
fi

mkdir -p "$TLS_DIR"
chmod 700 "$HUB_DIR" "$TLS_DIR"

SAN="${HUB_TLS_SAN:-DNS:hub,DNS:localhost,IP:127.0.0.1}"
if [ ! -s "$TLS_DIR/fullchain.pem" ] || [ ! -s "$TLS_DIR/privkey.pem" ]; then
  echo "dsh-hub: generating a local CA and a server certificate (SAN: $SAN)"
  ( umask 077
    cd "$TLS_DIR"
    cat > ca.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = dsh-hub local CA
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
    openssl req -x509 -new -config ca.cnf -newkey rsa:2048 -nodes -sha256 -days 825 \
      -keyout ca.key -out ca.pem 2>/dev/null
    cat > server.ext <<EOF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF
    openssl req -new -newkey rsa:2048 -nodes -subj "/CN=dsh-hub" -keyout privkey.pem -out server.csr 2>/dev/null
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -sha256 \
      -extfile server.ext -out server.pem 2>/dev/null
    cat server.pem ca.pem > fullchain.pem
    rm -f server.csr
    chmod 600 privkey.pem ca.key
    chmod 644 ca.pem fullchain.pem server.pem
  )
  echo "dsh-hub: server cert sha256 $(openssl x509 -in "$TLS_DIR/server.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
fi

# The CA certificate is public: hand it to the host so DSH / workers can use it as caFile.
if [ -d /out ]; then
  cp "$TLS_DIR/ca.pem" /out/hub-ca.pem
  echo "dsh-hub: CA certificate copied to /out/hub-ca.pem"
fi

if [ ! -s "$HUB_DIR/hub.json" ]; then
  ALLOW_JSON='[]'
  if [ -n "${HUB_ALLOW:-}" ]; then
    ALLOW_JSON=$(printf '%s' "$HUB_ALLOW" | awk -F, '{ o=""; for (i=1;i<=NF;i++) { gsub(/^[ \t]+|[ \t]+$/, "", $i); if ($i != "") o = o (o == "" ? "" : ",") "\"" $i "\"" } print "[" o "]" }')
  fi
  cat > "$HUB_DIR/hub.json" <<EOF
{
  "port": 7891,
  "host": "0.0.0.0",
  "tls": { "cert": "tls/fullchain.pem", "key": "tls/privkey.pem" },
  "allow": $ALLOW_JSON,
  "trustProxy": false,
  "maxRetries": 2,
  "offlineAfterMs": 90000,
  "sweepIntervalMs": 15000
}
EOF
  chmod 600 "$HUB_DIR/hub.json"
  echo "dsh-hub: wrote $HUB_DIR/hub.json (allow: $ALLOW_JSON)"
fi

exec node /app/server.mjs
