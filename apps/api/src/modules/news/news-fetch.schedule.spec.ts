import { readFileSync } from 'fs';
import { join } from 'path';
import { CronTime } from 'cron';
import { NEWS_FETCH_CRONS } from './news-fetch.schedule';

/** IST wall clock → Date. */
const ist = (s: string) => new Date(`${s}+05:30`);

/** Does any news-fetch cron fire at exactly this IST minute? Evaluated in Asia/Kolkata, as @Cron is. */
function firesAt(at: Date): boolean {
  return Object.values(NEWS_FETCH_CRONS).some((expr) => {
    const next = new CronTime(expr, 'Asia/Kolkata').getNextDateFrom(new Date(at.getTime() - 1000));
    return next.toMillis() === at.getTime();
  });
}

describe('news-fetch schedule — covers the NSE session AND the MCX evening', () => {
  it('fires every 5 minutes on a weekday from 08:00 to 23:30 IST', () => {
    for (const t of ['08:00', '09:15', '12:40', '15:30', '17:05', '21:00', '23:00', '23:30']) {
      expect({ t, fires: firesAt(ist(`2026-10-12T${t}:00`)) }).toEqual({ t, fires: true });
    }
  });

  it('is quiet before 08:00, after 23:30 and between the 5-minute marks', () => {
    for (const t of ['03:00', '07:55', '23:35', '23:55', '12:41']) {
      expect({ t, fires: firesAt(ist(`2026-10-12T${t}:00`)) }).toEqual({ t, fires: false });
    }
  });

  it('weekdays only', () => {
    expect(firesAt(ist('2026-10-10T12:00:00'))).toBe(false); // Saturday
    expect(firesAt(ist('2026-10-11T12:00:00'))).toBe(false); // Sunday
  });

  it('the scheduler pins Asia/Kolkata on every @Cron', () => {
    const src = readFileSync(join(__dirname, 'news-fetch.schedule.ts'), 'utf8');
    const crons = [...src.matchAll(/@Cron\(([^)]*)\)/g)].map((m) => m[1]);
    expect(crons.length).toBe(Object.keys(NEWS_FETCH_CRONS).length);
    for (const c of crons) expect(c).toMatch(/timeZone: 'Asia\/Kolkata'/);
  });
});
