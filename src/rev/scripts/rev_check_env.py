#!/usr/bin/env python3
"""rev_check_env — 环境检测"""
import json, sys, importlib, subprocess

def main():
    result = {"python": sys.version, "tools": {}}

    # angr
    try:
        angr = importlib.import_module("angr")
        result["tools"]["angr"] = {
            "available": True,
            "version": angr.__version__,
        }
    except ImportError:
        result["tools"]["angr"] = {"available": False, "install": "pip install angr"}

    # cle (binary loader)
    try:
        cle = importlib.import_module("cle")
        result["tools"]["cle"] = {"available": True, "version": cle.__version__}
    except ImportError:
        result["tools"]["cle"] = {"available": False}

    # pyvex (VEX IR)
    try:
        pyvex = importlib.import_module("pyvex")
        result["tools"]["pyvex"] = {"available": True, "version": pyvex.__version__}
    except ImportError:
        result["tools"]["pyvex"] = {"available": False}

    all_ok = all(t.get("available") for t in result["tools"].values())
    result["ready"] = all_ok

    if not all_ok:
        result["install_command"] = "pip install angr"

    print(json.dumps(result))

if __name__ == "__main__":
    main()
