#!/bin/sh
set -e

# Validate JWT private key
if [ ! -f "$JWT_PRIVATE_KEY_PATH" ]; then
 echo "ERROR: JWT private key not found at $JWT_PRIVATE_KEY_PATH"
 exit 1
fi

# Validate key permissions (should be 600)
KEY_PERMS=$(stat -c "%a" "$JWT_PRIVATE_KEY_PATH" 2>/dev/null || stat -f "%Lp" "$JWT_PRIVATE_KEY_PATH" 2>/dev/null || echo "000")
if [ "$KEY_PERMS" != "600" ]; then
 echo "WARNING: JWT private key permissions are $KEY_PERMS, should be 600"
 echo "Fixing permissions..."
 chmod 600 "$JWT_PRIVATE_KEY_PATH"
fi

# Validate JWT public key
if [ ! -f "$JWT_PUBLIC_KEY_PATH" ]; then
 echo "ERROR: JWT public key not found at $JWT_PUBLIC_KEY_PATH"
 exit 1
fi

echo "JWT keys validated successfully"
exec "$@"
