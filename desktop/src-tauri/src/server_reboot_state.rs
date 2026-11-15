//! Lock order is control -> reviews. Shutdown and operation admission share the same fence.
use super::*;

const MAX_HOSTS: usize = 64;
const HOST_BUSY: &str = "This pinned server already has an active or uncertain reboot request. Check that request's status; do not dispatch another reboot.";

#[derive(Default)]
pub(super) struct Control {
    closed: bool,
    running: usize,
    hosts: Vec<Host>,
}
struct Host {
    names: std::collections::BTreeSet<String>,
    fingerprints: std::collections::BTreeSet<String>,
    generation: u64,
    active: Option<Attempt>,
}
struct Attempt {
    review_id: String,
    dispatched: bool,
}
impl Host {
    fn matches(&self, target: &Target) -> bool {
        // OS reboot affects every user, port and environment. Keep observed aliases even
        // across a pin change; cloned keys conservatively serialize distinct hosts too.
        self.fingerprints.contains(&target.fingerprint)
            || self.names.contains(&restart::canonical_host(&target.host))
    }
}
impl Control {
    fn host(&mut self, target: &Target) -> Result<&mut Host, String> {
        let matches: Vec<_> = self
            .hosts
            .iter()
            .enumerate()
            .filter(|(_, host)| host.matches(target))
            .map(|(i, _)| i)
            .collect();
        let index = match matches.as_slice() {
            [index] => *index,
            [] => {
                if self.hosts.len() >= MAX_HOSTS { return Err("Reboot host history is full; no host safety records were discarded.".into()); }
                self.hosts.push(Host { names: Default::default(), fingerprints: Default::default(), generation: 0, active: None });
                self.hosts.len() - 1
            }
            _ => return Err("Overlapping SSH host identities have reboot history. Resolve the saved host identity before rebooting.".into()),
        };
        let host = &mut self.hosts[index];
        let name = restart::canonical_host(&target.host);
        if (!host.names.contains(&name) && host.names.len() >= 64)
            || (!host.fingerprints.contains(&target.fingerprint) && host.fingerprints.len() >= 64)
        {
            return Err(
                "Reboot host identity history is full; no safety records were discarded.".into(),
            );
        }
        host.names.insert(name);
        host.fingerprints.insert(target.fingerprint.clone());
        Ok(host)
    }
}

