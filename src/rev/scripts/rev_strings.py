#!/usr/bin/env python3
"""rev_strings — 搜索二进制中的字符串"""
import json, sys
import angr

def main():
    params = json.loads(sys.argv[1])
    filepath = params["file"]
    query = params.get("query")
    min_len = params.get("minLen", 4)

    project = angr.Project(filepath, auto_load_libs=False)
    cfg = project.analyses.CFGFast()

    # 从内存中提取字符串
    strings = []
    obj = project.loader.main_object

    for sec in obj.sections:
        if not (sec.name and sec.name.startswith(".")):
            continue
        try:
            data = project.loader.memory.load(sec.vaddr, min(sec.memsize, 2 * 1024 * 1024))
        except:
            continue

        current = bytearray()
        current_start = 0
        for i, byte in enumerate(data):
            if 0x20 <= byte < 0x7f or byte in (0x09, 0x0a, 0x0d):
                if not current:
                    current_start = i
                current.append(byte)
            else:
                if len(current) >= min_len:
                    try:
                        s = current.decode("ascii", errors="replace")
                        addr = sec.vaddr + current_start
                        strings.append({"address": hex(addr), "string": s, "section": sec.name})
                    except:
                        pass
                current = bytearray()

        if len(current) >= min_len:
            try:
                s = current.decode("ascii", errors="replace")
                addr = sec.vaddr + current_start
                strings.append({"address": hex(addr), "string": s, "section": sec.name})
            except:
                pass

    # 过滤
    if query:
        strings = [s for s in strings if query.lower() in s["string"].lower()]

    # 尝试关联引用函数
    for s in strings[:200]:
        try:
            addr = int(s["address"], 16)
            for func in cfg.functions.values():
                for site, target in func.get_call_sites():
                    pass
                for block in func.blocks:
                    if block.addr <= addr < block.addr + block.size:
                        s["referenced_by"] = func.name
                        break
        except:
            pass

    result = {
        "total": len(strings),
        "strings": strings[:200],
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
