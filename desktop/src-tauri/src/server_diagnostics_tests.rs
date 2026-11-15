use super::super::diagnostic_test_support::Fixture;
use super::*;

fn allow(_: &Entry, _: bool, _: &AtomicBool) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    Ok(zeroize::Zeroizing::new(Vec::new()))
}

fn future_sidecar(fixture: &Fixture) -> Value {
    let plan = fixture.entry.plan.as_ref().unwrap();
    let record = json!({"commandId":"browser.python-sync","stageId":"browser-runtime","substageId":"python-sync",
        "sequence":1,"completedSteps":4,"startedAt":10,"finishedAt":90,"outcome":"failed","exitCode":1,
        "output":{"retention":"tail","limitBytes":262144,"bytesSeen":12,"bytesRetained":12,"bytesDropped":0,"truncated":false,"streamComplete":true}});
    json!({"schema":1,"operationId":plan.operation_id,"environmentId":plan.environment_id,"releaseId":plan.release_id,
        "startedAt":1,"updatedAt":95,"commandCount":1,"omittedCommandCount":0,"commands":[record.clone()],"failedCommand":record,
        "logs":{"command.log":1,"failed-command.log":1}})
}
fn future_wire(fixture: &Fixture, metadata: &Value) -> Value {
    let mut response = fixture.response();
    response["sources"].as_array_mut().unwrap().extend([
        json!({"id":"diagnostics.json","status":"available","text":serde_json::to_string(metadata).unwrap(),"truncated":false}),
        json!({"id":"failed-command.log","status":"available","text":"preserved Python error\npassword=failed-canary\n","truncated":false})
    ]);
    response
}

