#!/bin/sh
set -eu

ROLE="${VENDURE_ROLE:-server}"
OBSERVABILITY_ARGS=""
if [ "${CATALOG_OBSERVABILITY_ENABLED:-false}" = "true" ]; then
    OBSERVABILITY_ARGS="--require=/app/catalog-observability.cjs"
fi

case "$ROLE" in
    bootstrap)
        exec node $OBSERVABILITY_ARGS .docker-runtime/packages/fabric-server/prepare.js
        ;;
    server)
        exec node $OBSERVABILITY_ARGS .docker-runtime/packages/fabric-server/index-server.js
        ;;
    worker)
        exec node $OBSERVABILITY_ARGS .docker-runtime/packages/fabric-server/index-worker.js
        ;;
    *)
        echo "Unknown VENDURE_ROLE: $ROLE" >&2
        exit 1
        ;;
esac
