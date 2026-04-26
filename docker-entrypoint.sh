#!/bin/sh
set -eu

SCRIPT_PREFIX="node -r ts-node/register -r tsconfig-paths/register"
ROLE="${VENDURE_ROLE:-server}"

case "$ROLE" in
    bootstrap)
        exec sh -c "$SCRIPT_PREFIX packages/fabric-server/prepare.ts"
        ;;
    server)
        exec sh -c "$SCRIPT_PREFIX packages/fabric-server/index-server.ts"
        ;;
    worker)
        exec sh -c "$SCRIPT_PREFIX packages/fabric-server/index-worker.ts"
        ;;
    *)
        echo "Unknown VENDURE_ROLE: $ROLE" >&2
        exit 1
        ;;
esac
