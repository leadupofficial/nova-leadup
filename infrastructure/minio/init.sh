#!/bin/bash
# Initialize MinIO buckets for NOVA
# Runs as an init container after MinIO starts

set -e

echo "Waiting for MinIO to be ready..."
until curl -sf http://minio:9000/minio/health/live; do
 echo "MinIO not ready yet, waiting..."
 sleep 2
done

echo "MinIO is ready. Setting up mc alias..."
mc alias set myminio http://minio:9000 minioadmin minioadmin

echo "Creating bucket: nova-assets"
mc mb myminio/nova-assets --ignore-existing || true

echo "Setting bucket policy to public-read"
mc anonymous set public myminio/nova-assets || true

echo "Creating bucket: nova-temp"
mc mb myminio/nova-temp --ignore-existing || true

echo "Setting lifecycle policy for temp bucket (7 day expiration)"
mc ilm import myminio/nova-temp --ignore-errors <<'POLICY' || true
{
 "Rules": [
 {
 "ID": "temp-expiry",
 "Status": "Enabled",
 "Expiration": { "Days": 7 }
 }
 ]
}
POLICY

echo "MinIO initialization complete"
