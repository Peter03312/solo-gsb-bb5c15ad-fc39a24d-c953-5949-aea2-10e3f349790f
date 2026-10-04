// 设备排班：排班/改派输入规整、左闭右开重叠判定与设备占用分段
// （纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 排班时段沿用预约冻结的 UTC 左闭右开窗口 [start, end)，不由操作者提交；
//   - 同一设备的生效排班不得重叠：两窗口满足 r.start < end 且 start < r.end 即冲突；
//     首尾相接（前一条终点 == 后一条起点）允许；
//   - 每个预约至多一条生效排班：重复排班（同预约同设备）返回原记录，
//     换设备必须走显式改派接口；
//   - 改派只允许在预约开始前且该预约尚未用于运行时完成；
//   - 已取消 / 已开始 / 已用于运行的预约不得改派或新排班；
//   - 未开始且未运行的排班可取消（保留历史、释放占用）；预约取消时同步取消排班。

import { normalizeDeviceNo } from './maintenance.js';

// 排班/改派请求规整：{ deviceNo }（非空，长度上限与运行接口一致）。
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeScheduleInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) return { errors: ['请求体必须是对象'], clean: null };
  const dev = normalizeDeviceNo(b.deviceNo);
  if (dev.errors.length) return { errors: dev.errors, clean: null };
  return { errors, clean: { deviceNo: dev.clean.deviceNo } };
}

// 左闭右开重叠：两个 [start, end) 窗口是否有交集（首尾相接不算重叠）。
export function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// 排班是否仍可改派/取消/新排班：
//   预约生效中、当前时刻早于预约开始、且预约尚未用于运行。
// usedByRun 为该预约关联的运行记录（存在即不可再动）。
export function canManageSchedule({ reservationStatus, startMs, nowMs, usedByRun }) {
  const reasons = [];
  if (reservationStatus === 'cancelled') {
    reasons.push('预约已取消');
  }
  if (nowMs >= startMs) {
    reasons.push('预约已开始');
  }
  if (usedByRun) {
    reasons.push('预约已用于运行');
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------- 设备占用分段 ----------
// schedules: [{ reservationId/id, startMs, endMs }]（调用前已按设备与状态过滤）。
// 返回 [{ startMs, endMs, count, reservationIds:[...], conflict }]，
// 裁剪到 [s, e)：在 [s,e) 上占用数量分段恒定；同一段内占用设备的排班集合不变。
// 左闭右开语义由「同一时刻先处理结束事件再处理开始事件」保证：
// 首尾相接的两条排班在相接时刻结束先于开始，不相接为同一段（count=1）。
// count > 1（同设备两条生效排班同时占用）的段 conflict=true。
export function deviceOccupancySegments(schedules, s, e) {
  const events = [];
  for (const it of schedules || []) {
    const a = Math.max(it.startMs, s);
    const b = Math.min(it.endMs, e);
    if (a < b) {
      events.push({ t: a, add: [it] });
      events.push({ t: b, del: [it] });
    }
  }
  // 同一时刻：结束事件先于开始事件——左闭右开
  events.sort((x, y) => {
    if (x.t !== y.t) return x.t - y.t;
    if (x.del && y.add) return -1;
    if (x.add && y.del) return 1;
    return 0;
  });

  const segments = [];
  let active = [];
  const rid = (it) => it.reservationId;
  let i = 0;
  let prev = s;
  const flush = (t) => {
    if (t <= prev) return;
    const reservationIds = active.map(rid);
    segments.push({
      startMs: prev,
      endMs: t,
      count: active.length,
      reservationIds,
      conflict: active.length > 1,
    });
    prev = t;
  };
  while (i < events.length) {
    const t = events[i].t;
    flush(t);
    while (i < events.length && events[i].t === t) {
      const ev = events[i];
      if (ev.del) {
        const ids = new Set(ev.del.map(rid));
        active = active.filter((x) => !ids.has(rid(x)));
      }
      if (ev.add) {
        active = [...active, ...ev.add];
      }
      i += 1;
    }
  }
  flush(e);
  return segments;
}

// 在设备占用分段中找出与候选窗口 [startMs, endMs) 冲突的生效排班编号
// （同设备时间重叠、且不是候选自身 excludeReservationId）。
// 返回 [{ reservationId, startMs, endMs }]（可能多条）。
export function findDeviceConflicts(schedules, startMs, endMs, excludeReservationId = null) {
  const out = [];
  for (const it of schedules || []) {
    if (excludeReservationId != null && it.reservationId === excludeReservationId) continue;
    if (intervalsOverlap(startMs, endMs, it.startMs, it.endMs)) {
      out.push({
        reservationId: it.reservationId,
        startMs: it.startMs,
        endMs: it.endMs,
      });
    }
  }
  return out;
}
