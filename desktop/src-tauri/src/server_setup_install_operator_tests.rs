//! Pure/synthetic tests: never call boundary(), execute(), Security.framework or a broker.
use super::*;
use std::sync::atomic::AtomicUsize;

const PRESERVED_PEER: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

struct PeerInitializationFixture {
    root: PathBuf,
    entries: Value,
}
impl PeerInitializationFixture {
    fn new(phase: &str) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let root =
            std::env::temp_dir().join(format!("outpost-peer-preservation-test-{}", Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        for directory in ["server-setup", "server-setup/restart-recovery"] {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(root.join(directory))
                .unwrap();
        }
        let peer = json!({"id":PRESERVED_PEER,"label":"Unrelated synthetic peer",
            "target":{"host":"preserved-peer.invalid","user":"fixture","port":22,"identityFile":null},
            "fingerprint":"synthetic-peer-fingerprint","phase":phase,"inspection":null,"recommendation":null,
            "endpoint":"http://127.0.0.1:39481","error":"sentinel-peer-error","log":["sentinel-peer-log"],
            "plan":null,"installation":null,"connectionPaused":false});
        let mut fresh = peer.clone();
        fresh["id"] = json!(FRESH);
        fresh["phase"] = json!("tunnel_ready");
        let fixture = Self {
            root,
            entries: json!({(PRESERVED_PEER):peer,(FRESH):fresh}),
        };
        private_write(
            &fixture.root.join(RESET_FILE),
            &serde_json::to_vec(&json!({"schemaVersion":1,"records":{}})).unwrap(),
        )
        .unwrap();
        fixture.save_entries();
        fixture
    }
    fn save_entries(&self) {
        private_write(
            &self.root.join("server-setup/entries.json"),
            &serde_json::to_vec(&self.entries).unwrap(),
        )
        .unwrap();
    }
    fn assert_refused_without_writes(&self) {
        let entry_path = self.root.join("server-setup/entries.json");
        let reset_path = self.root.join(RESET_FILE);
        let entry_bytes = fs::read(&entry_path).unwrap();
        let entry_stamp = stamp(&fs::metadata(&entry_path).unwrap());
        let reset_bytes = fs::read(&reset_path).unwrap();
        let reset_stamp = stamp(&fs::metadata(&reset_path).unwrap());
        let expected = setup_peer_projection(&self.entries).unwrap();
        let mut callback_called = false;
        let result = initialize_setup(&self.root, &expected).map(|setup| {
            callback_called = true;
            setup.close();
        });
        assert!(result.is_err());
        assert!(!callback_called);
        assert_eq!(fs::read(&entry_path).unwrap(), entry_bytes);
        assert_eq!(stamp(&fs::metadata(&entry_path).unwrap()), entry_stamp);
        assert_eq!(fs::read(&reset_path).unwrap(), reset_bytes);
        assert_eq!(stamp(&fs::metadata(&reset_path).unwrap()), reset_stamp);
        assert_eq!(
            document(&self.root, "server-setup/entries.json").unwrap(),
            self.entries
        );
    }
}
impl Drop for PeerInitializationFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn setup_peer_transient_phases_refuse_before_initialization_writes_or_callback() {
    for phase in ["inspecting", "connecting", "tunnel_ready"] {
        let fixture = PeerInitializationFixture::new(phase);
        fixture.assert_refused_without_writes();
        let preserved = document(&fixture.root, "server-setup/entries.json").unwrap();
        assert_eq!(preserved[PRESERVED_PEER]["phase"], phase);
        assert_eq!(
            preserved[PRESERVED_PEER]["endpoint"],
            "http://127.0.0.1:39481"
        );
        assert_eq!(preserved[PRESERVED_PEER]["error"], "sentinel-peer-error");
        assert_eq!(
            preserved[PRESERVED_PEER]["log"],
            json!(["sentinel-peer-log"])
        );
    }
}

#[test]
fn setup_peer_stable_record_survives_native_initialization_and_later_persistence() {
    let fixture = PeerInitializationFixture::new("review");
    let expected = preserved_setup_peers(
        &fixture.entries,
        &document(&fixture.root, RESET_FILE).unwrap(),
    )
    .unwrap();
    let setup = initialize_setup(&fixture.root, &expected).unwrap();
    assert_eq!(
        serde_json::to_value(setup.entry(PRESERVED_PEER).unwrap()).unwrap(),
        fixture.entries[PRESERVED_PEER]
    );
    let fresh = setup.entry(FRESH).unwrap();
    assert_eq!(fresh.phase, "interrupted");
    assert!(fresh.endpoint.is_none());
    verify_setup_peers(
        &document(&fixture.root, "server-setup/entries.json").unwrap(),
        &expected,
    )
    .unwrap();
    setup
        .record(FRESH, "review", "Synthetic fresh-only lifecycle change")
        .unwrap();
    verify_setup_peers(
        &document(&fixture.root, "server-setup/entries.json").unwrap(),
        &expected,
    )
    .unwrap();
    setup.close();
}

#[test]
fn setup_peer_serialization_defaults_and_unknown_fields_refuse_without_rewriting() {
    for change in 0..8 {
        let mut fixture = PeerInitializationFixture::new("review");
        let peer = &mut fixture.entries[PRESERVED_PEER];
        match change {
            0 => {
                peer.as_object_mut().unwrap().remove("connectionPaused");
            }
            1 => {
                peer.as_object_mut().unwrap().remove("plan");
            }
            2 => {
                peer.as_object_mut().unwrap().remove("error");
            }
            3 => {
                peer["futureField"] = json!("preserve-unknown-field");
            }
            4 => {
                peer["target"]["futureField"] = json!(true);
            }
            5 => {
                peer["plan"] = json!({"planId":Uuid::new_v4(),"operationId":Uuid::new_v4(),"environmentId":Uuid::new_v4(),
                    "releaseId":"host-00000000000000000000","sha256":"0".repeat(64),"size":1,"expiresAt":0,"browser":false,
                    "coexistenceRequired":false,"deviceId":Uuid::new_v4(),"publicKey":STANDARD.encode([7;32]),"nodeVersion":"fixture"});
            }
            6 | 7 => {
                peer["inspection"] = json!({"version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64",
                    "systemd":true,"uid":1000,"freeBytes":0,"memoryBytes":0,"markers":[],"container":false,
                    "sudo":"unknown","api":"absent","environment":null,"apiPort":4318,"nativePresent":false});
                peer["inspection"]
                    .as_object_mut()
                    .unwrap()
                    .remove(if change == 6 {
                        "apiPort"
                    } else {
                        "nativePresent"
                    });
            }
            _ => unreachable!(),
        }
        fixture.save_entries();
        fixture.assert_refused_without_writes();
    }
}

#[test]
fn setup_peer_restart_projection_must_already_be_a_no_op() {
    let fixture = PeerInitializationFixture::new("review");
    let (mut journal, _) = documents();
    journal["records"][RESET]["createdAt"] = json!(1);
    journal["records"][RESET]["affected"]
        .as_array_mut()
        .unwrap()
        .push(json!(PRESERVED_PEER));
    assert_eq!(preserved_setup_peers(&fixture.entries, &journal).unwrap_err(),
        "Native initialization or serialization would change a non-fresh setup; initialization refused");
    private_write(
        &fixture.root.join(RESET_FILE),
        &serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
    fixture.assert_refused_without_writes();
}

#[test]
fn setup_peer_freeze_compares_every_non_fresh_record_field_and_membership() {
    let fixture = PeerInitializationFixture::new("review");
    let expected = preserved_setup_peers(
        &fixture.entries,
        &document(&fixture.root, RESET_FILE).unwrap(),
    )
    .unwrap();
    for field in [
        "label",
        "target",
        "fingerprint",
        "phase",
        "inspection",
        "recommendation",
        "endpoint",
        "error",
        "log",
        "plan",
        "installation",
        "connectionPaused",
        "futureField",
    ] {
        let mut changed = fixture.entries.clone();
        changed[PRESERVED_PEER][field] = json!("sentinel-change");
        assert!(verify_setup_peers(&changed, &expected).is_err(), "{field}");
    }
    let mut changed = fixture.entries.clone();
    changed.as_object_mut().unwrap().remove(PRESERVED_PEER);
    assert!(verify_setup_peers(&changed, &expected).is_err());
    let mut changed = fixture.entries.clone();
    changed[Uuid::new_v4().to_string()] = fixture.entries[PRESERVED_PEER].clone();
    assert!(verify_setup_peers(&changed, &expected).is_err());
    let mut changed = fixture.entries.clone();
    changed[FRESH]["error"] = json!("fresh-only change");
    verify_setup_peers(&changed, &expected).unwrap();
}

#[test]
fn operator_directory_lease_excludes_concurrent_launchers_without_metadata_writes() {
    use std::os::unix::fs::DirBuilderExt;
    let root = std::env::temp_dir().join(format!("outpost-install-lease-test-{}", Uuid::new_v4()));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let lease = OperatorLease::acquire(&root).unwrap();
    assert!(OperatorLease::acquire(&root).is_err());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    drop(lease);
    drop(OperatorLease::acquire(&root).unwrap());
    fs::remove_dir(root).unwrap();
}

fn documents() -> (Value, Value) {
    let device = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let public = STANDARD.encode([7; 32]);
    let source_plan = json!({"deviceId":device,"publicKey":public});
    let source_progress = json!({"operationId":OLD_OPERATION,"state":"failed","completedSteps":4});
    let fresh = json!({"id":FRESH,"label":"Server 2","target":target(),"fingerprint":FINGERPRINT,"phase":"trusted",
        "inspection":null,"recommendation":null,"endpoint":null,"error":null,"log":[],"plan":null,"installation":null,"connectionPaused":false});
    let source = json!({"id":SOURCE,"phase":"reset","connectionPaused":true,"endpoint":null,"plan":source_plan,"installation":source_progress});
    let working = json!({"id":WORKING,"phase":"reset","connectionPaused":true,"endpoint":null,"plan":null,"inspection":null});
    let entries = json!({(FRESH):fresh,(SOURCE):source,(WORKING):working});
    let journal = json!({"schemaVersion":1,"records":{(RESET):{"resetId":RESET,"remoteComplete":true,"localComplete":true,
        "affected":[WORKING,SOURCE],"fresh":fresh,"binding":{"id":WORKING,"sourceId":SOURCE,"target":target(),"fingerprint":FINGERPRINT,
        "sourcePlan":source_plan,"sourceProgress":source_progress,"workingPlan":null,"workingInspection":null,
        "expected":{"operationId":OLD_OPERATION,"environmentId":OLD_ENVIRONMENT,"releaseId":"host-fa9eb6b5d217af95b920",
        "sha256":"f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57","size":223402,"deviceId":device,"publicKey":public}}}}});
    (journal, entries)
}
fn planned() -> (Value, (String, String)) {
    let (journal, mut entries) = documents();
    let identity = completed_reset(&journal, &entries).unwrap();
    entries[FRESH]["plan"] = json!({"planId":Uuid::new_v4(),"operationId":Uuid::new_v4(),"environmentId":Uuid::new_v4(),
        "releaseId":RELEASE,"sha256":ARCHIVE_SHA,"size":ARCHIVE_SIZE,"expiresAt":now()+300000,"browser":true,"fullControl":true,
        "coexistenceRequired":true,"deviceId":identity.0,"publicKey":identity.1,"nodeVersion":"24.22.1"});
    (entries, identity)
}
#[test]
fn exact_opt_ins_and_app_absence_are_required() {
    for (host, fresh) in [
        (None, None),
        (Some(OsStr::new(HOST)), None),
        (Some(OsStr::new("other")), Some(OsStr::new(FRESH))),
        (Some(OsStr::new(HOST)), Some(OsStr::new(OLD_OPERATION))),
    ] {
        assert!(opt_in(host, fresh).is_err());
    }
    opt_in(Some(OsStr::new(HOST)), Some(OsStr::new(FRESH))).unwrap();
    assert!(app_status(Some(0)).is_err());
    assert!(app_status(Some(2)).is_err());
    assert!(app_status(None).is_err());
    app_status(Some(1)).unwrap();
}
#[test]
fn only_normal_same_reset_completion_releases_the_fresh_operator() {
    let (journal, entries) = documents();
    completed_reset(&journal, &entries).unwrap();
    for field in ["remoteComplete", "localComplete"] {
        let mut changed = journal.clone();
        changed["records"][RESET][field] = json!(false);
        assert!(completed_reset(&changed, &entries).is_err());
    }
    for field in ["resetId", "fresh"] {
        let mut changed = journal.clone();
        changed["records"][RESET][field] = Value::Null;
        assert!(completed_reset(&changed, &entries).is_err());
    }
    let mut changed = journal.clone();
    changed["records"][RESET]["binding"]["expected"]["operationId"] = json!(Uuid::new_v4());
    assert!(completed_reset(&changed, &entries).is_err());
    let mut changed = entries.clone();
    changed[SOURCE]["phase"] = json!("restart_pending");
    assert!(completed_reset(&journal, &changed).is_err());
    let mut changed = entries;
    changed[SOURCE]["plan"]["deviceId"] = json!(Uuid::new_v4());
    assert!(completed_reset(&journal, &changed).is_err());
}
#[test]
fn fresh_plan_is_identity_capability_bundle_and_original_id_bound() {
    let (entries, identity) = planned();
    let entry = fresh_entry(&entries, &identity).unwrap();
    assert!(needs_launch(&entry));
    for field in ["browser", "fullControl"] {
        let mut changed = entries.clone();
        changed[FRESH]["plan"][field] = json!(false);
        assert!(fresh_entry(&changed, &identity).is_err());
    }
    for (field, value) in [
        ("operationId", OLD_OPERATION),
        ("environmentId", OLD_ENVIRONMENT),
        ("planId", FRESH),
        ("deviceId", FRESH),
        ("releaseId", "host-00000000000000000000"),
    ] {
        let mut changed = entries.clone();
        changed[FRESH]["plan"][field] = json!(value);
        assert!(fresh_entry(&changed, &identity).is_err());
    }
    let mut changed = entries.clone();
    changed[FRESH]["target"]["port"] = json!(2222);
    assert!(fresh_entry(&changed, &identity).is_err());
    let mut changed = entries;
    changed[SOURCE]["plan"]["operationId"] = json!(entry.plan.as_ref().unwrap().operation_id);
    assert!(fresh_entry(&changed, &identity).is_err());
}
#[test]
fn every_existing_receipt_forbids_a_second_launch_including_unknown() {
    let (entries, identity) = planned();
    let mut entry = fresh_entry(&entries, &identity).unwrap();
    let plan = entry.plan.as_ref().unwrap();
    for (state, steps) in [
        ("authorizing", 0),
        ("unknown", 0),
        ("queued", 0),
        ("running", 4),
        ("ready", 10),
        ("failed", 4),
        ("cancelled", 4),
        ("interrupted", 4),
        ("complete", 12),
    ] {
        entry.installation = Some(InstallProgress {
            operation_id: plan.operation_id.clone(),
            environment_id: plan.environment_id.clone(),
            release_id: plan.release_id.clone(),
            state: state.into(),
            completed_steps: steps,
            total_steps: 12,
            stage: "private-output-canary".into(),
            started_at: 1,
            updated_at: 2,
            log: vec!["never print".into()],
            error: None,
            remote_updated_at: None,
        });
        assert!(!needs_launch(&entry));
    }
}
#[test]
fn peer_projection_excludes_only_the_bound_new_environment() {
    let original = json!({"version":1,"legacyMutationsRetired":false,"selectedEnvironmentId":"peer",
        "environments":{"peer":{"label":"keep","routes":["http://127.0.0.1:99"]},"new":{"label":"before"}}});
    let baseline = peer_projection(original.clone(), Some("new")).unwrap();
    let mut changed = original.clone();
    changed["environments"]["new"]["label"] = json!("after");
    assert_eq!(peer_projection(changed, Some("new")).unwrap(), baseline);
    for field in ["selectedEnvironmentId", "legacyMutationsRetired"] {
        let mut changed = original.clone();
        changed[field] = Value::Null;
        assert_ne!(peer_projection(changed, Some("new")).unwrap(), baseline);
    }
    let mut changed = original;
    changed["environments"]["peer"]["label"] = json!("changed");
    assert_ne!(peer_projection(changed, Some("new")).unwrap(), baseline);
}
struct FakePolicy {
    allowed: Arc<AtomicBool>,
    fail_set: bool,
}
impl InteractionPolicy for FakePolicy {
    fn get(&self) -> OperatorResult<bool> {
        Ok(self.allowed.load(Ordering::SeqCst))
    }
    fn set(&self, value: bool) -> OperatorResult<()> {
        if self.fail_set {
            Err("synthetic policy refusal")
        } else {
            self.allowed.store(value, Ordering::SeqCst);
            Ok(())
        }
    }
}
#[test]
fn interaction_guard_suppresses_and_restores_previous_policy_on_success_and_error() {
    for previous in [true, false] {
        let state = Arc::new(AtomicBool::new(previous));
        {
            let mut guard = NoInteraction::enter(FakePolicy {
                allowed: state.clone(),
                fail_set: false,
            })
            .unwrap();
            assert!(!state.load(Ordering::SeqCst));
            guard.restore().unwrap();
        }
        assert_eq!(state.load(Ordering::SeqCst), previous);
        {
            let _guard = NoInteraction::enter(FakePolicy {
                allowed: state.clone(),
                fail_set: false,
            })
            .unwrap();
            assert!(!state.load(Ordering::SeqCst));
        }
        assert_eq!(state.load(Ordering::SeqCst), previous);
    }
    assert!(NoInteraction::enter(FakePolicy {
        allowed: Arc::new(AtomicBool::new(true)),
        fail_set: true
    })
    .is_err());
}
struct FakeStore {
    bytes: Option<Vec<u8>>,
    writes: Arc<AtomicUsize>,
    fail: bool,
}
impl IdentityStore for FakeStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        if self.fail {
            Err("synthetic locked Keychain".into())
        } else {
            Ok(self.bytes.clone())
        }
    }
    fn write(&self, _: &[u8]) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[test]
fn existing_only_identity_reader_never_creates_or_replaces_a_missing_or_locked_key() {
    for fail in [true, false] {
        let writes = Arc::new(AtomicUsize::new(0));
        let store = environments::ExistingIdentityStore(FakeStore {
            bytes: None,
            writes: writes.clone(),
            fail,
        });
        assert!(load_identity(&store).is_err());
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert!(store.write(b"forbidden").is_err());
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }
    let writes = Arc::new(AtomicUsize::new(0));
    let store = environments::ExistingIdentityStore(FakeStore {
        bytes: Some(
            serde_json::to_vec(&json!({"id":FRESH,"key":STANDARD.encode([9;32])})).unwrap(),
        ),
        writes: writes.clone(),
        fail: false,
    });
    assert_eq!(load_identity(&store).unwrap().id, FRESH);
    assert_eq!(writes.load(Ordering::SeqCst), 0);
}
#[test]
fn health_requires_signed_identity_capabilities_and_exact_worker_manifest() {
    let (entries, identity) = planned();
    let plan = fresh_entry(&entries, &identity).unwrap().plan.unwrap();
    let environment = json!({"environmentId":plan.environment_id,"protocolVersion":2,"supportedProtocolVersions":[2],"legacyUnboundRequests":false,
        "runtime":{"release":RELEASE},"services":{"worker":{"configured":true},"hostAdministration":{"configured":true}}});
    let runtime = json!({"piManagement":true,"configured":true,"hostAdministration":true,"browserEngine":"camoufox","browserDirect":true,"browserTakeover":true});
    let manifest = json!({"manifest":{"id":RELEASE,"piVersion":"fixture","extensions":[]}});
    let inventory = json!({"releaseId":RELEASE,"manifest":manifest["manifest"],"piVersion":"fixture","extensions":[]});
    verify_health(&environment, &runtime, &inventory, &plan, &manifest).unwrap();
    let mut wrong = environment.clone();
    wrong["environmentId"] = json!(OLD_ENVIRONMENT);
    assert!(verify_health(&wrong, &runtime, &inventory, &plan, &manifest).is_err());
    let mut wrong = runtime.clone();
    wrong["browserEngine"] = Value::Null;
    assert!(verify_health(&environment, &wrong, &inventory, &plan, &manifest).is_err());
    let mut wrong = inventory;
    wrong["manifest"]["id"] = json!("other");
    assert!(verify_health(&environment, &runtime, &wrong, &plan, &manifest).is_err());
}
