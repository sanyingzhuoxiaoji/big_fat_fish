'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORK_MINUTES_DEFAULT = 25;
const REST_MINUTES_DEFAULT = 5;
const TICK_INTERVAL_MS = 1000;
const MS_PER_MINUTE = 60000;

function dayKey(nowMs) {
  const d = new Date(nowMs);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function positiveMinutes(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('minutes must be a positive number');
  }
  return value;
}

/**
 * 番茄钟：以绝对 deadline（endAt）计算剩余时间，而不是逐秒递减。
 * - 运行中重启按持久化的 endAt 继续，休眠按墙钟经过时间处理。
 * - 暂停保存 remainingMs，暂停期间不计专注，跨重启不扣时。
 * - 到期一次且仅一次：完成后进入 workEnd/restEnd 终态并被持久化，不会重复触发。
 * - close() 只停止本地自动 tick，不清掉运行状态，与 stop() 不同。
 */
class Pomodoro {
  constructor({ filePath, now, onChange, onComplete, autoTick = true } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = filePath;
    this._now = now || (() => Date.now());
    this._onChange = typeof onChange === 'function' ? onChange : null;
    this._onComplete = typeof onComplete === 'function' ? onComplete : null;
    this._closed = false;
    this._timer = null;
    this._data = this._load();
    if (autoTick) {
      this._timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
      if (typeof this._timer.unref === 'function') this._timer.unref();
    }
  }

  start({ taskId, text, workMinutes, restMinutes } = {}) {
    const now = this._now();
    // 替换未完成的回合时，把已专注的真实用时记入当日累计（不计完成）。
    this._flushUnfinished(now);
    const work = positiveMinutes(workMinutes, WORK_MINUTES_DEFAULT);
    const rest = positiveMinutes(restMinutes, REST_MINUTES_DEFAULT);
    const totalMs = Math.round(work * MS_PER_MINUTE);
    this._data.run = {
      phase: 'work',
      paused: false,
      totalMs,
      endAt: now + totalMs,
      remainingMs: totalMs,
      taskId: taskId ?? null,
      text: text ?? null,
      startedAt: now,
      restMinutes: rest,
      focusMs: 0,
      lastStartAt: now,
    };
    this._save();
    this._emitChange();
  }

  pause() {
    const run = this._data.run;
    if (!run || run.paused || (run.phase !== 'work' && run.phase !== 'rest')) return;
    const now = this._now();
    if (now >= run.endAt) {
      // 已到期但tick未跑：先完成，不冻结出0秒暂停，也不把超时计入专注。
      this._complete(now);
      return;
    }
    if (run.phase === 'work') run.focusMs += Math.max(0, now - run.lastStartAt);
    run.remainingMs = Math.max(0, run.endAt - now);
    run.paused = true;
    this._save();
    this._emitChange();
  }

  resume() {
    const run = this._data.run;
    if (!run || !run.paused) return;
    const now = this._now();
    run.endAt = now + run.remainingMs;
    run.lastStartAt = now;
    run.paused = false;
    this._save();
    this._emitChange();
  }

  stop() {
    const run = this._data.run;
    if (!run) return;
    const now = this._now();
    // 停止记录真实已用时，但不计完成；已超时未tick时专注截止到deadline。
    if (run.phase === 'work') {
      if (!run.paused) run.focusMs += Math.max(0, Math.min(now, run.endAt) - run.lastStartAt);
      if (run.focusMs > 0) this._day(now).focusedMs += run.focusMs;
    }
    this._data.run = null;
    this._save();
    this._emitChange();
  }

  startRest() {
    const now = this._now();
    this._flushUnfinished(now);
    const previous = this._data.run;
    const rest = positiveMinutes(previous && previous.restMinutes, REST_MINUTES_DEFAULT);
    const totalMs = Math.round(rest * MS_PER_MINUTE);
    this._data.run = {
      phase: 'rest',
      paused: false,
      totalMs,
      endAt: now + totalMs,
      remainingMs: totalMs,
      taskId: previous ? previous.taskId : null,
      text: previous ? previous.text : null,
      startedAt: now,
      restMinutes: rest,
      focusMs: 0,
      lastStartAt: now,
    };
    this._save();
    this._emitChange();
  }

  tick() {
    if (this._closed) return;
    const run = this._data.run;
    if (!run || run.paused) return;
    if (run.phase !== 'work' && run.phase !== 'rest') return;
    const now = this._now();
    if (now < run.endAt) {
      // 运行中每个tick都公开最新快照，UI倒计时依赖逐秒remainingMs更新。
      this._emitChange();
      return;
    }
    this._complete(now);
  }

  snapshot() {
    const now = this._now();
    const run = this._data.run;
    const today = this._data.days[dayKey(now)] || { completed: 0, focusedMs: 0 };
    let phase = 'idle';
    let paused = false;
    let remainingMs = 0;
    let totalMs = 0;
    let taskId = null;
    let text = null;
    if (run) {
      phase = run.phase;
      paused = run.paused;
      totalMs = run.totalMs;
      taskId = run.taskId;
      text = run.text;
      remainingMs = run.paused ? run.remainingMs : Math.max(0, run.endAt - now);
      if (phase === 'workEnd' || phase === 'restEnd') remainingMs = 0;
    }
    return {
      phase,
      paused,
      remainingMs,
      totalMs,
      taskId,
      text,
      completedToday: today.completed,
      focusMinutesToday: Math.round(today.focusedMs / 6000) / 10,
    };
  }

  close() {
    this._closed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _complete(now) {
    const run = this._data.run;
    let event;
    if (run.phase === 'work') {
      // 运行到期的专注时长以 deadline 为准（休眠超出 deadline 的部分不计入专注）。
      run.focusMs += Math.max(0, run.endAt - run.lastStartAt);
      const day = this._day(now);
      day.completed += 1;
      day.focusedMs += run.focusMs;
      run.phase = 'workEnd';
      event = {
        phase: 'workEnd',
        taskId: run.taskId,
        text: run.text,
        totalMs: run.totalMs,
        completedToday: day.completed,
        focusMinutesToday: Math.round(day.focusedMs / 6000) / 10,
      };
    } else {
      run.phase = 'restEnd';
      event = { phase: 'restEnd', totalMs: run.totalMs };
    }
    this._save();
    this._emitChange();
    if (this._onComplete) this._onComplete(event);
  }

  _flushUnfinished(now) {
    const run = this._data.run;
    if (!run || run.phase !== 'work') return;
    if (!run.paused) run.focusMs += Math.max(0, Math.min(now, run.endAt) - run.lastStartAt);
    if (run.focusMs > 0) this._day(now).focusedMs += run.focusMs;
  }

  _day(nowMs) {
    const key = dayKey(nowMs);
    let day = this._data.days[key];
    if (!day) {
      day = { completed: 0, focusedMs: 0 };
      this._data.days[key] = day;
    }
    return day;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('bad focus state');
      return {
        version: 1,
        run: raw.run && typeof raw.run === 'object' ? raw.run : null,
        days: raw.days && typeof raw.days === 'object' ? raw.days : {},
      };
    } catch {
      return { version: 1, run: null, days: {} };
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._data));
    fs.renameSync(tmp, this.filePath);
  }

  _emitChange() {
    if (this._onChange) this._onChange(this.snapshot());
  }
}

module.exports = { Pomodoro };
