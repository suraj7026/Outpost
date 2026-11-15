//! Presentation-only history; never deletes receipts, trust, or connection bindings.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum ActivityKind {
    History,
    Diagnostics,
    Installation,
    Restart,
}
pub(super) struct Activity {
    pub kind: ActivityKind,
    pub token: String,
    pub target: Target,
    pub cancel: Arc<AtomicBool>,
}
pub(super) struct ActivityGuard {
    inner: Arc<Mutex<Inner>>,
    pub entry: Entry,
    pub token: String,
    pub cancel: Arc<AtomicBool>,
}
impl Drop for ActivityGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .activities
                .get(&self.entry.id)
                .is_some_and(|v| v.token == self.token)
            {
                inner.activities.remove(&self.entry.id);
            }
        }
    }
}
fn same_target(a: &Target, b: &Target) -> bool {
    // A different SSH user/key does not make a second installer on the same host safe.
    restart::same_host(a, b)
}
pub(super) fn activity_busy(inner: &Inner, entry: &Entry) -> bool {
    inner
        .activities
        .values()
        .any(|v| same_target(&v.target, &entry.target))
}
pub(super) fn target_busy(inner: &Inner, entry: &Entry) -> bool {
    activity_busy(inner, entry)
        || inner.running.keys().any(|id| {
            inner
                .entries
                .get(id)
                .is_some_and(|v| same_target(&v.target, &entry.target))
        })
}
pub(super) fn active_install_state(state: &str) -> bool {
    !matches!(
        state,
        "failed" | "cancelled" | "interrupted" | "ready" | "complete"
    )
}
fn eligible(entry: &Entry) -> bool {
    if !matches!(
        entry.phase.as_str(),
        "trusted"
            | "review"
            | "install_review"
            | "installed"
            | "installation_stopped"
            | "tunnel_ready"
            | "disconnected"
            | "failed"
            | "interrupted"
    ) {
        return false;
    }
    entry
        .installation
        .as_ref()
        .is_none_or(|p| !active_install_state(&p.state))
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    schema_version: u8,
    archived: BTreeSet<String>,
}
impl Setup {
    pub(super) fn activity(&self, id: &str, kind: ActivityKind) -> Result<ActivityGuard, String> {
        self.ready()?;
        environments::validate_id(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let entry = inner.entries.get(id).ok_or("Unknown setup target")?.clone();
        if entry.id != id {
            return Err("Setup journal identity mismatch".into());
        }
        entry.target.validate()?;
        if kind != ActivityKind::Restart {
            Self::restart_allowed(&inner, &entry)?;
        }
        if target_busy(&inner, &entry)
            || kind == ActivityKind::Installation && inner.tunnels.contains_key(id)
        {
            return Err("This server has a local operation in progress. Wait for it to finish or cancel its diagnostic read.".into());
        }
        let token = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        inner.activities.insert(
            id.into(),
            Activity {
                kind,
                token: token.clone(),
                target: entry.target.clone(),
                cancel: cancel.clone(),
            },
        );
        Ok(ActivityGuard {
            inner: self.inner.clone(),
            entry,
            token,
            cancel,
        })
    }
    // Call under the journal lock: history changes and active observations serialize together.
    fn read_history(&self) -> Result<History, String> {
        let path = self.directory.join("history.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(History {
                    schema_version: 1,
                    ..History::default()
                })
            }
            Err(_) => return Err("Cannot read setup history visibility".into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
            return Err("Unsafe setup history visibility file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let parent =
                fs::metadata(&self.directory).map_err(|_| "Cannot inspect history directory")?;
            if metadata.uid() != parent.uid() || metadata.permissions().mode() & 0o077 != 0 {
                return Err("Setup history must be a private owned file".into());
            }
        }
        let value: History =
            serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read setup history")?)
                .map_err(|_| "Invalid setup history visibility file")?;
        if value.schema_version != 1 || value.archived.len() > 4096 {
            return Err("Unsupported setup history visibility file".into());
        }
        for id in &value.archived {
            environments::validate_id(id)?;
        }
        Ok(value)
    }
    fn save_history(&self, history: &History) -> Result<Vec<String>, String> {
        if history.archived.len() > 4096 {
            return Err("Setup history visibility capacity reached".into());
        }
        private_write(
            &self.directory.join("history.json"),
            &serde_json::to_vec(history).map_err(|_| "Cannot encode history visibility")?,
        )
        .map_err(|_| "Cannot persist private history visibility")?;
        Ok(history.archived.iter().cloned().collect())
    }
    pub(super) fn archive_reset_history(&self, ids: &BTreeSet<String>) -> Result<(), String> {
        let mut history = self.read_history()?;
        history.archived.extend(ids.iter().cloned());
        self.save_history(&history)?;
        Ok(())
    }
    pub(super) fn reveal_history(&self, id: &str) -> Result<(), String> {
        let mut history = self.read_history()?;
        if history.archived.remove(id) {
            self.save_history(&history)?;
        }
        Ok(())
    }
    pub(super) fn history_list(&self) -> Result<Vec<String>, String> {
        self.ready()?;
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let mut history = self.read_history()?;
        let original = history.archived.len();
        history.archived.retain(|id| {
            inner.entries.get(id).is_some_and(|entry| {
                if Self::restart_allowed(&inner, entry).is_err() {
                    return true;
                }
                // Connection supervision may reopen an archived server's route. That
                // is not a new installation and must not undo presentation cleanup.
                !entry
                    .installation
                    .as_ref()
                    .is_some_and(|p| active_install_state(&p.state))
                    && !matches!(
                        entry.phase.as_str(),
                        "installing" | "authorizing" | "unknown"
                    )
            })
        });
        if history.archived.len() != original {
            return self.save_history(&history);
        }
        Ok(history.archived.into_iter().collect())
    }
    fn history_archive(&self, id: &str) -> Result<Vec<String>, String> {
        let guard = self.activity(id, ActivityKind::History)?;
        if !eligible(&guard.entry) {
            return Err("Check progress before removing this setup. Active, authorizing or unknown installations cannot be archived.".into());
        }
        if let Some(saved) = &guard.entry.installation {
            let plan = guard
                .entry
                .plan
                .as_ref()
                .ok_or("No saved installation plan")?;
            if saved.operation_id != plan.operation_id
                || saved.environment_id != plan.environment_id
                || saved.release_id != plan.release_id
            {
                return Err("Saved installation identity does not match its plan".into());
            }
            // Use the newly fetched receipt, not the monotonic journal merge (which may
            // deliberately retain an older terminal state over a conflicting reply).
            let progress = self.read_install_status(&guard.entry, false)
                .map_err(|_| "A fresh installation status is required before removing this setup. Check progress and try again.")?;
            if active_install_state(&progress.state) {
                let _inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
                self.reveal_history(id)?;
                return Err(
                    "The installation is active or its status is unknown; it cannot be archived."
                        .into(),
                );
            }
            if guard.entry.installation.as_ref().is_some_and(|p| {
                progress.completed_steps
                    < if p.state == "complete" {
                        10
                    } else {
                        p.completed_steps
                    }
                    || p.remote_timestamp().is_some_and(|time| {
                        progress.remote_timestamp().is_none_or(|fresh| fresh < time)
                    })
            }) {
                return Err("The server returned stale installation status; check progress before archiving.".into());
            }
        }
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let current = inner.entries.get(id).ok_or("Unknown setup target")?;
        if !same_history_identity(current, &guard.entry)
            || !eligible(current)
            || guard.cancel.load(Ordering::SeqCst)
        {
            return Err(
                "Setup changed during the status read. Check progress before archiving.".into(),
            );
        }
        let mut history = self.read_history()?;
        history.archived.insert(id.into());
        let result = self.save_history(&history)?;
        diagnostics::invalidate(&mut inner, id);
        Ok(result)
    }
    pub(super) fn history_restore(&self, id: &str) -> Result<Vec<String>, String> {
        self.ready()?;
        environments::validate_id(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        Self::restart_allowed(&inner, inner.entries.get(id).ok_or("Unknown setup target")?)?;
        let mut history = self.read_history()?;
        history.archived.remove(id);
        let result = self.save_history(&history)?;
        diagnostics::invalidate(&mut inner, id);
        Ok(result)
    }
}
fn same_history_identity(a: &Entry, b: &Entry) -> bool {
    a.target == b.target
        && a.fingerprint == b.fingerprint
        && serde_json::to_value(&a.plan).ok() == serde_json::to_value(&b.plan).ok()
        && serde_json::to_value(&a.installation).ok() == serde_json::to_value(&b.installation).ok()
}
#[tauri::command]
pub fn setup_history_list(setup: tauri::State<'_, Arc<Setup>>) -> Result<Vec<String>, String> {
    setup.history_list()
}
#[tauri::command]
pub async fn setup_history_archive(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<Vec<String>, String> {
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || setup.history_archive(&id))
        .await
        .map_err(|_| "History status check interrupted")?
}
#[tauri::command]
pub fn setup_history_restore(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<Vec<String>, String> {
    setup.history_restore(&id)
}

#[cfg(test)]
#[path = "server_history_tests.rs"]
mod tests;
