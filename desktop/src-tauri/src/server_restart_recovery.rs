//! Operator-only same-reset recovery. Compiled only with the guarded test operator, never IPC.
use super::*;

fn same_pending(a: &journal::Pending, b: &journal::Pending) -> Result<bool, String> {
    Ok(serde_json::to_value(a).map_err(|_| "Invalid held restart")?
        == serde_json::to_value(b).map_err(|_| "Invalid held restart")?)
}

impl CachedReview {
    fn recovery(&self) -> Result<(), String> {
        self.current()?;
        if !self
            .recovery_token
            .as_deref()
            .is_some_and(recovery_token_valid)
            || self.recovery_pending.is_none()
            || self.recovery_registry.is_none()
        {
            return Err("A fresh operator recovery review is required".into());
        }
        Ok(())
    }
}

impl Setup {
    fn check_restart_recovery(&self, request: &Request) -> Result<(), String> {
        self.check_restart_request(request)?;
        let reserved = request
            .recovery_pending
            .as_ref()
            .ok_or("Held restart reservation missing")?;
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let entry = inner
            .entries
            .get(&request.binding.id)
            .ok_or("Working setup missing")?;
        let memory = inner
            .restart_journal
            .recovery_pending(entry, &request.reset_id)?;
        let disk = Journal::read(&self.directory)?;
        let durable = disk.recovery_pending(entry, &request.reset_id)?;
        if !same_pending(memory, reserved)?
            || !same_pending(durable, reserved)?
            || reserved.binding != request.binding
            || affected_setup_ids(&inner, &request.binding) != reserved.affected
            || entry.phase != "restart_pending"
            || !entry.connection_paused
            || entry.endpoint.is_some()
        {
            return Err("Held restart identity, affected setups or durable journal changed; check the same restart outcome".into());
        }
        reserved.require_unpublished_fresh(&inner)?;
        Ok(())
    }

    pub(super) fn reserve_restart_recovery(
        &self,
        id: &str,
        reset_id: &str,
        password: bool,
    ) -> Result<Request, String> {
        environments::validate_id(reset_id)?;
        let guard = self.activity(id, ActivityKind::Restart)?;
        let pending = {
            let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            inner
                .restart_journal
                .recovery_pending(&guard.entry, reset_id)?
                .clone()
        };
        let request = Request {
            guard,
            binding: pending.binding.clone(),
            reset_id: reset_id.into(),
            password,
            recovery_pending: Some(pending),
        };
        self.check_restart_recovery(&request)?;
        self.inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .restart_reviews
            .retain(|v| !same_host(&v.binding.target, &request.binding.target));
        Ok(request)
    }

    pub(super) fn restart_recovery_review_with(
        &self,
        request: Request,
        registry: &environments::Registry,
        auth: impl FnOnce(
            &Entry,
            &str,
            bool,
            &AtomicBool,
        ) -> Result<Zeroizing<Vec<u8>>, AuthorizationError>,
    ) -> Result<RestartReview, String> {
        self.check_restart_recovery(&request)?;
        let pending = request
            .recovery_pending
            .as_ref()
            .ok_or("Held restart reservation missing")?;
        let fence = registry.reserve_restart_fence(&request.binding.expected.environment_id)?;
        let snapshot = registry.restart_recovery_snapshot(&fence, &pending.affected)?;
        let input = self.restart_input(&request, "recover_review", auth)?;
        self.check_restart_recovery(&request)?;
        if registry.restart_recovery_snapshot(&fence, &pending.affected)? != snapshot {
            return Err("Restart fence changed during recovery authorization".into());
        }
        let bytes = self.call_restart_helper(&request, "recover_review", None, input)?;
        self.check_restart_recovery(&request)?;
        if registry.restart_recovery_snapshot(&fence, &pending.affected)? != snapshot {
            return Err("Restart fence changed during recovery review".into());
        }
        let parsed = (|| {
            let wire: WireReview =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid recovery review")?;
            let cached = validate_review(wire, &request)?;
            match (cached.review.can_reset, cached.recovery_token.as_deref()) {
                (true, Some(token)) if recovery_token_valid(token) => {}
                (false, None) => {}
                _ => return Err("Invalid recovery preparation token".into()),
            }
            Ok(cached)
        })();
        let mut cached = parsed.map_err(|_: String| "[serverProtocol:recover_review] The recovery review failed identity, scope or preparation validation; no cleanup was requested.")?;
        cached.recovery_pending = Some(pending.clone());
        cached.recovery_registry = Some(snapshot);
        let review = cached.review.clone();
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        inner.restart_reviews.retain(|v| {
            v.review.expires_at > now() && !same_host(&v.binding.target, &request.binding.target)
        });
        if inner.restart_reviews.len() >= 32 {
            inner.restart_reviews.remove(0);
        }
        inner.restart_reviews.push(cached);
        Ok(review)
    }

