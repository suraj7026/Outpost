//! Restores saved SSH access only. Never installs, enrolls, dispatches or retries commands.

use super::*;
use tauri::Manager;

impl Setup {
    pub(crate) fn restore_bindings(&self, registry: &environments::Registry) -> Result<(), String> {
        let mut candidates: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
        for entry in self.list()? {
            if self.restart_entry_allowed(&entry.id).is_err() {
                continue;
            }
            if let Some(environment) = entry
                .inspection
                .as_ref()
                .and_then(|inspection| inspection.environment.as_ref())
            {
                candidates
                    .entry(environment.environment_id.clone())
                    .or_default()
                    .push(entry);
            }
        }
        for (environment, entries) in candidates {
            // Ownership comes from the inspected installation UUID, never a hostname or port.
            // Ambiguous journals are deliberately not chosen on the owner's behalf.
            if let [entry] = entries.as_slice() {
                registry.attach_ssh(
                    &environment,
                    &entry.id,
                    entry.connection_paused
                        || (entry.phase == "disconnected" && entry.error.is_none()),
                )?;
            }
        }
        Ok(())
    }
    fn route_matches(&self, id: &str, endpoint: &str) -> bool {
        !self.closed.load(Ordering::SeqCst)
            && self.inner.lock().is_ok_and(|inner| {
                inner.tunnels.contains_key(id)
                    && inner.entries.get(id).is_some_and(|entry| {
                        !entry.connection_paused && entry.endpoint.as_deref() == Some(endpoint)
                    })
            })
    }
    pub(crate) async fn recover_saved(
        &self,
        registry: &environments::Registry,
        environment: &str,
        binding: &environments::SshBinding,
    ) -> Result<bool, String> {
        self.ready()?;
        self.restart_entry_allowed(&binding.setup_id)?;
        if binding.paused {
            return Ok(false);
        }
        let gate = self
            .inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .recovering
            .entry(binding.setup_id.clone())
            .or_default()
            .clone();
        let _recovery = gate
            .try_lock()
            .map_err(|_| "This target already has a connection operation")?;
        if !registry.matches_ssh(environment, binding) {
            return Err("Connection changed or paused during reconnection".into());
        }
        let entries = self.list()?;
        let entry = entries
            .iter()
            .find(|entry| entry.id == binding.setup_id)
            .ok_or("Saved SSH target is missing; restore the setup journal")?;
        if entry.connection_paused {
            return Err("SSH connection is paused".into());
        }
        if entry
            .inspection
            .as_ref()
            .and_then(|inspection| inspection.environment.as_ref())
            .is_none_or(|found| found.environment_id != environment)
        {
            return Err("SSH installation identity does not match this saved server".into());
        }
        self.ssh_args(entry)?;
        let mut endpoint = entry
            .endpoint
            .clone()
            .filter(|endpoint| self.route_matches(&entry.id, endpoint));
        if endpoint.as_deref() == Some(binding.route.as_str())
            && registry.route_available(environment)
        {
            match registry.check_ssh(environment).await {
                Ok(()) => {
                    registry.set_lifecycle(environment, "connected", None)?;
                    return Ok(false);
                }
                Err(error) if error.starts_with("Cannot reach your server.") => {
                    registry.invalidate_ssh(environment, binding)?;
                    self.disconnect(&entry.id)?;
                    endpoint = None;
                }
                Err(error) => {
                    registry.invalidate_ssh(environment, binding)?;
                    return Err(error);
                }
            }
        }
        registry.invalidate_ssh(environment, binding)?;
        registry.set_lifecycle(environment, "connecting", None)?;
        let endpoint = match endpoint {
            Some(endpoint) => endpoint,
            None => self
                .tunnel(&entry.id)
                .await?
                .endpoint
                .ok_or("Verified SSH route missing")?,
        };
        if let Err(error) = registry
            .replace_ssh(environment, binding, &endpoint, || {
                self.route_matches(&entry.id, &endpoint)
            })
            .await
        {
            if registry.matches_ssh(environment, binding)
                && self.route_matches(&entry.id, &endpoint)
            {
                let _ = self.disconnect(&entry.id);
            }
            return Err(error);
        }
        Ok(true)
    }
}
fn retryable(error: &str) -> bool {
    error.starts_with("Cannot reach your server.")
        || error.starts_with("SSH route did not verify")
        || error.contains("connection operation")
        || error.contains("during reconnection")
}
fn retry_delay(attempt: u32, environment: &str) -> Duration {
    let seconds = 2_u64.saturating_pow(attempt.min(6)).min(60);
    let jitter = environment.bytes().map(u64::from).sum::<u64>() % 1000;
    Duration::from_millis(seconds * 1000 + jitter)
}
async fn supervise(app: tauri::AppHandle, environment: String, setup_id: String) {
    let setup = app.state::<Arc<Setup>>().inner().clone();
    let mut generation = None;
    let mut next = Instant::now();
    let mut attempts = 0;
    let mut blocked = false;
    let mut wake = setup.wake_generation.load(Ordering::SeqCst);
    while !setup.closed.load(Ordering::SeqCst) {
        let registry = app.state::<environments::Registry>();
        let binding = registry.ssh_bindings().ok().and_then(|bindings| {
            bindings
                .into_iter()
                .find(|(id, binding)| id == &environment && binding.setup_id == setup_id)
                .map(|(_, binding)| binding)
        });
        let Some(binding) = binding else {
            let _ = setup.disconnect(&setup_id);
            break;
        };
        if generation != Some(binding.generation) {
            generation = Some(binding.generation);
            next = Instant::now();
            attempts = 0;
            blocked = false;
        }
        let current_wake = setup.wake_generation.load(Ordering::SeqCst);
        if wake != current_wake {
            wake = current_wake;
            if !blocked {
                next = Instant::now();
                attempts = 0;
            }
        }
        if binding.paused {
            let _ = registry.set_lifecycle(&environment, "paused", None);
        } else if !blocked && Instant::now() >= next {
            match setup.recover_saved(&registry, &environment, &binding).await {
                Ok(_) => {
                    attempts = 0;
                    next = Instant::now() + Duration::from_secs(10);
                }
                Err(error) => {
                    attempts += 1;
                    blocked = !retryable(&error);
                    let _ = registry.set_lifecycle(
                        &environment,
                        if blocked {
                            "needs_attention"
                        } else {
                            "retrying"
                        },
                        Some(error),
                    );
                    next = Instant::now() + retry_delay(attempts, &environment);
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
pub async fn run(app: tauri::AppHandle) {
    let setup = app.state::<Arc<Setup>>().inner().clone();
    let mut workers: BTreeMap<
        (String, String),
        (tauri::async_runtime::JoinHandle<()>, Arc<AtomicBool>),
    > = BTreeMap::new();
    while !setup.closed.load(Ordering::SeqCst) {
        let registry = app.state::<environments::Registry>();
        workers.retain(|_, (_, finished)| !finished.load(Ordering::SeqCst));
        if let Err(error) = setup.restore_bindings(&registry) {
            for (environment, _) in registry.ssh_bindings().unwrap_or_default() {
                let _ =
                    registry.set_lifecycle(&environment, "needs_attention", Some(error.clone()));
            }
        } else {
            for (environment, binding) in registry.ssh_bindings().unwrap_or_default() {
                let key = (environment.clone(), binding.setup_id.clone());
                if !workers.contains_key(&key) {
                    let finished = Arc::new(AtomicBool::new(false));
                    let done = finished.clone();
                    let handle = app.clone();
                    let worker = tauri::async_runtime::spawn(async move {
                        supervise(handle, environment, binding.setup_id).await;
                        done.store(true, Ordering::SeqCst);
                    });
                    workers.insert(key, (worker, finished));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    for (_, (worker, _)) in workers {
        worker.abort();
    }
}

#[cfg(test)]
#[path = "server_lifecycle_tests.rs"]
mod tests;
