# dsh-hub in a container, for local end-to-end tests (and as a template for the server).
# Build context: services/dsh-hub   (see docker-compose.yml next to this file)
FROM dockerproxy.net/library/node:22-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY deploy/docker/entrypoint.sh /usr/local/bin/dsh-hub-entrypoint
# Windows checkouts may turn the script into CRLF; sh would then fail with "not found".
RUN sed -i 's/\r$//' /usr/local/bin/dsh-hub-entrypoint && chmod 755 /usr/local/bin/dsh-hub-entrypoint

# State, hub.json, TLS and controllers.json live in <DSH home>/agent-hub = /data/agent-hub.
ENV DSH_HOME=/data
VOLUME ["/data"]
EXPOSE 7891

# Alive = the hub answers HTTP at all (403 from an allow list still counts as up).
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 CMD node -e "const fs=require('fs');const ca='/data/agent-hub/tls/ca.pem';require('https').get({host:'127.0.0.1',port:Number(process.env.DSH_HUB_PORT||7891),path:'/v1/health',ca:fs.existsSync(ca)?fs.readFileSync(ca):undefined},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dsh-hub-entrypoint"]
