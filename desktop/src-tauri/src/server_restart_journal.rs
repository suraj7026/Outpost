use super::*;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Journal {
    schema_version: u8,
    pub(super) records: BTreeMap<String, Pending>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in super::super) struct Pending {
    pub(super) reset_id: String,
    pub(super) binding: Binding,
    pub(super) affected: BTreeSet<String>,
    pub(super) created_at: u64,
    pub(super) remote_complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_failure: Option<String>,
    local_complete: bool,
    fresh: Entry,
}
impl Pending {
    #[cfg(test)]
    pub(super) fn require_unpublished_fresh(&self, inner: &Inner) -> Result<(), String> {
        if inner.entries.contains_key(&self.fresh.id) {
            return Err("Reserved fresh setup ID is already occupied; check the same restart outcome".into());
        }
        Ok(())
    }
    pub(super) fn held(&self, state: &str) -> RestartResult {
        let mut result = RestartResult::held(&self.reset_id, state);
        if let Some(message) = &self.last_failure {
            result.message = format!("Last failed cleanup: {message} {}", result.message);
        }
        result
    }
    fn owns_entry(&self, entry: &Entry) -> bool {
        self.affected.contains(&entry.id)
            || entry.plan.as_ref().is_some_and(|p| {
                p.operation_id == self.binding.expected.operation_id
                    || p.environment_id == self.binding.expected.environment_id
            })
            || entry
                .inspection
                .as_ref()
                .and_then(|i| i.environment.as_ref())
                .is_some_and(|e| e.environment_id == self.binding.expected.environment_id)
    }
}
impl Journal {
    #[cfg(test)]
    pub(super) fn recovery_pending(
        &self,
        entry: &Entry,
        reset_id: &str,
    ) -> Result<&Pending, String> {
        let pending = self
            .records
            .get(reset_id)
            .ok_or("Held restart record missing")?;
        if pending.remote_complete
            || pending.local_complete
            || pending.binding.id != entry.id
            || self
                .resolve_status(entry)?
                .is_none_or(|p| p.reset_id != reset_id)
            || self.records.values().any(|p| {
                p.reset_id != reset_id
                    && (same_host(&p.binding.target, &pending.binding.target)
                        || p.binding.expected.environment_id
                            == pending.binding.expected.environment_id
                        || p.binding.expected.operation_id == pending.binding.expected.operation_id
                        || !p.affected.is_disjoint(&pending.affected))
            })
        {
            return Err("Recovery requires one exact unresolved restart; use same-ID status for completed outcomes".into());
        }
        Ok(pending)
    }
    pub(in super::super) fn phase(&self, entry: &Entry) -> Option<&'static str> {
        let mut retired = false;
        for pending in self.records.values().filter(|p| p.owns_entry(entry)) {
            if !pending.remote_complete {
                return Some("restart_pending");
            }
            retired = true;
        }
        if retired {
            return Some("reset");
        }
        self.records
            .values()
            .any(|p| {
                !p.local_complete
                    && entry.id != p.fresh.id
                    && same_host(&p.binding.target, &entry.target)
            })
            .then_some("restart_pending")
    }
    pub(in super::super) fn project_entry(&self, entry: &mut Entry) -> bool {
        let Some(phase) = self.phase(entry) else {
            return false;
        };
        let changed = entry.phase != phase
            || !entry.connection_paused
            || entry.endpoint.is_some()
            || entry.error.as_deref() != Some(HOLD);
        entry.phase = phase.into();
        entry.connection_paused = true;
        entry.endpoint = None;
        entry.error = Some(HOLD.into());
        changed
    }
    pub(super) fn resolve_status(&self, entry: &Entry) -> Result<Option<&Pending>, String> {
        let mut candidates: Vec<_> = self
            .records
            .values()
            .filter(|p| p.binding.id == entry.id || p.binding.source_id == entry.id)
            .collect();
        if candidates.is_empty() {
            candidates = self
                .records
                .values()
                .filter(|p| p.affected.contains(&entry.id))
                .collect();
        }
        if candidates.is_empty() {
            candidates = self
                .records
                .values()
                .filter(|p| {
                    same_host(&p.binding.target, &entry.target)
                        && p.binding.fingerprint == entry.fingerprint
                })
                .collect();
            // A current hold takes precedence over unrelated completed generations, but
            // two unresolved matches are never ordered by timestamp or label.
            if candidates.iter().any(|p| !p.local_complete) {
                candidates.retain(|p| !p.local_complete);
            }
        }
        match candidates.as_slice() {
            [pending] => Ok(Some(pending)),
            [] if matches!(entry.phase.as_str(), "restart_pending" | "reset")
                || self.records.values().any(|p| {
                    p.owns_entry(entry)
                        || !p.local_complete && same_host(&p.binding.target, &entry.target)
                }) => Err(HOLD.into()),
            [] => Ok(None),
            _ => Err(format!("Multiple restart outcomes match this verified host. Choose an original setup explicitly; no cleanup was dispatched. {}", candidates.iter().map(|p| format!("sourceId={} resetId={}", p.binding.source_id, p.reset_id)).collect::<Vec<_>>().join("; "))),
        }
    }
    pub(in super::super) fn load(directory: &std::path::Path) -> Result<Self, String> {
        let root = directory.join("restart-recovery");
        let fresh = durable_directory(&root)?;
        if fresh {
            let journal = Self {
                schema_version: 1,
                records: BTreeMap::new(),
            };
            journal.save(directory)?;
            return Ok(journal);
        }
        Self::read(directory)
    }
    pub(super) fn read(directory: &std::path::Path) -> Result<Self, String> {
        let root = directory.join("restart-recovery");
        let root_meta = fs::symlink_metadata(&root)
            .map_err(|_| "Restart journal directory missing; recovery is blocked")?;
        if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
            return Err("Unsafe restart journal directory".into());
        }
        let path = root.join("journal.json");
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| "Restart journal missing; recovery is blocked")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 8 * 1024 * 1024 {
            return Err("Unsafe restart journal".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let owner = fs::metadata(directory)
                .map_err(|_| "Cannot inspect restart directory")?
                .uid();
            if meta.permissions().mode() & 0o077 != 0
                || root_meta.permissions().mode() & 0o077 != 0
                || meta.uid() != owner
                || root_meta.uid() != owner
            {
                return Err("Restart journal must be private and owned".into());
            }
        }
        let journal: Self =
            serde_json::from_slice(&fs::read(path).map_err(|_| "Restart journal unreadable")?)
                .map_err(|_| "Invalid restart journal; recovery is blocked")?;
        if journal.schema_version != 1 || journal.records.len() > 4096 {
            return Err("Unsupported restart journal".into());
        }
        for (id, pending) in &journal.records {
            environments::validate_id(id)?;
            environments::validate_id(&pending.binding.id)?;
            environments::validate_id(&pending.binding.source_id)?;
            environments::validate_id(&pending.fresh.id)?;
            pending.binding.target.validate()?;
            let plan: install::InstallPlan =
                serde_json::from_value(pending.binding.source_plan.clone())
                    .map_err(|_| "Invalid original restart plan")?;
            plan.validate()?;
            let mut source = pending.fresh.clone();
            source.plan = Some(plan);
            source.installation = serde_json::from_value(pending.binding.source_progress.clone())
                .map_err(|_| "Invalid original restart receipt")?;
            if id != &pending.reset_id
                || pending.binding.expected != Expected::from_entry(&source)?
                || pending
                    .last_failure
                    .as_deref()
                    .is_some_and(|v| !public_message_valid(v))
                || pending.local_complete && !pending.remote_complete
                || pending.affected.contains(&pending.fresh.id)
                || !pending.affected.contains(&pending.binding.id)
                || !pending.affected.contains(&pending.binding.source_id)
                || pending.fresh.target != pending.binding.target
                || pending.fresh.fingerprint != pending.binding.fingerprint
                || pending.fresh.plan.is_some()
                || pending.fresh.installation.is_some()
                || pending.fresh.inspection.is_some()
                || pending.fresh.phase != "trusted"
            {
                return Err("Restart journal identity mismatch".into());
            }
            for id in &pending.affected {
                environments::validate_id(id)?;
            }
        }
        Ok(journal)
    }
    fn save(&self, directory: &std::path::Path) -> Result<(), String> {
        private_write(
            &directory.join("restart-recovery/journal.json"),
            &serde_json::to_vec(self).map_err(|_| "Cannot encode restart journal")?,
        )
    }
}
impl Setup {
    pub(in super::super) fn restart_allowed(inner: &Inner, entry: &Entry) -> Result<(), String> {
        for pending in inner.restart_journal.records.values() {
            if pending.owns_entry(entry)
                || !pending.local_complete && same_host(&pending.binding.target, &entry.target)
            {
                return Err(HOLD.into());
            }
        }
        Ok(())
    }
    pub(crate) fn restart_entry_allowed(&self, id: &str) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        Self::restart_allowed(&inner, inner.entries.get(id).ok_or("Unknown setup target")?)
    }
    pub(super) fn prepare_restart(&self, request: &Request) -> Result<Pending, String> {
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        Self::restart_allowed(&inner, &request.guard.entry)?;
        if inner.restart_journal.records.len() >= 4096 {
            return Err("Restart recovery journal is full".into());
        }
        let affected = affected_setup_ids(&inner, &request.binding);
        let fresh = Entry {
            id: Uuid::new_v4().to_string(), label: request.guard.entry.label.clone(), target: request.binding.target.clone(), fingerprint: request.binding.fingerprint.clone(),
            phase: "trusted".into(), inspection: None, recommendation: None, endpoint: None, error: None,
            log: vec!["Verified native reset complete. Saved host trust retained; inspect and review a new installation plan. No installation approval was carried forward.".into()],
            plan: None, installation: None, connection_paused: false,
        };
        let pending = Pending {
            reset_id: request.reset_id.clone(),
            binding: request.binding.clone(),
            affected,
            created_at: now(),
            remote_complete: false,
            last_failure: None,
            local_complete: false,
            fresh,
        };
        // Keep the in-memory hold even if fsync fails: a rename may already have committed.
        inner
            .restart_journal
            .records
            .insert(pending.reset_id.clone(), pending.clone());
        inner.restart_journal.save(&self.directory)?;
        Ok(pending)
    }
    pub(super) fn pause_restart_entries(&self, pending: &Pending) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        for id in &pending.affected {
            if let Some(cancel) = inner.running.get(id) {
                cancel.store(true, Ordering::SeqCst);
            }
            inner.tunnels.remove(id);
            diagnostics::invalidate(&mut inner, id);
            if let Some(entry) = inner.entries.get_mut(id) {
                entry.connection_paused = true;
                entry.endpoint = None;
                entry.phase = if pending.remote_complete {
                    "reset"
                } else {
                    "restart_pending"
                }
                .into();
                entry.error = Some(HOLD.into());
            }
        }
        self.persist(&inner)
    }
    fn check_restart_publication(&self, inner: &Inner, pending: &Pending) -> Result<(), String> {
        if let Some(entry) = inner.entries.get(&pending.fresh.id) {
            // An unfinished publication can only retry its exact creation snapshot. Once the
            // completion is durable, preserve later work but still require the original identity.
            if entry.id != pending.fresh.id
                || entry.target != pending.fresh.target
                || entry.fingerprint != pending.fresh.fingerprint
                || !pending.local_complete
                    && serde_json::to_value(entry).map_err(|_| "Invalid fresh setup entry")?
                        != serde_json::to_value(&pending.fresh).map_err(|_| "Invalid reserved fresh setup")?
            {
                return Err("Reserved fresh setup ID is occupied by a different entry".into());
            }
            self.pinned_ssh_args(entry)?;
        }
        Ok(())
    }
    pub(super) fn reconcile_restart(
        &self,
        reset_id: &str,
        state: &str,
        failure: Option<&str>,
        registry: &environments::Registry,
    ) -> Result<RestartResult, String> {
        if failure.is_some_and(|v| state != "failed" || !public_message_valid(v)) {
            return Err("Invalid public restart failure".into());
        }
        let pending = {
            let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            let mut pending = inner
                .restart_journal
                .records
                .get(reset_id)
                .ok_or("Restart recovery identity missing")?
                .clone();
            if let Some(message) = failure {
                pending.last_failure = Some(message.into());
            }
            pending.remote_complete |= state == "complete";
            if pending.remote_complete && !pending.local_complete {
                // Include verified replacement connections created while the outcome was
                // unknown. Freeze this set at completion so later fresh drafts stay usable.
                pending
                    .affected
                    .extend(affected_setup_ids(&inner, &pending.binding));
                pending.affected.remove(&pending.fresh.id);
            }
            inner
                .restart_journal
                .records
                .insert(reset_id.into(), pending.clone());
            if inner.restart_journal.save(&self.directory).is_err() {
                return Ok(pending.held("unknown"));
            }
            pending
        };
        if !pending.remote_complete {
            return Ok(pending.held(state));
        }
        // Each step is idempotent, and only local bookkeeping is repeated after remote completion.
        let finish = (|| {
            {
                let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
                self.check_restart_publication(&inner, &pending)?;
            }
            registry.finish_restart_fence(&pending.binding.expected.environment_id)?;
            self.pause_restart_entries(&pending)?;
            let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            self.check_restart_publication(&inner, &pending)?;
            self.archive_reset_history(&pending.affected)?;
            if !inner.entries.contains_key(&pending.fresh.id) {
                let working = inner
                    .entries
                    .get(&pending.binding.id)
                    .ok_or("Working setup missing")?;
                self.pinned_ssh_args(working)?;
                if working.target != pending.binding.target
                    || working.fingerprint != pending.binding.fingerprint
                {
                    return Err("Working SSH identity changed".into());
                }
                let pin =
                    fs::read_to_string(self.directory.join(format!("{}.known_hosts", working.id)))
                        .map_err(|_| "Pinned trust missing")?;
                let (key, fingerprint) = parse_key(&pin)?;
                if fingerprint != pending.fresh.fingerprint {
                    return Err("Pinned trust changed".into());
                }
                private_write(
                    &self
                        .directory
                        .join(format!("{}.known_hosts", pending.fresh.id)),
                    format!("{} {key}\n", Self::alias(&pending.fresh.id)).as_bytes(),
                )?;
                inner
                    .entries
                    .insert(pending.fresh.id.clone(), pending.fresh.clone());
            }
            // Retry persistence even if an earlier attempt updated memory then failed to sync.
            self.persist(&inner)?;
            inner
                .restart_journal
                .records
                .get_mut(reset_id)
                .ok_or("Restart missing")?
                .local_complete = true;
            if let Err(error) = inner.restart_journal.save(&self.directory) {
                inner
                    .restart_journal
                    .records
                    .get_mut(reset_id)
                    .unwrap()
                    .local_complete = false;
                return Err(error);
            }
            Ok::<_, String>(())
        })();
        if finish.is_err() {
            return Ok(pending.held("unknown"));
        }
        Ok(RestartResult { state: "complete".into(), reset_id: reset_id.into(), entry: Some(pending.fresh), message: "Native reset verified complete. Review capabilities and a new installation plan; no old approval was reused.".into() })
    }
}
