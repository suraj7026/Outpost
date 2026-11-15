//! Exact held-operation recovery; no new reset ID, journal restoration, or installation.
use super::*;

const HELD_RESET: &str = "5e5f59b9-ccaa-4402-ac8d-10fd315978d4";
const RESERVED_FRESH: &str = "2e1c768b-fb41-4f33-912e-a86cbc038098";
const ENVIRONMENT: &str = "cbfedef7-2f91-4b6d-8ba8-d4c1f5ea5a6b";

fn recovery_opt_in(host: Option<&OsStr>, reset: Option<&OsStr>) -> Result<()> {
    require(
        host == Some(OsStr::new(HOST)) && reset == Some(OsStr::new(HELD_RESET)),
        "recoveryOptIn",
        "exactHostAndHeldResetRequired",
    )
}
fn recovery_boundary() -> Result<()> {
    recovery_opt_in(
        std::env::var_os("OUTPOST_OPERATOR_RECOVER").as_deref(),
        std::env::var_os("OUTPOST_OPERATOR_RESET_ID").as_deref(),
    )?;
    reset_boundary()
}
fn recovery_binding() -> Result<(Binding, BTreeSet<String>)> {
    recovery_boundary()?;
    let directory = Path::new(LIVE_ROOT).join("server-setup");
    let journal = Journal::read(&directory)
        .map_err(|_| SafeError::new("recoveryPreflight", "durableJournalUnavailable"))?;
    require(
        journal.records.len() == 1,
        "recoveryPreflight",
        "exactHeldRecordRequired",
    )?;
    let pending = journal
        .records
        .get(HELD_RESET)
        .ok_or_else(|| SafeError::new("recoveryPreflight", "heldResetMissing"))?;
    let value = serde_json::to_value(pending)
        .map_err(|_| SafeError::new("recoveryPreflight", "heldRecordInvalid"))?;
    let binding = &pending.binding;
    require(
        pending.reset_id == HELD_RESET
            && !pending.remote_complete
            && value["localComplete"] == false
            && value["fresh"]["id"].as_str() == Some(RESERVED_FRESH)
            && binding.id == WORKING_ID
            && binding.source_id == SOURCE_ID
            && binding.target.host == HOST
            && binding.target.port == PORT
            && binding.target.user == USER
            && binding.target.identity_file.as_deref() == Some(KEY)
            && binding.fingerprint == FINGERPRINT
            && binding.expected.operation_id == OPERATION_ID
            && binding.expected.environment_id == ENVIRONMENT
            && binding.expected.release_id == "host-fa9eb6b5d217af95b920"
            && binding.expected.sha256
                == "f79cfd440df77d7fda482e707126df7fe84167551644d5540eb8874c44d52c57"
            && binding.expected.size == 223402
            && binding.source_progress["state"] == "failed"
            && binding.source_progress["completedSteps"] == 4
            && binding.source_progress["totalSteps"] == 12
            && pending.affected.contains(WORKING_ID)
            && pending.affected.contains(SOURCE_ID),
        "recoveryPreflight",
        "heldIdentityOrOriginalPlanChanged",
    )?;
    let entries = select_entries(&read_existing(
        &directory.join("entries.json"),
        MAX_ENTRIES,
    )?)?;
    for id in [WORKING_ID, SOURCE_ID] {
        require(
            entries[id].phase == "restart_pending",
            "recoveryPreflight",
            "originalEntryNotHeld",
        )?;
        verified_pin(
            id,
            &read_existing(&directory.join(format!("{id}.known_hosts")), 4096)?,
            FINGERPRINT,
        )?;
    }
    let current = Binding::new(&entries[WORKING_ID], &entries[SOURCE_ID])
        .map_err(|_| SafeError::new("recoveryPreflight", "liveOriginalBindingInvalid"))?;
    require(
        reset_binding_matches(binding, &current),
        "recoveryPreflight",
        "liveOriginalBindingChanged",
    )?;
    Ok((binding.clone(), pending.affected.clone()))
}
fn dispatch_guard(expected: &Binding, peers: &Value) -> Result<()> {
    require(
        recovery_binding()?.0 == *expected,
        "recoveryPreflight",
        "heldBindingChanged",
    )?;
    verify_registry_peers(peers, &expected.expected.environment_id)?;
    recovery_boundary()
}
fn authorize_recovery(
    entry: &Entry,
    mode: &str,
    password: bool,
    cancel: &AtomicBool,
    purpose: &str,
    expected: &Binding,
    peers: &Value,
    failure: &mut Option<SafeError>,
) -> std::result::Result<Zeroizing<Vec<u8>>, AuthorizationError> {
    let result = (|| {
        require(
            mode == purpose
                && matches!(purpose, "recover_review" | "apply")
                && password
                && entry.id == WORKING_ID
                && entry.target == expected.target
                && entry.fingerprint == FINGERPRINT,
            "recoveryAuthorization",
            "purposeOrTargetMismatch",
        )?;
        checked_reset_authorization(
            || dispatch_guard(expected, peers),
            || authorize(entry, mode, password, cancel),
        )
    })();
    result.map_err(|error| {
        *failure = Some(error);
        cancel.store(true, Ordering::SeqCst);
        AuthorizationError::RequestCancel
    })
}

