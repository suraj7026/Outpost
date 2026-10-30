const namespace = 'outpost-hosts';
const items = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'pod-security.kubernetes.io/enforce': 'privileged' } } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'coordinator-only', namespace }, spec: {
    podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'pi-workspace' } }, podSelector: { matchLabels: { app: 'pi-workspace' } } }], ports: [{ protocol: 'TCP', port: 4319 }] }],
  } },
];
for (const [name, host] of [['main', 'surajhomeserver'], ['worker', 'surajhomeserver2']]) {
  const labels = { app: `outpost-host-${name}` };
  items.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: `host-${name}`, namespace }, spec: {
    replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      nodeSelector: { 'kubernetes.io/hostname': host }, hostPID: true, automountServiceAccountToken: false,
      containers: [{ name: 'executor', image: 'node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c', command: ['node', '/executor/host-executor.mjs'],
        env: [{ name: 'OUTPOST_HOST_NAME', value: host }, { name: 'OUTPOST_HOST_TOKEN', valueFrom: { secretKeyRef: { name: 'executor-auth', key: 'token' } } }],
        securityContext: { privileged: true, runAsUser: 0, readOnlyRootFilesystem: true },
        resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '1', memory: '512Mi' } },
        readinessProbe: { httpGet: { path: '/health', port: 4319 }, periodSeconds: 5 },
        volumeMounts: [{ name: 'executor', mountPath: '/executor', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
      }], volumes: [{ name: 'executor', configMap: { name: 'host-executor' } }, { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } }],
    } },
  } });
  items.push({ apiVersion: 'v1', kind: 'Service', metadata: { name: `host-${name}`, namespace }, spec: { selector: labels, ports: [{ port: 4319, targetPort: 4319 }] } });
}
console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
