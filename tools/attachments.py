#!/usr/bin/env python3
"""Build the Gmail inline-attachment list for poster thumbnails.

Usage (from anywhere):
    python3 -I /tmp/cinema-data/tools/attachments.py data/posters/aaa.jpg data/posters/bbb.jpg ...

Pass the films' "posterThumb" values in the order the posters should be attached.
Prints JSON:
    {"attachments": [...], "cid": {"data/posters/aaa.jpg": "cid:att0", ...}, "missing": [...]}

Pass "attachments" unchanged as send_message's attachments parameter (each entry is a
file reference "sha256:<hex>:<absolute path>", so no base64 has to be copied), and use
the "cid" values as <img src="..."> for the matching films. Duplicates are attached once.
Files listed under "missing" get the grey placeholder instead.
"""
import hashlib
import json
import os
import sys

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
attachments, cid, missing = [], {}, []
for rel in sys.argv[1:]:
    if rel in cid:
        continue
    path = os.path.join(repo, rel)
    if not os.path.isfile(path):
        missing.append(rel)
        continue
    with open(path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    cid[rel] = f"cid:att{len(attachments)}"
    attachments.append({
        "content": f"sha256:{digest}:{path}",
        "filename": os.path.basename(path),
        "mimeType": "image/jpeg",
        "inline": True,
    })
print(json.dumps({"attachments": attachments, "cid": cid, "missing": missing}, indent=1))
