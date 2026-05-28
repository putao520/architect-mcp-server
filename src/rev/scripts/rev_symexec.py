#!/usr/bin/env python3
"""rev_symexec — 符号执行探索路径"""
import json, sys
import angr

def main():
    params = json.loads(sys.argv[1])
    filepath = params["file"]
    find_addr_str = params["find"]
    avoid_addrs_str = params.get("avoid", "")
    max_steps = params.get("maxSteps", 1000)

    project = angr.Project(filepath, auto_load_libs=False)
    cfg = project.analyses.CFGFast()

    try:
        find_addr = int(find_addr_str, 16) if isinstance(find_addr_str, str) else find_addr_str
    except:
        print(json.dumps({"error": f"Invalid find address: {find_addr_str}"}))
        return

    avoid_addrs = []
    if avoid_addrs_str:
        for a in avoid_addrs_str.split(","):
            a = a.strip()
            if a:
                try:
                    avoid_addrs.append(int(a, 16) if a.startswith("0x") else int(a))
                except:
                    pass

    # 创建初始状态
    state = project.factory.entry_state()
    simgr = project.factory.simulation_manager(state)

    # 执行符号执行
    try:
        simgr.explore(find=find_addr, avoid=avoid_addrs if avoid_addrs else None, n=max_steps)

        found = simgr.found
        result = {
            "find_address": hex(find_addr),
            "avoid_addresses": [hex(a) for a in avoid_addrs],
            "reachable": len(found) > 0,
            "active_states": len(simgr.active),
            "deadended_states": len(simgr.deadended),
            "found_states": len(found),
            "avoided_states": len(simgr.avoid) if simgr.avoid else 0,
            "errored_states": len(simgr.errored) if simgr.errored else 0,
        }

        if found:
            # 提取触发输入
            found_state = found[0]
            try:
                stdin_content = found_state.posix.dumps(0)
                result["trigger_stdin"] = stdin_content.hex() if stdin_content else None
                result["trigger_stdin_ascii"] = stdin_content.decode("ascii", errors="replace") if stdin_content else None
            except:
                result["trigger_stdin"] = None

            try:
                stdout_content = found_state.posix.dumps(1)
                result["trigger_stdout"] = stdout_content.decode("ascii", errors="replace") if stdout_content else None
            except:
                result["trigger_stdout"] = None

            # 路径描述
            try:
                path_addrs = [hex(h.addr) for h in found_state.history]
                result["path_length"] = len(path_addrs)
                result["path"] = path_addrs[:50]
            except:
                result["path_length"] = None

    except Exception as e:
        result = {
            "find_address": hex(find_addr),
            "reachable": False,
            "error": str(e)[:500],
        }

    print(json.dumps(result))

if __name__ == "__main__":
    main()
