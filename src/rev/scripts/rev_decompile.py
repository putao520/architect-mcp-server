#!/usr/bin/env python3
"""rev_decompile — 反编译函数为伪 C 代码"""
import json, sys
import angr

def main():
    params = json.loads(sys.argv[1])
    filepath = params["file"]
    func_name = params.get("function")
    func_addr = params.get("address")

    project = angr.Project(filepath, auto_load_libs=False)
    cfg = project.analyses.CFGFast()

    # 定位函数
    func = None
    if func_addr:
        try:
            addr = int(func_addr, 16) if isinstance(func_addr, str) else func_addr
            func = cfg.functions.get(addr)
        except:
            pass
    if not func and func_name:
        for f in cfg.functions.values():
            if f.name == func_name:
                func = f
                break
    if not func and func_name:
        for f in cfg.functions.values():
            if func_name.lower() in (f.name or "").lower():
                func = f
                break

    if not func:
        print(json.dumps({"error": f"Function not found: {func_name or func_addr}"}))
        return

    # 反编译
    try:
        decomp = project.analyses.Decompiler(func)
        if decomp and decomp.codegen:
            decompiled = decomp.codegen.text
        else:
            decompiled = "(decompilation failed)"
    except Exception as e:
        decompiled = f"(decompilation error: {str(e)[:200]})"

    # 调用关系
    callees = []
    for site in func.get_call_sites():
        target = func.get_call_target(site)
        target_func = cfg.functions.get(target) if target else None
        callees.append({
            "address": hex(target) if target else "unknown",
            "name": target_func.name if target_func else "unknown",
        })

    callers = []
    for caller_func in cfg.functions.values():
        for site in caller_func.get_call_sites():
            target = caller_func.get_call_target(site)
            if target == func.addr:
                callers.append({
                    "address": hex(caller_func.addr),
                    "name": caller_func.name,
                })

    result = {
        "function": func.name,
        "address": hex(func.addr),
        "size": func.size,
        "signature": f"{func.name}({', '.join(str(p) for p in func.arguments)})",
        "decompiled": decompiled,
        "callees_count": len(callees),
        "callees": callees[:50],
        "callers_count": len(callers),
        "callers": callers[:50],
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
