#!/usr/bin/env python3
"""rev_cfg — 控制流图分析"""
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

    # 提取基本块和边
    blocks = []
    edges = []
    block_addrs = set()

    for block in func.blocks:
        block_addrs.add(block.addr)
        blocks.append({
            "address": hex(block.addr),
            "size": block.size,
            "instructions": block.instructions if hasattr(block, "instructions") else None,
        })

    # 从 CFG 中提取函数内的边
    for node in cfg.graph.nodes():
        if node.function_address != func.addr:
            continue
        if node.addr not in block_addrs:
            continue
        for src, dst, data in cfg.graph.out_edges(node, data=True):
            if dst.addr in block_addrs:
                edge_type = "fallthrough"
                if isinstance(data, dict):
                    jt = data.get("jump_type")
                    if jt == "Call":
                        edge_type = "call"
                    elif jt == "Return":
                        edge_type = "return"
                    elif jt in ("True", "False"):
                        edge_type = f"conditional_{jt.lower()}"
                    elif jt == "Unconditional":
                        edge_type = "unconditional"
                    elif jt:
                        edge_type = jt
                edges.append({
                    "from": hex(src.addr),
                    "to": hex(dst.addr),
                    "type": edge_type,
                })

    # 生成 Mermaid CFG
    mermaid_lines = ["graph TD"]
    addr_to_id = {}
    for i, block in enumerate(blocks):
        node_id = f"B{i}"
        addr_to_id[block["address"]] = node_id
        label = f"{block['address']}\\n{block['size']}B"
        mermaid_lines.append(f"    {node_id}[\"{label}\"]")

    for edge in edges:
        src_id = addr_to_id.get(edge["from"], "unknown")
        dst_id = addr_to_id.get(edge["to"], "unknown")
        if src_id != "unknown" and dst_id != "unknown":
            style = "-->"
            if "conditional_true" in edge["type"]:
                style = "--T-->"
            elif "conditional_false" in edge["type"]:
                style = "--F-->"
            elif edge["type"] == "call":
                style = "==call==>"
            mermaid_lines.append(f"    {src_id} {style} {dst_id}")

    result = {
        "function": func.name,
        "address": hex(func.addr),
        "blocks_count": len(blocks),
        "edges_count": len(edges),
        "blocks": blocks,
        "edges": edges,
        "mermaid_cfg": "\n".join(mermaid_lines),
    }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
