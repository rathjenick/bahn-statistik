import { zeitzone } from './config.ts';

const teile = new Intl.DateTimeFormat('en-CA', {
  timeZone: zeitzone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function lokal(d: Date) {
  const t = Object.fromEntries(teile.formatToParts(d).map((p) => [p.type, p.value]));
  return { datum: `${t.year}-${t.month}-${t.day}`, stunde: Number(t.hour), minute: Number(t.minute), t };
}

// Kalendertag in Berlin, z. B. "2026-10-16".
export const lokalesDatum = (d: Date) => lokal(d).datum;
export const lokaleStunde = (d: Date) => lokal(d).stunde;

// Abstand Berlin–UTC in Millisekunden zum Zeitpunkt d.
function versatz(d: Date): number {
  const { t } = lokal(d);
  const alsUtc = Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour, +t.minute, +t.second);
  return alsUtc - Math.floor(d.getTime() / 1000) * 1000;
}

// 00:00 Uhr Berliner Zeit an diesem Tag.
export function mitternacht(datum: string): Date {
  const [j, m, t] = datum.split('-').map(Number);
  const naiv = Date.UTC(j, m - 1, t);
  let ergebnis = naiv - versatz(new Date(naiv));
  ergebnis = naiv - versatz(new Date(ergebnis));
  return new Date(ergebnis);
}

export function folgetag(datum: string): string {
  const [j, m, t] = datum.split('-').map(Number);
  return new Date(Date.UTC(j, m - 1, t + 1)).toISOString().slice(0, 10);
}

export const plusMinuten = (iso: string | Date, min: number) =>
  new Date(new Date(iso).getTime() + min * 60_000).toISOString();

export const minutenZwischen = (von: string, bis: string) => (Date.parse(bis) - Date.parse(von)) / 60_000;

const uhr = new Intl.DateTimeFormat('de-DE', { timeZone: zeitzone, hour: '2-digit', minute: '2-digit' });
const tag = new Intl.DateTimeFormat('de-DE', { timeZone: zeitzone, weekday: 'short', day: '2-digit', month: '2-digit' });

export const uhrzeit = (iso: string | null | undefined) => (iso ? uhr.format(new Date(iso)) : '–');
export const tagKurz = (iso: string) => tag.format(new Date(iso));
