#!/bin/sh
set -eu

ROLE="${VENDURE_ROLE:-server}"

case "$ROLE" in
    bootstrap)
        exec node .docker-runtime/packages/fabric-server/prepare.js
        ;;
    server)
        exec node .docker-runtime/packages/fabric-server/index-server.js
        ;;
    worker)
        exec node .docker-runtime/packages/fabric-server/index-worker.js
        ;;
    *)
        echo "Unknown VENDURE_ROLE: $ROLE" >&2
        exit 1
        ;;
esac
