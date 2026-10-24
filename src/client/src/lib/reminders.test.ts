import { describe, expect, it } from 'vitest'
import { isReminderDue, REMINDER_DUE_WINDOW_MS, reminderKey } from './reminders.js'

describe('isReminderDue', () => {
  const START = 1_000_000

  it('is not due before the programme starts', () => {
    expect(isReminderDue(START, START - 1)).toBe(false)
  })

  it('is due the moment the programme starts, and for a short window after', () => {
    expect(isReminderDue(START, START)).toBe(true)
    expect(isReminderDue(START, START + REMINDER_DUE_WINDOW_MS - 1)).toBe(true)
  })

  it('stops being due once the window passes — stale tabs stay quiet', () => {
    expect(isReminderDue(START, START + REMINDER_DUE_WINDOW_MS)).toBe(false)
    expect(isReminderDue(START, START + REMINDER_DUE_WINDOW_MS * 10)).toBe(false)
  })
})

describe('reminderKey', () => {
  it('identifies a programme by tvg_id and start', () => {
    expect(reminderKey('101', 1234)).toBe('101:1234')
  })
})
