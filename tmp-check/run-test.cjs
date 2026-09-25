// 定时任务时间计算冒烟测试（临时脚本，验证 lib/scheduled-task.ts 的核心逻辑）
const lib = require('./lib/scheduled-task.js')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// 固定参照时间：2026-09-21 是周一，本地 10:00:00
const ref = new Date(2026, 8, 21, 10, 0, 0, 0).getTime()

// ── 每天 09:30：今天已过 → 上次=今天 09:30，下次=明天 09:30 ──
const daily = { kind: 'daily', hour: 9, minute: 30 }
check('daily/previous', new Date(lib.previousTriggerAt(daily, ref)).toString(), new Date(2026, 8, 21, 9, 30).toString())
check('daily/next', new Date(lib.nextTriggerAt(daily, ref)).toString(), new Date(2026, 8, 22, 9, 30).toString())

// 时刻未到（每天 18:30）：上次=昨天 18:30，下次=今天 18:30
const dailyLate = { kind: 'daily', hour: 18, minute: 30 }
check('daily-late/previous', new Date(lib.previousTriggerAt(dailyLate, ref)).toString(), new Date(2026, 8, 20, 18, 30).toString())
check('daily-late/next', new Date(lib.nextTriggerAt(dailyLate, ref)).toString(), new Date(2026, 8, 21, 18, 30).toString())

// ── 工作日 12:30：周一 10:00 → 上次=上周五 12:30，下次=今天 12:30 ──
const weekdays = { kind: 'weekdays', hour: 12, minute: 30 }
check('weekdays/previous', new Date(lib.previousTriggerAt(weekdays, ref)).toString(), new Date(2026, 8, 18, 12, 30).toString())
check('weekdays/next', new Date(lib.nextTriggerAt(weekdays, ref)).toString(), new Date(2026, 8, 21, 12, 30).toString())

// 周末（2026-09-19 周六 10:00）：工作日任务下次=周一 12:30
const saturday = new Date(2026, 8, 19, 10, 0, 0, 0).getTime()
check('weekdays/next-on-saturday', new Date(lib.nextTriggerAt(weekdays, saturday)).toString(), new Date(2026, 8, 21, 12, 30).toString())
check('weekdays/previous-on-saturday', new Date(lib.previousTriggerAt(weekdays, saturday)).toString(), new Date(2026, 8, 18, 12, 30).toString())

// ── 每周一 10:00：参照时间正好 10:00 → 上次=今天（含等于），下次=下周一 ──
const weeklyMon = { kind: 'weekly', weekday: 1, hour: 10, minute: 0 }
check('weekly/previous-equal', new Date(lib.previousTriggerAt(weeklyMon, ref)).toString(), new Date(2026, 8, 21, 10, 0).toString())
check('weekly/next', new Date(lib.nextTriggerAt(weeklyMon, ref)).toString(), new Date(2026, 8, 28, 10, 0).toString())

// ── 每月 1 日 09:00：9-21 参照 → 上次=9/1，下次=10/1 ──
const monthly = { kind: 'monthly', monthDay: 1, hour: 9, minute: 0 }
check('monthly/previous', new Date(lib.previousTriggerAt(monthly, ref)).toString(), new Date(2026, 8, 1, 9, 0).toString())
check('monthly/next', new Date(lib.nextTriggerAt(monthly, ref)).toString(), new Date(2026, 9, 1, 9, 0).toString())

// ── 文案 key / 参数 ──
check('label/daily', lib.scheduleLabel(daily), { key: 'scheduledTasks.schedule.daily', params: { time: '09:30' } })
check('label/weekdays', lib.scheduleLabel(weekdays), { key: 'scheduledTasks.schedule.weekdays', params: { time: '12:30' } })
check('label/weekly', lib.scheduleLabel(weeklyMon), { key: 'scheduledTasks.schedule.weekly', params: { weekday: 'monday', time: '10:00' } })
check('label/monthly', lib.scheduleLabel(monthly), { key: 'scheduledTasks.schedule.monthly', params: { day: 1, time: '09:00' } })
check('label/text', lib.scheduleLabelText(weeklyMon, (key, params) => `${key}|${JSON.stringify(params)}`), 'scheduledTasks.schedule.weekly|{"weekday":"scheduledTasks.weekday.monday","time":"10:00"}')

// ── 耗时 / 时刻展示 ──
check('duration/short', lib.formatDuration(12_500), '12s')
check('duration/min', lib.formatDuration(65_000), '1m 05s')
check('duration/hour', lib.formatDuration(3_723_000), '1h 02m')
check('moment/today', lib.formatMoment(new Date(2026, 8, 21, 18, 5).getTime(), ref), { kind: 'today', time: '18:05' })
check('moment/yesterday', lib.formatMoment(new Date(2026, 8, 20, 9, 5).getTime(), ref), { kind: 'yesterday', time: '09:05' })
check('moment/date', lib.formatMoment(new Date(2026, 7, 12, 9, 5).getTime(), ref), { kind: 'date', time: '09:05', date: '08-12' })

// ── 助手回复摘要 ──
const long = 'x'.repeat(300)
check('summary/none', lib.summarizeAssistantReply([{ role: 'user', content: 'hi' }]), undefined)
check('summary/last', lib.summarizeAssistantReply([{ role: 'assistant', content: ' 第一版 ' }, { role: 'assistant', content: ' 结果：完成\n第二行 ' }]), '结果：完成 第二行')
check('summary/truncate', lib.summarizeAssistantReply([{ role: 'assistant', content: long }]).length, 201)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
