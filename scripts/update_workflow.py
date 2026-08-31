with open('.github/workflows/build-apk.yml') as f:
 lines = f.readlines()

out = []
for i, line in enumerate(lines):
 if i >= 67 and i <= 74:
 continue
 out.append(line)

insert_idx = None
for i, line in enumerate(out):
 if 'Build release APK' in line:
 insert_idx = i
 break

if insert_idx:
 out.insert(insert_idx, ' - name: Fix Android build files\n')
 out.insert(insert_idx + 1, ' working-directory: apps/mobile/android\n')
 out.insert(insert_idx + 2, " run: 'node .github/workflows/fix-android.js\n")
 out.insert(insert_idx + 3, '\n')
 out.insert(insert_idx + 4, ' echo "Applied fixes"\'\n')

with open('.github/workflows/build-apk.yml', 'w') as f:
 f.writelines(out)

print('Done')
