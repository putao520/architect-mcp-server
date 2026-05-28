#!/usr/bin/env python3
"""rev_list_functions — 列出二进制中的函数"""
import json, sys
import angr

def main():
    params = json.loads(sys.argv[1])
    filepath = params["file"]
    filter_type = params.get("filter", "all")
    namespace = params.get("namespace")
    offset = params.get("offset", 0)
    limit = params.get("limit", 200)

    project = angr.Project(filepath, auto_load_libs=False)
    cfg = project.analyses.CFGFast()

    functions = list(cfg.functions.values())

    if filter_type == "named":
        functions = [f for f in functions if f.name and not f.name.startswith("sub_")]
    elif filter_type == "thunk":
        functions = [f for f in functions if f.is_thunk]
    elif filter_type == "entry":
        functions = [f for f in functions if f.addr == project.entry]

    if namespace:
        functions = [f for f in functions if namespace in (f.name or "")]

    functions.sort(key=lambda f: f.addr)
    total = len(functions)
    functions = functions[offset:offset + limit]

    result = {
        "total": total,
        "offset": offset,
        "showing": len(functions),
        "functions": [
            {
                "name": f.name,
                "address": hex(f.addr),
                "size": f.size,
                "blocks": len(f.blocks) if f.blocks else 0,
                "is_thunk": f.is_thunk,
                "is_plt": hasattr(f, "is_plt") and f.is_plt,
            }
            for f in functions
        ],
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
