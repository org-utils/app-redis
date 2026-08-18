// Sentinel failover probe: exercises the real wrapper (dist build) and the
// session subsystem through a sentinel failover, from inside the compose
// network. Requires the sentinel stack from docker-compose.sentinel.yml
// and a built dist/ (npm run build).
//
//   docker compose -f test/infra/docker-compose.sentinel.yml up -d
//   npm run build
//   docker run -d --name failover-probe --network infra_default \
//     -v "$PWD":/app:ro -v "$PWD/test/infra":/probe -w /probe \
//     node:22-alpine node sentinel-failover-probe.mjs
//   sleep 8 && docker stop infra-redis-master-1-1
//   docker logs -f failover-probe
//
// Expected final line: "PASS: sentinel failover preserved sessions and
// service". Note: macOS Docker Desktop cannot route container IPs from the
// host, which is why the probe runs inside the compose network.
import { RedisClientWrapper } from '/app/dist/client.js';
import { createSessionManager } from '/app/dist/session/session-manager.js';

const SENTINELS = [
  { host: '172.28.0.21', port: 26379 },
  { host: '172.28.0.22', port: 26379 },
  { host: '172.28.0.23', port: 26379 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sentinel queries need a connection to the sentinel itself (the wrapper's
// `raw` client in sentinel mode talks to the resolved master).
async function sentinelMaster() {
  const s = new RedisClientWrapper({
    host: '172.28.0.21',
    port: 26379,
    maxRetries: 1,
  });
  try {
    const r = await s.raw.sentinel('get-master-addr-by-name', 'sessions-master-1');
    return r;
  } finally {
    await s.raw.quit().catch(() => {});
  }
}

const client = new RedisClientWrapper({
  mode: 'sentinel',
  sentinelNodes: SENTINELS,
  sentinelMasterName: 'sessions-master-1',
  maxRetries: 5,
});

const manager = createSessionManager({
  client,
  config: { enabled: true, namespace: 'failover-probe', touchInterval: 1 },
});

async function expectValid(token, label) {
  const v = await manager.service.validate(token, { userId: 'probe-1' });
  if (!v.valid) {
    console.log(`FAIL ${label}: expected valid, got`, v.reason);
    process.exit(1);
  }
  console.log(`ok ${label}`);
}

console.log('1. create + validate on the current master');
const created = await manager.service.create({ userId: 'probe-1' });
await expectValid(created.token, 'validate before failover');

console.log('2. killing master-1 (docker stop infra-redis-master-1-1)');

console.log('3. waiting for sentinel failover...');
let master = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  try {
    master = await sentinelMaster();
  } catch {
    master = null;
  }
  if (master && master[0] === '172.28.0.11') {
    console.log(`ok failover completed: ${master[0]}:${master[1]} (after ${i + 1}s)`);
    break;
  }
  if (i === 59) {
    console.log('FAIL: no failover observed', master);
    process.exit(1);
  }
}

console.log('4. validate the pre-failover session through the new master');
let validated = false;
for (let i = 0; i < 20 && !validated; i++) {
  try {
    await expectValid(created.token, 'validate after failover');
    validated = true;
  } catch {
    await sleep(1000);
  }
}
if (!validated) {
  console.log('FAIL: session lost after failover');
  process.exit(1);
}

console.log('5. create + validate on the new master');
const after = await manager.service.create({ userId: 'probe-1' });
await expectValid(after.token, 'validate on new master');

console.log('PASS: sentinel failover preserved sessions and service');
await client.raw.quit();
process.exit(0);