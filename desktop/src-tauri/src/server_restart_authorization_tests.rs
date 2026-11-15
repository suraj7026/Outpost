use super::*;
use authorization::{Error, ProcessPhase};

const CANARY: &str = "restart-auth-output-secret-canary";

#[test]
fn every_local_authorization_failure_blocks_review_stop_and_apply_without_journaling() {
    for mode in ["review", "stop", "apply"] {
        for error in [
            Error::UserCancel,
            Error::Timeout,
            Error::Unavailable,
            Error::ProcessFailure {
                phase: ProcessPhase::Exit,
                code: Some(1),
            },
            Error::ProcessFailure {
                phase: ProcessPhase::AppleScript,
                code: Some(-1743),
            },
            Error::InvalidResponse,
            Error::RequestCancel,
        ] {
            let f = fixture();
            let registry = registry(&f);
            let approved_review = (mode == "apply").then(|| review(&f, &f.entry.id));
            let call_count = calls(&f).len();
            let entries = fs::read(f.setup.directory.join("entries.json")).unwrap();
            let registry_before = fs::read(f.root.join("environments/registry.json")).unwrap();
            let result = if let Some(review) = approved_review {
                f.setup
                    .restart_apply_with(
                        f.setup
                            .reserve_restart_apply(
                                &f.entry.id,
                                &review.review_id,
                                &review.host,
                                true,
                            )
                            .unwrap(),
                        &registry,
                        |_, purpose, _, _| {
                            assert_eq!(purpose, mode);
                            Err(error)
                        },
                    )
                    .map(|_| ())
            } else {
                let request = f
                    .setup
                    .reserve_restart(&f.entry.id, &f.entry.id, true)
                    .unwrap();
                if mode == "review" {
                    f.setup
                        .restart_review_with(request, |_, purpose, _, _| {
                            assert_eq!(purpose, mode);
                            Err(error)
                        })
                        .map(|_| ())
                } else {
                    f.setup.restart_stop_with(request, |_, purpose, _, _| {
                        assert_eq!(purpose, mode);
                        Err(error)
                    })
                }
            };
            assert_eq!(result.unwrap_err(), error.to_string());
            assert_eq!(calls(&f).len(), call_count);
            assert_eq!(
                fs::read(f.setup.directory.join("entries.json")).unwrap(),
                entries
            );
            assert_eq!(
                fs::read(f.root.join("environments/registry.json")).unwrap(),
                registry_before
            );
            let inner = f.setup.inner.lock().unwrap();
            assert!(inner.activities.is_empty());
            assert!(inner.restart_journal.records.is_empty());
            drop(inner);
            // A declined/failed prompt must release the temporary environment fence too.
            drop(
                registry
                    .reserve_restart_fence(&f.entry.plan.as_ref().unwrap().environment_id)
                    .unwrap(),
            );
        }
    }
}

pub(super) fn change_request(f: &Fixture, problem: &str) {
    match problem {
        "cancel" => f.setup.inner.lock().unwrap().activities[&f.entry.id]
            .cancel
            .store(true, Ordering::SeqCst),
        "token" => {
            f.setup
                .inner
                .lock()
                .unwrap()
                .activities
                .get_mut(&f.entry.id)
                .unwrap()
                .token = Uuid::new_v4().to_string()
        }
        "closed" => f.setup.closed.store(true, Ordering::SeqCst),
        "target" => {
            f.setup
                .inner
                .lock()
                .unwrap()
                .entries
                .get_mut(&f.entry.id)
                .unwrap()
                .target
                .host = "changed.example".into()
        }
        "pin" => fs::remove_file(
            f.setup
                .directory
                .join(format!("{}.known_hosts", f.entry.id)),
        )
        .unwrap(),
        _ => panic!("unknown test case"),
    }
}

#[test]
fn queued_and_post_prompt_request_failures_have_their_own_provenance() {
    for after_prompt in [false, true] {
        for (problem, expected) in [
            ("cancel", REQUEST_CANCELLED),
            ("token", REQUEST_REPLACED),
            ("closed", SUPERVISOR_UNAVAILABLE),
            ("target", "[restartRequest:targetChanged] Restart target or original operation changed. Review again."),
            ("pin", TARGET_UNVERIFIED),
        ] {
            let f = fixture();
            let request = f.setup.reserve_restart(&f.entry.id, &f.entry.id, true).unwrap();
            if !after_prompt { change_request(&f, problem); }
            let error = f.setup.restart_review_with(request, |_, _, _, _| {
                assert!(after_prompt, "queued requests must fail before prompting");
                change_request(&f, problem);
                Ok(Zeroizing::new(format!("{CANARY}\n").into_bytes()))
            }).unwrap_err();
            assert_eq!(error, expected);
            assert!(!error.contains(CANARY));
            assert!(!error.contains("[localAuthorization:"));
            assert!(calls(&f).is_empty());
            let mut inner = f.setup.inner.lock().unwrap();
            assert!(inner.restart_journal.records.is_empty());
            if problem == "token" {
                // The old ActivityGuard must not remove a replacement owner's reservation.
                assert_eq!(inner.activities.len(), 1);
                inner.activities.clear();
            } else {
                assert!(inner.activities.is_empty());
            }
        }
    }
    let mut f = fixture();
    let request = f
        .setup
        .reserve_restart(&f.entry.id, &f.entry.id, false)
        .unwrap();
    f.setup.failure = Some(CANARY.into());
    let error = f
        .setup
        .restart_review_with(request, |_, _, _, _| {
            panic!("unavailable supervisor must not prompt")
        })
        .unwrap_err();
    assert_eq!(error, SUPERVISOR_UNAVAILABLE);
    assert!(calls(&f).is_empty());
}

