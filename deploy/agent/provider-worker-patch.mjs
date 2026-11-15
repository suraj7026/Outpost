import { pathToFileURL } from 'node:url';

export function providerWorkerPatch(release) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(release)) throw new Error('Invalid release ID');
  const base = `.outpost/releases/${release}`;
  const security = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  const tokenMount = { name: 'pi-worker-auth', mountPath: '/run/outpost-worker', readOnly: true };
  const releaseMount = { name: 'home', mountPath: '/opt/outpost', subPath: base, readOnly: true };
  return { spec: { template: { spec: {
    shareProcessNamespace: false,
    containers: [
      { name: 'workspace', volumeMounts: [releaseMount], env: [{ name: 'PI_CODING_AGENT_DIR', value: '/home/node/.pi/agent' }] },
      { name: 'coordinator', command: ['/usr/bin/tini','--','node','--import','/opt/outpost/node_modules/tsx/dist/loader.mjs','/opt/outpost/server/main.ts'], workingDir: '/opt/outpost',
        env: [{ name: 'OUTPOST_PI_WORKER_URL', value: 'http://127.0.0.1:4320' }, { name: 'OUTPOST_PI_WORKER_TOKEN_FILE', value: '/run/outpost-worker/token' }],
        volumeMounts: [releaseMount, tokenMount] },
      { name: 'pi-worker', image: 'docker.io/library/homelab-pi-workspace:1.4.0-1', imagePullPolicy: 'Never',
        command: ['/usr/bin/tini','--','node','--import','/opt/outpost/node_modules/tsx/dist/loader.mjs','/opt/outpost/server/pi-worker/main.ts'], workingDir: '/opt/outpost',
        securityContext: security,
        env: [
          { name: 'HOME', value: '/home/node' }, { name: 'PI_CODING_AGENT_DIR', value: '/home/node/.pi/agent' },
          { name: 'OUTPOST_PI_WORKSPACES', value: '/home/node/.outpost/workspaces' }, { name: 'OUTPOST_PI_SESSIONS', value: '/home/node/.outpost/pi' },
          { name: 'OUTPOST_PI_RELEASE_FILE', value: '/opt/outpost/release.json' }, { name: 'OUTPOST_PI_WORKER_TOKEN_FILE', value: '/run/outpost-worker/token' },
          { name: 'PI_TELEMETRY', value: '0' }, { name: 'PI_SKIP_VERSION_CHECK', value: '1' },
          { name: 'PI_OLLAMA_WEB_TOOLS', value: '0' },
        ],
        resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '2', memory: '2Gi' } },
        readinessProbe: { exec: { command: ['node','-e', "const fs=require('fs'); fetch('http://127.0.0.1:4320/v1',{method:'POST',headers:{authorization:'Bearer '+fs.readFileSync('/run/outpost-worker/token','utf8').trim(),'content-type':'application/json'},body:JSON.stringify({type:'management',owner:'00000000-0000-4000-8000-000000000000',request:{type:'catalogue'}})}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"] }, initialDelaySeconds: 3, periodSeconds: 10, timeoutSeconds: 15 },
        volumeMounts: [
          { name: 'home', mountPath: '/opt/outpost/server', subPath: `${base}/worker-server`, readOnly: true },
          ...['node_modules','package.json','package-lock.json','release.json'].map(name => ({ name: 'home', mountPath: `/opt/outpost/${name}`, subPath: `${base}/${name}`, readOnly: true })),
          { name: 'home', mountPath: '/home/node/.pi/agent', subPath: '.pi/agent' },
          { name: 'home', mountPath: '/home/node/.outpost/workspaces', subPath: '.outpost/workspaces' },
          { name: 'home', mountPath: '/home/node/.outpost/pi', subPath: '.outpost/pi' },
          tokenMount, { name: 'pi-worker-tmp', mountPath: '/tmp' },
        ],
      },
    ],
    volumes: [{ name: 'pi-worker-auth', secret: { secretName: 'outpost-pi-worker', defaultMode: 288 } }, { name: 'pi-worker-tmp', emptyDir: { sizeLimit: '256Mi' } }],
  } } } };
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(providerWorkerPatch(process.argv[2]), null, 2));
