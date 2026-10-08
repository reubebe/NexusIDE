"""Fetch pinned source snapshots for review/import. Never executes fetched code."""
import json, pathlib, subprocess, urllib.request, concurrent.futures
selections = {
 'k-dense-ai/scientific-agent-skills': ['skills/statistical-analysis/', 'skills/literature-review/', 'skills/peer-review/'],
 'mukul975/anthropic-cybersecurity-skills': ['skills/detecting-indirect-prompt-injection/'],
 'cathrynlavery/diagram-design': ['skills/diagram-design/'],
}
def api(route):
 return json.loads(subprocess.check_output(['gh','api',route],text=True))
for repo,prefixes in selections.items():
 sha=api('repos/'+repo+'/commits/HEAD')['sha']
 tree=api('repos/'+repo+'/git/trees/'+sha+'?recursive=1')['tree']
 entries=[x for x in tree if x['type']=='blob' and any(x['path'].startswith(p) for p in prefixes)]
 root=pathlib.Path('.research/selected-skills')/repo.split('/')[-1]
 root.mkdir(parents=True,exist_ok=True)
 def fetch(entry):
  if entry.get('size',0)>2000000: return
  p=entry['path']; dest=root/p; dest.parent.mkdir(parents=True,exist_ok=True)
  dest.write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/{repo}/{sha}/{p}',timeout=30).read())
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: list(pool.map(fetch,entries))
 for name in ['LICENSE','LICENSE.md','NOTICE']:
  try: (root/name).write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/{repo}/{sha}/{name}',timeout=15).read())
  except Exception: pass
 (root/'provenance.json').write_text(json.dumps({'repository':'https://github.com/'+repo,'commit':sha,'selected':prefixes},indent=2))
 print(repo,sha,len(entries),'resources fetched')