fn synthetic_prompt(f: &Fixture, password: bool) -> Command {
    let path = f.root.join("synthetic-native-prompt");
    fs::write(
        &path,
        if password {
            "printf 'OUTPOST-AUTH/1:approved\\nfixture-secret\\n'\n"
        } else {
            "printf 'OUTPOST-AUTH/1:approved\\n'\n"
        },
    )
    .unwrap();
    let mut command = Command::new("/bin/sh");
    command.arg(path);
    assert!(!format!("{command:?}").contains("fixture-secret"));
    command
}

#[test]
fn affirmative_native_envelope_reaches_review_with_password_only_on_helper_stdin() {
    for password in [false, true] {
        let f = fixture();
        let r = f
            .setup
            .restart_review_with(
                f.setup
                    .reserve_restart(&f.entry.id, &f.entry.id, password)
                    .unwrap(),
                |_, purpose, requested_password, cancel| {
                    assert_eq!(purpose, "review");
                    assert_eq!(requested_password, password);
                    authorization::run_prompt_command(
                        &mut synthetic_prompt(&f, password),
                        password,
                        cancel,
                        Duration::from_secs(5),
                    )
                    .map(authorization::Secret::into_input)
                },
            )
            .unwrap();
        assert!(r.can_reset);
        let calls = calls(&f);
        assert_eq!(calls.len(), 1);
        let serialized = serde_json::to_string(&calls).unwrap();
        assert!(!serialized.contains("fixture-secret"));
        assert!(serialized.contains(if password {
            "sudo -k -S -p '' --"
        } else {
            "sudo -n --"
        }));
        assert!(!fs::read_to_string(f.setup.directory.join("entries.json"))
            .unwrap()
            .contains("fixture-secret"));
        assert!(f.setup.inner.lock().unwrap().activities.is_empty());
    }
}

pub(super) fn fail_server(f: &mut Fixture, exit: u8) {
    let path = f.root.join("synthetic-server-failure");
    fs::write(
        &path,
        format!("#!/bin/sh\nprintf '{CANARY}\\n'\nprintf '{CANARY} (-128)\\n' >&2\nexit {exit}\n"),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    f.setup.ssh_fixture = Some(path.to_string_lossy().into_owned());
}

#[test]
fn server_failure_is_not_local_cancel_or_a_claim_about_sudo_passwords() {
    for exit in [0, 1] {
        let mut f = fixture();
        fail_server(&mut f, exit);
        let error = f
            .setup
            .restart_review_with(
                f.setup
                    .reserve_restart(&f.entry.id, &f.entry.id, true)
                    .unwrap(),
                allow,
            )
            .unwrap_err();
        assert!(error.starts_with(if exit == 0 {
            "[serverProtocol:review]"
        } else {
            "[serverExecution:review]"
        }));
        assert!(!error.contains(CANARY));
        assert!(!error.contains("[localAuthorization:"));
        assert!(!error.contains("wrong password"));
        assert!(!error.contains("unlocked SSH"));
        assert!(f
            .setup
            .inner
            .lock()
            .unwrap()
            .restart_journal
            .records
            .is_empty());
    }
}

#[test]
fn post_dispatch_failures_keep_unknown_fenced_outcome_and_safe_phase_labels() {
    for exit in [0, 1] {
        let mut f = fixture();
        let registry = registry(&f);
        let r = review(&f, &f.entry.id);
        fail_server(&mut f, exit);
        let result = apply(&f, &r, &registry);
        assert_eq!(result.state, "unknown");
        assert!(result.message.starts_with(if exit == 0 {
            "[serverProtocol:apply]"
        } else {
            "[serverExecution:apply]"
        }));
        assert!(!result.message.contains(CANARY));
        assert!(!result.message.contains("no cleanup was dispatched"));
        assert_eq!(f.setup.entry(&f.entry.id).unwrap().phase, "restart_pending");
        let result = f
            .setup
            .restart_status(
                f.setup.reserve_restart_status(&f.entry.id).unwrap(),
                &registry,
            )
            .unwrap();
        assert_eq!(result.state, "unknown");
        assert!(result.message.starts_with(if exit == 0 {
            "[serverProtocol:status]"
        } else {
            "[serverExecution:status]"
        }));
        assert!(!result.message.contains(CANARY));
        assert!(!f
            .setup
            .inner
            .lock()
            .unwrap()
            .restart_journal
            .records
            .is_empty());
    }
}
