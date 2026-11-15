use super::super::diagnostic_test_support::Fixture;
use super::*;

#[test]
fn archive_is_private_reversible_and_preserves_journal_trust_and_connections() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let setup = &fixture.setup;
    let id = &fixture.entry.id;
    let journal = fs::read(setup.directory.join("entries.json")).unwrap();
    let pin = fs::read(setup.directory.join(format!("{id}.known_hosts"))).unwrap();
    assert_eq!(setup.history_archive(id).unwrap(), vec![id.clone()]);
    assert_eq!(
        setup.list().unwrap().len(),
        1,
        "Connection recovery still sees archived entries"
    );
    assert_eq!(
        fs::read(setup.directory.join("entries.json")).unwrap(),
        journal
    );
    assert_eq!(
        fs::read(setup.directory.join(format!("{id}.known_hosts"))).unwrap(),
        pin
    );
    assert_eq!(
        fs::metadata(setup.directory.join("history.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let reopened = Setup::new(fixture.root.clone()).unwrap();
    assert_eq!(reopened.history_list().unwrap(), vec![id.clone()]);
    assert!(reopened.history_restore(id).unwrap().is_empty());
    assert!(setup.history_list().unwrap().is_empty());
}
#[test]
fn archive_requires_fresh_bound_inactive_status_and_not_a_monotonic_local_receipt() {
    let fixture = Fixture::new();
    let mut receipt = serde_json::to_value(&fixture.entry.installation).unwrap();
    for state in ["unknown", "running", "queued"] {
        receipt["state"] = json!(state);
        fixture.receipt(&receipt);
        assert!(fixture.setup.history_archive(&fixture.entry.id).is_err());
    }
    receipt["state"] = json!("failed");
    receipt["updatedAt"] = json!(99);
    fixture.receipt(&receipt);
    assert!(fixture.setup.history_archive(&fixture.entry.id).is_err());
    receipt["updatedAt"] = json!(102);
    receipt["completedSteps"] = json!(3);
    fixture.receipt(&receipt);
    assert!(fixture.setup.history_archive(&fixture.entry.id).is_err());
    receipt["completedSteps"] = json!(4);
    receipt["environmentId"] = json!(Uuid::new_v4().to_string());
    fixture.receipt(&receipt);
    assert!(fixture.setup.history_archive(&fixture.entry.id).is_err());
    fs::remove_file(fixture.root.join("receipt.json")).unwrap();
    assert!(fixture
        .setup
        .history_archive(&fixture.entry.id)
        .unwrap_err()
        .contains("fresh"));
    assert!(fixture.setup.history_list().unwrap().is_empty());
}
#[test]
fn active_observation_reveals_archived_history_without_disconnect() {
    let fixture = Fixture::new();
    fixture.setup.history_archive(&fixture.entry.id).unwrap();
    let mut receipt = serde_json::to_value(&fixture.entry.installation).unwrap();
    receipt["state"] = json!("running");
    receipt["updatedAt"] = json!(102);
    fixture.receipt(&receipt);
    // The install command path reveals activity even when a monotonic merge might reject it.
    let progress = fixture
        .setup
        .read_install_status(&fixture.entry, false)
        .unwrap();
    assert!(active_install_state(&progress.state));
    {
        let mut inner = fixture.setup.inner.lock().unwrap();
        inner
            .entries
            .get_mut(&fixture.entry.id)
            .unwrap()
            .installation = Some(progress);
    }
    assert!(fixture.setup.history_list().unwrap().is_empty());
    assert!(fixture.setup.history_archive(&fixture.entry.id).is_err());
    assert!(
        !fixture
            .setup
            .entry(&fixture.entry.id)
            .unwrap()
            .connection_paused
    );
}
#[test]
fn connection_recovery_does_not_unarchive_terminal_installation_history() {
    let fixture = Fixture::new();
    fixture.setup.history_archive(&fixture.entry.id).unwrap();
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&fixture.entry.id)
        .unwrap()
        .phase = "connecting".into();
    assert_eq!(
        fixture.setup.history_list().unwrap(),
        vec![fixture.entry.id.clone()]
    );
    assert!(
        fixture.setup.history_archive(&fixture.entry.id).is_err(),
        "A new archive request is still blocked during local work"
    );
}
#[test]
fn local_busy_and_duplicate_targets_are_blocked_but_peers_are_independent() {
    let fixture = Fixture::new();
    let id = &fixture.entry.id;
    let guard = fixture
        .setup
        .activity(id, ActivityKind::Diagnostics)
        .unwrap();
    assert!(fixture.setup.history_archive(id).is_err());
    assert!(fixture.setup.begin(id).is_err());
    let mut peer = fixture.entry.clone();
    peer.id = Uuid::new_v4().to_string();
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(peer.id.clone(), peer.clone());
    assert!(
        fixture.setup.begin(&peer.id).is_err(),
        "Same host under a second entry must not bypass ownership"
    );
    peer.target.host = "other.example".into();
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(peer.id.clone(), peer.clone());
    assert!(fixture.setup.begin(&peer.id).is_ok());
    drop(guard);
    assert!(fixture.setup.history_archive(id).is_ok());
}
#[test]
fn archive_of_preinstall_history_needs_no_ssh_and_corrupt_metadata_fails_closed() {
    let fixture = Fixture::new();
    {
        let mut inner = fixture.setup.inner.lock().unwrap();
        let entry = inner.entries.get_mut(&fixture.entry.id).unwrap();
        entry.installation = None;
        entry.phase = "trusted".into();
    }
    fs::remove_file(fixture.root.join("receipt.json")).unwrap();
    assert!(fixture.setup.history_archive(&fixture.entry.id).is_ok());
    fs::write(fixture.setup.directory.join("history.json"), b"invalid").unwrap();
    assert!(fixture.setup.history_list().is_err());
    assert_eq!(
        fixture.setup.list().unwrap().len(),
        1,
        "Visibility metadata cannot break connection recovery"
    );
}
