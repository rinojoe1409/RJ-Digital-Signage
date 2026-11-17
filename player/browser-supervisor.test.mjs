import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createKioskSupervisor } from './agent.mjs';

const flush = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
const report = { status: 'playing', currentPublicationId: 'publication-test', screen: { width: 1920, height: 1080 } };

class Clock {
  time = 0;
  nextId = 0;
  timers = new Map();
  now = () => this.time;
  timestamp = () => new Date(Date.UTC(2026, 10, 17) + this.time).toISOString();
  setTimer = (callback, delay) => { const id = ++this.nextId; this.timers.set(id, { at: this.time + delay, callback }); return id; };
  clearTimer = id => { this.timers.delete(id); };
  async advance(duration) {
    const target = this.time + duration;
    for (let count = 0; count < 10000; count++) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { this.time = target; await flush(); return; }
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    throw new Error('Unexpected unbounded timer loop.');
  }
}

class BrowserChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  exit(code = 0) { this.exitCode = code; this.emit('close', code, null); }
}

function fixture(overrides = {}) {
  const clock = new Clock(), children = [], terminated = [];
  let errors = 0;
  const supervisor = createKioskSupervisor({
    now: clock.now, timestamp: clock.timestamp, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    launch() { const child = new BrowserChild(); children.push(child); return child; },
    terminate(child) { terminated.push(child); child.exit(); },
    onError() { errors++; }, ...overrides,
  });
  return { clock, supervisor, children, terminated, get errors() { return errors; } };
}

test('Chromium handoff exit21 preserves a live delegated renderer across repeated five-second checks', async () => {
  const { clock, supervisor, children, terminated } = fixture();
  supervisor.start(); await flush();
  assert.equal(children.length, 1);
  children[0].exit(21);
  assert.equal(supervisor.reportRenderer(report), true);
  for (let cycle = 0; cycle < 60; cycle++) {
    await clock.advance(5000);
    supervisor.reportRenderer(report);
    assert.equal(supervisor.snapshot().launches, 1, 'A delegated page must not be reopened every five seconds');
    assert.equal(clock.timers.size, 1);
  }
  assert.equal(supervisor.snapshot().exits, 1);
  assert.equal(supervisor.snapshot().lastExitCode, 21);
  assert.ok(supervisor.snapshot().suppressedRestarts >= 3);
  assert.equal(supervisor.snapshot().lastRendererReportAt, clock.timestamp());
  await supervisor.stop();
  assert.equal(terminated.length, 0, 'A bootstrap that already exited is never killed or mistaken for another Edge process');
  assert.equal(clock.timers.size, 0);
});

test('no renderer after bootstrap exit recovers once after startup grace and tolerates duplicate old close callbacks', async () => {
  const { clock, supervisor, children } = fixture();
  supervisor.start(); await flush(); children[0].exit(0);
  await clock.advance(29999); assert.equal(children.length, 1);
  await clock.advance(1); assert.equal(children.length, 2);
  children[0].emit('close', 0, null);
  await clock.advance(180000);
  assert.equal(children.length, 2, 'A live owned child cannot be replaced just because renderer reports are absent');
  assert.equal(supervisor.snapshot().exits, 1);
  await supervisor.stop(); assert.equal(clock.timers.size, 0);
});

test('delegated renderer grace handles throttled reports and eventually recovers an actually missing page', async () => {
  const { clock, supervisor, children } = fixture();
  supervisor.start(); await flush(); children[0].exit(0);
  supervisor.reportRenderer(report);
  await clock.advance(60000); assert.equal(children.length, 1, 'Occluded Chromium pages can report only once per minute');
  supervisor.reportRenderer(report);
  await clock.advance(89999); assert.equal(children.length, 1);
  await clock.advance(1); assert.equal(children.length, 2, 'No child and no fresh page report eventually starts a replacement');
  await supervisor.stop();
});

test('only valid renderer reports extend liveness using receipt time, including a zero monotonic baseline', async () => {
  const { clock, supervisor, children } = fixture();
  supervisor.start(); await flush(); children[0].exit(21);
  for (const invalid of [null, {}, [], { ...report, status: 'downloading' }, { ...report, screen: { width: 0, height: 1080 } }, { ...report, currentPublicationId: '<invalid>' }]) {
    assert.equal(supervisor.reportRenderer(invalid), false);
  }
  assert.equal(supervisor.snapshot().lastRendererReportAt, null);
  assert.equal(supervisor.reportRenderer({ ...report, at: '2999-12-31T23:59:59.999Z' }), true);
  assert.equal(supervisor.snapshot().lastRendererReportAt, clock.timestamp(), 'Client timestamps cannot make a dead page appear alive forever');
  await clock.advance(5000); assert.equal(children.length, 1, 'A report received at monotonic zero is still a real report');
  await clock.advance(85000); assert.equal(children.length, 2);
  await supervisor.stop();
});

test('spawn error plus close keeps one recovery timer and stop cancels all future relaunches', async () => {
  const fixtureValue = fixture();
  const { clock, supervisor, children } = fixtureValue;
  supervisor.start(); await flush();
  children[0].emit('error', new Error('Simulated launch failure')); children[0].exit(1);
  assert.equal(fixtureValue.errors, 1);
  assert.equal(clock.timers.size, 1);
  await clock.advance(30000); assert.equal(children.length, 2);
  await supervisor.stop(); await clock.advance(180000);
  assert.equal(children.length, 2); assert.equal(clock.timers.size, 0);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('async launch is exclusive and a stop during startup disposes its eventual owned child', async () => {
  let resolveLaunch, calls = 0;
  const { clock, supervisor, terminated } = fixture({ launch() { calls++; return new Promise(resolve => { resolveLaunch = resolve; }); } });
  supervisor.start(); supervisor.start(); await flush();
  supervisor.reportRenderer(report); await clock.advance(20000);
  assert.equal(calls, 1);
  const stopped = supervisor.stop(), eventual = new BrowserChild();
  resolveLaunch(eventual); await stopped;
  assert.deepEqual(terminated, [eventual]);
  await clock.advance(180000); assert.equal(calls, 1); assert.equal(clock.timers.size, 0);
});

test('headless mode never starts browser processes or watchdog timers', async () => {
  const { supervisor, clock, children } = fixture({ enabled: false });
  supervisor.start(); supervisor.start(); await clock.advance(180000);
  assert.equal(supervisor.reportRenderer(report), false);
  assert.equal(supervisor.snapshot().state, 'disabled');
  assert.equal(children.length, 0); assert.equal(clock.timers.size, 0);
  await supervisor.stop();
});
