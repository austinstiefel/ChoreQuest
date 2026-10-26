"""Read-only source inventory. Does not import the Python app or open any DB.

Run from the repository using .venv/Scripts/python.exe. JSON on stdout can be
used to refresh/review docs/business-api.md; no output files are written here.
"""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
models = ast.parse((ROOT / "backend/models.py").read_text(encoding="utf-8"))
tables = {
    c.name: next((ast.literal_eval(n.value) for n in c.body if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in n.targets)), None)
    for c in models.body if isinstance(c, ast.ClassDef)
}
front = {str(p.relative_to(ROOT)).replace("\\", "/"): p.read_text(encoding="utf-8")
         for p in (ROOT / "frontend/src").rglob("*") if p.suffix in (".jsx", ".js")}
inventory = []
for path in sorted((ROOT / "backend/routers").glob("*.py")):
    if path.stem in ("auth", "__init__"):
        continue
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    prefix = next((ast.literal_eval(k.value) for n in ast.walk(tree) if isinstance(n, ast.Call)
                   and isinstance(n.func, ast.Name) and n.func.id == "APIRouter"
                   for k in n.keywords if k.arg == "prefix"), "")
    for fn in tree.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in fn.decorator_list:
            if not (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                    and isinstance(dec.func.value, ast.Name) and dec.func.value.id == "router"
                    and dec.func.attr in ("get", "post", "put", "delete", "patch")):
                continue
            suffix = ast.literal_eval(dec.args[0])
            if path.stem == "admin" and not suffix.startswith("/settings"):
                continue
            contract = {k.arg: ast.unparse(k.value) for k in dec.keywords}
            defaults = [None] * (len(fn.args.args) - len(fn.args.defaults)) + list(fn.args.defaults)
            params = [{"name": arg.arg, "annotation": ast.unparse(arg.annotation) if arg.annotation else None,
                       "default": ast.unparse(default) if default else None}
                      for arg, default in zip(fn.args.args, defaults)]
            signature = " ".join(p["default"] or "" for p in params)
            role = "admin" if "require_admin" in signature else "parent" if "require_parent" in signature else "authenticated" if "get_current_user" in signature else "public"
            body = ast.get_source_segment(source, fn)
            used = sorted({tables[n.id] for n in ast.walk(fn) if isinstance(n, ast.Name)
                           and n.id in tables and tables[n.id]})
            errors = sorted({ast.literal_eval(k.value) for n in ast.walk(fn) if isinstance(n, ast.Call)
                             and isinstance(n.func, ast.Name) and n.func.id == "HTTPException"
                             for k in n.keywords if k.arg == "status_code" and isinstance(k.value, ast.Constant)})
            effects = [name for name in ("ws_manager", "Notification", "check_achievements", "award_pet_xp_db",
                       "auto_generate_week_assignments", "try_quest_drop", "send_push_to_user", "get_vapid_public_key") if name in body]
            inventory.append({"method": dec.func.attr.upper(), "path": prefix + suffix, "role": role,
                              "source": str(path.relative_to(ROOT)).replace("\\", "/"), "line": fn.lineno,
                              "function": fn.name, "parameters": params, "response": contract.get("response_model", "inline return"),
                              "status": int(contract.get("status_code", "200")), "errors": errors,
                              "tables_directly_referenced": used, "side_effects": effects,
                              "callers_in_domain": sorted(p for p, text in front.items() if prefix in text)})
print(json.dumps(inventory, indent=2))
