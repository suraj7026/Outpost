use super::super::tests::{inspected, root, tunnel_fixture};
use super::*;
const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OLD: &str = "http://127.0.0.1:1";
fn registry(root: &std::path::Path, create: bool) -> environments::Registry {
    if create {
        drop(
            environments::Registry::new(root.into(), Arc::new(tokio::sync::Mutex::new(())))
                .unwrap(),
        );
        private_write(&root.join("environments/registry.json"), &serde_json::to_vec(&json!({
            "version":1,"legacyMutationsRetired":false,"selectedEnvironmentId":A,"environments":{
                A:{"environmentId":A,"label":"Owner A","routes":[OLD,"https://manual.example"],"activeRoute":OLD},
                B:{"environmentId":B,"label":"Owner B","routes":["https://other.example"],"activeRoute":"https://other.example"}
            }
        })).unwrap()).unwrap();
    }
    let mut registry =
        environments::Registry::new(root.into(), Arc::new(tokio::sync::Mutex::new(()))).unwrap();
    registry.fixture_identity = true;
    environments::tests::identify(&registry.get(A).unwrap());
    registry
}
fn binding(registry: &environments::Registry) -> environments::SshBinding {
    registry
        .ssh_bindings()
        .unwrap()
        .into_iter()
        .find(|(id, _)| id == A)
        .unwrap()
        .1
}
fn metadata(root: &std::path::Path) -> Value {
    serde_json::from_slice(&fs::read(root.join("environments/registry.json")).unwrap()).unwrap()
}
#[test]
fn saved_ssh_restart_recovers_without_inspection_installation_or_enrollment() {
    tauri::async_runtime::block_on(async {
        let dir = root();
        let mut setup = Setup::new(dir.clone()).unwrap();
        let entry = inspected(&setup, A);
        tunnel_fixture(&mut setup, A);
        setup.persist(&setup.inner.lock().unwrap()).unwrap();
        let registry = registry(&dir, true);
        let other = metadata(&dir)["environments"][B].clone();
        setup.restore_bindings(&registry).unwrap();
        assert!(!registry.route_available(A));
        assert!(
            registry
                .get(A)
                .unwrap()
                .prepare_request("v1/query", json!({"type":"snapshot"}), true)
                .is_err(),
            "Never send signed requests to the stale saved port"
        );
        let recovery = dir.join(format!("environments/{A}/pending.enc"));
        fs::write(&recovery, b"preserve recovery bytes even when unreadable").unwrap();
        let first = binding(&registry);
        assert!(setup.recover_saved(&registry, A, &first).await.unwrap());
        let first_route = binding(&registry).route;
        assert_ne!(first_route, OLD);
        assert!(registry.route_available(A));
        assert_eq!(metadata(&dir)["selectedEnvironmentId"], A);
        assert_eq!(metadata(&dir)["environments"][B], other);
        assert_eq!(
            metadata(&dir)["environments"][A]["routes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(metadata(&dir)["environments"][A]["label"], "Owner A");
        assert!(
            !setup
                .recover_saved(&registry, A, &binding(&registry))
                .await
                .unwrap(),
            "Healthy routes do not churn"
        );
        setup.close();
        drop(setup);
        drop(registry);
        let mut setup = Setup::new(dir.clone()).unwrap();
        tunnel_fixture(&mut setup, A);
        let registry = self::registry(&dir, false);
        assert!(!registry.route_available(A));
        assert!(setup
            .recover_saved(&registry, A, &binding(&registry))
            .await
            .unwrap());
        assert_ne!(binding(&registry).route, first_route);
        assert_eq!(
            metadata(&dir)["environments"][A]["routes"]
                .as_array()
                .unwrap()
                .len(),
            2,
            "Ephemeral ports are replaced, not accumulated"
        );
        assert_eq!(
            fs::read(&recovery).unwrap(),
            b"preserve recovery bytes even when unreadable"
        );
        assert_eq!(
            setup.inner.lock().unwrap().entries[&entry.id]
                .inspection
                .as_ref()
                .unwrap()
                .environment
                .as_ref()
                .unwrap()
                .environment_id,
            A
        );
        let log = fs::read_to_string(setup.directory.join("fixture-requests")).unwrap();
        assert!(log
            .lines()
            .all(|line| serde_json::from_str::<Value>(line).unwrap()["type"] == "environment"));
        setup.close();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn dropped_tunnels_recover_and_explicit_pause_survives_restart() {
    tauri::async_runtime::block_on(async {
        let dir = root();
        let mut setup = Setup::new(dir.clone()).unwrap();
        let entry = inspected(&setup, A);
        tunnel_fixture(&mut setup, A);
        let registry = registry(&dir, true);
        setup.restore_bindings(&registry).unwrap();
        setup
            .recover_saved(&registry, A, &binding(&registry))
            .await
            .unwrap();
        let first_route = binding(&registry).route;
        {
            let mut inner = setup.inner.lock().unwrap();
            let child = inner.tunnels.get_mut(&entry.id).unwrap();
            child.kill().unwrap();
            child.wait().unwrap();
        }
        setup
            .recover_saved(&registry, A, &binding(&registry))
            .await
            .unwrap();
        assert_ne!(binding(&registry).route, first_route);
        registry.ssh_policy(A, true).unwrap();
        setup.pause_route(&entry.id).unwrap();
        assert!(!registry.route_available(A));
        assert!(!setup
            .recover_saved(&registry, A, &binding(&registry))
            .await
            .unwrap());
        assert!(setup.inner.lock().unwrap().tunnels.is_empty());
        setup.close();
        drop(setup);
        drop(registry);
        let mut setup = Setup::new(dir.clone()).unwrap();
        tunnel_fixture(&mut setup, A);
        let registry = self::registry(&dir, false);
        setup.restore_bindings(&registry).unwrap();
        assert!(binding(&registry).paused);
        assert_eq!(registry.lifecycle(A).unwrap().unwrap()["state"], "paused");
        registry.ssh_policy(A, false).unwrap();
        setup.resume_route(&entry.id).unwrap();
        setup
            .recover_saved(&registry, A, &binding(&registry))
            .await
            .unwrap();
        assert!(registry.route_available(A));
        setup.close();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn changed_pin_identity_or_enrollment_never_publishes_a_route() {
    tauri::async_runtime::block_on(async {
        for failure in ["pin", "installation", "enrollment"] {
            let dir = root();
            let mut setup = Setup::new(dir.clone()).unwrap();
            let entry = inspected(&setup, A);
            tunnel_fixture(&mut setup, if failure == "installation" { B } else { A });
            let registry = registry(&dir, true);
            setup.restore_bindings(&registry).unwrap();
            if failure == "pin" {
                fs::write(
                    setup.directory.join(format!("{}.known_hosts", entry.id)),
                    "changed",
                )
                .unwrap();
            }
            if failure == "enrollment" {
                fs::write(setup.directory.join("fixture-reject"), "reject").unwrap();
            }
            assert!(
                setup
                    .recover_saved(&registry, A, &binding(&registry))
                    .await
                    .is_err(),
                "{failure}"
            );
            assert_eq!(binding(&registry).route, OLD);
            assert!(!registry.route_available(A));
            assert!(setup.inner.lock().unwrap().tunnels.is_empty());
            setup.close();
            fs::remove_dir_all(dir).unwrap();
        }
    });
}
#[test]
fn cancellation_generation_prevents_late_route_publication_even_after_resume() {
    tauri::async_runtime::block_on(async {
        let dir = root();
        let mut setup = Setup::new(dir.clone()).unwrap();
        let entry = inspected(&setup, A);
        tunnel_fixture(&mut setup, A);
        let registry = registry(&dir, true);
        setup.restore_bindings(&registry).unwrap();
        let old = binding(&registry);
        let route = setup.tunnel(&entry.id).await.unwrap().endpoint.unwrap();
        registry.ssh_policy(A, true).unwrap();
        registry.ssh_policy(A, false).unwrap();
        assert!(registry
            .replace_ssh(A, &old, &route, || true)
            .await
            .unwrap_err()
            .contains("changed or paused"));
        assert_eq!(binding(&registry).route, OLD);
        assert!(!registry.route_available(A));
        assert!(
            registry
                .replace_ssh(A, &binding(&registry), &route, || false)
                .await
                .is_err(),
            "Shutdown/cancelled tunnel cannot publish"
        );
        setup.close();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn ambiguous_missing_removed_and_direct_connections_are_not_guessed() {
    let dir = root();
    let setup = Setup::new(dir.clone()).unwrap();
    let registry = registry(&dir, true);
    inspected(&setup, A);
    inspected(&setup, A);
    inspected(&setup, B);
    setup.restore_bindings(&registry).unwrap();
    assert!(
        registry.ssh_bindings().unwrap().is_empty(),
        "Ambiguous A journals and B's direct HTTPS route are untouched"
    );
    assert_eq!(
        metadata(&dir)["environments"][B]["activeRoute"],
        "https://other.example"
    );
    registry
        .attach_ssh(
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
            false,
        )
        .unwrap();
    assert_eq!(
        metadata(&dir)["environments"].as_object().unwrap().len(),
        2,
        "No removed connection is recreated"
    );
    setup.close();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn concurrent_recovery_attempts_own_only_one_tunnel() {
    tauri::async_runtime::block_on(async {
        let dir = root();
        let mut setup = Setup::new(dir.clone()).unwrap();
        inspected(&setup, A);
        tunnel_fixture(&mut setup, A);
        let registry = registry(&dir, true);
        setup.restore_bindings(&registry).unwrap();
        let expected = binding(&registry);
        let (first, second) = tokio::join!(
            setup.recover_saved(&registry, A, &expected),
            setup.recover_saved(&registry, A, &expected)
        );
        assert!(first.is_ok() || second.is_ok());
        assert_eq!(setup.inner.lock().unwrap().tunnels.len(), 1);
        assert!(registry.route_available(A));
        assert_eq!(
            metadata(&dir)["environments"][A]["routes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        setup.close();
        fs::remove_dir_all(dir).unwrap();
    });
}
#[test]
fn reconnect_backoff_is_bounded_and_auth_failures_need_attention() {
    assert!(retryable("Cannot reach your server. network unavailable"));
    assert!(!retryable("Device enrollment revoked"));
    assert!(!retryable("Pinned host key changed; connection blocked"));
    assert!(!retryable(
        "SSH installation identity does not match this saved server"
    ));
    assert!(retry_delay(1, A) < retry_delay(4, A));
    assert!(retry_delay(u32::MAX, A) < Duration::from_secs(61));
    assert_ne!(retry_delay(1, A), retry_delay(1, B));
}
