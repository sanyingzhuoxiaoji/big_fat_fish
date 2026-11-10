const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Pomodoro}=require('../src/services/pomodoro.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-timer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'focus.json');}
test('pause excludes paused time and preserves linked task through completion',t=>{let now=100000;let completed=0;const timer=new Pomodoro({filePath:fixture(t),now:()=>now,autoTick:false,onComplete:()=>completed++});t.after(()=>timer.close());timer.start({taskId:'task-a',text:'写报告',workMinutes:1,restMinutes:1});now+=10000;timer.pause();assert.equal(timer.snapshot().remainingMs,50000);now+=120000;timer.resume();now+=50000;timer.tick();assert.equal(timer.snapshot().phase,'workEnd');assert.equal(timer.snapshot().taskId,'task-a');assert.equal(timer.snapshot().completedToday,1);timer.tick();assert.equal(completed,1);});
test('restart restores running deadline and does not count one completion twice',t=>{let now=100000;const filePath=fixture(t);let timer=new Pomodoro({filePath,now:()=>now,autoTick:false});timer.start({taskId:'task-b',workMinutes:1});timer.close();now+=70000;timer=new Pomodoro({filePath,now:()=>now,autoTick:false});timer.tick();assert.equal(timer.snapshot().phase,'workEnd');assert.equal(timer.snapshot().completedToday,1);timer.close();timer=new Pomodoro({filePath,now:()=>now,autoTick:false});timer.tick();assert.equal(timer.snapshot().completedToday,1);timer.close();});

test('pause arriving after deadline completes only the planned duration', t => {
  let now = 100000;
  let completed = 0;
  const timer = new Pomodoro({ filePath: fixture(t), now: () => now, autoTick: false, onComplete: () => completed++ });
  t.after(() => timer.close());
  timer.start({ workMinutes: 1 });
  now += 120000;
  timer.pause();
  assert.equal(timer.snapshot().phase, 'workEnd');
  assert.equal(timer.snapshot().completedToday, 1);
  assert.equal(timer.snapshot().focusMinutesToday, 1);
  timer.resume();
  timer.tick();
  assert.equal(completed, 1);
});
