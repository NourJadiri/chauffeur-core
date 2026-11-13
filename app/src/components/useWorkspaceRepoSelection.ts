import { useEffect, useState } from "react";
import { type RepoChoice, toggledRepo, withoutTicketRepos, withTicketRepos } from "@/lib/newWorkspace";
import { useRepoCatalog } from "@/state/repos";

type InitialChoice = { selection: string[] | null; sources: Record<string, string> };

export function useWorkspaceRepoSelection(initial: InitialChoice) {
  const { repos, error } = useRepoCatalog();
  const [choice, setChoice] = useState(initial);
  const pending = choice.selection === null;
  useEffect(() => {
    if (!pending || (!repos && !error)) return;
    setChoice((current) => current.selection === null
      ? { ...current, selection: repos?.filter((repo) => repo.is_default).map((repo) => repo.key) ?? [] }
      : current);
  }, [pending, repos, error]);
  const update = (change: (current: RepoChoice) => RepoChoice) => {
    setChoice((current) => change({ selection: current.selection ?? [], sources: current.sources }));
  };
  const selection = choice.selection ?? [];
  return {
    repos,
    selection,
    sources: choice.sources,
    pending,
    empty: !pending && selection.length === 0,
    toggle: (repo: string) => update((current) => toggledRepo(current, repo)),
    addTicket: (ticket: string, added: string[]) => update((current) => withTicketRepos(current, ticket, added)),
    removeTicket: (ticket: string) => update((current) => withoutTicketRepos(current, ticket)),
    clear: () => setChoice({ selection: [], sources: {} }),
  };
}
