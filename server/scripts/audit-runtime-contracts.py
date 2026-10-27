"""Read-only Python runtime source inventory. No app imports, env or DB access.

Run with the repository's existing .venv/Scripts/python.exe -B.
"""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
flows = []
rest = []
for path in sorted((ROOT / "backend").rglob("*.py")):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    globals_ = {target.id: node.value for node in tree.body if isinstance(node, ast.Assign)
                for target in node.targets if isinstance(target, ast.Name)}
    prefix = next((ast.literal_eval(key.value) for node in ast.walk(tree)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                   and node.func.id == "APIRouter" for key in node.keywords if key.arg == "prefix"), "")
    for fn in tree.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in fn.decorator_list:
            if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and isinstance(dec.func.value, ast.Name) and dec.func.value.id in ("router", "app") and dec.func.attr in ("get", "post", "put", "delete"):
                suffix = ast.literal_eval(dec.args[0])
                if suffix != "/{full_path:path}":
                    rest.append({"method": dec.func.attr.upper(), "path": prefix + suffix, "function": fn.name})
        for call in ast.walk(fn):
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or not isinstance(call.func.value, ast.Name) or call.func.value.id != "ws_manager" or call.func.attr not in ("broadcast", "send_to_user", "send_to_parents"):
                continue
            message = call.args[1] if call.func.attr == "send_to_user" else call.args[0]
            if isinstance(message, ast.Name):
                message = globals_.get(message.id, message)
            event_type = next((ast.literal_eval(value) for key, value in zip(message.keys, message.values)
                               if isinstance(key, ast.Constant) and key.value == "type"), None) if isinstance(message, ast.Dict) else None
            flows.append({"source": str(path.relative_to(ROOT)).replace("\\", "/"), "line": call.lineno,
                          "function": fn.name, "delivery": call.func.attr, "type": event_type,
                          "call": ast.unparse(call)})
main = ast.parse((ROOT / "backend/main.py").read_text(encoding="utf-8"))
jobs = [{"source": "backend/main.py", "function": node.name, "line": node.lineno}
        for node in main.body if isinstance(node, ast.AsyncFunctionDef) and node.name in ("daily_reset_task", "reset_stale_streaks")]
push_hook = ast.parse((ROOT / "backend/services/push_hook.py").read_text(encoding="utf-8"))
urls = next(ast.literal_eval(node.value) for node in push_hook.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "_NOTIFICATION_URL_MAP" for target in node.targets))
print(json.dumps({"rest_count": len(rest), "rest": rest, "websocket_emit_sites": len(flows),
                  "event_types": sorted({flow["type"] for flow in flows if flow["type"]}),
                  "flows": flows, "jobs": jobs, "notification_urls": urls}, indent=2))
