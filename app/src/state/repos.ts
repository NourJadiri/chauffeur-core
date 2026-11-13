import { useCallback, useEffect } from "react";
import { loadAllRepos, loadRepos, useApp } from "./app";

export function useRepoCatalog(mode: "cached" | "all" = "cached", enabled = true) {
  const repos = useApp((state) => state.repos);
  const error = useApp((state) => state.reposError);
  const revision = useApp((state) => state.reposRevision);
  const sources = useApp((state) => state.reposSources);
  const sync = useApp((state) => state.reposSync);
  const load = mode === "all" ? loadAllRepos : loadRepos;
  const shouldLoad = enabled && (mode === "all" || repos === null);
  useEffect(() => {
    if (shouldLoad) void load();
  }, [shouldLoad, load]);
  const refresh = useCallback(() => load(true), [load]);
  return { repos, error, revision, sources, sync, refresh };
}
