import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeScheduleInput,
  intervalsOverlap,
  deviceOccupancySegments,
  findDeviceConflicts,
} from '../src/schedule.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const iso = (ms) => new Date(ms).toISOString();
const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

let pubId;

// 依据已发布图建立核验并完成（entries 直接按冻结图构造，必然通过）
async function completeVerificationFor(pid) {
  const created = await call('POST', '/api/verifications', { publicationId: pid });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const vid = created.json.id;
  const pub = await call('GET', `/api/publications/${pid}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${vid}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return vid;
}

async function makeReservation(batchNo, startMs, endMs) {
  const r = await call('POST', '/api/reservations', {
    batchNo,
    publicationId: pubId,
    startUtc: iso(startMs),
    endUtc: iso(endMs),
  });
  assert.equal(r.status, 201, `${batchNo}: ${JSON.stringify(r.json)}`);
  return r.json.id;
}

test('准备：配置、发布与完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  const p = await call('POST', '/api/publish');
  assert.equal(p.status, 201);
  pubId = p.json.id;
  await completeVerificationFor(pubId);
});

test('纯函数：左闭右开重叠判定（首尾相接不重叠）', () => {
  assert.equal(intervalsOverlap(0, 10, 10, 20), false);
  assert.equal(intervalsOverlap(0, 10, 5, 15), true);
  assert.equal(intervalsOverlap(0, 10, 0, 10), true);
  assert.equal(intervalsOverlap(5, 6, 0, 5), false);
});

test('纯函数：设备占用分段——相接不合并、冲突段标记', () => {
  const schedules = [
    { reservationId: 1, startMs: 0, endMs: 10 },
    { reservationId: 2, startMs: 10, endMs: 20 },
    { reservationId: 3, startMs: 5, endMs: 8 },
  ];
  const segs = deviceOccupancySegments(schedules, 0, 20);
  assert.deepEqual(
    segs.map((s) => [s.startMs, s.endMs, s.count, s.conflict]),
    [
      [0, 5, 1, false],
      [5, 8, 2, true],
      [8, 10, 1, false],
      [10, 20, 1, false],
    ],
  );
  assert.deepEqual(
    segs[1].reservationIds.sort(),
    [1, 3],
  );
  assert.deepEqual(segs[3].reservationIds, [2]);
  // findDeviceConflicts：排除自身
  const conflicts = findDeviceConflicts(schedules, 10, 20, 2);
  assert.deepEqual(conflicts.map((c) => c.reservationId), []);
  assert.deepEqual(
    findDeviceConflicts(schedules, 9, 11, null).map((c) => c.reservationId).sort(),
    [1, 2],
  );
  // 首尾相接不算冲突
  assert.deepEqual(
    findDeviceConflicts(schedules, 20, 30, null).map((c) => c.reservationId),
    [],
  );
});

test('纯函数：排班输入规整——空设备编号/非对象 → errors', () => {
  assert.ok(normalizeScheduleInput(null).errors.length);
  assert.ok(normalizeScheduleInput({}).errors.length);
  assert.ok(normalizeScheduleInput({ deviceNo: '  ' }).errors.length);
  assert.equal(normalizeScheduleInput({ deviceNo: ' CENT-01 ' }).clean.deviceNo, 'CENT-01');
});

test('排班：非法输入（空设备、非法预约编号）→ 400/404，不留记录', async () => {
  const now = Date.now();
  const rid = await makeReservation('SC-BAD', now + 3600_000, now + 7200_000);
  let r = await call('POST', `/api/reservations/${rid}/schedule`, { deviceNo: '   ' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/reservations/999999/schedule', { deviceNo: 'D1' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/reservations/0/schedule', { deviceNo: 'D1' });
  assert.equal(r.status, 400);
  const list = await call('GET', '/api/schedules');
  assert.equal(list.json.length, 0);
});

test('排班：同设备生效排班不得重叠，首尾相接允许', async () => {
  const now = Date.now();
  const t0 = now + 86_400_000; // 明天，确保未开始
  const r1 = await makeReservation('SC-OV-1', t0, t0 + 3600_000);
  const r2 = await makeReservation('SC-OV-2', t0 + 3600_000, t0 + 7200_000);
  const r3 = await makeReservation('SC-OV-3', t0 + 1800_000, t0 + 5400_000);

  let r = await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-A' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.deviceNo, 'CENT-A');
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.phase, 'notStarted');
  assert.equal(r.json.reassignable, true);
  assert.equal(r.json.cancellable, true);
  // 首尾相接 → 允许
  r = await call('POST', `/api/reservations/${r2}/schedule`, { deviceNo: 'CENT-A' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // 与两条都重叠 → 409，附冲突排班信息，不留记录
  r = await call('POST', `/api/reservations/${r3}/schedule`, { deviceNo: 'CENT-A' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors[0].includes('已被'));
  assert.equal(r.json.detail.deviceNo, 'CENT-A');
  assert.ok([r1, r2].includes(r.json.detail.conflictingReservationId));
  // 放到另一台设备 → 201
  r = await call('POST', `/api/reservations/${r3}/schedule`, { deviceNo: 'CENT-B' });
  assert.equal(r.status, 201);
});

test('排班：同预约同设备重复提交返回原记录（200）；换设备直接提交 409', async () => {
  const now = Date.now();
  const t0 = now + 2 * 86_400_000;
  const rid = await makeReservation('SC-IDEM', t0, t0 + 3600_000);
  let r = await call('POST', `/api/reservations/${rid}/schedule`, { deviceNo: 'DEV-1' });
  assert.equal(r.status, 201);
  const firstId = r.json.id;
  r = await call('POST', `/api/reservations/${rid}/schedule`, { deviceNo: 'DEV-1' });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, firstId);
  r = await call('POST', `/api/reservations/${rid}/schedule`, { deviceNo: 'DEV-2' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.existingId, firstId);
  assert.equal(r.json.detail.scheduledDeviceNo, 'DEV-1');
});

test('改派：开始前原子换设备；冲突保留原排班；同设备重放 200', async () => {
  const now = Date.now();
  const t0 = now + 3 * 86_400_000;
  const r1 = await makeReservation('SC-RE-1', t0, t0 + 3600_000);
  const r2 = await makeReservation('SC-RE-2', t0, t0 + 3600_000);

  let a = await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-X' });
  assert.equal(a.status, 201);
  const b = await call('POST', `/api/reservations/${r2}/schedule`, { deviceNo: 'CENT-Y' });
  assert.equal(b.status, 201);

  // 改派到被占用的 CENT-Y → 409，原排班保留
  let r = await call('POST', `/api/schedules/${a.json.id}/reassign`, { deviceNo: 'CENT-Y' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors[0].includes('本次改派未生效'));
  assert.equal(r.json.detail.conflictingReservationId, r2);
  const still = await call('GET', `/api/schedules/${a.json.id}`);
  assert.equal(still.json.deviceNo, 'CENT-X');
  assert.equal(still.json.reassignCount, 0);

  // 同设备重放 → 200 原记录
  r = await call('POST', `/api/schedules/${a.json.id}/reassign`, { deviceNo: 'CENT-X' });
  assert.equal(r.status, 200);
  assert.equal(r.json.reassignCount, 0);

  // 改派到空闲设备 → 200，累计 reassignCount；原设备时段释放（相接验证）
  r = await call('POST', `/api/schedules/${a.json.id}/reassign`, { deviceNo: 'CENT-Z' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.deviceNo, 'CENT-Z');
  assert.equal(r.json.reassignCount, 1);
  // CENT-X 现已空出：r2 改派过去应成功
  r = await call('POST', `/api/schedules/${b.json.id}/reassign`, { deviceNo: 'CENT-X' });
  assert.equal(r.status, 200);
  assert.equal(r.json.deviceNo, 'CENT-X');

  // 不存在的排班 → 404
  r = await call('POST', '/api/schedules/999999/reassign', { deviceNo: 'CENT-X' });
  assert.equal(r.status, 404);
});

test('取消排班：未开始可取消并释放占用；已取消幂等；取消后可重新排班', async () => {
  const now = Date.now();
  const t0 = now + 4 * 86_400_000;
  const r1 = await makeReservation('SC-CA-1', t0, t0 + 3600_000);
  const r2 = await makeReservation('SC-CA-2', t0, t0 + 3600_000);

  const a = await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-Q' });
  assert.equal(a.status, 201);
  const sid = a.json.id;
  // 占用中：r2 不能排到 CENT-Q
  let r = await call('POST', `/api/reservations/${r2}/schedule`, { deviceNo: 'CENT-Q' });
  assert.equal(r.status, 409);
  // 取消
  r = await call('POST', `/api/schedules/${sid}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'cancelled');
  assert.equal(r.json.cancellable, false);
  assert.equal(r.json.phase, 'cancelled');
  // 幂等
  r = await call('POST', `/api/schedules/${sid}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'cancelled');
  // 占用已释放
  r = await call('POST', `/api/reservations/${r2}/schedule`, { deviceNo: 'CENT-Q' });
  assert.equal(r.status, 201);
  // r1 可重新排班（历史保留）
  r = await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-Q2' });
  assert.equal(r.status, 201);
  assert.notEqual(r.json.id, sid);
  const all = await call('GET', `/api/schedules?reservationId=${r1}`);
  assert.equal(all.json.length, 2);
  const cancelled = await call('POST', `/api/schedules/${sid}/reassign`, { deviceNo: 'D' });
  assert.equal(cancelled.status, 409);
});

test('预约取消时同步取消生效排班并释放占用', async () => {
  const now = Date.now();
  const t0 = now + 5 * 86_400_000;
  const r1 = await makeReservation('SC-CAS-1', t0, t0 + 3600_000);
  const r2 = await makeReservation('SC-CAS-2', t0, t0 + 3600_000);

  const a = await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-K' });
  assert.equal(a.status, 201);
  // 取消预约
  let r = await call('POST', `/api/reservations/${r1}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.schedule, null); // 无生效排班
  const sch = await call('GET', `/api/schedules/${a.json.id}`);
  assert.equal(sch.json.status, 'cancelled');
  // 占用释放：r2 可排到同一设备同一时段
  r = await call('POST', `/api/reservations/${r2}/schedule`, { deviceNo: 'CENT-K' });
  assert.equal(r.status, 201);
  // 已取消预约不能再排班
  r = await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-K' });
  assert.equal(r.status, 409);
});

