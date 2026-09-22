import json
import sys

files = [
 "services/notification-service/tsconfig.json",
]
for f in files:
 with open(f) as fh:
 d = json.load(fh)
 d.get('compilerOptions', {}).pop('allowImportingTsExtensions', None)
 with open(f, 'w') as fh:
 json.dump(d, fh, indent=2)
 fh.write('\n')
 print('fixed', f)
