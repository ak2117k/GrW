import { eiaEvents } from './rule-events';

const HOL = ['2026-01-19', '2026-09-07', '2026-11-26'];
const OVR = [{ kind: 'eia_natgas' as const, originalDate: '2026-11-26', date: '2026-11-25', localTime: '12:00' }];
const at = (from: string, days: number, kind: string) =>
  eiaEvents(from, days, HOL, OVR).filter((e) => e.kind === kind).map((e) => e.startsAt.toISOString());

it('petroleum Wednesdays 10:30 ET across both 2026 DST switches (21:00 / 20:00 IST)', () => {
  expect(at('2026-03-02', 14, 'eia_petroleum')).toEqual(['2026-03-04T15:30:00.000Z', '2026-03-11T14:30:00.000Z']);
  expect(at('2026-10-26', 14, 'eia_petroleum')).toEqual(['2026-10-28T14:30:00.000Z', '2026-11-04T15:30:00.000Z']);
});

it('a US federal holiday Mon–Wed moves the petroleum report to Thursday', () => {
  expect(at('2026-01-19', 7, 'eia_petroleum')).toEqual(['2026-01-22T15:30:00.000Z']);
  expect(at('2026-09-07', 7, 'eia_petroleum')).toEqual(['2026-09-10T14:30:00.000Z']);
});

it('natural gas Thursdays 10:30 ET; an explicit override moves Thanksgiving to Wednesday noon', () => {
  expect(at('2026-10-26', 7, 'eia_natgas')).toEqual(['2026-10-29T14:30:00.000Z']);
  expect(at('2026-11-23', 7, 'eia_natgas')).toEqual(['2026-11-25T17:00:00.000Z']);
});

it('event shape', () => {
  const e = eiaEvents('2026-10-26', 7, [], [])[0];
  expect(e).toEqual({
    scope: 'commodity', kind: 'eia_petroleum', key: 'CRUDEOIL', title: 'EIA weekly petroleum status report',
    startsAt: new Date('2026-10-28T14:30:00.000Z'), allDay: false, impact: 'high',
    source: 'rule: EIA weekly petroleum status (Wed 10:30 ET)', sourceRef: 'eia_petroleum:2026-10-28',
  });
});
