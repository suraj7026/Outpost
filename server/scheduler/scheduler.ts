import { z } from 'zod';
import { Ledger } from '../core/ledger.js';
import { digest, id } from '../core/contracts.js';
import { NewTask, Tasks } from '../tasks/tasks.js';
export const Schedule = z.strictObject({ name: z.string().min(1),timezone: z.string(),nextAt: z.number().int().nonnegative(),intervalMs: z.number().int().min(60000).nullable(),missed: z.enum(['skip','coalesce']),paused: z.boolean().default(false),task: NewTask });
export type Schedule = z.infer<typeof Schedule>;
export class Scheduler {
  constructor(private db: Ledger, private tasks: Tasks) {}
  save(key: string, expected: number, input: unknown) {
    const schedule = Schedule.parse(input); new Intl.DateTimeFormat('en',{ timeZone: schedule.timezone }).format();
    return this.db.put('automation',key,expected,schedule);
  }
  tick(time = Date.now()) {
    return this.db.transaction(() => {
      const started: string[] = [];
      for (const schedule of this.db.list<Schedule>('automation')) {
        const data = schedule.data; if (data.paused || data.nextAt > time) continue;
        const occurrence = `${schedule.id}:${schedule.revision}:${data.nextAt}`;
        const overdue = data.intervalMs !== null && time-data.nextAt >= data.intervalMs;
        if (!(overdue && data.missed === 'skip') && !this.db.get('occurrence',occurrence)) {
          const taskId = id(); this.tasks.create(taskId,data.task); started.push(taskId);
          this.db.put('occurrence',occurrence,0,{ automationId: schedule.id,taskId,scheduledAt: data.nextAt });
        }
        const nextAt = data.intervalMs ? data.nextAt+(Math.floor((time-data.nextAt)/data.intervalMs)+1)*data.intervalMs : data.nextAt;
        this.db.put('automation',schedule.id,schedule.revision,{ ...data,nextAt,paused: data.intervalMs === null });
      }
      return started;
    });
  }
  changed(monitorId: string, observed: string) {
    const hash = digest(observed), previous = this.db.get('monitor',monitorId);
    if (previous?.data.hash === hash) return false;
    this.db.put('monitor',monitorId,previous?.revision ?? 0,{ hash,observedAt: Date.now() }); return previous !== undefined;
  }
}
