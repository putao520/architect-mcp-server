#!/usr/bin/env python3
"""rev_import — 导入二进制文件并执行 CFG 分析"""
import json, sys
import angr

def main():
    params = json.loads(sys.argv[1])
    filepath = params["file"]
    auto_load_libs = params.get("autoLoadLibs", False)

    project = angr.Project(filepath, auto_load_libs=auto_load_libs)
    cfg = project.analyses.CFGFast()

    # 段信息
    sections = []
    for sec in project.loader.main_object.sections:
        sections.append({
            "name": sec.name,
            "vaddr": hex(sec.vaddr),
            "size": sec.memsize,
            "permissions": sec.permissions if hasattr(sec, "permissions") else None,
        })

    # 导入/导出
    imports = []
    for name, reloc in project.loader.main_object.imports.items():
        imports.append({"name": name, "symbol": reloc.symbol.name if reloc.symbol else None})

    exports = []
    for sym in project.loader.main_object.symbols:
        if sym.is_export:
            exports.append({"name": sym.name, "address": hex(sym.rebased_addr), "size": sym.size})

    # 函数统计
    functions = list(cfg.functions.values())
    named_funcs = [f for f in functions if f.name and not f.name.startswith("sub_")]
    thunk_funcs = [f for f in functions if f.is_thunk]

    # 字符串
    strings = []
    try:
        for sec in project.loader.main_object.sections:
            if sec.name in (".rodata", ".data", ".rdata"):
                try:
                    data = project.loader.memory.load(sec.vaddr, min(sec.memsize, 65536))
                    current = bytearray()
                    for byte in data:
                        if 0x20 <= byte < 0x7f:
                            current.append(byte)
                        else:
                            if len(current) >= 4:
                                strings.append(current.decode("ascii", errors="replace"))
                            current = bytearray()
                    if len(current) >= 4:
                        strings.append(current.decode("ascii", errors="replace"))
                except:
                    pass
    except:
        pass

    result = {
        "file": filepath,
        "arch": project.arch.name,
        "bits": project.arch.bits,
        "entry": hex(project.entry),
        "loader": project.loader.main_object.execstack,
        "sections_count": len(sections),
        "sections": sections[:50],
        "imports_count": len(imports),
        "imports": imports[:100],
        "exports_count": len(exports),
        "exports": exports[:100],
        "functions_count": len(functions),
        "named_functions_count": len(named_funcs),
        "thunk_functions_count": len(thunk_funcs),
        "strings_count": len(strings),
        "strings_sample": strings[:50],
        "pie": project.loader.main_object.pic,
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