#[test]
fn optional_sidecar_provenance_and_preserved_output_are_native_owned_and_sanitized() {
    let fixture = Fixture::new();
    let mut metadata = future_sidecar(&fixture);
    metadata["argv"] = json!(["raw-argv-canary"]);
    metadata["logs"]["../../.env"] = json!("path-canary");
    for field in ["commands", "failedCommand"] {
        let record = if field == "commands" {
            &mut metadata[field][0]
        } else {
            &mut metadata[field]
        };
        record["label"] = json!("malicious-label-canary\u{1b}[31m");
        record["argv"] = json!(["raw-argv-canary"]);
        record["environment"] = json!({"arbitrary":"env-canary"});
        record["output"]["bytesSeen"] = json!(100);
        record["output"]["bytesDropped"] = json!(88);
        record["output"]["truncated"] = json!(true);
    }
    fixture.wire(&future_wire(&fixture, &metadata));
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    let provenance = report
        .sources
        .iter()
        .find(|source| source.id == "diagnostics.json")
        .unwrap();
    assert_eq!(provenance.status, SourceStatus::Available);
    let selected: Value = serde_json::from_str(&provenance.text).unwrap();
    assert_eq!(
        selected["failedCommand"]["commandId"],
        "browser.python-sync"
    );
    assert!(selected["failedCommand"].get("argv").is_none());
    assert!(selected["failedCommand"].get("label").is_none());
    let log = report
        .sources
        .iter()
        .find(|source| source.id == "failed-command.log")
        .unwrap();
    assert_eq!(log.status, SourceStatus::Available);
    assert!(log.text.contains("preserved Python error"));
    assert!(
        log.truncated,
        "Preserved output coverage must include helper-side truncation"
    );
    assert_eq!(
        report
            .sources
            .iter()
            .find(|source| source.id == "command.log")
            .unwrap()
            .status,
        SourceStatus::Unavailable
    );
    let ipc = serde_json::to_string(&report).unwrap();
    assert!(!ipc.contains("canary"));
    assert!(
        !ipc.contains("unknown failure"),
        "Latest output must not displace preserved output"
    );
    assert!(report.redacted);
    assert!(report
        .notes
        .iter()
        .any(|note| note.contains("identifies the recorded failed command")));
    let path = fixture
        .setup
        .export_diagnostics(&fixture.entry.id, &report.report_id, &fixture.root)
        .unwrap();
    let exported = fs::read_to_string(path).unwrap();
    assert!(!exported.contains("canary"));
    assert_eq!(
        serde_json::from_str::<Value>(&exported).unwrap(),
        serde_json::to_value(report).unwrap()
    );
}
#[test]
fn optional_private_sources_cannot_bypass_consent_even_if_peer_sends_them() {
    let fixture = Fixture::new();
    fixture.wire(&future_wire(&fixture, &future_sidecar(&fixture)));
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, false, |_, _, _| {
            panic!("No implicit authorization")
        })
        .unwrap();
    for id in [
        "diagnostics.json",
        "failed-command.log",
        "command.log",
        "launch.log",
    ] {
        let source = report
            .sources
            .iter()
            .find(|source| source.id == id)
            .unwrap();
        assert_eq!(source.status, SourceStatus::PermissionDenied);
        assert!(source.text.is_empty());
    }
}
#[test]
fn optional_provenance_rejects_foreign_identity_unreviewed_labels_and_log_mappings() {
    let fixture = Fixture::new();
    for field in [
        "operationId",
        "environmentId",
        "releaseId",
        "commandId",
        "stageId",
        "substageId",
        "logs",
    ] {
        let mut metadata = future_sidecar(&fixture);
        match field {
            "commandId" | "stageId" | "substageId" => {
                metadata["failedCommand"][field] = json!("malicious-label-canary; rm something")
            }
            "logs" => metadata["logs"]["failed-command.log"] = json!(2),
            _ => metadata[field] = json!("foreign-canary"),
        }
        fixture.wire(&future_wire(&fixture, &metadata));
        let report = fixture
            .setup
            .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
            .unwrap();
        for id in ["diagnostics.json", "failed-command.log"] {
            let source = report
                .sources
                .iter()
                .find(|source| source.id == id)
                .unwrap();
            assert_eq!(source.status, SourceStatus::Unsafe, "{field}");
            assert!(source.text.is_empty());
        }
        assert_eq!(
            report
                .sources
                .iter()
                .find(|source| source.id == "command.log")
                .unwrap()
                .status,
            SourceStatus::Available
        );
        assert!(!serde_json::to_string(&report).unwrap().contains("canary"));
    }
}
#[test]
fn missing_optional_sidecar_is_legacy_compatible_without_invented_attribution() {
    let fixture = Fixture::new();
    let mut response = future_wire(&fixture, &future_sidecar(&fixture));
    response["sources"][5]["status"] = json!("missing");
    response["sources"][5]["text"] = json!("");
    fixture.wire(&response);
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    assert!(report
        .notes
        .iter()
        .any(|note| note.contains("filename alone does not prove")));
    response["sources"][6]["status"] = json!("missing");
    response["sources"][6]["text"] = json!("");
    fixture.wire(&response);
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    assert_eq!(
        report
            .sources
            .iter()
            .find(|source| source.id == "command.log")
            .unwrap()
            .status,
        SourceStatus::Available
    );
    assert!(report
        .notes
        .iter()
        .any(|note| note.contains("Legacy command.log")));
}
#[test]
fn sidecar_projection_preserves_failed_record_and_valid_json_within_report_budget() {
    let fixture = Fixture::new();
    let mut metadata = future_sidecar(&fixture);
    metadata["commands"] = json!((1..=32)
        .map(|sequence| {
            let mut record = metadata["failedCommand"].clone();
            record["sequence"] = json!(sequence);
            record
        })
        .collect::<Vec<_>>());
    metadata["commandCount"] = json!(32);
    metadata["logs"]["command.log"] = json!(32);
    let projection = sidecar::project(
        &serde_json::to_string(&metadata).unwrap(),
        &Binding::from_entry(&fixture.entry).unwrap(),
    )
    .unwrap_or_else(|_| panic!("valid helper sidecar"));
    assert!(projection.truncated);
    assert!(projection.text.len() <= sidecar::TEXT_LIMIT);
    let selected: Value = serde_json::from_str(&projection.text).unwrap();
    assert_eq!(selected["commands"].as_array().unwrap().len(), 8);
    assert_eq!(selected["omittedCommandCount"], 24);
    assert_eq!(selected["failedCommand"]["sequence"], 1);
    let mut response = future_wire(&fixture, &selected);
    response["sources"][6]["text"] = json!("🙂\"\\\n".repeat(1800));
    fixture.wire(&response);
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_REPLY);
    let source = report
        .sources
        .iter()
        .find(|source| source.id == "diagnostics.json")
        .unwrap();
    assert!(serde_json::from_str::<Value>(&source.text).is_ok());
}

