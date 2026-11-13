import { expect, spyOn } from "bun:test";
import type { ReposListResult } from "@chauffeur/protocol";
import { act } from "react";
import { deferred, domTest } from "@/test/dom";
import { repo } from "@/test/repos";

domTest("cached repo reads share a request and preserve newer page metadata", import.meta.path, async () => {
  const { client, loadRepos, rememberRepos, useApp } = await import("./app");
  const response = deferred<ReposListResult>();
  const rpc = spyOn(client, "call").mockImplementation(async () => response.promise);
  try {
    const first = loadRepos();
    expect(loadRepos()).toBe(first);
    rememberRepos([{ ...repo("shared"), description: "Fresh page metadata" }]);
    response.resolve({ repos: [repo("default", true), repo("shared")], github_sources: false, refreshed_at: "2026-11-13T12:00:00Z" });
    await first;
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]).toEqual(["repos.cached", { refresh: false }]);
    expect(useApp.getState().repos?.map((entry) => entry.key)).toEqual(["default", "shared"]);
    expect(useApp.getState().repos?.[1].description).toBe("Fresh page metadata");
    expect(useApp.getState()).toMatchObject({
      reposSources: false,
      reposRevision: 0,
      reposError: null,
      reposSync: { refreshedAt: "2026-11-13T12:00:00Z", githubError: null },
    });
  } finally {
    rpc.mockRestore();
  }
});

domTest("a refreshed repo catalog ignores old replies and keeps its data after a failed read", import.meta.path, async () => {
  const { client, loadRepos, useApp } = await import("./app");
  const old = deferred<ReposListResult>();
  const fresh = deferred<ReposListResult>();
  let count = 0;
  const rpc = spyOn(client, "call").mockImplementation(async () => {
    count += 1;
    if (count === 1) return old.promise;
    if (count === 2) return fresh.promise;
    throw new Error("Repo catalog unavailable");
  });
  try {
    const stale = loadRepos();
    const latest = loadRepos(true);
    fresh.resolve({ repos: [repo("fresh")] });
    await latest;
    old.resolve({ repos: [repo("old")] });
    await stale;
    expect(useApp.getState().repos?.map((entry) => entry.key)).toEqual(["fresh"]);
    expect(useApp.getState().reposRevision).toBe(1);
    await loadRepos(true);
    expect(useApp.getState().reposError).toBe("Repo catalog unavailable");
    expect(useApp.getState().repos?.map((entry) => entry.key)).toEqual(["fresh"]);
  } finally {
    rpc.mockRestore();
  }
});

domTest("the catalog hook loads the full list only when explicitly enabled and never loops on its replies", import.meta.path, async ({ render, until }) => {
  const { client, rememberRepos } = await import("./app");
  const { useRepoCatalog } = await import("./repos");
  rememberRepos([repo("partial")]);
  const rpc = spyOn(client, "call").mockImplementation(async () => ({ repos: [repo("full", true)] }));
  let catalog!: ReturnType<typeof useRepoCatalog>;
  function Probe({ mode, enabled = true }: { mode: "cached" | "all"; enabled?: boolean }) {
    catalog = useRepoCatalog(mode, enabled);
    return <output>{catalog.repos?.map((entry) => entry.key).join(",")}</output>;
  }
  try {
    await render(<Probe mode="cached" />);
    expect(rpc).not.toHaveBeenCalled();
    await render(<Probe mode="all" enabled={false} />);
    expect(rpc).not.toHaveBeenCalled();
    await render(<Probe mode="all" />);
    await until(() => document.querySelector("output")?.textContent === "full");
    expect(rpc.mock.calls).toEqual([["repos.list", { refresh: false }]]);
    await render(<Probe mode="all" />);
    expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => { await catalog.refresh(); });
    expect(rpc.mock.calls[1]).toEqual(["repos.list", { refresh: true }]);
    await render(null);
  } finally {
    rpc.mockRestore();
  }
});
