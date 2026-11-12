import { expect, spyOn, test } from "bun:test";
import type { GithubStatus, RepoInfo, ReposListResult, ReposPageParams, ReposPageResult } from "@chauffeur/protocol";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";

function repo(name: string, isDefault = false): RepoInfo {
  return {
    key: name, name, full_name: `acme/${name}`, owner: "acme", owner_is_org: true,
    private: true, local: false, clone_path: null, default_branch: "main", description: null,
    pushed_at: null, last_used: null, is_default: isDefault,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const page = (repos: RepoInfo[], next?: string): ReposPageResult => ({
  repos, next_cursor: next, truncated: false, refreshed_at: "2026-11-12T12:00:00Z",
});

test("new workspace uses cached defaults, loads only requested pages and keeps selections through search races and retries", async () => {
  if (process.env.REPO_PICKER_ISOLATED !== "1") {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, REPO_PICKER_ISOLATED: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) throw new Error(`${stdout}\n${stderr}`);
    return;
  }
  const browser = new Window();
  const globals = {
    window: browser, document: browser.document, localStorage: browser.localStorage,
    navigator: browser.navigator, HTMLElement: browser.HTMLElement, Node: browser.Node, Event: browser.Event,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { CreateWorkspaceDialog } = await import("./CreateWorkspaceDialog");
  const { client, loadAllRepos, loadRepos, useApp } = await import("@/state/app");
  const before = useApp.getState();
  useApp.setState({ repos: null, reposError: null, reposRevision: 0, reposSync: { refreshedAt: null, githubError: null }, createOpen: true, createRetry: null, models: [], loadout: [] });
  const cached = deferred<ReposListResult>();
  const first = deferred<ReposPageResult>();
  const oldSearch = deferred<ReposPageResult>();
  const recent = Array.from({ length: 50 }, (_, index) => repo(`repo-${String(index + 1).padStart(5, "0")}`));
  const calls: string[] = [];
  const pages: ReposPageParams[] = [];
  let fail = false;
  const rpc = spyOn(client, "call").mockImplementation(async (method, params) => {
    calls.push(method);
    if (method === "repos.cached") return cached.promise;
    if (method === "repos.list") return { repos: [repo("new-default", true), repo("default-outside-page")] };
    if (method === "settings.get") return { workspaces: { github_org: "acme", branch_prefix: "test", github_login: "tester" }, linear: { enabled: false, start_tickets: false } };
    if (method === "github.status") return {
      git: true, git_install: "xcode", gh: "/fake/gh", own: false, version: "test", download_size: null,
      account: "tester", organizations: ["acme"], organization: "acme", connecting: null,
    } satisfies GithubStatus;
    if (method === "repos.page" && "query" in params && "refresh" in params) {
      pages.push(params);
      if (fail) return { ...page([]), github_error: "GitHub rate limit exceeded" };
      if (params.query === "repo-19999") return oldSearch.promise;
      if (params.query === "repo-18000") return page([repo("repo-18000")]);
      if (params.cursor === "next") return page([repo("repo-00051")]);
      return first.promise;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`UI did not reach the expected state: ${document.body.textContent}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
  };
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) throw new Error(`Missing button: ${selector}`);
    await act(async () => { button.click(); });
  };
  const type = async (text: string) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="repo-filter"]');
    if (!input) throw new Error("Missing repo search");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  try {
    const startup = loadRepos();
    await act(async () => { root.render(<StrictMode><CreateWorkspaceDialog /></StrictMode>); });
    expect(calls.filter((method) => method === "repos.cached")).toHaveLength(1);
    expect(calls).not.toContain("repos.list");
    await act(async () => {
      cached.resolve({ repos: [repo("default-outside-page", true)] });
      await startup;
    });
    expect(document.querySelector<HTMLButtonElement>('[data-testid="create-workspace"]')?.disabled).toBe(false);
    expect(pages).toHaveLength(0);

    await click('[data-testid="add-repo"]');
    await until(() => pages.length === 1);
    expect(document.querySelector('[data-repo="default-outside-page"]')?.getAttribute("aria-selected")).toBe("true");
    await act(async () => { first.resolve(page(recent, "next")); });
    await until(() => !!document.querySelector('[data-testid="repos-load-more"]'));
    expect(pages).toHaveLength(1);
    await click('[data-testid="repos-load-more"]');
    await until(() => !!document.querySelector('[data-repo="repo-00051"]'));
    expect(pages).toHaveLength(2);
    expect(pages[1].cursor).toBe("next");
    expect(document.querySelector('[data-repo="default-outside-page"]')?.getAttribute("aria-selected")).toBe("true");

    await click('[data-owner="acme"]');
    await until(() => pages.some((params) => params.owner === "acme"));
    await type("repo-1");
    await type("repo-19999");
    await until(() => pages.some((params) => params.query === "repo-19999"));
    expect(pages.some((params) => params.query === "repo-1")).toBe(false);
    await type("repo-18000");
    await until(() => !!document.querySelector('[data-repo="repo-18000"]'));
    await act(async () => { oldSearch.resolve(page([repo("repo-19999")])); });
    expect(document.querySelector('[data-repo="repo-19999"]')).toBeNull();
    expect(useApp.getState().repos?.some((entry) => entry.key === "repo-19999")).toBe(false);

    fail = true;
    await click('button[aria-label="Refresh from GitHub"]');
    await until(() => !!document.querySelector('[data-testid="repos-github-error"]'));
    expect(document.querySelector('[data-repo="repo-18000"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="create-workspace"]')?.closest('[role="dialog"]')?.textContent).toContain("default-outside-page");
    fail = false;
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Retry");
    if (!retry) throw new Error("Missing Retry");
    await act(async () => { retry.click(); });
    await until(() => !document.querySelector('[data-testid="repos-github-error"]'));
    expect(pages.at(-1)?.refresh).toBe(true);

    await click('[data-repo="repo-18000"]');
    await until(() => document.querySelector('[data-testid="repo-filter"]')?.getAttribute("value") === "");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("default-outside-page");
    expect(dialog?.textContent).toContain("repo-18000");
    await click('[data-owner="All"]');
    await type("not-loaded");
    expect(document.querySelector('[data-testid="repos-search-scope"]')?.textContent).toContain("Choose an owner");
    expect(pages.some((params) => params.query === "not-loaded")).toBe(false);
    expect(calls).not.toContain("repos.list");

    await act(async () => {
      useApp.setState({ createOpen: false });
      await loadAllRepos();
    });
    expect(useApp.getState().repos?.map((entry) => entry.key)).toEqual(["new-default", "default-outside-page"]);
    expect(useApp.getState().repos?.filter((entry) => entry.is_default).map((entry) => entry.key)).toEqual(["new-default"]);
    await act(async () => { useApp.setState({ createOpen: true }); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("new-default");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("default-outside-page");
  } finally {
    await act(async () => { root.unmount(); });
    rpc.mockRestore();
    useApp.setState(before, true);
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15_000);
