import { expect, spyOn } from "bun:test";
import type { ReposListResult } from "@chauffeur/protocol";
import { act } from "react";
import { deferred, domTest } from "@/test/dom";
import { repo } from "@/test/repos";

domTest("workspace repo defaults are applied once and never undo an explicit empty choice", import.meta.path, async ({ render, until }) => {
  const { client, rememberRepos } = await import("@/state/app");
  const { useWorkspaceRepoSelection } = await import("./useWorkspaceRepoSelection");
  const response = deferred<ReposListResult>();
  const rpc = spyOn(client, "call").mockImplementation(async () => response.promise);
  let choice!: ReturnType<typeof useWorkspaceRepoSelection>;
  function Probe() {
    choice = useWorkspaceRepoSelection({ selection: null, sources: {} });
    return <output>{choice.pending ? "pending" : choice.selection.join(",")}</output>;
  }
  try {
    await render(<Probe />);
    expect(choice.pending).toBe(true);
    await act(async () => { response.resolve({ repos: [repo("default", true), repo("other")] }); });
    await until(() => !choice.pending);
    expect(choice.selection).toEqual(["default"]);
    await act(async () => { choice.clear(); });
    await act(async () => { rememberRepos([repo("later-default", true)]); });
    expect(choice).toMatchObject({ selection: [], sources: {}, pending: false, empty: true });
    await render(null);
  } finally {
    rpc.mockRestore();
  }
});

domTest("manual repo choices made during loading survive late defaults", import.meta.path, async ({ render, until }) => {
  const { client } = await import("@/state/app");
  const { useWorkspaceRepoSelection } = await import("./useWorkspaceRepoSelection");
  const response = deferred<ReposListResult>();
  const rpc = spyOn(client, "call").mockImplementation(async () => response.promise);
  let choice!: ReturnType<typeof useWorkspaceRepoSelection>;
  function Probe() {
    choice = useWorkspaceRepoSelection({ selection: null, sources: {} });
    return <output>{choice.selection.join(",")}</output>;
  }
  try {
    await render(<Probe />);
    await act(async () => { choice.toggle("manual"); });
    await act(async () => { response.resolve({ repos: [repo("default", true)] }); });
    await until(() => choice.repos !== null);
    expect(choice).toMatchObject({ selection: ["manual"], pending: false });
    await render(null);
  } finally {
    rpc.mockRestore();
  }
});

domTest("restored repo choices keep ticket ownership until the user takes over a repo", import.meta.path, async ({ render }) => {
  const { rememberRepos } = await import("@/state/app");
  const { useWorkspaceRepoSelection } = await import("./useWorkspaceRepoSelection");
  rememberRepos([repo("default", true)]);
  let choice!: ReturnType<typeof useWorkspaceRepoSelection>;
  function Probe() {
    choice = useWorkspaceRepoSelection({ selection: ["inherited"], sources: {} });
    return <output>{choice.selection.join(",")}</output>;
  }
  await render(<Probe />);
  expect(choice.selection).toEqual(["inherited"]);
  await act(async () => { choice.addTicket("T-1", ["inherited", "ticket-only", "shared"]); });
  expect(choice.sources).toEqual({ "ticket-only": "T-1", shared: "T-1" });
  await act(async () => { choice.toggle("ticket-only"); });
  await act(async () => { choice.toggle("ticket-only"); });
  await act(async () => { choice.removeTicket("T-1"); });
  expect(choice.selection).toEqual(["inherited", "ticket-only"]);
  expect(choice.sources).toEqual({});
});

domTest("a failed initial catalog settles the workspace repo choice without waiting forever", import.meta.path, async ({ render, until }) => {
  const { client } = await import("@/state/app");
  const { useWorkspaceRepoSelection } = await import("./useWorkspaceRepoSelection");
  const rpc = spyOn(client, "call").mockImplementation(async () => { throw new Error("Catalog offline"); });
  let choice!: ReturnType<typeof useWorkspaceRepoSelection>;
  function Probe() {
    choice = useWorkspaceRepoSelection({ selection: null, sources: {} });
    return <output>{choice.pending ? "pending" : "ready"}</output>;
  }
  try {
    await render(<Probe />);
    await until(() => !choice.pending);
    expect(choice).toMatchObject({ selection: [], empty: true });
    expect(rpc.mock.calls).toEqual([["repos.cached", { refresh: false }]]);
    await render(null);
  } finally {
    rpc.mockRestore();
  }
});
