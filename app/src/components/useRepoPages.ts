import { useEffect, useRef, useState } from "react";
import type { RepoInfo } from "@chauffeur/protocol";
import { mergeRepos } from "@/lib/repoPicker";
import { errorMessage } from "@/lib/rpc";
import { client, useApp } from "@/state/app";

type PageState = {
  repos: RepoInfo[];
  loading: boolean;
  nextCursor: string | null;
  error: string | null;
  refreshedAt: string | null;
  truncated: boolean;
};

const EMPTY: PageState = { repos: [], loading: false, nextCursor: null, error: null, refreshedAt: null, truncated: false };

export function useRepoPages(owner: string, query: string, source: string, enabled: boolean) {
  const revision = useApp((state) => state.reposRevision);
  const [state, setState] = useState<PageState>(EMPTY);
  const actions = useRef({ more: () => {}, refresh: () => {}, retry: () => {} });

  useEffect(() => {
    let live = true;
    let loading = false;
    let nextCursor: string | null = null;
    let attempted: string | null = null;
    setState({ ...EMPTY, loading: enabled });

    const load = async (cursor: string | null, refresh = false) => {
      if (!live || loading || !enabled) return;
      loading = true;
      attempted = cursor;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const result = await client.call("repos.page", { owner: owner || undefined, query, cursor: cursor ?? undefined, refresh });
        if (!live) return;
        if (result.github_error) {
          setState((current) => ({ ...current, error: result.github_error ?? null }));
          return;
        }
        nextCursor = result.next_cursor ?? null;
        useApp.setState((current) => ({ repos: mergeRepos(current.repos ?? [], result.repos) }));
        setState((current) => ({
          repos: cursor ? mergeRepos(current.repos, result.repos) : result.repos,
          loading: true,
          nextCursor,
          error: null,
          refreshedAt: result.refreshed_at ?? null,
          truncated: result.truncated,
        }));
      } catch (error) {
        if (live) setState((current) => ({ ...current, error: errorMessage(error) }));
      } finally {
        loading = false;
        if (live) setState((current) => ({ ...current, loading: false }));
      }
    };

    const timer = setTimeout(() => { void load(null); }, query ? 250 : 0);
    actions.current = {
      more: () => { if (nextCursor) void load(nextCursor); },
      refresh: () => { clearTimeout(timer); void load(null, true); },
      retry: () => { clearTimeout(timer); void load(attempted, true); },
    };
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [owner, query, source, enabled, revision]);

  return {
    ...state,
    loadMore: () => actions.current.more(),
    refresh: () => actions.current.refresh(),
    retry: () => actions.current.retry(),
  };
}
