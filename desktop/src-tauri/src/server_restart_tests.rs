use super::super::diagnostic_test_support::Fixture;
use super::*;
use std::os::unix::fs::PermissionsExt;

#[path = "server_restart_authorization_tests.rs"]
mod authorization_regressions;
#[path = "server_restart_operator.rs"]
mod operator;
#[path = "server_restart_recovery_tests.rs"]
mod recovery_regressions;
#[path = "server_restart_review_tests.rs"]
mod review_regressions;
#[path = "server_restart_transport_tests.rs"]
mod transport_regressions;

const PEER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
fn allow(
    _: &Entry,
    _: &str,
    password: bool,
    _: &AtomicBool,
) -> Result<Zeroizing<Vec<u8>>, AuthorizationError> {
    Ok(Zeroizing::new(if password {
        b"fixture-secret\n".to_vec()
    } else {
        Vec::new()
    }))
}
fn fixture() -> Fixture {
    let mut f = Fixture::new();
    let path = f.root.join("restart-ssh-fixture");
    fs::write(f.root.join("setup_restart_bootstrap.py"), BOOTSTRAP).unwrap();
    fs::write(f.root.join("qualified-helper.py"), HELPER).unwrap();
    fs::write(&path, r#"#!/usr/bin/python3
import base64,hashlib,json,secrets,sys,pathlib,runpy,shlex,time
root=pathlib.Path(__file__).parent
assert '-oStrictHostKeyChecking=yes' in sys.argv
assert len(sys.argv[-1].encode()) < 8192
command=shlex.split(sys.argv[-1])
stream=sys.stdin.buffer
if command[:6] == ['sudo','-k','-S','-p','','--']:
    assert stream.readline() == b'fixture-secret\n'
    command=command[6:]
elif command[:3] == ['sudo','-n','--']:
    command=command[3:]
assert len(command) == 8 and command[:5] == ['/usr/bin/python3','-I','-B','-S','-c']
loader=base64.b64encode((root/'setup_restart_bootstrap.py').read_bytes()).decode('ascii')
assert command[5] == 'import base64;exec(compile(base64.b64decode("'+loader+'"),"<outpost-restart-bootstrap>","exec"))'
bootstrap=runpy.run_path(str(root/'setup_restart_bootstrap.py'))
source=bootstrap['read_verified_source'](stream, int(command[6]), command[7])
assert source == (root/'qualified-helper.py').read_bytes()
raw=stream.read(16385)
assert len(raw) <= 16384
r=json.loads(raw)
assert r['mode'] in ('review','apply','status','stop','recover_review','recover_apply')
extra={'snapshotDigest','recoveryToken'} if r['mode']=='recover_apply' else {'snapshotDigest'} if r['mode']=='apply' else set()
assert set(r)=={'mode','resetId','expected'}|extra
assert set(r['expected'])=={'operationId','environmentId','releaseId','sha256','size','deviceId','publicKey'}
with (root/'calls').open('a') as out: out.write(json.dumps({'request':r,'args':sys.argv[1:]})+'\n')
if (root/'pause-helper-mode').exists() and (root/'pause-helper-mode').read_text()==r['mode']:
    (root/'helper-entered').touch()
    deadline=time.monotonic()+10
    while not (root/'helper-release').exists():
        assert time.monotonic()<deadline, 'synthetic helper synchronization timed out'
        time.sleep(0.01)
base={'schemaVersion':1,'resetId':r['resetId'],**{k:r['expected'][k] for k in ('operationId','environmentId','releaseId')}}
if r['mode']=='stop':
    assert 'sudo ' in sys.argv[-1]
    (root/'active').unlink(missing_ok=True)
    raise SystemExit(0)
preparation=root/'recovery-preparation.json'
intent=root/'recovery-intent'
def emit(value, patch):
    if (root/patch).exists(): value.update(json.loads((root/patch).read_text()))
    print(json.dumps(value))
if r['mode'] in ('review','recover_review'):
    active=(root/'active').exists()
    v={**base,'snapshotDigest':'b'*64,'paths':['/opt/outpost-native','/etc/outpost-native','/var/lib/outpost-native'],'services':['outpost-native-worker.service','outpost-native-coordinator.service'],'accounts':['user:outpost-pi','group:outpost-pi','group:outpost-workspaces'],'preserved':['/var/lib/outpost-setup/operations','SSH settings and keys'],'warnings':['Deletes native tasks, credentials, configuration and data.'],'blockers':['Installer is active; stop and review again.'] if active else [],'canReset':not active,'state':'running' if active else 'failed','completedSteps':4,'totalSteps':12}
    if (root/'bad-scope').exists(): v['paths'].append('/home')
    if (root/'bad-identity').exists(): v['operationId']='bad'
    if r['mode']=='recover_review':
        reason='Recovery preparation contains deletion intent; no replay allowed.' if intent.exists() else 'Reset is already complete; check the same restart outcome.' if (root/'remote-complete').exists() else None
        if reason:
            v.update(canReset=False, blockers=[reason], services=[], accounts=[])
        if v['canReset']:
            token=secrets.token_hex(32)
            snapshot=hashlib.sha256(token.encode()).hexdigest()
            preparation.write_text(json.dumps({**r,'snapshotDigest':snapshot,'recoveryToken':token}))
            if (root/'interrupt-preparation').exists():
                v.update(canReset=False, blockers=['Recovery preparation publication is unconfirmed.'], services=[], accounts=[])
            else:
                v['snapshotDigest']=snapshot
                v['recoveryToken']=token
        if (root/'omit-recovery-token').exists(): v.pop('recoveryToken',None)
    emit(v, 'review-patch.json')
elif r['mode'] in ('apply','recover_apply'):
    if r['mode']=='recover_apply':
        p=json.loads(preparation.read_text())
        if intent.exists() or any(p[k]!=r[k] for k in ('resetId','expected','snapshotDigest','recoveryToken')):
            emit({**base,'state':'unknown','message':'Recovery preparation changed; no replay allowed.'}, 'result-patch.json')
            raise SystemExit(0)
        intent.write_text('durable intent')
    elif preparation.exists():
        emit({**base,'state':'unknown','message':'Recovery preparation holds this reset.'}, 'result-patch.json')
        raise SystemExit(0)
    else:
        assert r['snapshotDigest']=='b'*64
    assert (root/'server-setup/restart-recovery/journal.json').exists()
    assert r['resetId'] in json.loads((root/'server-setup/restart-recovery/journal.json').read_text())['records']
    assert r['expected']['environmentId'] in json.loads((root/'environments/restart-fences/journal.json').read_text())['environments']
    if (root/'lost').exists(): raise SystemExit(1)
    if (root/'break-registry').exists():
        p=root/'environments/registry.json'
        p.rename(p.with_name('registry.saved'))
        p.mkdir()
    if (root/'break-journal').exists():
        p=root/'server-setup/restart-recovery/journal.json'
        p.rename(p.with_name('journal.saved'))
        p.mkdir()
    if (root/'wrong-outcome').exists(): base['environmentId']='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    emit({**base,'state':'failed' if (root/'apply-failed').exists() else 'complete','message':'Inspected state changed since review; no cleanup started.' if (root/'apply-failed').exists() else 'Reset verified complete.'}, 'result-patch.json')
else:
    assert 'sudo ' not in sys.argv[-1]
    assert r['mode']=='status'
    emit({**base,'state':'complete' if (root/'remote-complete').exists() else 'unknown','message':'Outcome metadata only.'}, 'result-patch.json')
"#).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    f.setup.ssh_fixture = Some(path.to_string_lossy().into_owned());
    f
}
fn registry(f: &Fixture) -> environments::Registry {
    drop(
        environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap(),
    );
    let env = &f.entry.plan.as_ref().unwrap().environment_id;
    private_write(&f.root.join("environments/registry.json"), &serde_json::to_vec(&json!({
        "version":1,"legacyMutationsRetired":false,"selectedEnvironmentId":env,"environments":{
            env:{"environmentId":env,"label":"Original","routes":["http://127.0.0.1:1"],"activeRoute":"http://127.0.0.1:1","ssh":{"setupId":f.entry.id,"route":"http://127.0.0.1:1","paused":false,"generation":0}},
            PEER:{"environmentId":PEER,"label":"Peer","routes":["https://peer.example"],"activeRoute":"https://peer.example"}
        }
    })).unwrap()).unwrap();
    environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap()
}
fn review(f: &Fixture, id: &str) -> RestartReview {
    f.setup
        .restart_review_with(
            f.setup.reserve_restart(id, &f.entry.id, false).unwrap(),
            allow,
        )
        .unwrap()
}
fn apply(f: &Fixture, r: &RestartReview, registry: &environments::Registry) -> RestartResult {
    f.setup
        .restart_apply_with(
            f.setup
                .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
                .unwrap(),
            registry,
            allow,
        )
        .unwrap()
}
fn calls(f: &Fixture) -> Vec<Value> {
    fs::read_to_string(f.root.join("calls"))
        .unwrap_or_default()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn add(f: &Fixture, mut entry: Entry) -> String {
    entry.id = Uuid::new_v4().to_string();
    let (key, _) = parse_key(
        &fs::read_to_string(
            f.setup
                .directory
                .join(format!("{}.known_hosts", f.entry.id)),
        )
        .unwrap(),
    )
    .unwrap();
    private_write(
        &f.setup.directory.join(format!("{}.known_hosts", entry.id)),
        format!("{} {key}\n", Setup::alias(&entry.id)).as_bytes(),
    )
    .unwrap();
    let id = entry.id.clone();
    let mut inner = f.setup.inner.lock().unwrap();
    inner.entries.insert(id.clone(), entry);
    f.setup.persist(&inner).unwrap();
    id
}
fn assert_status_none(setup: &Setup, id: &str, registry: &environments::Registry) {
    let result = setup
        .restart_status(setup.reserve_restart_status(id).unwrap(), registry)
        .unwrap();
    let expected: Value =
        serde_json::from_str(include_str!("../../test-fixtures/restart-status-none.json")).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), expected);
    assert!(setup.inner.lock().unwrap().activities.is_empty());
}

