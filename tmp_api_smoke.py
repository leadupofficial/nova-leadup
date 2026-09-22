import requests, json

BASE = "http://127.0.0.1:3001"
rows = []

def chk(name, fn):
 try:
 r = fn()
 tag = "[" + str(r.status_code) + "]"
 tag += " OK" if r.status_code < 300 else " FAIL"
 try:
 j = r.json()
 tag += " | " + json.dumps(j)[:220]
 except Exception:
 tag += " | " + r.text[:120]
 except Exception as e:
 tag = "[ERR] " + str(e)
 rows.append((name, tag))
 print(" " + name + ": " + tag)

print("=== Phase 1: No-auth routes ===")
chk("healthz", lambda: requests.get(BASE + "/api/healthz"))
chk("register", lambda: requests.post(BASE + "/api/auth/register", json={"name":"QA","email":"qa@test.com","password":"Pass1234!"}))
chk("login", lambda: requests.post(BASE + "/api/auth/login", json={"email":"qa@test.com","password":"Pass1234!"}))
chk("unauth profile", lambda: requests.get(BASE + "/api/auth/profile"))

print("\n=== Phase 2: Auth flow ===")
login = requests.post(BASE + "/api/auth/login", json={"email":"qa@test.com","password":"Pass1234!"})
print(" login status:", login.status_code, login.text[:200])
try:
 token = login.json().get("token","")
except Exception:
 token = ""
print(" token length:", len(token))

h = {"Authorization": "Bearer " + token} if token else {}

print("\n=== Phase 3: Protected routes ===")
chk("profile", lambda: requests.get(BASE + "/api/auth/profile", headers=h))
chk("conversations", lambda: requests.get(BASE + "/api/conversations", headers=h))
chk("avatars", lambda: requests.get(BASE + "/api/avatars", headers=h))
chk("notifications", lambda: requests.get(BASE + "/api/notifications", headers=h))
chk("admin/users", lambda: requests.get(BASE + "/api/admin/users", headers=h))

print("\n=== Phase 4: Create conversation ===")
chk("create conv", lambda: requests.post(BASE + "/api/conversations", headers=h, json={"title":"QA Test"}))

print("\n=== Summary ===")
fails = [r for r in rows if "FAIL" in r[1] or "ERR" in r[1]]
print("Total:", len(rows), "Fails:", len(fails))
for r in fails:
 print(" FAIL:", r)
