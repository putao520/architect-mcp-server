#!/usr/bin/env python3
"""rev_xrefs — 交叉引用"""
import json, sys
import angr

def main():
    params = json.loads(sys.argv[1])
    filepath = params["file"]
    addr_str = params["address"]
    direction = params.get("direction", "both")

    project = angr.Project(filepath, auto_load_libs=False)
    cfg = project.analyses.CFGFast()

    try:
        addr = int(addr_str, 16) if isinstance(addr_str, str) else addr_str
    except:
        print(json.dumps({"error": f"Invalid address: {addr_str}"}))
        return

    xrefs_to = []
    xrefs_from = []

    if direction in ("to", "both"):
        # 谁引用了这个地址 — 用 CFG 边遍历
        for src, dst, data in cfg.graph.edges(data=True):
            if dst.addr == addr or (hasattr(dst, 'function_address') and dst.function_address == addr):
                if src.function_address == addr:
                    continue
                func = cfg.functions.get(src.function_address)
                xrefs_to.append({
                    "from_address": hex(src.addr),
                    "from_function": func.name if func else "unknown",
                    "to_address": hex(addr),
                    "jump_type": data.get("jump_type", "unknown") if isinstance(data, dict) else None,
                })

        # 也检查函数调用关系
        for func in cfg.functions.values():
            for site in func.get_call_sites():
                target = func.get_call_target(site)
                if target == addr:
                    xrefs_to.append({
                        "from_address": hex(site),
                        "from_function": func.name,
                        "to_address": hex(addr),
                        "jump_type": "call",
                    })

    if direction in ("from", "both"):
        # 这个地址引用了谁
        func = cfg.functions.get(addr)
        if func:
            for site in func.get_call_sites():
                target = func.get_call_target(site)
                target_func = cfg.functions.get(target) if target else None
                xrefs_from.append({
                    "from_address": hex(site),
                    "from_function": func.name,
                    "to_address": hex(target) if target else "unknown",
                    "to_function": target_func.name if target_func else "unknown",
                    "jump_type": "call",
                })

            # 从 CFG 边中查找该函数的出边
            for src, dst, data in cfg.graph.edges(data=True):
                if src.function_address == func.addr and hasattr(dst, 'addr'):
                    target_func = cfg.functions.get(dst.function_address) if hasattr(dst, 'function_address') else None
                    xrefs_from.append({
                        "from_address": hex(src.addr),
                        "from_function": func.name,
                        "to_address": hex(dst.addr),
                        "to_function": target_func.name if target_func else "unknown",
                        "jump_type": data.get("jump_type", "unknown") if isinstance(data, dict) else None,
                    })

    # 去重
    seen_to = set()
    deduped_to = []
    for x in xrefs_to:
        key = (x["from_address"], x["to_address"])
        if key not in seen_to:
            seen_to.add(key)
            deduped_to.append(x)

    seen_from = set()
    deduped_from = []
    for x in xrefs_from:
        key = (x["from_address"], x["to_address"])
        if key not in seen_from:
            seen_from.add(key)
            deduped_from.append(x)

    result = {
        "address": hex(addr),
        "xrefs_to_count": len(deduped_to),
        "xrefs_to": deduped_to[:100],
        "xrefs_from_count": len(deduped_from),
        "xrefs_from": deduped_from[:100],
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