test('开始运行：有生效排班时设备必须一致；无排班沿用原放行规则；重放返回原冻结运行', async () => {
  const now = Date.now();
  const t0 = now + 500; // 先排班，稍候窗口开启
  const t1 = now + 3600_000;

  // 预约 A：排班到 DEV-S1（开始前完成排班），用别的设备开始 → 409
  const ra = await makeReservation('SC-RUN-A', t0, t1);
  let r = await call('POST', `/api/reservations/${ra}/schedule`, { deviceNo: 'DEV-S1' });
  assert.equal(r.status, 201);
  const sidA = r.json.id;
  const vers = await call('GET', '/api/verifications');
  const vid = vers.json[0].id;
  // 未到预约时段：设备不一致的检查在时段检查之前？不——这里仅验证排班一致性，
  // 等窗口开启后再提交
  await new Promise((resolve) => setTimeout(resolve, 520));
  r = await call('POST', '/api/runs', {
    runNo: 'RUN-SC-A',
    deviceNo: 'DEV-S2',
    verificationId: vid,
    reservationId: ra,
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors[0].includes('与排班设备不一致'));
  assert.equal(r.json.detail.scheduledDeviceNo, 'DEV-S1');

  // 用排班设备开始 → 201
  r = await call('POST', '/api/runs', {
    runNo: 'RUN-SC-A',
    deviceNo: 'DEV-S1',
    verificationId: vid,
    reservationId: ra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // 同运行编号同内容重放 → 200 原冻结记录（不重新核对）
  r = await call('POST', '/api/runs', {
    runNo: 'RUN-SC-A',
    deviceNo: 'DEV-S1',
    verificationId: vid,
    reservationId: ra,
  });
  assert.equal(r.status, 200);

  // 已用于运行（此时预约也已开始）：不能取消/改派排班
  r = await call('POST', `/api/schedules/${sidA}/reassign`, { deviceNo: 'DEV-S9' });
  assert.equal(r.status, 409);
  assert.match(r.json.errors[0], /已用于运行|已开始/);
  r = await call('POST', `/api/schedules/${sidA}/cancel`);
  assert.equal(r.status, 409);

  // 预约 B：无生效排班，任意设备沿用原放行规则 → 201（窗口已开启）
  const rb = await makeReservation('SC-RUN-B', now - 1000, t1);
  r = await call('GET', `/api/reservations/${rb}`);
  assert.equal(r.json.schedule, null);
  r = await call('POST', '/api/runs', {
    runNo: 'RUN-SC-B',
    deviceNo: 'DEV-FREE',
    verificationId: vid,
    reservationId: rb,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('已开始的预约不能新排班或改派（窗口覆盖当前时刻）', async () => {
  const now = Date.now();
  const started = await makeReservation('SC-STARTED', now - 60_000, now + 3600_000);
  let r = await call('POST', `/api/reservations/${started}/schedule`, { deviceNo: 'DEV-PAST' });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors[0].includes('已开始'));
});

test('查询：列表过滤、设备占用分段与冲突展示', async () => {
  const now = Date.now();
  const t0 = now + 6 * 86_400_000;
  const r1 = await makeReservation('SC-Q-1', t0, t0 + 3600_000);
  const r2 = await makeReservation('SC-Q-2', t0 + 3600_000, t0 + 7200_000);
  await call('POST', `/api/reservations/${r1}/schedule`, { deviceNo: 'CENT-OCC' });
  await call('POST', `/api/reservations/${r2}/schedule`, { deviceNo: 'CENT-OCC' });

  // 按设备过滤
  let r = await call('GET', '/api/schedules?deviceNo=CENT-OCC');
  assert.equal(r.json.length, 2);
  assert.ok(r.json.every((s) => s.deviceNo === 'CENT-OCC'));
  // 非法 deviceNo → 400；非法 reservationId → 400；非法 status → 400
  assert.equal((await call('GET', '/api/schedules?deviceNo=%20%20')).status, 400);
  assert.equal((await call('GET', '/api/schedules?reservationId=x')).status, 400);
  assert.equal((await call('GET', '/api/schedules?status=nope')).status, 400);

  // 占用查询：默认覆盖该设备全部生效排班；相接时段分为两段
  r = await call('GET', '/api/devices/CENT-OCC/occupancy');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.peak, 1);
  assert.equal(r.json.hasConflict, false);
  assert.equal(r.json.segments.length, 2);
  assert.equal(r.json.segments[0].end, r.json.segments[1].start);
  assert.deepEqual(r.json.segments[0].reservationIds, [r1]);
  assert.deepEqual(r.json.segments[1].reservationIds, [r2]);
  assert.equal(r.json.schedules.length, 2);

  // 窗口裁剪 + from≥to → 400 + 非法时间 → 400
  r = await call(
    'GET',
    `/api/devices/CENT-OCC/occupancy?from=${iso(t0 + 900_000)}&to=${iso(t0 + 4500_000)}`,
  );
  assert.equal(r.status, 200);
  assert.equal(r.json.segments.length, 2);
  assert.equal(Date.parse(r.json.segments[0].start), t0 + 900_000);
  assert.equal(Date.parse(r.json.segments[1].end), t0 + 4500_000);
  assert.equal(
    (
      await call(
        'GET',
        `/api/devices/CENT-OCC/occupancy?from=${iso(t0)}&to=${iso(t0)}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('GET', '/api/devices/CENT-OCC/occupancy?from=not-a-date')).status,
    400,
  );
  // 只给 to 且早于窗口起点（from 默认=排班起点 > to）→ 400
  assert.equal(
    (
      await call(
        'GET',
        `/api/devices/CENT-OCC/occupancy?to=${iso(t0 - 1000)}`,
      )
    ).status,
    400,
  );
  // 未知设备也可查占用（空窗口 → 当前时刻，空分段）
  r = await call('GET', '/api/devices/CENT-UNKNOWN/occupancy');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.segments, []);
  assert.equal(r.json.peak, 0);
});

test('设备视图与 /api/state 包含排班；预约视图携带 schedule 摘要', async () => {
  const devices = await call('GET', '/api/devices');
  assert.ok(devices.json.some((d) => d.deviceNo === 'CENT-OCC'));
  const state = await call('GET', '/api/state');
  assert.ok(Array.isArray(state.json.schedules));
  assert.ok(state.json.schedules.length >= 2);
});
