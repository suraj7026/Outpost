//! Persisted SSH ownership and authenticated, compare-and-swap route replacement.
use super::*;
use std::sync::atomic::Ordering;

pub(super) fn is_loopback(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint).is_ok_and(|url| {
        url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    })
}
impl Registry {
    pub(crate) fn ssh_bindings(&self) -> Result<Vec<(String, SshBinding)>, String> {
        let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        Ok(inner
            .metadata
            .environments
            .iter()
            .filter_map(|(id, saved)| saved.ssh.clone().map(|ssh| (id.clone(), ssh)))
            .collect())
    }
    pub(crate) fn attach_ssh(&self, id: &str, setup_id: &str, paused: bool) -> Result<(), String> {
        validate_id(setup_id)?;
        self.restart_unfenced(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        let mut metadata = inner.metadata.clone();
        let Some(saved) = metadata.environments.get_mut(id) else {
            return Ok(());
        };
        if saved.ssh.is_some() || !is_loopback(&saved.active_route) {
            return Ok(());
        }
        saved.ssh = Some(SshBinding {
            setup_id: setup_id.into(),
            route: saved.active_route.clone(),
            paused,
            generation: 0,
        });
        metadata.validate()?;
        private_write(
            &self.directory.join("environments/registry.json"),
            &serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
        )?;
        let state = inner
            .connections
            .get(id)
            .ok_or("Environment is not registered")?;
        state.route_available.store(false, Ordering::SeqCst);
        state.cancel_stream()?;
        inner.metadata = metadata;
        Ok(())
    }
    pub(crate) fn ssh_policy(&self, id: &str, paused: bool) -> Result<Option<SshBinding>, String> {
        self.restart_unfenced(id)?;
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        let mut metadata = inner.metadata.clone();
        let saved = metadata
            .environments
            .get_mut(id)
            .ok_or("Environment is not registered")?;
        let Some(ssh) = &mut saved.ssh else {
            return Ok(None);
        };
        ssh.paused = paused;
        ssh.generation = ssh
            .generation
            .checked_add(1)
            .ok_or("Connection generation exhausted")?;
        let binding = ssh.clone();
        metadata.validate()?;
        private_write(
            &self.directory.join("environments/registry.json"),
            &serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
        )?;
        let state = inner
            .connections
            .get(id)
            .ok_or("Environment is not registered")?;
        state.route_available.store(false, Ordering::SeqCst);
        state.cancel_stream()?;
        inner.metadata = metadata;
        inner.lifecycle.insert(
            id.into(),
            json!({"state":if paused { "paused" } else { "connecting" },"error":null}),
        );
        Ok(Some(binding))
    }
    pub(crate) fn matches_ssh(&self, id: &str, expected: &SshBinding) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            inner
                .metadata
                .environments
                .get(id)
                .and_then(|saved| saved.ssh.as_ref())
                == Some(expected)
        })
    }
    pub(crate) fn invalidate_ssh(&self, id: &str, expected: &SshBinding) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        if inner
            .metadata
            .environments
            .get(id)
            .and_then(|saved| saved.ssh.as_ref())
            != Some(expected)
        {
            return Err("Connection changed or paused during reconnection".into());
        }
        let state = inner
            .connections
            .get(id)
            .ok_or("Environment is not registered")?;
        state.route_available.store(false, Ordering::SeqCst);
        state.cancel_stream()
    }
    pub(crate) fn route_available(&self, id: &str) -> bool {
        self.get(id)
            .is_ok_and(|state| state.route_available.load(Ordering::SeqCst))
    }
    pub(crate) fn set_lifecycle(
        &self,
        id: &str,
        status: &str,
        error: Option<String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        if let Some(ssh) = inner
            .metadata
            .environments
            .get(id)
            .and_then(|saved| saved.ssh.as_ref())
        {
            let status = if ssh.paused { "paused" } else { status };
            inner
                .lifecycle
                .insert(id.into(), json!({"state": status, "error": error}));
        }
        Ok(())
    }
    pub(crate) fn lifecycle(&self, id: &str) -> Result<Option<Value>, String> {
        let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        Ok(inner
            .metadata
            .environments
            .get(id)
            .and_then(|saved| saved.ssh.as_ref())
            .map(|ssh| {
                if ssh.paused {
                    json!({"state":"paused","error":null})
                } else {
                    inner
                        .lifecycle
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| json!({"state":"connecting","error":null}))
                }
            }))
    }
    pub(crate) async fn check_ssh(&self, id: &str) -> Result<(), String> {
        let value = query_value(self.get(id)?.as_ref(), "environment".into(), json!({})).await?;
        validate_descriptor(&value, Some(id))
    }
    pub(crate) async fn replace_ssh(
        &self,
        id: &str,
        expected: &SshBinding,
        endpoint: &str,
        valid: impl Fn() -> bool,
    ) -> Result<(), String> {
        let gate = self
            .inner
            .lock()
            .map_err(|_| "Registry lock failed")?
            .registration
            .entry(id.into())
            .or_default()
            .clone();
        let _registration = gate.lock().await;
        {
            let inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
            if inner
                .metadata
                .environments
                .get(id)
                .and_then(|saved| saved.ssh.as_ref())
                != Some(expected)
                || expected.paused
                || !valid()
            {
                return Err("Connection changed or paused during reconnection".into());
            }
        }
        let state = self.get(id)?;
        let endpoint = validate_endpoint(endpoint)?;
        if !is_loopback(&endpoint) {
            return Err("Managed SSH routes must remain loopback-only".into());
        }
        let candidate = Self::connection(&self.directory.join("environments"), id, &endpoint)?;
        #[cfg(test)]
        if self.fixture_identity {
            tests::identify(&candidate);
        }
        let value = query_value(&candidate, "environment".into(), json!({})).await?;
        validate_descriptor(&value, Some(id))?;
        let _mutation = state.mutation.lock().await;
        let mut inner = self.inner.lock().map_err(|_| "Registry lock failed")?;
        let mut metadata = inner.metadata.clone();
        let saved = metadata
            .environments
            .get_mut(id)
            .ok_or("Environment removed during reconnection")?;
        if saved.ssh.as_ref() != Some(expected) || expected.paused || !valid() {
            return Err("Connection changed or paused during reconnection".into());
        }
        // Replace only the route explicitly owned by this binding. Manual routes stay intact.
        saved
            .routes
            .retain(|route| route != &expected.route && route != &endpoint);
        saved.routes.push(endpoint.clone());
        saved.active_route = endpoint.clone();
        saved.ssh = Some(SshBinding {
            route: endpoint.clone(),
            ..expected.clone()
        });
        metadata.validate()?;
        private_write(
            &self.directory.join("environments/registry.json"),
            &serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
        )?;
        state.activate_route(endpoint)?;
        state.route_available.store(true, Ordering::SeqCst);
        inner.metadata = metadata;
        inner
            .lifecycle
            .insert(id.into(), json!({"state":"connected","error":null}));
        Ok(())
    }
}
