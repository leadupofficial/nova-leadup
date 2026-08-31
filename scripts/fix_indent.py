with open('.github/workflows/build-apk.yml') as f:
 lines = f.readlines()

fixed = []
for i, line in enumerate(lines):
 if i == 0 or not line.strip():
 fixed.append(line)
 else:
 fixed.append(' ' + line)

with open('.github/workflows/build-apk.yml', 'w') as f:
 f.writelines(fixed)
print('Fixed', len(lines), 'lines')