    pub(super) fn reserve_restart_recovery_apply(
        &self,
        id: &str,
        review_id: &str,
        host: &str,
        password: bool,
    ) -> Result<ApplyRequest, String> {
        let guard = self.activity(id, ActivityKind::Restart)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let index = inner
            .restart_reviews
            .iter()
            .position(|v| v.binding.id == id && v.review.review_id == review_id)
            .ok_or("Recovery review is missing or replaced; review again")?;
        let cached = inner.restart_reviews[index].clone();
        cached.recovery()?;
        if host != cached.review.host {
            return Err("Type the exact reviewed hostname to confirm removal".into());
        }
        inner.restart_reviews.remove(index);
        drop(inner);
        let request = Request {
            guard,
            binding: cached.binding.clone(),
            reset_id: cached.review.reset_id.clone(),
            password,
            recovery_pending: cached.recovery_pending.clone(),
        };
        self.check_restart_recovery(&request)?;
        Ok(ApplyRequest { request, cached })
    }

    pub(super) fn restart_recovery_apply_with(
        &self,
        apply: ApplyRequest,
        registry: &environments::Registry,
        auth: impl FnOnce(
            &Entry,
            &str,
            bool,
            &AtomicBool,
        ) -> Result<Zeroizing<Vec<u8>>, AuthorizationError>,
    ) -> Result<RestartResult, String> {
        let ApplyRequest { request, cached } = apply;
        cached.recovery()?;
        self.check_restart_recovery(&request)?;
        let pending = request
            .recovery_pending
            .as_ref()
            .ok_or("Held restart reservation missing")?;
        if cached.binding != request.binding
            || cached.review.reset_id != request.reset_id
            || !same_pending(
                pending,
                cached
                    .recovery_pending
                    .as_ref()
                    .ok_or("Recovery review missing")?,
            )?
        {
            return Err("Recovery review no longer matches the held restart".into());
        }
        let fence = registry.reserve_restart_fence(&request.binding.expected.environment_id)?;
        let snapshot = registry.restart_recovery_snapshot(&fence, &pending.affected)?;
        if cached.recovery_registry.as_ref() != Some(&snapshot) {
            return Err("Restart registry changed since recovery review; review again".into());
        }
        let input = self.restart_input(&request, "apply", auth)?;
        cached.recovery()?;
        self.check_restart_recovery(&request)?;
        if registry.restart_recovery_snapshot(&fence, &pending.affected)? != snapshot {
            return Err("Restart fence changed during recovery authorization".into());
        }
        // The existing journal/fence remain authoritative. Never prepare or commit another reset.
        let outcome = self.call_restart_helper_with_token(
            &request, "recover_apply", Some(&cached.snapshot_digest),
            cached.recovery_token.as_deref(), input,
        ).and_then(|bytes| parse_result(&bytes, &request).map_err(|_| "[serverProtocol:recover_apply] The recovery cleanup response failed outcome validation. Check the same restart outcome; do not replay cleanup.".into()));
        let validation = self.check_restart_recovery(&request).and_then(|()| {
            if registry.restart_recovery_snapshot(&fence, &pending.affected)? != snapshot {
                return Err("Restart fence changed during recovery cleanup".into());
            }
            Ok(())
        });
        drop(fence);
        if let Err(error) = validation {
            // A changed durable record must not be overwritten even by completion bookkeeping.
            let mut result = pending.held("unknown");
            result.message = format!("{error} {}", result.message);
            return Ok(result);
        }
        let mut result = self.reconcile_restart(
            &request.reset_id,
            outcome.as_ref().map_or("unknown", |v| v.state.as_str()),
            outcome
                .as_ref()
                .ok()
                .filter(|v| v.state == "failed")
                .map(|v| v.message.as_str()),
            registry,
        )?;
        if let Err(error) = outcome {
            result.message = format!("{error} {}", result.message);
        }
        Ok(result)
    }
}
