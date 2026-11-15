# Static-analysis fixtures only. Never imported or executed.
import json
import pickle
import requests
import subprocess

# ruleid: python-dynamic-code
eval(untrusted)
# ruleid: python-unsafe-deserialization
pickle.loads(untrusted)
# ruleid: python-shell-command
subprocess.run(untrusted, shell=True)
# ruleid: python-disabled-tls
requests.get(url, verify=False)
# ok: python-unsafe-deserialization
json.loads(untrusted)
# ok: python-shell-command
subprocess.run(["tool", untrusted], check=True)
# ok: python-disabled-tls
requests.get(url, verify=True)
