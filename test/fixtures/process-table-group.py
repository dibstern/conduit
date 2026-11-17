import json
import os
import signal
import sys
import time

# Keep a zombie until the leader exits, and leave the other children alive.
children = {}
for role in ["ignoresTerm", "zombie", "escapee"]:
    ready_r, ready_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(ready_r)
        if role == "escapee":
            os.setsid()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.write(ready_w, b"ready")
        os.close(ready_w)
        if role == "zombie":
            os._exit(0)
        while True:
            time.sleep(1)
    os.close(ready_w)
    os.read(ready_r, 5)
    os.close(ready_r)
    children[role] = pid

# Report ready only once the zombie has exited; WNOWAIT leaves it unreaped.
os.waitid(os.P_PID, children["zombie"], os.WEXITED | os.WNOWAIT)
print(json.dumps({"leader": os.getpid(), **children}), flush=True)
sys.stdin.readline()
os.waitpid(children["zombie"], 0)
