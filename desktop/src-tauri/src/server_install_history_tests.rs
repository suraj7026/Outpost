use super::super::diagnostic_test_support::Fixture;
use super::*;

#[test]
fn stopped_four_of_twelve_cannot_be_retried_and_diagnostics_cannot_authorize_install() {
    let fixture = Fixture::new();
    let plan = fixture.entry.plan.as_ref().unwrap();
    let before = serde_json::to_value(fixture.setup.entry(&fixture.entry.id).unwrap()).unwrap();
    let result = fixture.setup.start_install(
        &fixture.entry.id,
        &plan.plan_id,
        true,
        false,
        false,
        fixture.root.join("missing-release"),
        (plan.device_id.clone(), plan.public_key.clone()),
    );
    assert!(result.unwrap_err().contains("already has a receipt"));
    assert_eq!(
        serde_json::to_value(fixture.setup.entry(&fixture.entry.id).unwrap()).unwrap(),
        before
    );
    let guard = fixture
        .setup
        .activity(&fixture.entry.id, history::ActivityKind::Diagnostics)
        .unwrap();
    let result = fixture.setup.start_install(
        &fixture.entry.id,
        &plan.plan_id,
        true,
        false,
        false,
        fixture.root.join("missing-release"),
        (plan.device_id.clone(), plan.public_key.clone()),
    );
    assert!(result.unwrap_err().contains("local operation"));
    drop(guard);
    assert!(fixture.setup.inner.lock().unwrap().running.is_empty());
}

#[test]
fn active_observation_reveals_even_when_journal_rejects_regressing_receipt() {
    let fixture = Fixture::new();
    let path = fixture.setup.directory.join("history.json");
    private_write(
        &path,
        &serde_json::to_vec(&json!({"schemaVersion":1,"archived":[fixture.entry.id]})).unwrap(),
    )
    .unwrap();
    let mut progress = fixture.entry.installation.clone().unwrap();
    progress.state = "running".into();
    progress.completed_steps = 3;
    progress.updated_at = 99;
    let stored = fixture
        .setup
        .store_install(&fixture.entry.id, progress, InstallProgressSource::Remote)
        .unwrap();
    assert_eq!(stored.installation.unwrap().state, "failed");
    let history: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(history["archived"], json!([]));
}
