#!/bin/sh
# Creates the bucket and makes processed output (HLS + posters) publicly readable.
# Raw uploads under uploads/ stay private and are only reachable via presigned URLs.
set -e
mc --config-dir "$MC_CONFIG_DIR" alias set local http://minio:9000 minioadmin minioadmin
mc --config-dir "$MC_CONFIG_DIR" mb --ignore-existing local/ugn-videos
mc --config-dir "$MC_CONFIG_DIR" anonymous set download local/ugn-videos/public
echo "minio initialised"
