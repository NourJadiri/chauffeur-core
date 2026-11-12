use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use chauffeur_protocol::client::{ClientCall, ReposListResult, ReposPageResult};
use chauffeur_protocol::model::{WorkspaceInfo, WorkspaceState};
use chauffeurd::{Daemon, paths::Paths, rpc};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

struct Fixture {
    root: tempfile::TempDir,
    daemon: Arc<Daemon>,
}

impl Fixture {
    fn new(sources: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        let clones = root.path().join("clones");
        std::fs::create_dir_all(clones.join("local-notes/.git")).unwrap();
        std::fs::write(
            home.join("settings.toml"),
            format!(
                "github_org = \"acme\"\ngithub_sources = {sources}\ndefault_repos = [\"repo-00001\"]\nbranch_prefix = \"test\"\nclone_roots = [{}]\nlinear_enabled = false\n",
                serde_json::to_string(&clones).unwrap(),
            ),
        )
        .unwrap();
        let gh = bin.join("gh");
        std::fs::write(&gh, include_str!("fixtures/repo-picker-gh.py")).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let daemon = Daemon::open(Paths::new(
            home,
            root.path().join("workspaces"),
            root.path().join("repos"),
        ))
        .unwrap();
        daemon.shell_env.set_vars(BTreeMap::from([
            ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
            (
                "REPO_PICKER_FIXTURE".into(),
                root.path().to_string_lossy().into(),
            ),
            ("GIT_AUTHOR_NAME".into(), "test".into()),
            ("GIT_AUTHOR_EMAIL".into(), "test@example.com".into()),
            ("GIT_COMMITTER_NAME".into(), "test".into()),
            ("GIT_COMMITTER_EMAIL".into(), "test@example.com".into()),
        ]));
        Self { root, daemon }
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> T {
        let call: ClientCall =
            serde_json::from_value(json!({ "method": method, "params": params })).unwrap();
        let result = rpc::handle(&self.daemon, call).await.unwrap();
        serde_json::from_value(result).unwrap()
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("gh.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn make_origin(&self) -> PathBuf {
        let seed = self.root.path().join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        std::fs::write(seed.join("README.md"), "the repo outside the first page\n").unwrap();
        git(&seed, &["add", "README.md"]);
        git(
            &seed,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
        );
        let origin = self.root.path().join("origin.git");
        git(
            self.root.path(),
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                origin.to_str().unwrap(),
            ],
        );
        origin
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.daemon.shutdown.cancel();
    }
}

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_AUTHOR_NAME", "test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn a_twenty_thousand_repo_organization_is_browsed_one_page_at_a_time_and_an_unloaded_repo_can_be_used()
 {
    let f = Fixture::new(false);
    let cached: ReposListResult = f.call("repos.cached", json!({})).await;
    assert!(
        cached
            .repos
            .iter()
            .any(|repo| repo.key == "repo-00001" && repo.is_default)
    );
    assert!(
        cached
            .repos
            .iter()
            .any(|repo| repo.key == "local-notes" && repo.local)
    );
    assert!(f.requests().is_empty(), "opening never needs GitHub");

    let first: ReposPageResult = f.call("repos.page", json!({})).await;
    assert!(first.github_error.is_none(), "{first:?}");
    assert_eq!(first.repos.len(), 50);
    assert!(first.next_cursor.is_some());
    assert!(!first.repos.iter().any(|repo| repo.key == "repo-19999"));
    assert_eq!(
        f.requests().len(),
        1,
        "no later page is fetched automatically"
    );

    let cached: ReposListResult = f.call("repos.cached", json!({})).await;
    assert!(cached.repos.iter().any(|repo| repo.key == "repo-00050"));
    assert_eq!(f.requests().len(), 1);
    assert!(
        cached.refreshed_at.is_none(),
        "a partial page is not a full sync"
    );

    let second: ReposPageResult = f
        .call("repos.page", json!({ "cursor": first.next_cursor }))
        .await;
    assert_eq!(second.repos.len(), 50);
    assert_eq!(second.repos[0].key, "repo-00051");
    assert_eq!(f.requests().len(), 2);
    assert_eq!(f.requests()[1]["mainCursor"], "50");

    let search: ReposPageResult = f
        .call(
            "repos.page",
            json!({ "owner": "acme", "query": "repo-19999" }),
        )
        .await;
    assert!(search.github_error.is_none(), "{search:?}");
    assert_eq!(search.repos.len(), 1);
    assert_eq!(search.repos[0].key, "repo-19999");
    assert!(search.repos[0].private);
    assert_eq!(
        f.requests().len(),
        3,
        "search does not enumerate the missing pages"
    );

    assert!(search.repos[0].clone_path.is_none());
    f.make_origin();
    let created: chauffeur_protocol::client::CreateWorkspaceResult = f
        .call(
            "workspace.create",
            json!({ "name": "unloaded-repo", "repos": ["repo-19999"] }),
        )
        .await;
    let workspace: WorkspaceInfo = created.workspace;
    assert_eq!(workspace.state, WorkspaceState::Ready);
    assert_eq!(workspace.worktrees.len(), 1);
    assert_eq!(workspace.worktrees[0].repo, "repo-19999");
    assert!(
        std::fs::read_to_string(Path::new(&workspace.worktrees[0].path).join("README.md"))
            .unwrap()
            .contains("outside the first page")
    );
    assert_eq!(
        f.requests().len(),
        4,
        "creation clones only the selected repo without a full listing"
    );
    assert_eq!(f.requests()[3]["clone"], "acme/repo-19999");
    assert!(
        f.daemon.store.repos_cache().unwrap().is_empty(),
        "partial pages never replace the full catalog"
    );
}

#[tokio::test]
async fn a_configured_default_can_be_cloned_and_used_before_any_github_page_is_loaded() {
    let f = Fixture::new(false);
    f.make_origin();
    let cached: ReposListResult = f.call("repos.cached", json!({})).await;
    let defaults: Vec<_> = cached
        .repos
        .iter()
        .filter(|repo| repo.is_default)
        .map(|repo| &repo.key)
        .collect();
    let created: chauffeur_protocol::client::CreateWorkspaceResult = f
        .call(
            "workspace.create",
            json!({ "name": "cached-default", "repos": defaults }),
        )
        .await;
    assert_eq!(created.workspace.state, WorkspaceState::Ready);
    assert_eq!(f.requests(), [json!({ "clone": "acme/repo-00001" })]);
}

#[tokio::test]
async fn an_existing_twenty_thousand_repo_cache_is_bounded_without_hiding_defaults_or_local_clones()
{
    let f = Fixture::new(false);
    let repos: Vec<_> = (1..=20_000)
        .map(|number| chauffeurd::store::CachedRepo {
            name: format!("repo-{number:05}"),
            full_name: format!("acme/repo-{number:05}"),
            ..Default::default()
        })
        .collect();
    f.daemon.store.replace_repos_cache(&repos).unwrap();
    let cached: ReposListResult = f.call("repos.cached", json!({})).await;
    assert!(cached.repos.len() <= 52);
    assert!(
        cached
            .repos
            .iter()
            .any(|repo| repo.is_default && repo.key == "repo-00001")
    );
    assert!(
        cached
            .repos
            .iter()
            .any(|repo| repo.local && repo.key == "local-notes")
    );
    assert!(f.requests().is_empty());
    assert_eq!(f.daemon.store.repos_cache().unwrap().len(), 20_000);
}

#[tokio::test]
async fn concurrent_page_requests_are_shared_and_failed_refreshes_keep_the_previous_page() {
    let f = Fixture::new(true);
    let (first, same): (ReposPageResult, ReposPageResult) = tokio::join!(
        f.call("repos.page", json!({ "refresh": true })),
        f.call("repos.page", json!({ "refresh": true })),
    );
    assert!(first.github_error.is_none(), "{first:?}");
    assert_eq!(
        first.repos.len(),
        51,
        "overlapping sources are deduplicated"
    );
    assert!(first.repos.iter().any(|repo| repo.key == "friend/notes"));
    assert_eq!(same.repos.len(), first.repos.len());
    assert_eq!(f.requests().len(), 1);

    std::fs::write(f.root.path().join("fail"), "").unwrap();
    let failed: ReposPageResult = f.call("repos.page", json!({ "refresh": true })).await;
    assert!(
        failed
            .github_error
            .as_deref()
            .unwrap()
            .contains("rate limit")
    );
    assert_eq!(failed.repos.len(), first.repos.len());
    assert_eq!(failed.next_cursor, first.next_cursor);
    let cached: ReposListResult = f.call("repos.cached", json!({})).await;
    assert!(cached.repos.iter().any(|repo| repo.key == "friend/notes"));
    std::fs::remove_file(f.root.path().join("fail")).unwrap();

    let second: ReposPageResult = f
        .call("repos.page", json!({ "cursor": first.next_cursor }))
        .await;
    assert!(second.github_error.is_none(), "{second:?}");
    assert_eq!(second.repos.len(), 50);
    assert_eq!(
        f.requests().last().unwrap()["accountEnabled"],
        "false",
        "an exhausted source is not fetched again"
    );
}

#[tokio::test]
async fn a_page_cursor_cannot_be_reused_for_a_different_search_or_source() {
    let f = Fixture::new(false);
    let first: ReposPageResult = f.call("repos.page", json!({})).await;
    for params in [
        json!({ "owner": "acme", "query": "repo-19999", "cursor": first.next_cursor }),
        json!({ "owner": "someone-else" }),
        json!({ "cursor": "not-a-cursor" }),
    ] {
        let call =
            serde_json::from_value(json!({ "method": "repos.page", "params": params })).unwrap();
        assert!(matches!(
            rpc::handle(&f.daemon, call).await,
            Err(chauffeurd::Error::BadRequest(_))
        ));
    }
    f.daemon
        .settings
        .update(|doc| doc["github_org"] = toml_edit::value("another-org"))
        .unwrap();
    let call = serde_json::from_value(
        json!({ "method": "repos.page", "params": { "cursor": first.next_cursor } }),
    )
    .unwrap();
    assert!(matches!(
        rpc::handle(&f.daemon, call).await,
        Err(chauffeurd::Error::BadRequest(_))
    ));
    assert_eq!(f.requests().len(), 1, "invalid pages never reach GitHub");
}
