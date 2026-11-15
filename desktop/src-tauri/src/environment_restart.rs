//! Durable per-environment tombstones. No remote calls, route guessing or peer removal.
use super::*;
#[cfg(test)]
#[path = "environment_restart_tests.rs"]
mod tests;
use std::collections::BTreeSet;
use std::sync::atomic::Ordering;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RestartFences {
    schema_version: u8,
    environments: BTreeSet<String>,
}
impl RestartFences {
    pub(super) fn load(root: &std::path::Path) -> Result<Self, String> {
        let directory = root.join("restart-fences");
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    schema_version: 1,
                    environments: BTreeSet::new(),
                })
            }
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            _ => return Err("Unsafe restart fence directory".into()),
        }
        let path = directory.join("journal.json");
        let meta = fs::symlink_metadata(&path).map_err(|_| "Restart fence journal missing")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 256 * 1024 {
            return Err("Unsafe restart fence journal".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if meta.permissions().mode() & 0o077 != 0
                || meta.uid()
                    != fs::metadata(root)
                        .map_err(|_| "Cannot inspect restart fence directory")?
                        .uid()
            {
                return Err("Restart fences must be private and owned".into());
            }
        }
        let result: Self =
            serde_json::from_slice(&fs::read(path).map_err(|_| "Restart fences unreadable")?)
                .map_err(|_| "Invalid restart fences")?;
        if result.schema_version != 1 || result.environments.len() > 4096 {
            return Err("Unsupported restart fences".into());
        }
        for id in &result.environments {
            validate_id(id)?;
        }
        Ok(result)
    }
    fn save(&self, root: &std::path::Path) -> Result<(), String> {
        durable_directory(&root.join("restart-fences"))?;
        private_write(
            &root.join("restart-fences/journal.json"),
            &serde_json::to_vec(self).map_err(|_| "Invalid restart fence journal")?,
        )
    }
    pub(super) fn contains(&self, id: &str) -> bool {
        self.environments.contains(id)
    }
}
pub(crate) struct RestartFence {
    environment: String,
    _registration: tokio::sync::OwnedMutexGuard<()>,
    _mutation: Option<tokio::sync::OwnedMutexGuard<()>>,
    state: Option<Arc<State>>,
}
impl Registry {
    pub(crate) fn restart_unfenced(&self, id: &str) -> Result<(), String> {
        if self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .restart_fences
            .contains(id)
        {
            return Err(
                "This environment is held or retired by a setup restart; check restart outcome"
                    .into(),
            );
        }
        Ok(())
    }
    pub(crate) fn reserve_restart_fence(&self, environment: &str) -> Result<RestartFence, String> {
        self.reserve_restart_fence_with(environment, || {})
    }
    fn reserve_restart_fence_with(
        &self,
        environment: &str,
        before_registration: impl FnOnce(),
    ) -> Result<RestartFence, String> {
        validate_id(environment)?;
        let gate = self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .registration
            .entry(environment.into())
            .or_default()
            .clone();
        before_registration();
        let registration = gate
            .try_lock_owned()
            .map_err(|_| "A saved connection operation is in progress; finish it before restart")?;
        // Registration can publish a new State between finding its gate and acquiring it.
        // Only the lookup under this guard identifies the mutation gate we must own.
        let state = self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .connections
            .get(environment)
            .cloned();
        let mutation = state
            .as_ref()
            .map(|s| {
                s.mutation
                    .clone()
                    .try_lock_owned()
                    .map_err(|_| "Signed work is in progress; finish it before restart")
            })
            .transpose()?;
        let fence = RestartFence {
            environment: environment.into(),
            _registration: registration,
            _mutation: mutation,
            state,
        };
        let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        self.check_restart_fence(&inner, &fence)?;
        Ok(fence)
    }
    fn check_restart_fence(
        &self,
        inner: &RegistryInner,
        fence: &RestartFence,
    ) -> Result<(), String> {
        let same_state = match (inner.connections.get(&fence.environment), &fence.state) {
            (Some(current), Some(reserved)) => {
                Arc::ptr_eq(current, reserved) && fence._mutation.is_some()
            }
            (None, None) => fence._mutation.is_none(),
            _ => false,
        };
        if !same_state {
            return Err("Saved connection changed while restart was reserved; review again".into());
        }
        // Recovery storage remains authoritative even if a connection is no longer registered.
        match fs::symlink_metadata(
            self.directory
                .join("environments")
                .join(&fence.environment)
                .join("pending.enc"),
        ) {
            Ok(_) => {
                return Err("Resolve pending signed work before restarting this environment".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot verify pending signed work; restart blocked".into()),
        }
        if let Some(state) = &fence.state {
            let client = state.client.lock().map_err(|_| "Connection lock failed")?;

            if client.pending.is_some() {
                return Err(
                    "Resolve pending signed work before restarting this environment".into(),
                );
            }
        }
        Ok(())
    }
    pub(crate) fn validate_restart_fence(
        &self,
        fence: &RestartFence,
        setup_ids: &BTreeSet<String>,
    ) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        self.check_restart_fence(&inner, fence)?;
        if inner
            .metadata
            .environments
            .get(&fence.environment)
            .and_then(|e| e.ssh.as_ref())
            .is_some_and(|b| !setup_ids.contains(&b.setup_id))
        {
            return Err(
                "Saved connection ownership does not match the original operation; restart blocked"
                    .into(),
            );
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn restart_recovery_snapshot(
        &self,
        fence: &RestartFence,
        setup_ids: &BTreeSet<String>,
    ) -> Result<Value, String> {
        self.validate_restart_fence(fence, setup_ids)?;
        let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        self.check_restart_fence(&inner, fence)?;
        let root = self.directory.join("environments");
        let fence_meta = fs::symlink_metadata(root.join("restart-fences"))
            .map_err(|_| "Recovery fence directory missing")?;
        if !fence_meta.is_dir() || fence_meta.file_type().is_symlink() {
            return Err("Unsafe recovery fence directory".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if fence_meta.permissions().mode() & 0o077 != 0
                || fence_meta.uid()
                    != fs::metadata(&root)
                        .map_err(|_| "Recovery registry missing")?
                        .uid()
            {
                return Err("Recovery fences must be private and owned".into());
            }
        }
        let disk = RestartFences::load(&root)?;
        if !inner.restart_fences.contains(&fence.environment)
            || disk.environments != inner.restart_fences.environments
        {
            return Err(
                "Recovery requires matching existing memory and durable restart fences".into(),
            );
        }
        let path = root.join("registry.json");
        let meta = fs::symlink_metadata(&path).map_err(|_| "Recovery registry missing")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 8 * 1024 * 1024 {
            return Err("Unsafe recovery registry".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if meta.permissions().mode() & 0o077 != 0
                || meta.uid()
                    != fs::metadata(&root)
                        .map_err(|_| "Recovery registry missing")?
                        .uid()
            {
                return Err("Recovery registry must be private and owned".into());
            }
        }
        let metadata: Metadata =
            serde_json::from_slice(&fs::read(path).map_err(|_| "Recovery registry unreadable")?)
                .map_err(|_| "Invalid recovery registry")?;
        metadata.validate()?;
        let disk = serde_json::to_value(metadata).map_err(|_| "Invalid recovery registry")?;
        let memory =
            serde_json::to_value(&inner.metadata).map_err(|_| "Invalid recovery registry")?;
        if disk != memory
            || inner
                .metadata
                .environments
                .get(&fence.environment)
                .and_then(|e| e.ssh.as_ref())
                .is_some_and(|binding| !binding.paused || !setup_ids.contains(&binding.setup_id))
        {
            return Err("Recovery registry ownership or hold changed".into());
        }
        Ok(json!({"metadata": memory, "fences": inner.restart_fences.environments}))
    }
    pub(crate) fn commit_restart_fence(
        &self,
        fence: &RestartFence,
        setup_ids: &BTreeSet<String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        self.check_restart_fence(&inner, fence)?;
        if inner
            .metadata
            .environments
            .get(&fence.environment)
            .and_then(|e| e.ssh.as_ref())
            .is_some_and(|b| !setup_ids.contains(&b.setup_id))
        {
            return Err(
                "Saved connection ownership does not match the original operation; restart blocked"
                    .into(),
            );
        }
        if inner.restart_fences.environments.len() >= 4096
            && !inner.restart_fences.contains(&fence.environment)
        {
            return Err("Restart fence capacity reached".into());
        }
        inner
            .restart_fences
            .environments
            .insert(fence.environment.clone());
        // Fence memory first; even an fsync error may follow a successful durable rename.
        if let Some(state) = &fence.state {
            state.removed.store(true, Ordering::SeqCst);
            state.route_available.store(false, Ordering::SeqCst);
            state.cancel_stream()?;
        }
        inner
            .restart_fences
            .save(&self.directory.join("environments"))?;
        let mut metadata = inner.metadata.clone();
        if let Some(binding) = metadata
            .environments
            .get_mut(&fence.environment)
            .and_then(|e| e.ssh.as_mut())
        {
            binding.paused = true;
            binding.generation = binding
                .generation
                .checked_add(1)
                .ok_or("SSH generation exhausted")?;
        }
        private_write(
            &self.directory.join("environments/registry.json"),
            &serde_json::to_vec(&metadata).map_err(|_| "Invalid registry")?,
        )?;
        inner.metadata = metadata;
        Ok(())
    }
    pub(crate) fn finish_restart_fence(&self, environment: &str) -> Result<(), String> {
        let fence = self.reserve_restart_fence(environment)?;
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        self.check_restart_fence(&inner, &fence)?;
        // A missing fence means no destructive dispatch was permitted by this registry.
        if !inner.restart_fences.contains(environment) {
            return Err("Restart registry fence missing; local recovery required".into());
        }
        let mut metadata = inner.metadata.clone();
        metadata.environments.remove(environment);
        if metadata.selected_environment_id.as_deref() == Some(environment) {
            metadata.selected_environment_id = None;
        }
        private_write(
            &self.directory.join("environments/registry.json"),
            &serde_json::to_vec(&metadata).map_err(|_| "Invalid registry")?,
        )?;
        inner.metadata = metadata;
        inner.connections.remove(environment);
        inner.lifecycle.remove(environment);
        if let Some(state) = fence.state.as_ref() {
            state.removed.store(true, Ordering::SeqCst);
            state.route_available.store(false, Ordering::SeqCst);
            state.cancel_stream()?;
        }
        Ok(())
    }
}
