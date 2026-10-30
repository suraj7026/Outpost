import { useEffect, useState } from "react";
import { call, nativeApp, recordedPreview } from "./api";
import type { Connection } from "./useConnection";
import ConnectionAdministration from "./ConnectionAdministration";
import ProviderSettings from './agent/ProviderSettings';
import { AppearanceSettings, type Appearance } from "./appearance";

export default function ConnectionSettings({ connection, appearance }: { connection: Connection; appearance: Appearance }) {
  const [endpoint, setEndpoint] = useState(""),
    [token, setToken] = useState("");
  useEffect(() => {
    if (connection.info) setEndpoint(connection.info.endpoint);
  }, [connection.info?.endpoint]);
  const readOnly = recordedPreview() || !nativeApp();
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>Your device signs requests. The agent stays on your servers.</p>
        </div>
      </div>
      <ProviderSettings connection={connection} />
      <AppearanceSettings appearance={appearance} />
      <section className="settings-section">
        <div>
          <h2>Private server</h2>
          <p>
            Localhost connects through the SSH tunnel to your cluster. Remote
            endpoints must use HTTPS.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (readOnly || connection.busy || connection.info?.pending) return;
            void call("set_endpoint", { endpoint })
              // Drop old projections and in-flight event callbacks before connecting elsewhere.
              .then(() => window.location.reload())
              .catch((error) => connection.setError(String(error)));
          }}
        >
          <label htmlFor="server-url">Server URL</label>
          <input
            id="server-url"
            disabled={readOnly || connection.busy || connection.info?.pending}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="http://127.0.0.1:4318"
          />
          <button
            className="primary"
            disabled={readOnly || connection.busy || connection.info?.pending}
          >
            Save and connect
          </button>
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>Device identity</h2>
          <p>
            The signing key stays in macOS Keychain. This client reuses your
            existing Outpost device identity.
          </p>
        </div>
        <div>
          <label>Device ID</label>
          <code className="identity-value">
            {connection.info?.deviceId || "Waiting for Keychain access"}
          </code>
          <label>Public pairing key</label>
          <code className="identity-value">
            {connection.info?.publicKey || "Unavailable"}
          </code>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>First-device pairing</h2>
          <p>
            Only needed for a new server. Existing paired devices reconnect
            without a token.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (readOnly || connection.busy || connection.info?.pending) return;
            void connection.perform(async () => {
              await call("pair", { token });
              setToken("");
            });
          }}
        >
          <label htmlFor="pair-token">Bootstrap token</label>
          <input
            id="pair-token"
            disabled={readOnly || connection.busy || connection.info?.pending}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button disabled={readOnly || !token || connection.busy || connection.info?.pending}>Pair device</button>
        </form>
      </section>
      <ConnectionAdministration connection={connection} />
      <section className="settings-section">
        <div>
          <h2>Model provider</h2>
          <p>
            Only cloud models advertised by your connected Ollama server are
            listed. Local-only models are hidden. Task, tool and page context is
            sent to Ollama Cloud when a cloud model runs.
          </p>
        </div>
        <div className="model-list">
          {!connection.models.length && <p className="empty-line">No cloud models available from this Ollama server.</p>}
          {connection.models.map((model) => (
            <div key={model}>
              <span>{model}</span>
              {model === connection.runtime?.model && (
                <span className="small">Default</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

