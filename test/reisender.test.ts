import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oeffne, Speicher, type Reise } from '../src/db.ts';
import { schritt, vorbereiten, type Regeln } from '../src/reisender.ts';
import type { Abschnitt, Fahrplanauskunft, Halt, PlanAnfrage, Reiseplan } from '../src/transitous.ts';

const regeln: Regeln = {
  mindestUmstiegMin: 5,
  umplanPufferMin: 3,
  ankunftNachlaufMin: 2,
  aufgebenNachStunden: 24,
  verkehrsmittel: 'RAIL',
  ohneBetreiber: 'flix',
};

const t = (hhmm: string) => `2026-10-17T${hhmm}:00.000Z`;

// Ein Zug mit Halten [Name, Soll, Ist?, ausgefallen?].
type HaltDef = [string, string, string?, boolean?];
function zug(tripId: string, name: string, halte: HaltDef[]): Reiseplan {
  const h = halte.map(([n, soll, ist, aus]): Halt => ({
    name: n,
    stopId: n,
    scheduledArrival: t(soll),
    arrival: t(ist ?? soll),
    scheduledDeparture: t(soll),
    departure: t(ist ?? soll),
    cancelled: aus,
  }));
  const leg: Abschnitt = {
    mode: 'REGIONAL_RAIL',
    from: h[0],
    to: h.at(-1)!,
    intermediateStops: h.slice(1, -1),
    startTime: h[0].departure!,
    endTime: h.at(-1)!.arrival!,
    scheduledStartTime: h[0].scheduledDeparture!,
    scheduledEndTime: h.at(-1)!.scheduledArrival!,
    realTime: true,
    duration: 0,
    tripId,
    displayName: name,
  };
  return { startTime: leg.startTime, endTime: leg.endTime, duration: 0, transfers: 0, legs: [leg] };
}

// Abschnitt eines Zugs zwischen zwei Halten, wie ihn die Planung liefert (Soll).
function abschnitt(z: Reiseplan, von: string, nach: string): Abschnitt {
  const halte = [z.legs[0].from, ...z.legs[0].intermediateStops!, z.legs[0].to];
  const a = halte.find((h) => h.stopId === von)!;
  const b = halte.find((h) => h.stopId === nach)!;
  return {
    ...z.legs[0],
    from: a,
    to: b,
    intermediateStops: [],
    startTime: a.scheduledDeparture!,
    endTime: b.scheduledArrival!,
    scheduledStartTime: a.scheduledDeparture!,
    scheduledEndTime: b.scheduledArrival!,
  };
}

class FalscheBahn implements Fahrplanauskunft {
  zuege = new Map<string, Reiseplan>();
  plaene: ((a: PlanAnfrage) => Abschnitt[][]) = () => [];
  anfragen: PlanAnfrage[] = [];
  constructor(...zuege: Reiseplan[]) {
    for (const z of zuege) this.zuege.set(z.legs[0].tripId!, z);
  }
  async plan(a: PlanAnfrage) {
    this.anfragen.push(a);
    return {
      itineraries: this.plaene(a).map((legs) => ({
        startTime: legs[0].startTime,
        endTime: legs.at(-1)!.endTime,
        duration: 0,
        transfers: legs.length - 1,
        legs,
      })),
    };
  }
  async fahrt(id: string) {
    return this.zuege.get(id) ?? null;
  }
  async suche() {
    return [];
  }
}

function neueReise(soll: Abschnitt[]): { speicher: Speicher; reise: Reise } {
  const speicher = new Speicher(oeffne(':memory:'));
  const fahrten = vorbereiten(soll);
  speicher.neueReise({
    strecke: 'test',
    datum: '2026-10-17',
    signatur: 'x',
    sollAb: fahrten[0].scheduledStartTime,
    sollAn: fahrten.at(-1)!.scheduledEndTime,
    sollUmstiege: fahrten.length - 1,
    soll: fahrten,
    reisender: {
      ort: { stopId: fahrten[0].from.stopId, name: fahrten[0].from.name },
      ziel: { stopId: 'Ziel', name: 'Ziel' },
      zeit: fahrten[0].scheduledStartTime,
      plan: structuredClone(fahrten),
      anBord: false,
    },
  });
  return { speicher, reise: speicher.faellige(new Date('2030-01-01'))[0] };
}

