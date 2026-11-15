use super::*;

pub(super) struct Fixture {
    pub root: PathBuf,
    pub setup: Setup,
    pub entry: Entry,
}
impl Fixture {
    pub fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let root = tests::root();
        let mut setup = Setup::new(root.clone()).unwrap();
        let mut key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
        key.extend([6; 32]);
        let (key, fingerprint) =
            parse_key(&format!("fixture ssh-ed25519 {}", STANDARD.encode(key))).unwrap();
        let id = Uuid::new_v4().to_string();
        let operation = Uuid::new_v4().to_string();
        let environment = Uuid::new_v4().to_string();
        let release = format!("host-{}", "a".repeat(20));
        let entry: Entry = serde_json::from_value(json!({
            "id":id,"label":"Diagnostic fixture","target":{"host":"fixture.example","user":"operator","port":2222,"identityFile":null},
            "fingerprint":fingerprint,"phase":"installation_stopped","inspection":null,"recommendation":null,"endpoint":null,"error":null,"log":[],
            "plan":{"planId":Uuid::new_v4().to_string(),"operationId":operation,"environmentId":environment,"releaseId":release,"sha256":"a".repeat(64),"size":1,"expiresAt":0,"browser":true,"fullControl":false,"coexistenceRequired":false,"deviceId":Uuid::new_v4().to_string(),"publicKey":STANDARD.encode([7;32]),"nodeVersion":"24.22.1"},
            "installation":{"operationId":operation,"environmentId":environment,"releaseId":release,"state":"failed","completedSteps":4,"totalSteps":12,"stage":"Browser runtime","startedAt":1,"updatedAt":100,"error":"Command exited with code 1","log":[]}
        })).unwrap();
        private_write(
            &setup.directory.join(format!("{id}.known_hosts")),
            format!("{} {key}\n", Setup::alias(&id)).as_bytes(),
        )
        .unwrap();
        {
            let mut inner = setup.inner.lock().unwrap();
            inner.entries.insert(id, entry.clone());
            setup.persist(&inner).unwrap();
        }
        let script = root.join("diagnostic-ssh-fixture");
        fs::write(
            &script,
            r#"#!/usr/bin/python3
import json,sys,pathlib,time
root=pathlib.Path(__file__).parent
assert '-oStrictHostKeyChecking=yes' in sys.argv
assert not sys.argv[-1].endswith('--bootstrap')
if (root/'delay').exists(): time.sleep(2)
if '-I -B -S -c' in sys.argv[-1]:
    print((root/'diagnostic.json').read_text())
else:
    print((root/'receipt.json').read_text())
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        setup.ssh_fixture = Some(script.to_string_lossy().into_owned());
        let fixture = Self { root, setup, entry };
        fixture.receipt(&serde_json::to_value(&fixture.entry.installation).unwrap());
        fixture.wire(&fixture.response());
        fixture
    }
    pub fn response(&self) -> Value {
        let progress = serde_json::to_value(&self.entry.installation).unwrap();
        json!({"schemaVersion":1,"operationId":progress["operationId"],"environmentId":progress["environmentId"],"releaseId":progress["releaseId"],"state":"failed","stage":"Browser runtime","completedSteps":4,"totalSteps":12,"updatedAt":101,
        "sources":[
            {"id":"status.json","status":"available","text":"exit code 1","truncated":false},
            {"id":"launch.json","status":"available","text":"returnCode: 0","truncated":false},
            {"id":"command.log","status":"available","text":"unknown failure\nAPI_KEY=canary-secret-123\nhttps://user:canary-url-123@example.test\n\u{1b}[31mred\u{1b}[0m","truncated":false},
            {"id":"launch.log","status":"missing","text":"","truncated":false},
            {"id":"service","status":"missing","text":"LoadState=not-found","truncated":false}
        ]})
    }
    pub fn wire(&self, value: &Value) {
        fs::write(
            self.root.join("diagnostic.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    pub fn receipt(&self, value: &Value) {
        fs::write(
            self.root.join("receipt.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.setup.close();
        let _ = fs::remove_dir_all(&self.root);
    }
}
