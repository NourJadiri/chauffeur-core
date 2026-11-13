import type { RepoInfo, ReposPageResult } from "@chauffeur/protocol";

export function repo(name: string, isDefault = false): RepoInfo {
  return {
    key: name, name, full_name: `acme/${name}`, owner: "acme", owner_is_org: true,
    private: true, local: false, clone_path: null, default_branch: "main", description: null,
    pushed_at: null, last_used: null, is_default: isDefault,
  };
}

export function repoPage(repos: RepoInfo[], next?: string): ReposPageResult {
  return { repos, next_cursor: next, truncated: false, refreshed_at: "2026-11-12T12:00:00Z" };
}