// Lässt die Uhr jeweils bis zur nächsten Prüfung springen.
async function fahre(reise: Reise, api: Fahrplanauskunft) {
  const arten: string[] = [];
  for (let i = 0; i < 50 && reise.naechstePruefung; i++) {
    const jetzt = new Date(Date.parse(reise.naechstePruefung) + 1_000);
    for (const e of await schritt(reise, jetzt, api, regeln)) arten.push(`${e.art}@${e.ort}`);
  }
  return arten;
}

test('pünktliche Reise mit Umstieg', async () => {
  const a = zug('A', 'RE6', [['Heide', '06:00'], ['Altona', '07:20']]);
  const b = zug('B', 'ICE 1', [['Altona', '07:37'], ['Ziel', '09:51']]);
  const { reise } = neueReise([abschnitt(a, 'Heide', 'Altona'), abschnitt(b, 'Altona', 'Ziel')]);
  const arten = await fahre(reise, new FalscheBahn(a, b));
  assert.equal(reise.zustand, 'angekommen');
  assert.equal(reise.verspaetungMin, 0);
  assert.equal(reise.umplanungen, 0);
  assert.deepEqual(arten, ['abfahrt@Heide', 'ankunft_halt@Altona', 'anschluss_ok@Altona', 'abfahrt@Altona', 'ankunft_ziel@Ziel']);
});

test('Verspätung reißt den Anschluss, Ankunft mit dem nächsten Zug', async () => {
  const a = zug('A', 'RE6', [['Heide', '06:00', '06:10'], ['Altona', '07:20', '07:34']]);
  const b = zug('B', 'ICE 1', [['Altona', '07:37'], ['Ziel', '09:51']]);
  const c = zug('C', 'ICE 3', [['Altona', '08:37', '08:40'], ['Ziel', '10:51', '10:55']]);
  const bahn = new FalscheBahn(a, b, c);
  bahn.plaene = () => [[abschnitt(c, 'Altona', 'Ziel')].map((x) => ({ ...x, startTime: t('08:40'), endTime: t('10:55') }))];
  const { reise } = neueReise([abschnitt(a, 'Heide', 'Altona'), abschnitt(b, 'Altona', 'Ziel')]);
  const arten = await fahre(reise, bahn);
  assert.equal(reise.zustand, 'angekommen');
  assert.equal(reise.verpassteAnschluesse, 1);
  assert.equal(reise.umplanungen, 1);
  assert.equal(reise.verspaetungMin, 64);
  assert.equal(reise.istAb, t('06:10'));
  assert.match(reise.ursache!, /ICE 1 in Altona verpasst/);
  assert.ok(arten.includes('anschluss_verpasst@Altona'));
  // Umgeplant wird ab Ankunft plus Puffer.
  assert.equal(bahn.anfragen[0].zeit.toISOString(), t('07:37'));
  assert.equal(bahn.anfragen[0].von, 'Altona');
});