pub(super) struct Slot<'a>(&'a Reboots);
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut control = self.0.control.lock().unwrap_or_else(|e| e.into_inner());
        control.running -= 1;
        self.0.drained.notify_all();
    }
}
pub(super) struct Reservation<'a> {
    reboots: &'a Reboots,
    id: String,
    target: Target,
}
impl Reservation<'_> {
    pub(super) fn dispatch(&self) -> Result<(), String> {
        let mut control = self
            .reboots
            .control
            .lock()
            .map_err(|_| "Reboot supervisor lock failed")?;
        if control.closed {
            return Err("Reboot cancelled before dispatch.".into());
        }
        let host = control.host(&self.target)?;
        let attempt = host
            .active
            .as_mut()
            .filter(|a| a.review_id == self.id)
            .ok_or("Reboot no longer owns this server reservation")?;
        let mut reviews = self
            .reboots
            .reviews
            .lock()
            .map_err(|_| "Reboot review lock failed")?;
        let review = reviews
            .get_mut(&self.id)
            .ok_or("Reboot review expired before dispatch")?;
        if review.created.elapsed() >= REVIEW_TTL {
            return Err("Reboot review expired before dispatch. Review again.".into());
        }
        attempt.dispatched = true;
        review.dispatched = Some(Instant::now());
        Ok(())
    }
    pub(super) fn guard_rejected(&self) -> Result<(), String> {
        let mut control = self
            .reboots
            .control
            .lock()
            .map_err(|_| "Reboot supervisor lock failed")?;
        if let Some(attempt) = control
            .host(&self.target)?
            .active
            .as_mut()
            .filter(|a| a.review_id == self.id)
        {
            attempt.dispatched = false;
        }
        let mut reviews = self
            .reboots
            .reviews
            .lock()
            .map_err(|_| "Reboot review lock failed")?;
        if let Some(review) = reviews.get_mut(&self.id) {
            review.dispatched = None;
            review.guard_passed = Some(false);
        }
        Ok(())
    }
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut control = self
            .reboots
            .control
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Ok(host) = control.host(&self.target) {
            if host
                .active
                .as_ref()
                .is_some_and(|a| a.review_id == self.id && !a.dispatched)
            {
                host.active = None;
            }
        }
    }
}
impl Reboots {
    pub(super) fn cancel(&self) {
        let mut control = self.control.lock().unwrap_or_else(|e| e.into_inner());
        control.closed = true;
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn close(&self) {
        self.cancel();
        let mut control = self.control.lock().unwrap_or_else(|e| e.into_inner());
        // Every admitted operation holds its slot until all owned SSH/prompt children have
        // been killed and reaped. Queued workers cannot acquire a slot after this fence.
        while control.running != 0 {
            control = self
                .drained
                .wait(control)
                .unwrap_or_else(|e| e.into_inner());
        }
    }
    pub(super) fn slot(&self) -> Result<Slot<'_>, String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Reboot supervisor lock failed")?;
        if control.closed {
            return Err("Reboot supervisor is stopping; no new command was dispatched.".into());
        }
        if control.running >= 4 {
            return Err("Too many server checks are running. Wait for a check to finish.".into());
        }
        control.running += 1;
        Ok(Slot(self))
    }
    pub(super) fn review_generation(&self, target: &Target) -> Result<u64, String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Reboot supervisor lock failed")?;
        if control.closed {
            return Err("Reboot supervisor is stopping.".into());
        }
        let host = control.host(target)?;
        if host.active.is_some() {
            return Err(HOST_BUSY.into());
        }
        Ok(host.generation)
    }
    pub(super) fn consume(
        &self,
        id: &str,
        confirmation: &str,
    ) -> Result<(Review, Reservation<'_>), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Reboot supervisor lock failed")?;
        if control.closed {
            return Err("Reboot supervisor is stopping.".into());
        }
        let mut reviews = self
            .reviews
            .lock()
            .map_err(|_| "Reboot review lock failed")?;
        let review = reviews
            .get_mut(id)
            .ok_or("Reboot review is unavailable. Review this server again.")?;
        let host = control.host(&review.bound.target)?;
        if host.active.is_some() {
            return Err(HOST_BUSY.into());
        }
        if host.generation != review.generation {
            return Err("This review predates another reboot attempt. Create a fresh review after its outcome is verified.".into());
        }
        let next = host
            .generation
            .checked_add(1)
            .ok_or("Reboot generation exhausted")?;
        review.consume(confirmation)?;
        let review = review.clone();
        host.generation = next;
        host.active = Some(Attempt {
            review_id: id.into(),
            dispatched: false,
        });
        for sibling in reviews.values_mut() {
            if host.matches(&sibling.bound.target) {
                sibling.consumed = true;
            }
        }
        Ok((
            review.clone(),
            Reservation {
                reboots: self,
                id: id.into(),
                target: review.bound.target,
            },
        ))
    }
    pub(super) fn verified_return(&self, id: &str, review: &Review) -> Result<(), String> {
        let mut control = self
            .control
            .lock()
            .map_err(|_| "Reboot supervisor lock failed")?;
        let host = control.host(&review.bound.target)?;
        if !host
            .active
            .as_ref()
            .is_some_and(|a| a.review_id == id && a.dispatched)
        {
            return Err("Reboot status no longer owns this host generation.".into());
        }
        let next = host
            .generation
            .checked_add(1)
            .ok_or("Reboot generation exhausted")?;
        let mut reviews = self
            .reviews
            .lock()
            .map_err(|_| "Reboot review lock failed")?;
        let current = reviews.get_mut(id).ok_or("Reboot review expired")?;
        if current.guard_passed != Some(true) {
            return Err("The pre-dispatch boot guard was not acknowledged; reboot attribution remains unknown.".into());
        }
        current.returned = true;
        current.checking = false;
        host.active = None;
        host.generation = next;
        Ok(())
    }
}
