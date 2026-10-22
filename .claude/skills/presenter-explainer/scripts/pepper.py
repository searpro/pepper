"""Pepper from Python, through pepper_call.mjs (for when the MCP tools are down).

  from pepper import submit, jobs                 # submit('generate_image', model=…, …) -> [job ids]
  python3 pepper.py wait JOBS.json S01 S02        # blocks until those jobs finish, one line each
  python3 pepper.py fetch JOBS.json OUTDIR        # waits for every job in the file, downloads KEY[_n].ext

JOBS.json maps names to a job id, or to a list of ids (count > 1). A tool's result
can hold several text parts (the job, then a "next" hint), so every JSON value in
it is parsed and the ones with an id are kept. Downloads use curl (the python.org
build on this Mac has no CA bundle for urllib).
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def call(tool, **args):
    out = subprocess.run(['node', f'{HERE}/pepper_call.mjs', tool, json.dumps(args)], capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr + out.stdout)
    objs, s, dec, i = [], out.stdout, json.JSONDecoder(), 0
    while i < len(s):
        if s[i] in '{[':
            o, i = dec.raw_decode(s, i)
            objs.append(o)
        else:
            i += 1
    return objs


def _jobs_in(objs):
    found = []
    for o in objs:
        if isinstance(o, dict) and 'jobs' in o:
            found += o['jobs']
        elif isinstance(o, dict) and 'id' in o:
            found.append(o)
    return found


def submit(tool, **args):
    return [j['id'] for j in _jobs_in(call(tool, wait_seconds=0, **args))]


def jobs(ids, wait=0):
    return _jobs_in(call('get_job', ids=ids, wait_seconds=wait))


def _flat(path):
    flat = {}
    for k, v in json.load(open(path)).items():
        if isinstance(v, list):
            for n, j in enumerate(v, 1):
                flat[f'{k}_{n}'] = j
        else:
            flat[k] = v
    return flat


def wait(path, names, outdir=None):
    flat = _flat(path)
    todo = {k: flat[k] for k in (names or flat)}
    t0 = time.time()
    while todo:
        for j in jobs(list(todo.values())[:20], wait=45):
            name = next((k for k, v in todo.items() if v == j['id']), None)
            if not name or j['status'] not in ('completed', 'failed', 'cancelled'):
                continue
            del todo[name]
            if j['status'] == 'completed' and outdir:
                os.makedirs(outdir, exist_ok=True)
                ext = os.path.splitext(j['output_name'])[1]
                subprocess.run(['curl', '-sf', '-o', f'{outdir}/{name}{ext}', j['download_url']], check=True)
            print(f"{name} {j['status']} after {(time.time() - t0) / 60:.1f} min", j.get('output_name') or j.get('error', ''), flush=True)


if __name__ == '__main__':
    cmd, path, *rest = sys.argv[1:]
    if cmd == 'wait':
        wait(path, rest)
    elif cmd == 'fetch':
        wait(path, None, rest[0])
    else:
        sys.exit(__doc__)