test('Übergang: Maßstab ist der geplante, höchstens 5 min', async () => {
  // Geplant sind 4 min Übergang, tatsächlich bleiben 3 min.
  // Maßstab ist min(geplant, 5) = 4, also verpasst.
  const a = zug('A', 'RE', [['X', '06:00'], ['Y', '06:30', '06:31']]);
  const b = zug('B', 'IC', [['Y', '06:34'], ['Ziel', '07:00']]);
  const { reise } = neueReise([abschnitt(a, 'X', 'Y'), abschnitt(b, 'Y', 'Ziel')]);
  const bahn = new FalscheBahn(a, b);
  await fahre(reise, bahn);
  assert.equal(reise.verpassteAnschluesse, 1);

  // Bei 4 min tatsächlichem Übergang klappt es.
  const a2 = zug('A', 'RE', [['X', '06:00'], ['Y', '06:30']]);
  const { reise: r2 } = neueReise([abschnitt(a2, 'X', 'Y'), abschnitt(b, 'Y', 'Ziel')]);
  await fahre(r2, new FalscheBahn(a2, b));
  assert.equal(r2.zustand, 'angekommen');
  assert.equal(r2.verpassteAnschluesse, 0);
});

test('Ausfall am Start: nächste Verbindung', async () => {
  const a = zug('A', 'RE6', [['Heide', '06:00', undefined, true], ['Ziel', '07:20', undefined, true]]);
  const b = zug('B', 'RE6', [['Heide', '07:00'], ['Ziel', '08:20', '08:25']]);
  const bahn = new FalscheBahn(a, b);
  bahn.plaene = () => [[{ ...abschnitt(b, 'Heide', 'Ziel'), endTime: t('08:25') }]];
  const { reise } = neueReise([abschnitt(a, 'Heide', 'Ziel')]);
  const arten = await fahre(reise, bahn);
  assert.equal(reise.zustand, 'angekommen');
  assert.equal(reise.ausfaelle, 1);
  assert.equal(reise.verspaetungMin, 65);
  assert.equal(reise.istAb, t('07:00'));
  assert.deepEqual(arten.slice(0, 2), ['ausfall@Heide', 'umgeplant@Heide']);
});

test('Zug endet vorzeitig: Ausstieg am letzten bedienten Halt', async () => {
  const a = zug('A', 'ICE 1', [['Altona', '07:00'], ['Hannover', '08:30', '08:40'], ['Bielefeld', '09:30', undefined, true], ['Ziel', '10:30', undefined, true]]);
  const b = zug('B', 'IC 2', [['Hannover', '09:00'], ['Ziel', '11:30']]);
  const bahn = new FalscheBahn(a, b);
  bahn.plaene = (anfrage) => (anfrage.von === 'Hannover' ? [[abschnitt(b, 'Hannover', 'Ziel')]] : []);
  const { reise } = neueReise([abschnitt(a, 'Altona', 'Ziel')]);
  const arten = await fahre(reise, bahn);
  assert.ok(arten.includes('teilausfall@Hannover'), arten.join());
  assert.equal(reise.zustand, 'angekommen');
  assert.equal(reise.verspaetungMin, 60);
});

test('keine Weiterfahrt: gestrandet', async () => {
  const a = zug('A', 'RE', [['X', '06:00', undefined, true], ['Ziel', '07:00', undefined, true]]);
  const { reise } = neueReise([abschnitt(a, 'X', 'Ziel')]);
  await fahre(reise, new FalscheBahn(a));
  assert.equal(reise.zustand, 'gestrandet');
  assert.equal(reise.verspaetungMin, null);
});

test('FlixTrain wird beim Umplanen nicht genommen', async () => {
  const a = zug('A', 'RE', [['X', '06:00', undefined, true], ['Ziel', '07:00', undefined, true]]);
  const flix = zug('F', 'FLX 20', [['X', '06:10'], ['Ziel', '07:00']]);
  const b = zug('B', 'RE', [['X', '07:00'], ['Ziel', '08:00']]);
  const bahn = new FalscheBahn(a, flix, b);
  bahn.plaene = () => [
    [{ ...abschnitt(flix, 'X', 'Ziel'), agencyName: 'FlixTrain-eu' }],
    [abschnitt(b, 'X', 'Ziel')],
  ];
  const { reise } = neueReise([abschnitt(a, 'X', 'Ziel')]);
  await fahre(reise, bahn);
  assert.equal(reise.verspaetungMin, 60);
});
