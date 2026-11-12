#!/usr/bin/python3
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

root = Path(os.environ["REPO_PICKER_FIXTURE"])
args = sys.argv[1:]
if args[:2] == ["repo", "clone"]:
    assert len(args) == 4 and args[2].startswith("acme/"), args
    with (root / "gh.jsonl").open("a") as log:
        log.write(json.dumps({"clone": args[2]}) + "\n")
    sys.exit(subprocess.run(["/usr/bin/git", "clone", "-q", str(root / "origin.git"), args[3]]).returncode)
if args[:4] == ["api", "--hostname", "github.com", "user"]:
    print(json.dumps({"login": "tester"}))
    sys.exit(0)
if args[:4] == ["api", "--hostname", "github.com", "user/orgs"]:
    print("acme")
    sys.exit(0)
if args[:2] == ["api", "user"]:
    print("tester" if "--jq" in args else json.dumps({"login": "tester"}))
    sys.exit(0)
assert "--paginate" not in args, "the picker must not fetch every page"
assert args[0] == "api", args


def repo(owner, number):
    name = f"repo-{number:05}" if isinstance(number, int) else number
    return {
        "name": name,
        "full_name": f"{owner}/{name}",
        "private": True,
        "owner": {"type": "Organization"},
        "default_branch": "main",
        "description": f"Repository {name}",
        "pushed_at": "2026-11-01T00:00:00Z",
    }


if args[1] == "graphql":
    fields = dict(arg.split("=", 1) for arg in args[2:] if "=" in arg)
    assert "first: 50" in fields["query"], fields
    assert "isArchived: false" in fields["query"], fields
    request = {key: value for key, value in fields.items() if key != "query"}
    response = {"data": {}}
    if fields["mainEnabled"] == "true":
        offset = int(fields.get("mainCursor", "0"))
        nodes = [repo(fields["owner"], n) for n in range(offset + 1, min(offset + 51, 20001))]
        for node in nodes:
            node["default_branch"] = {"name": "main"}
        response["data"]["repositoryOwner"] = {
            "repositories": {
                "nodes": nodes,
                "pageInfo": {"hasNextPage": offset + 50 < 20000, "endCursor": str(offset + 50)},
            }
        }
    if fields["accountEnabled"] == "true":
        nodes = [repo(fields["owner"] or "acme", n) for n in range(1, 50)] + [repo("friend", "notes")]
        for node in nodes:
            node["default_branch"] = {"name": "main"}
        response["data"]["viewer"] = {
            "repositories": {"nodes": nodes, "pageInfo": {"hasNextPage": False, "endCursor": "account-end"}}
        }
else:
    endpoint = urlsplit(args[1])
    assert endpoint.path == "search/repositories", args
    params = parse_qs(endpoint.query)
    assert params["per_page"] == ["50"], params
    assert "user:acme" in params["q"][0], params
    assert "archived:false" in params["q"][0], params
    assert "fork:true" in params["q"][0], params
    assert '"repo-19999"' in params["q"][0], params
    request = {"search": params["q"][0], "page": params["page"][0]}
    response = {"items": [repo("acme", 19999)], "total_count": 1, "incomplete_results": False}

with (root / "gh.jsonl").open("a") as log:
    log.write(json.dumps(request) + "\n")
if (root / "fail").exists():
    print("GitHub rate limit exceeded: try again later", file=sys.stderr)
    sys.exit(1)
print(json.dumps(response))