#[test]
#[ignore = "LIVE DESTRUCTIVE recovery of exact held Outpost2 reset; explicit host/operation/reset opt-ins and native approvals required"]
fn outpost2_live_recover_held_reset_and_read_only_inspect() -> std::result::Result<(), ResetError> {
    recovery_boundary()?;
    let (expected, affected) = recovery_binding()?;
    let backup = ResetBackup::create()?;
    let peers = registry_peers(backup.registry.clone(), &expected.expected.environment_id)?;
    dispatch_guard(&expected, &peers)?;
    backup.verify_before_open()?;
    let owned = CloseLiveSetup(
        Setup::new(PathBuf::from(LIVE_ROOT))
            .map_err(|_| SafeError::new("recoverySetup", "liveInitializationFailed"))?,
    );
    let setup = &owned.0;
    require(
        setup.directory == Path::new(LIVE_ROOT).join("server-setup")
            && setup.ssh_fixture.is_none()
            && setup.ssh_program() == "/usr/bin/ssh",
        "recoveryPreflight",
        "liveNativeTransportRequired",
    )?;
    let registry = environments::Registry::new(
        PathBuf::from(LIVE_ROOT),
        Arc::new(tokio::sync::Mutex::new(())),
    )
    .map_err(|_| SafeError::new("recoveryRegistry", "liveInitializationFailed"))?;
    require(
        !registry.fixture_identity,
        "recoveryRegistry",
        "nativeRegistryRequired",
    )?;
    let previous_ids = setup
        .inner
        .lock()
        .map_err(|_| SafeError::new("recoveryPreflight", "setupLockFailed"))?
        .entries
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    require(
        !previous_ids.contains(RESERVED_FRESH),
        "recoveryPreflight",
        "reservedFreshAlreadyPublished",
    )?;
    dispatch_guard(&expected, &peers)?;
    let status = setup
        .restart_status(
            setup
                .reserve_restart_status(WORKING_ID)
                .map_err(|_| SafeError::new("recoveryStatus", "statusReservationFailed"))?,
            &registry,
        )
        .map_err(|_| SafeError::new("recoveryStatus", "statusReadFailed"))?;
    require(
        status.reset_id == HELD_RESET
            && matches!(status.state.as_str(), "complete" | "unknown" | "failed"),
        "recoveryStatus",
        "sameResetStatusRequired",
    )?;
    println!(
        "{}",
        json!({"resetId": HELD_RESET, "statusBeforeRecovery": status.state})
    );
    require(
        std::env::var_os("OUTPOST_OPERATOR_STATUS_ONLY").is_none()
            || std::env::var_os("OUTPOST_OPERATOR_STATUS_ONLY").as_deref() == Some(OsStr::new("1"))
                && status.state == "complete",
        "recoveryStatus",
        "statusOnlyRequiresVerifiedCompletion",
    )?;
    let fresh = if status.state == "complete" {
        reset_outcome(Ok(status), HELD_RESET, None)?
    } else {
        dispatch_guard(&expected, &peers)?;
        let request = setup
            .reserve_restart_recovery(WORKING_ID, HELD_RESET, true)
            .map_err(|_| SafeError::new("recoveryReservation", "heldReviewReservationFailed"))?;
        require(
            request.binding == expected && request.reset_id == HELD_RESET && request.password,
            "recoveryPreflight",
            "reservedHeldBindingChanged",
        )?;
        let mut authorization_failure = None;
        let result = setup.restart_recovery_review_with(
            request,
            &registry,
            |entry, mode, password, cancel| {
                authorize_recovery(
                    entry,
                    mode,
                    password,
                    cancel,
                    "recover_review",
                    &expected,
                    &peers,
                    &mut authorization_failure,
                )
            },
        );
        let review = result.map_err(|_| {
            authorization_failure
                .unwrap_or_else(|| SafeError::new("recoveryReview", "nativeRecoveryReviewFailed"))
        })?;
        println!(
            "{}",
            serde_json::to_string_pretty(&review)
                .map_err(|_| SafeError::new("output", "recoveryReviewEncodingFailed"))?
        );
        require(
            review.reset_id == HELD_RESET,
            "recoveryScope",
            "heldResetChanged",
        )?;
        reset_review_scope(&review, &expected)?;
        dispatch_guard(&expected, &peers)?;
        let apply = setup
            .reserve_restart_recovery_apply(WORKING_ID, &review.review_id, HOST, true)
            .map_err(|_| SafeError::new("recoveryReservation", "heldApplyReservationFailed"))?;
        require(
            apply.request.binding == expected
                && apply.request.reset_id == HELD_RESET
                && apply.request.password,
            "recoveryPreflight",
            "reservedHeldApplyChanged",
        )?;
        reset_review_scope(&apply.cached.review, &expected)?;
        let mut authorization_failure = None;
        let result =
            setup.restart_recovery_apply_with(apply, &registry, |entry, mode, password, cancel| {
                authorize_recovery(
                    entry,
                    mode,
                    password,
                    cancel,
                    "apply",
                    &expected,
                    &peers,
                    &mut authorization_failure,
                )
            });
        if !result
            .as_ref()
            .is_ok_and(|v| v.reset_id == HELD_RESET && v.state == "complete")
        {
            report_saved_failure(&setup.directory, HELD_RESET);
        }
        reset_outcome(result, HELD_RESET, authorization_failure)?
    };
    recovery_boundary()?;
    require(
        fresh.id == RESERVED_FRESH,
        "recoveryCompletion",
        "reservedFreshIdentityChanged",
    )?;
    verify_fresh_target(&fresh, &expected, &previous_ids)?;
    let saved = setup
        .entry(&fresh.id)
        .map_err(|_| SafeError::new("recoveryCompletion", "freshEntryMissing"))?;
    verify_fresh_target(&saved, &expected, &previous_ids)?;
    setup
        .pinned_ssh_args(&saved)
        .map_err(|_| SafeError::new("recoveryCompletion", "freshPinInvalid"))?;
    verify_retired_entries(setup, &affected)?;
    require(
        registry
            .restart_unfenced(&expected.expected.environment_id)
            .is_err(),
        "recoveryCompletion",
        "targetFenceMissing",
    )?;
    require(
        current_registry_document()?["environments"]
            .get(&expected.expected.environment_id)
            .is_none(),
        "recoveryCompletion",
        "targetRegistryEntryNotRemoved",
    )?;
    verify_registry_peers(&peers, &expected.expected.environment_id)?;
    let inspected = setup
        .inspect(&fresh.id)
        .map_err(|_| SafeError::new("freshInspection", "readOnlyInspectionFailed"))?;
    let inspection = inspected
        .inspection
        .as_ref()
        .ok_or_else(|| SafeError::new("freshInspection", "inspectionMissing"))?;
    require(
        inspected.id == RESERVED_FRESH
            && inspected.target == expected.target
            && inspected.fingerprint == FINGERPRINT
            && inspected.plan.is_none()
            && inspected.installation.is_none()
            && !inspection.native_present,
        "freshInspection",
        "nativeInstallationStillPresentOrTargetChanged",
    )?;
    verify_retired_entries(setup, &affected)?;
    verify_registry_peers(&peers, &expected.expected.environment_id)?;
    println!(
        "{}",
        json!({"state": "complete", "resetId": HELD_RESET, "freshId": inspected.id,
        "nativePresent": false, "recommendation": inspection.recommendation()})
    );
    Ok(())
}

#[test]
fn recovery_requires_exact_host_and_existing_reset_before_side_effects() {
    for (host, reset) in [
        (None, None),
        (Some(OsStr::new(HOST)), None),
        (None, Some(OsStr::new(HELD_RESET))),
        (Some(OsStr::new("other-host")), Some(OsStr::new(HELD_RESET))),
        (Some(OsStr::new(HOST)), Some(OsStr::new(OPERATION_ID))),
    ] {
        assert!(recovery_opt_in(host, reset).is_err());
    }
    recovery_opt_in(Some(OsStr::new(HOST)), Some(OsStr::new(HELD_RESET))).unwrap();
}