#[test]
fn contract_sanitizes_before_ipc_cache_and_private_export() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    let value = serde_json::to_value(&report).unwrap();
    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    let mut expected = vec![
        "schemaVersion",
        "reportId",
        "setupId",
        "operationId",
        "environmentId",
        "releaseId",
        "stage",
        "state",
        "completedSteps",
        "totalSteps",
        "collectedAt",
        "expiresAt",
        "sources",
        "notes",
        "redacted",
    ];
    expected.sort_unstable();
    assert_eq!(keys, expected);
    assert_eq!(report.completed_steps, 4);
    assert_eq!(report.state, "failed");
    assert!(report.redacted);
    assert!(report.collected_at > 1_000_000_000_000);
    assert_eq!(report.expires_at - report.collected_at, CACHE_TTL);
    let ipc = serde_json::to_string(&report).unwrap();
    assert!(!ipc.contains("canary"));
    assert!(!ipc.contains("\\u001b"));
    assert!(ipc.contains("unknown failure"));
    let path = fixture
        .setup
        .export_diagnostics(&fixture.entry.id, &report.report_id, &fixture.root)
        .unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let exported = fs::read_to_string(&path).unwrap();
    assert!(!exported.contains("canary"));
    assert_eq!(serde_json::from_str::<Value>(&exported).unwrap(), value);
    let second = fixture
        .setup
        .export_diagnostics(&fixture.entry.id, &report.report_id, &fixture.root)
        .unwrap();
    assert_ne!(path, second);
    assert!(private_setup_log_write(std::path::Path::new(&path), b"overwrite").is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), exported);
    assert!(fixture
        .setup
        .export_diagnostics(
            &fixture.entry.id,
            &Uuid::new_v4().to_string(),
            &fixture.root
        )
        .is_err());
}
#[test]
fn private_logs_require_explicit_consent_even_for_root_and_password_never_crosses_report() {
    let fixture = Fixture::new();
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, false, |_, _, _| {
            panic!("No implicit native prompt")
        })
        .unwrap();
    for source in report
        .sources
        .iter()
        .filter(|v| matches!(v.id.as_str(), "command.log" | "launch.log"))
    {
        assert_eq!(source.status, SourceStatus::PermissionDenied);
        assert!(source.text.is_empty());
    }
    assert!(fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, true, allow)
        .is_err());
    {
        let mut inner = fixture.setup.inner.lock().unwrap();
        inner.entries.get_mut(&fixture.entry.id).unwrap().inspection = Some(serde_json::from_value(json!({"version":1,"os":"ubuntu","osVersion":"24.04","architecture":"x86_64","systemd":true,"uid":0,"freeBytes":1,"memoryBytes":1,"markers":[],"container":false,"sudo":"root","api":"absent","environment":null})).unwrap());
    }
    let mut prompted = false;
    fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, true, |_, password, _| {
            prompted = true;
            assert!(!password);
            allow(&fixture.entry, false, &AtomicBool::new(false))
        })
        .unwrap();
    assert!(prompted, "Root still needs purpose-specific native consent");
}
#[test]
fn cancellation_before_worker_start_prevents_authorization_and_ssh() {
    use std::os::unix::fs::PermissionsExt;
    let mut fixture = Fixture::new();
    let script = fixture.root.join("unexpected-diagnostic-ssh");
    fs::write(&script, "#!/usr/bin/python3\nimport pathlib\npathlib.Path(__file__).with_name('ssh-started').touch()\nraise SystemExit(1)\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    fixture.setup.ssh_fixture = Some(script.to_string_lossy().into_owned());
    let before = serde_json::to_value(fixture.setup.entry(&fixture.entry.id).unwrap()).unwrap();
    for (protected, password) in [(false, false), (true, false), (true, true)] {
        // This is the handler/worker hand-off, with the worker deliberately not run yet.
        let request = fixture
            .setup
            .reserve_diagnostics(&fixture.entry.id, protected, password)
            .unwrap();
        let token = request.guard.token.clone();
        assert_eq!(
            fixture.setup.inner.lock().unwrap().activities[&fixture.entry.id].token,
            token
        );
        assert!(fixture
            .setup
            .reserve_diagnostics(&fixture.entry.id, protected, password)
            .is_err());
        fixture.setup.cancel_diagnostics(&fixture.entry.id).unwrap();
        assert!(request.guard.cancel.load(Ordering::SeqCst));
        let result = fixture
            .setup
            .collect_reserved_diagnostics_with(request, |_, _, _| {
                panic!("A cancelled queued request must not authorize")
            });
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(!fixture.root.join("ssh-started").exists());
        let inner = fixture.setup.inner.lock().unwrap();
        assert!(inner.activities.is_empty());
        assert!(inner.running.is_empty());
        assert!(inner.diagnostic_cache.is_empty());
    }
    assert_eq!(
        serde_json::to_value(fixture.setup.entry(&fixture.entry.id).unwrap()).unwrap(),
        before
    );
    assert!(!fixture.root.join("cancel").exists());
}

#[test]
fn dropping_an_undispatched_request_releases_ownership() {
    let fixture = Fixture::new();
    let request = fixture
        .setup
        .reserve_diagnostics(&fixture.entry.id, true, false)
        .unwrap();
    let token = request.guard.token.clone();
    drop(request);
    assert!(fixture.setup.inner.lock().unwrap().activities.is_empty());
    let next = fixture
        .setup
        .reserve_diagnostics(&fixture.entry.id, true, false)
        .unwrap();
    assert_ne!(next.guard.token, token);
    assert!(!next.guard.cancel.load(Ordering::SeqCst));
}

#[test]
fn native_report_budget_preserves_final_log_lines_and_metadata() {
    let fixture = Fixture::new();
    let binding = Binding::from_entry(&fixture.entry).unwrap();
    let wire = future_wire(&fixture, &future_sidecar(&fixture));
    let (mut report, _) = report_from_wire(
        &serde_json::to_vec(&wire).unwrap(),
        &fixture.entry,
        &binding,
        true,
        Uuid::new_v4().to_string(),
    )
    .unwrap();
    for source in &mut report.sources {
        let repetitions = match source.id.as_str() {
            "failed-command.log" => 4000,
            "launch.log" | "service" | "status.json" => 1300,
            "launch.json" => 300,
            _ => continue,
        };
        source.text = format!(
            "{}\nNo space left on device 🙂",
            "\"\\\n".repeat(repetitions)
        );
    }
    let metadata: Vec<_> = report
        .sources
        .iter()
        .filter(|source| {
            matches!(
                source.id.as_str(),
                "status.json" | "launch.json" | "diagnostics.json"
            )
        })
        .map(|source| (source.id.clone(), source.text.clone()))
        .collect();
    assert!(serde_json::to_vec(&report).unwrap().len() > MAX_REPLY);
    fit_report_budget(&mut report).unwrap();
    assert!(serde_json::to_vec(&report).unwrap().len() <= MAX_REPLY);
    let failure = report
        .sources
        .iter()
        .find(|source| source.id == "failed-command.log")
        .unwrap();
    assert!(failure.truncated);
    assert!(failure.text.ends_with("No space left on device 🙂"));
    for (id, text) in metadata {
        assert_eq!(
            report
                .sources
                .iter()
                .find(|source| source.id == id)
                .unwrap()
                .text,
            text
        );
    }
    assert!(serde_json::from_str::<Value>(
        &report
            .sources
            .iter()
            .find(|source| source.id == "diagnostics.json")
            .unwrap()
            .text
    )
    .is_ok());
}

#[test]
fn log_tail_trimming_is_utf8_and_line_boundary_safe() {
    for (input, limit, expected) in [
        ("old\nnew", 3, "new"),
        ("old\npassword=canary\nfinal", 12, "final"),
        ("old\n🙂🙂\nfinal", 10, "final"),
        ("password=canary", 6, ""),
        ("🙂", 0, ""),
    ] {
        let mut value = input.to_string();
        assert!(text::truncate_tail(&mut value, limit));
        assert_eq!(value, expected);
        assert!(!text::sanitize(&value).contains("canary"));
    }
}

#[test]
fn native_log_source_limit_preserves_final_error_and_drops_cut_secret_line() {
    let fixture = Fixture::new();
    let binding = Binding::from_entry(&fixture.entry).unwrap();
    for id in ["command.log", "failed-command.log"] {
        let mut wire = if id == "command.log" {
            fixture.response()
        } else {
            future_wire(&fixture, &future_sidecar(&fixture))
        };
        let source = wire["sources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|source| source["id"] == id)
            .unwrap();
        source["text"] = json!(format!(
            "{}password={}\nNo space left on device",
            "older line🙂\n".repeat(1600),
            "canary".repeat(2200)
        ));
        let bytes = serde_json::to_vec(&wire).unwrap();
        assert!(bytes.len() <= MAX_REPLY);
        let (report, _) = report_from_wire(
            &bytes,
            &fixture.entry,
            &binding,
            true,
            Uuid::new_v4().to_string(),
        )
        .unwrap();
        let evidence = report
            .sources
            .iter()
            .find(|source| source.id == id)
            .unwrap();
        assert!(evidence.truncated);
        assert!(evidence.text.ends_with("No space left on device"));
        assert!(!evidence.text.contains("canary"));
        assert!(evidence.text.len() <= 12288);
    }
}

#[test]
fn authorization_cancellation_is_separate_from_installer_and_drops_old_cache() {
    let fixture = Fixture::new();
    fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    let before = serde_json::to_value(fixture.setup.entry(&fixture.entry.id).unwrap()).unwrap();
    let result =
        fixture
            .setup
            .collect_diagnostics_with(&fixture.entry.id, true, true, |_, _, cancel| {
                fixture.setup.cancel_diagnostics(&fixture.entry.id).unwrap();
                assert!(cancel.load(Ordering::SeqCst));
                Err("password=never-expose-this-native-error".into())
            });
    assert_eq!(result.unwrap_err(), CANCELLED);
    assert_eq!(
        serde_json::to_value(fixture.setup.entry(&fixture.entry.id).unwrap()).unwrap(),
        before
    );
    let inner = fixture.setup.inner.lock().unwrap();
    assert!(inner.activities.is_empty());
    assert!(inner.diagnostic_cache.is_empty());
    assert!(inner.running.is_empty());
    assert!(!fixture.root.join("cancel").exists());
}
#[test]
fn cancellation_during_read_reaps_only_owned_ssh_and_allows_a_later_request() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("delay"), b"1").unwrap();
    thread::scope(|scope| {
        let handle = scope.spawn(|| {
            fixture
                .setup
                .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
        });
        for _ in 0..100 {
            if fixture
                .setup
                .inner
                .lock()
                .unwrap()
                .activities
                .contains_key(&fixture.entry.id)
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        fixture.setup.cancel_diagnostics(&fixture.entry.id).unwrap();
        assert!(handle.join().unwrap().unwrap_err().contains("cancelled"));
    });
    assert!(fixture.setup.inner.lock().unwrap().activities.is_empty());
    fs::remove_file(fixture.root.join("delay")).unwrap();
    assert!(fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
        .is_ok());
}
#[test]
fn foreign_stale_malicious_metadata_and_oversized_replies_never_enter_cache() {
    let fixture = Fixture::new();
    for field in ["operationId", "environmentId", "releaseId"] {
        let mut wire = fixture.response();
        wire[field] = json!("foreign=password=secret-canary");
        fixture.wire(&wire);
        let error = fixture
            .setup
            .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
            .unwrap_err();
        assert!(!error.contains("canary"));
    }
    for field in ["updatedAt", "completedSteps"] {
        let mut wire = fixture.response();
        wire[field] = json!(0);
        fixture.wire(&wire);
        assert!(fixture
            .setup
            .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
            .is_err());
    }
    let mut wire = fixture.response();
    wire["sources"][0]["label"] = json!("Authorization: bearer canary-label");
    fixture.wire(&wire);
    assert!(fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .is_err());
    wire = fixture.response();
    wire["sources"][0]["id"] = json!("../../.env");
    fixture.wire(&wire);
    assert!(fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .is_err());
    wire = fixture.response();
    wire["sources"][0]["text"] = json!("é".repeat(MAX_REPLY));
    fixture.wire(&wire);
    assert!(fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .is_err());
    assert!(fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .diagnostic_cache
        .is_empty());
}
#[test]
fn metadata_and_unknown_error_text_are_sanitized_not_just_successful_logs() {
    let fixture = Fixture::new();
    let mut wire = fixture.response();
    wire["stage"] = json!("token=stage-canary");
    wire["sources"][3]["status"] = json!("unavailable");
    wire["sources"][3]["text"] = json!("password=error-canary");
    fixture.wire(&wire);
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, true, false, allow)
        .unwrap();
    assert!(!serde_json::to_string(&report).unwrap().contains("canary"));
}
#[test]
fn native_binding_is_rechecked_after_authorization_and_on_export() {
    let fixture = Fixture::new();
    let result =
        fixture
            .setup
            .collect_diagnostics_with(&fixture.entry.id, true, false, |_, _, _| {
                fixture
                    .setup
                    .inner
                    .lock()
                    .unwrap()
                    .entries
                    .get_mut(&fixture.entry.id)
                    .unwrap()
                    .target
                    .host = "changed.example".into();
                allow(&fixture.entry, false, &AtomicBool::new(false))
            });
    assert!(result.is_err());
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .insert(fixture.entry.id.clone(), fixture.entry.clone());
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
        .unwrap();
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&fixture.entry.id)
        .unwrap()
        .plan
        .as_mut()
        .unwrap()
        .operation_id = Uuid::new_v4().to_string();
    assert!(fixture
        .setup
        .export_diagnostics(&fixture.entry.id, &report.report_id, &fixture.root)
        .is_err());
}
#[test]
fn late_response_cannot_publish_for_a_changed_native_binding() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("delay"), b"1").unwrap();
    thread::scope(|scope| {
        let handle = scope.spawn(|| {
            fixture
                .setup
                .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
        });
        for _ in 0..100 {
            if fixture
                .setup
                .inner
                .lock()
                .unwrap()
                .activities
                .contains_key(&fixture.entry.id)
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_millis(100));
        fixture
            .setup
            .inner
            .lock()
            .unwrap()
            .entries
            .get_mut(&fixture.entry.id)
            .unwrap()
            .target
            .port = 2200;
        assert!(handle.join().unwrap().is_err());
    });
    assert!(fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .diagnostic_cache
        .is_empty());
}
#[test]
fn cache_evicts_oldest_across_independent_targets() {
    let fixture = Fixture::new();
    let first = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
        .unwrap();
    let pin = fs::read_to_string(
        fixture
            .setup
            .directory
            .join(format!("{}.known_hosts", fixture.entry.id)),
    )
    .unwrap();
    for index in 0..CACHE_COUNT {
        let mut peer = fixture.entry.clone();
        peer.id = Uuid::new_v4().to_string();
        peer.target.host = format!("peer-{index}.example");
        private_write(
            &fixture
                .setup
                .directory
                .join(format!("{}.known_hosts", peer.id)),
            pin.replace(&Setup::alias(&fixture.entry.id), &Setup::alias(&peer.id))
                .as_bytes(),
        )
        .unwrap();
        fixture
            .setup
            .inner
            .lock()
            .unwrap()
            .entries
            .insert(peer.id.clone(), peer.clone());
        fixture
            .setup
            .collect_diagnostics_with(&peer.id, false, false, allow)
            .unwrap();
    }
    assert_eq!(
        fixture.setup.inner.lock().unwrap().diagnostic_cache.len(),
        CACHE_COUNT
    );
    assert!(fixture
        .setup
        .export_diagnostics(&fixture.entry.id, &first.report_id, &fixture.root)
        .is_err());
}
#[test]
fn bounded_native_process_deadline_and_flood_never_return_raw_errors() {
    let start = Instant::now();
    assert!(run_bounded(
        "/usr/bin/python3",
        &["-c".into(), "import time;time.sleep(10)".into()],
        b"",
        Duration::from_millis(100),
        &AtomicBool::new(false),
        1024
    )
    .is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(run_bounded(
        "/usr/bin/python3",
        &[
            "-c".into(),
            "import sys;sys.stdout.write('canary'*100000)".into()
        ],
        b"",
        Duration::from_secs(2),
        &AtomicBool::new(false),
        MAX_REPLY
    )
    .unwrap_err()
    .contains("SSH"));
}
#[test]
fn cache_is_bounded_expires_and_cancel_invalidates_snapshots() {
    let fixture = Fixture::new();
    let report = fixture
        .setup
        .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
        .unwrap();
    {
        let mut inner = fixture.setup.inner.lock().unwrap();
        inner.diagnostic_cache[0].cached_at = Instant::now() - Duration::from_millis(CACHE_TTL + 1);
    }
    assert!(fixture
        .setup
        .export_diagnostics(&fixture.entry.id, &report.report_id, &fixture.root)
        .is_err());
    for _ in 0..12 {
        fixture
            .setup
            .collect_diagnostics_with(&fixture.entry.id, false, false, allow)
            .unwrap();
    }
    assert!(fixture.setup.inner.lock().unwrap().diagnostic_cache.len() <= CACHE_COUNT);
    fixture.setup.cancel_diagnostics(&fixture.entry.id).unwrap();
    assert!(fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .diagnostic_cache
        .is_empty());
}
#[test]
fn offline_guide_uses_actual_pinned_target_and_safe_fixed_read_commands() {
    let mut fixture = Fixture::new();
    fixture.setup.ssh_fixture = Some("/does-not-exist".into());
    fixture
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&fixture.entry.id)
        .unwrap()
        .target
        .identity_file = Some("/keys/missing key's id".into());
    let guide = fixture.setup.diagnostic_guide(&fixture.entry.id).unwrap();
    let value = serde_json::to_value(guide).unwrap();
    assert_eq!(value["destination"], "operator@fixture.example:2222");
    assert_eq!(value["steps"][0]["runOn"], "mac");
    let connect = value["steps"][0]["command"].as_str().unwrap();
    for required in [
        "fixture.example",
        "2222",
        "operator",
        "StrictHostKeyChecking=yes",
        "UserKnownHostsFile",
        "-tt",
        "BatchMode=yes",
    ] {
        assert!(connect.contains(required));
    }
    assert!(connect.contains("IdentitiesOnly=yes"));
    assert!(connect.contains("missing key"));
    assert!(connect.contains("'\\''"));
    let rendered = serde_json::to_string(&value).unwrap();
    assert!(rendered.contains(&fixture.entry.plan.as_ref().unwrap().operation_id));
    for forbidden in [
        "StrictHostKeyChecking=no",
        "--bootstrap",
        "restart",
        "journalctl -f",
    ] {
        assert!(!value["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["command"].as_str().unwrap().contains(forbidden)));
    }
    assert!(rendered.contains("4/12"));
    assert!(rendered.contains("12288"));
    assert!(rendered.contains("4096"));
}
#[test]
fn secret_canaries_terminal_sequences_private_blocks_and_utf8_truncation() {
    for input in [
        "password = short-canary",
        "{\"api_key\":\"json-canary\"}",
        "Authorization: Basic auth-canary",
        "https://u:url-canary@example.org/path",
        "https://example.org/path?x=query-canary",
        "-----BEGIN PRIVATE KEY-----\nblock-canary\n-----END PRIVATE KEY-----",
        "tail-canary\n-----END OPENSSH PRIVATE KEY-----",
        "\u{1b}[31mpass\u{1b}[0mword=ansi-canary",
        "tok\u{202e}en=bidi-canary",
        "\u{9d}c1-canary\u{9c}safe",
        "PASSWORD=\ncontinuation-canary",
        "api_key: |\n  multiline-canary\n  more-canary",
        "\u{1b}]8;;https://osc-canary\u{7}link\u{1b}]8;;\u{7}",
    ] {
        assert!(!text::sanitize(input).contains("canary"), "{input}");
    }
    assert_eq!(
        text::sanitize("unknown error: exit 1\nmore evidence"),
        "unknown error: exit 1\nmore evidence"
    );
    let mut text = "é🙂".repeat(100);
    assert!(text::truncate(&mut text, 101));
    assert!(text.len() <= 101);
}