#[test]
fn first_open_status_with_archived_original_plan_matches_shared_none_fixture() {
    let f = fixture();
    let registry = registry(&f);
    f.setup
        .archive_reset_history(&BTreeSet::from([f.entry.id.clone()]))
        .unwrap();
    let mut working = f.entry.clone();
    working.plan = None;
    working.installation = None;
    working.phase = "trusted".into();
    let id = add(&f, working);
    let before = fs::read(f.setup.directory.join("entries.json")).unwrap();
    let history = fs::read(f.setup.directory.join("history.json")).unwrap();
    let journal = fs::read(f.setup.directory.join("restart-recovery/journal.json")).unwrap();
    let mut reopened = Setup::new(f.root.clone()).unwrap();
    reopened.ssh_fixture = f.setup.ssh_fixture.clone();
    assert!(reopened
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
    assert!(reopened.entry(&f.entry.id).unwrap().plan.is_some());
    for setup in [&f.setup, &reopened] {
        for id in [&f.entry.id, &id] {
            assert_status_none(setup, id, &registry);
        }
    }
    assert_eq!(
        fs::read(f.setup.directory.join("entries.json")).unwrap(),
        before
    );
    assert_eq!(
        fs::read(f.setup.directory.join("history.json")).unwrap(),
        history
    );
    assert_eq!(
        fs::read(f.setup.directory.join("restart-recovery/journal.json")).unwrap(),
        journal
    );
    assert!(
        calls(&f).is_empty(),
        "first-open status must not dispatch SSH"
    );
}

#[test]
fn first_open_status_with_empty_journal_and_no_plan_matches_shared_none_fixture() {
    let f = fixture();
    let registry = registry(&f);
    {
        let mut inner = f.setup.inner.lock().unwrap();
        let entry = inner.entries.get_mut(&f.entry.id).unwrap();
        entry.plan = None;
        entry.installation = None;
        entry.phase = "trusted".into();
        f.setup.persist(&inner).unwrap();
    }
    let mut reopened = Setup::new(f.root.clone()).unwrap();
    reopened.ssh_fixture = f.setup.ssh_fixture.clone();
    assert!(reopened
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
    assert!(reopened.restart_candidates(&f.entry.id).unwrap().is_empty());
    for setup in [&f.setup, &reopened] {
        assert_status_none(setup, &f.entry.id, &registry);
    }
    assert!(
        calls(&f).is_empty(),
        "absence needs neither SSH nor authorization"
    );
}

#[test]
fn native_contract_scope_and_purpose_auth_are_separate() {
    let f = fixture();
    let r = review(&f, &f.entry.id);
    let value = serde_json::to_value(&r).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 18);
    assert!(value.get("snapshotDigest").is_none());
    assert_eq!(r.completed_steps, 4);
    assert_eq!(r.paths, PATHS);
    let c = calls(&f);
    assert_eq!(c[0]["request"]["mode"], "review");
    assert_eq!(c[0]["request"]["expected"]["sha256"], "a".repeat(64));
    let command = c[0]["args"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap();
    assert!(command.starts_with("sudo -n -- /usr/bin/python3 -I -B -S -c"));
    assert_eq!(command, format!("sudo -n -- {}", helper_command().unwrap()));
    for mode in ["review", "stop", "apply"] {
        let script = authorization::script(
            authorization::Purpose::from_mode(mode).unwrap(),
            "operator@fixture.example:2222",
            true,
        );
        assert!(script.contains("hidden answer"));
        assert!(script.contains(if mode == "review" {
            "default button \"Review removal scope\""
        } else {
            "default button \"Cancel\""
        }));
        assert!(script.contains("cancel button \"Cancel\""));
        assert!(!script.contains("Authorize installation"));
        assert!(!script.contains("Read protected logs"));
    }
    for marker in ["bad-scope", "bad-identity"] {
        fs::write(f.root.join(marker), b"").unwrap();
        assert!(f
            .setup
            .restart_review_with(
                f.setup
                    .reserve_restart(&f.entry.id, &f.entry.id, false)
                    .unwrap(),
                allow
            )
            .is_err());
        fs::remove_file(f.root.join(marker)).unwrap();
    }
}
#[test]
fn archived_operation_uses_new_working_ssh_and_requires_explicit_source() {
    let f = fixture();
    f.setup
        .archive_reset_history(&BTreeSet::from([f.entry.id.clone()]))
        .unwrap();
    let mut working = f.entry.clone();
    working.target.host = "FIXTURE.EXAMPLE.".into();
    working.target.user = "new-operator".into();
    working.plan = None;
    working.installation = None;
    let key = f.root.join("new-private-key");
    private_write(&key, b"fixture-only").unwrap();
    working.target.identity_file = Some(key.to_string_lossy().into_owned());
    let id = add(&f, working);
    let mut other = f.entry.clone();
    let mut plan = serde_json::to_value(&other.plan).unwrap();
    plan["operationId"] = json!(Uuid::new_v4().to_string());
    other.plan = Some(serde_json::from_value(plan).unwrap());
    other.installation = None;
    let other_id = add(&f, other);
    let candidates = f.setup.restart_candidates(&id).unwrap();
    assert_eq!(candidates.len(), 2);
    assert!(candidates.iter().any(|v| v.id == f.entry.id));
    assert!(candidates.iter().any(|v| v.id == other_id));
    assert!(f.setup.reserve_restart(&id, "", false).is_err());
    let r = review(&f, &id);
    assert_eq!(r.source_id, f.entry.id);
    let c = calls(&f);
    let args = c[0]["args"].as_array().unwrap();
    assert!(args.contains(&json!("new-operator")));
    assert!(args.contains(&json!(key.to_string_lossy())));
    assert!(args.contains(&json!("FIXTURE.EXAMPLE.")));
    assert_eq!(
        c[0]["request"]["expected"]["operationId"],
        f.entry.plan.as_ref().unwrap().operation_id
    );
    assert_eq!(f.setup.history_list().unwrap(), vec![f.entry.id.clone()]);
    let mut spoof = f.entry.clone();
    spoof.target.host = "peer.example".into();
    let spoof_id = add(&f, spoof);
    assert!(f.setup.reserve_restart(&id, &spoof_id, false).is_err());
    f.setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&other_id)
        .unwrap()
        .fingerprint = "SHA256:wrong".into();
    assert_eq!(f.setup.restart_candidates(&id).unwrap().len(), 1);
}
#[test]
fn queued_cancel_and_declined_auth_never_dispatch_or_persist_reset() {
    let f = fixture();
    let r = f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, true)
        .unwrap();
    assert!(f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .is_err());
    f.setup.pause_route(&f.entry.id).unwrap();
    assert!(r.guard.cancel.load(Ordering::SeqCst));
    assert!(f
        .setup
        .restart_review_with(r, |_, _, _, _| panic!("cancelled queued authorization"))
        .is_err());
    assert!(calls(&f).is_empty());
    assert!(f
        .setup
        .restart_review_with(
            f.setup
                .reserve_restart(&f.entry.id, &f.entry.id, true)
                .unwrap(),
            |_, _, _, _| Err(AuthorizationError::UserCancel)
        )
        .is_err());
    assert!(calls(&f).is_empty());
    assert!(f
        .setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
    let registry = registry(&f);
    let r = review(&f, &f.entry.id);
    let request = f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .unwrap();
    f.setup.pause_route(&f.entry.id).unwrap();
    assert!(f
        .setup
        .restart_apply_with(request, &registry, |_, _, _, _| panic!(
            "cancelled queued apply"
        ))
        .is_err());
    assert_eq!(calls(&f).len(), 1);
    assert!(f
        .setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
}
#[test]
fn expired_replaced_changed_and_mistyped_reviews_fail_before_auth() {
    let f = fixture();
    let r = review(&f, &f.entry.id);
    assert!(f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, "wrong", false)
        .is_err());
    f.setup.inner.lock().unwrap().restart_reviews[0]
        .review
        .expires_at = 0;
    assert!(f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .is_err());
    let old = review(&f, &f.entry.id);
    let new = review(&f, &f.entry.id);
    assert!(f
        .setup
        .reserve_restart_apply(&f.entry.id, &old.review_id, &old.host, false)
        .is_err());
    f.setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&f.entry.id)
        .unwrap()
        .target
        .user = "changed".into();
    assert!(f
        .setup
        .reserve_restart_apply(&f.entry.id, &new.review_id, &new.host, false)
        .is_err());
    let registry = registry(&f);
    let r = review(&f, &f.entry.id);
    let request = f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .unwrap();
    assert!(f
        .setup
        .restart_apply_with(request, &registry, |_, _, _, _| {
            f.setup
                .inner
                .lock()
                .unwrap()
                .entries
                .get_mut(&f.entry.id)
                .unwrap()
                .target
                .user = "changed-again".into();
            allow(&f.entry, "apply", false, &AtomicBool::new(false))
        })
        .is_err());
    assert!(f
        .setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
    assert!(!calls(&f).iter().any(|c| c["request"]["mode"] == "apply"));
}
#[test]
fn active_installer_requires_explicit_scoped_stop_and_new_review() {
    let f = fixture();
    fs::write(f.root.join("active"), b"").unwrap();
    let r = review(&f, &f.entry.id);
    assert!(!r.can_reset);
    assert!(!r.blockers.is_empty());
    assert!(f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .is_err());
    f.setup
        .restart_stop_with(
            f.setup
                .reserve_restart(&f.entry.id, &f.entry.id, true)
                .unwrap(),
            allow,
        )
        .unwrap();
    assert!(f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .is_err());
    assert!(review(&f, &f.entry.id).can_reset);
    assert_eq!(
        calls(&f)
            .iter()
            .map(|c| c["request"]["mode"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["review", "stop", "review"]
    );
}
#[test]
fn unresolved_signed_work_blocks_without_prompt_and_peer_is_not_fenced() {
    let f = fixture();
    let registry = registry(&f);
    let env = &f.entry.plan.as_ref().unwrap().environment_id;
    let pending = f.root.join("environments").join(env).join("pending.enc");
    private_write(&pending, b"unresolved-fixture").unwrap();
    let r = review(&f, &f.entry.id);
    let request = f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .unwrap();
    assert!(f
        .setup
        .restart_apply_with(request, &registry, |_, _, _, _| panic!(
            "pending must block before auth"
        ))
        .unwrap_err()
        .contains("pending"));
    assert_eq!(fs::read(&pending).unwrap(), b"unresolved-fixture");
    assert!(registry.get(PEER).is_ok());
    assert!(registry.get(env).is_ok());
    assert!(f
        .setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
}
#[test]
fn lost_reply_survives_desktop_restart_then_status_completes_once_and_suppresses_old_entries() {
    let f = fixture();
    let registry = registry(&f);
    let env = &f.entry.plan.as_ref().unwrap().environment_id;
    let before_plan = serde_json::to_value(&f.entry.plan).unwrap();
    let before_receipt = serde_json::to_value(&f.entry.installation).unwrap();
    let old_pin = fs::read(
        f.setup
            .directory
            .join(format!("{}.known_hosts", f.entry.id)),
    )
    .unwrap();
    fs::write(f.root.join("lost"), b"").unwrap();
    let r = review(&f, &f.entry.id);
    let result = apply(&f, &r, &registry);
    assert_eq!(result.state, "unknown");
    assert!(result.entry.is_none());
    assert!(registry.get(env).is_err());
    assert!(registry.get(PEER).is_ok());
    assert!(f.setup.begin(&f.entry.id).is_err());
    assert!(f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .is_err());
    assert!(f.setup.resume_route(&f.entry.id).is_err());
    let mut reopened = Setup::new(f.root.clone()).unwrap();
    reopened.ssh_fixture = f.setup.ssh_fixture.clone();
    let restored =
        environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    assert!(restored.get(env).is_err());
    assert!(restored.get(PEER).is_ok());
    assert!(reopened.begin(&f.entry.id).is_err());
    let unknown = reopened
        .restart_status(
            reopened.reserve_restart_status(&f.entry.id).unwrap(),
            &restored,
        )
        .unwrap();
    assert_eq!(unknown.state, "unknown");
    fs::write(f.root.join("remote-complete"), b"").unwrap();
    let done = reopened
        .restart_status(
            reopened.reserve_restart_status(&f.entry.id).unwrap(),
            &restored,
        )
        .unwrap();
    assert_eq!(done.state, "complete");
    let fresh = done.entry.unwrap();
    assert_ne!(fresh.id, f.entry.id);
    assert_eq!(fresh.target, f.entry.target);
    assert!(fresh.plan.is_none() && fresh.installation.is_none() && fresh.inspection.is_none());
    assert_eq!(fresh.phase, "trusted");
    assert!(reopened.restart_entry_allowed(&fresh.id).is_ok());
    assert!(reopened.restart_candidates(&fresh.id).unwrap().is_empty());
    assert!(reopened.begin(&f.entry.id).is_err());
    assert!(reopened
        .activity(&f.entry.id, ActivityKind::Installation)
        .is_err());
    assert!(reopened.history_restore(&f.entry.id).is_err());
    assert_eq!(reopened.history_list().unwrap(), vec![f.entry.id.clone()]);
    assert_eq!(
        serde_json::to_value(&reopened.entry(&f.entry.id).unwrap().plan).unwrap(),
        before_plan
    );
    assert_eq!(
        serde_json::to_value(&reopened.entry(&f.entry.id).unwrap().installation).unwrap(),
        before_receipt
    );
    assert_eq!(
        fs::read(
            f.setup
                .directory
                .join(format!("{}.known_hosts", f.entry.id))
        )
        .unwrap(),
        old_pin
    );
    let repeat = reopened
        .restart_status(
            reopened.reserve_restart_status(&f.entry.id).unwrap(),
            &restored,
        )
        .unwrap();
    assert_eq!(repeat.entry.unwrap().id, fresh.id);
    assert_eq!(
        calls(&f)
            .iter()
            .filter(|c| c["request"]["mode"] == "apply")
            .count(),
        1
    );
    assert!(restored.get(PEER).is_ok());
    let persisted: Value =
        serde_json::from_slice(&fs::read(f.root.join("environments/registry.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["environments"].as_object().unwrap().len(), 1);
    assert_eq!(persisted["environments"][PEER]["label"], "Peer");
    let disk = fs::read_to_string(f.setup.directory.join("restart-recovery/journal.json")).unwrap();
    assert!(!disk.contains("fixture-secret"));
    drop(reopened);
    drop(restored);
    let final_setup = Setup::new(f.root.clone()).unwrap();
    assert!(final_setup.restart_entry_allowed(&f.entry.id).is_err());
    assert!(final_setup.restart_entry_allowed(&fresh.id).is_ok());
}
#[test]
fn remote_complete_local_history_failure_reconciles_without_repeating_cleanup() {
    let f = fixture();
    let registry = registry(&f);
    fs::create_dir(f.setup.directory.join("history.json")).unwrap();
    let r = review(&f, &f.entry.id);
    let result = apply(&f, &r, &registry);
    assert_eq!(result.state, "unknown");
    assert!(result.entry.is_none());
    assert!(f.setup.inner.lock().unwrap().restart_journal.records[&r.reset_id].remote_complete);
    fs::remove_dir(f.setup.directory.join("history.json")).unwrap();
    let done = f
        .setup
        .restart_status(
            f.setup.reserve_restart_status(&f.entry.id).unwrap(),
            &registry,
        )
        .unwrap();
    assert_eq!(done.state, "complete");
    assert_eq!(
        calls(&f)
            .iter()
            .map(|c| c["request"]["mode"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["review", "apply"]
    );
}
#[test]
fn host_operation_lock_is_canonical_but_other_hosts_are_independent() {
    let f = fixture();
    let mut alias = f.entry.clone();
    alias.target.host = "FIXTURE.EXAMPLE.".into();
    let alias_id = add(&f, alias);
    let mut peer = f.entry.clone();
    peer.target.host = "peer.example".into();
    let peer_id = add(&f, peer);
    let request = f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .unwrap();
    assert!(f
        .setup
        .reserve_restart(&alias_id, &f.entry.id, false)
        .is_err());
    assert!(f
        .setup
        .activity(&alias_id, ActivityKind::Installation)
        .is_err());
    let peer_guard = f
        .setup
        .activity(&peer_id, ActivityKind::Diagnostics)
        .unwrap();
    drop(request);
    drop(peer_guard);
    assert!(f
        .setup
        .reserve_restart(&alias_id, &f.entry.id, false)
        .is_ok());
}

#[test]
fn native_ipc_requires_explicit_source_and_boolean_password_not_a_secret() {
    let f = fixture();
    let setup = Arc::new(Setup::new(f.root.clone()).unwrap());
    let app = tauri::test::mock_builder()
        .manage(setup)
        .invoke_handler(tauri::generate_handler![
            setup_restart_candidates,
            setup_restart_review,
            setup_restart_stop
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: Value| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    };
    let candidates = invoke("setup_restart_candidates", json!({"id":f.entry.id})).unwrap();
    assert_eq!(candidates[0]["id"], f.entry.id);
    assert_eq!(
        candidates[0]["operationId"],
        f.entry.plan.as_ref().unwrap().operation_id
    );
    assert_eq!(candidates[0].as_object().unwrap().len(), 7);
    for command in ["setup_restart_review", "setup_restart_stop"] {
        assert!(invoke(command, json!({"id":f.entry.id,"password":false})).is_err());
        assert!(invoke(
            command,
            json!({"id":f.entry.id,"sourceId":f.entry.id,"password":"never-a-password-field"})
        )
        .is_err());
        let error = invoke(
            command,
            json!({"id":f.entry.id,"sourceId":"unknown","password":false}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("UUID"));
    }
    assert!(calls(&f).is_empty());
}
#[test]
fn root_review_and_apply_each_require_purpose_specific_consent_without_password() {
    let f = fixture();
    let registry = registry(&f);
    let inspected: Inspection = serde_json::from_value(json!({"version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64","systemd":true,"uid":0,"freeBytes":20000000000_u64,"memoryBytes":4000000000_u64,"markers":[],"container":false,"sudo":"root","api":"absent","environment":null})).unwrap();
    f.setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&f.entry.id)
        .unwrap()
        .inspection = Some(inspected);
    let r = f
        .setup
        .restart_review_with(
            f.setup
                .reserve_restart(&f.entry.id, &f.entry.id, true)
                .unwrap(),
            |_, mode, password, _| {
                assert_eq!(mode, "review");
                assert!(!password);
                Ok(Zeroizing::new(Vec::new()))
            },
        )
        .unwrap();
    let result = f
        .setup
        .restart_apply_with(
            f.setup
                .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, true)
                .unwrap(),
            &registry,
            |_, mode, password, _| {
                assert_eq!(mode, "apply");
                assert!(!password);
                Ok(Zeroizing::new(Vec::new()))
            },
        )
        .unwrap();
    assert_eq!(result.state, "complete");
    assert!(calls(&f).iter().all(|c| !c["args"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap()
        .contains("sudo ")));
}
#[test]
fn review_expiring_during_native_authorization_never_dispatches() {
    let f = fixture();
    let registry = registry(&f);
    let r = review(&f, &f.entry.id);
    let mut request = f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .unwrap();
    request.cached.created = Instant::now() - Duration::from_millis(TTL - 100);
    assert!(f
        .setup
        .restart_apply_with(request, &registry, |_, _, _, _| {
            thread::sleep(Duration::from_millis(150));
            Ok(Zeroizing::new(Vec::new()))
        })
        .unwrap_err()
        .contains("expired"));
    assert!(f
        .setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
    assert_eq!(calls(&f).len(), 1);
}
#[test]
fn new_ssh_apply_creates_only_fresh_trust_and_preserves_unrelated_setup() {
    let f = fixture();
    let registry = registry(&f);
    let mut working = f.entry.clone();
    working.target.user = "new-admin".into();
    working.plan = None;
    working.installation = None;
    let id = add(&f, working.clone());
    let mut peer = working.clone();
    peer.target.host = "other.example".into();
    let peer_id = add(&f, peer);
    let before = serde_json::to_value(f.setup.entry(&peer_id).unwrap()).unwrap();
    let r = review(&f, &id);
    let result = f
        .setup
        .restart_apply_with(
            f.setup
                .reserve_restart_apply(&id, &r.review_id, &r.host, true)
                .unwrap(),
            &registry,
            allow,
        )
        .unwrap();
    assert_eq!(result.state, "complete");
    let fresh = result.entry.unwrap();
    assert_eq!(fresh.target, working.target);
    assert!(f.setup.restart_entry_allowed(&id).is_err());
    assert!(f.setup.restart_entry_allowed(&f.entry.id).is_err());
    assert_eq!(
        serde_json::to_value(f.setup.entry(&peer_id).unwrap()).unwrap(),
        before
    );
    assert_eq!(f.setup.history_list().unwrap().len(), 2);
    let bytes =
        fs::read_to_string(f.setup.directory.join("restart-recovery/journal.json")).unwrap();
    assert!(!bytes.contains("fixture-secret"));
}
#[test]
fn post_complete_registry_and_journal_failures_are_status_only_reconcilable() {
    for (marker, directory, saved) in [
        (
            "break-registry",
            "environments/registry.json",
            "environments/registry.saved",
        ),
        (
            "break-journal",
            "server-setup/restart-recovery/journal.json",
            "server-setup/restart-recovery/journal.saved",
        ),
    ] {
        let f = fixture();
        let registry = registry(&f);
        fs::write(f.root.join(marker), b"").unwrap();
        let r = review(&f, &f.entry.id);
        let result = apply(&f, &r, &registry);
        assert_eq!(result.state, "unknown");
        assert!(result.entry.is_none());
        assert!(f
            .setup
            .reserve_restart(&f.entry.id, &f.entry.id, false)
            .is_err());
        fs::remove_dir(f.root.join(directory)).unwrap();
        fs::rename(f.root.join(saved), f.root.join(directory)).unwrap();
        fs::write(f.root.join("remote-complete"), b"").unwrap();
        let mut reopened = Setup::new(f.root.clone()).unwrap();
        reopened.ssh_fixture = f.setup.ssh_fixture.clone();
        let registry =
            environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(())))
                .unwrap();
        let result = reopened
            .restart_status(
                reopened.reserve_restart_status(&f.entry.id).unwrap(),
                &registry,
            )
            .unwrap();
        assert_eq!(result.state, "complete");
        assert_eq!(
            calls(&f)
                .iter()
                .filter(|c| c["request"]["mode"] == "apply")
                .count(),
            1
        );
    }
}
#[test]
fn wrong_remote_complete_identity_is_unknown_and_never_creates_fresh_entry() {
    let f = fixture();
    let registry = registry(&f);
    fs::write(f.root.join("wrong-outcome"), b"").unwrap();
    let r = review(&f, &f.entry.id);
    let result = apply(&f, &r, &registry);
    assert_eq!(result.state, "unknown");
    assert!(result.entry.is_none());
    assert_eq!(f.setup.list().unwrap().len(), 1);
    assert!(f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .is_err());
}
#[test]
fn orphaned_pending_recovery_and_missing_durable_journal_fail_closed() {
    let f = fixture();
    let registry =
        environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    let environment = &f.entry.plan.as_ref().unwrap().environment_id;
    let directory = f.root.join("environments").join(environment);
    fs::create_dir(&directory).unwrap();
    private_write(&directory.join("pending.enc"), b"unresolved").unwrap();
    assert!(registry.reserve_restart_fence(environment).is_err());
    fs::remove_file(f.setup.directory.join("restart-recovery/journal.json")).unwrap();
    assert!(Setup::new(f.root.clone()).is_err());
}
#[test]
fn mismatched_saved_connection_ownership_blocks_before_auth_or_bookkeeping() {
    let f = fixture();
    drop(registry(&f));
    let path = f.root.join("environments/registry.json");
    let environment = &f.entry.plan.as_ref().unwrap().environment_id;
    let mut metadata: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    metadata["environments"][environment]["ssh"]["setupId"] = json!(Uuid::new_v4().to_string());
    private_write(&path, &serde_json::to_vec(&metadata).unwrap()).unwrap();
    let registry =
        environments::Registry::new(f.root.clone(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    let r = review(&f, &f.entry.id);
    let request = f
        .setup
        .reserve_restart_apply(&f.entry.id, &r.review_id, &r.host, false)
        .unwrap();
    assert!(f
        .setup
        .restart_apply_with(request, &registry, |_, _, _, _| panic!(
            "wrong connection must never authorize"
        ))
        .unwrap_err()
        .contains("ownership"));
    assert!(registry.get(environment).is_ok());
    assert!(registry.get(PEER).is_ok());
    assert!(f
        .setup
        .inner
        .lock()
        .unwrap()
        .restart_journal
        .records
        .is_empty());
    assert_eq!(calls(&f).len(), 1);
}
