import json, os

services = ["services/api","services/auth","services/realtime-gateway","services/agent-orchestrator","services/admin","services/integration-service","services/notification-service","services/worker","services/workers","services/workflow-engine","services/voice-api"]

for svc in services:
 pkg_path = svc + "/package.json"
 if not os.path.exists(pkg_path):
 print("SKIP: " + pkg_path)
 continue
 with open(pkg_path) as f:
 data = json.load(f)
 if "exports" not in data:
 data["exports"] = {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}}
 with open(pkg_path, "w") as f:
 json.dump(data, f, indent=2)
 f.write("\n")
 print("OK: " + pkg_path)
 else:
 print("DONE: " + pkg_path)
