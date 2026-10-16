// Legt für einen Tag alle Soll-Verbindungen einer Strecke an, und zwar aus
// dem reinen Fahrplan ohne Echtzeit. So zählen auch Züge mit, die schon
// vorher als ausgefallen gemeldet waren.

import type { HaltSuche, Strecke } from './config.ts';
import type { Speicher } from './db.ts';
import { erlaubt, vorbereiten } from './reisender.ts';
import type { Fahrplanauskunft, Ort } from './transitous.ts';
import { mitternacht } from './zeit.ts';

export interface PlanRegeln {
  maxDauerFaktor: number;
  maxUmstiege: number;
  verkehrsmittel: string;
  ohneBetreiber: string;
}

const halteCache = new Map<string, { ort: Ort; bis: number }>();

export async function loeseHalt(api: Fahrplanauskunft, s: HaltSuche): Promise<Ort> {
  const gemerkt = halteCache.get(s.suche);
  if (gemerkt && gemerkt.bis > Date.now()) return gemerkt.ort;
  const treffer = await api.suche(s.suche);
  const ort = treffer.find((t) => t.name === s.name) ?? treffer[0];
  if (!ort) throw new Error(`Halt „${s.suche}“ nicht gefunden`);
  halteCache.set(s.suche, { ort, bis: Date.now() + 12 * 3_600_000 });
  return ort;
}

export async function planeTag(
  api: Fahrplanauskunft,
  speicher: Speicher,
  strecke: Strecke,
  datum: string,
  regeln: PlanRegeln,
  ab?: Date,
): Promise<number> {
  const von = await loeseHalt(api, strecke.von);
  const nach = await loeseHalt(api, strecke.nach);
  const beginn = mitternacht(datum).getTime();
  const ende = beginn + 24 * 3_600_000;

  // In Vier-Stunden-Fenstern über den Tag, damit MOTIS alle Abfahrten liefert.
  const gefunden = new Map<string, ReturnType<typeof vorbereiten>>();
  const fensterSek = 4 * 3600;
  for (let t = beginn; t < ende; t += fensterSek * 1000) {
    const antwort = await api.plan({
      von: von.id,
      nach: nach.id,
      zeit: new Date(t),
      echtzeit: false,
      suchfensterSek: fensterSek,
      verkehrsmittel: regeln.verkehrsmittel,
    });
    for (const it of antwort.itineraries) {
      const fahrten = vorbereiten(it.legs);
      if (fahrten.length === 0 || fahrten.length - 1 > regeln.maxUmstiege) continue;
      if (!erlaubt(fahrten, regeln.ohneBetreiber)) continue;
      const abfahrt = Date.parse(fahrten[0].scheduledStartTime);
      if (abfahrt < beginn || abfahrt >= ende) continue;
      gefunden.set(signatur(fahrten), fahrten);
    }
  }

  let kandidaten = [...gefunden.values()].map((f) => ({
    fahrten: f,
    ab: Date.parse(f[0].scheduledStartTime),
    an: Date.parse(f.at(-1)!.scheduledEndTime),
  }));
  // Nur Verbindungen, die keine andere schlägt: später los und trotzdem
  // nicht später da heißt, die frühere braucht niemand.
  kandidaten = kandidaten.filter(
    (k) => !kandidaten.some((o) => o !== k && o.ab >= k.ab && o.an <= k.an && (o.ab > k.ab || o.an < k.an)),
  );
  const schnellste = Math.min(...kandidaten.map((k) => k.an - k.ab));
  kandidaten = kandidaten.filter((k) => k.an - k.ab <= schnellste * regeln.maxDauerFaktor);
  if (ab) kandidaten = kandidaten.filter((k) => k.ab >= ab.getTime());

  let neu = 0;
  for (const k of kandidaten.sort((a, b) => a.ab - b.ab)) {
    const sollAb = k.fahrten[0].scheduledStartTime;
    const angelegt = speicher.neueReise({
      strecke: strecke.id,
      datum,
      signatur: signatur(k.fahrten),
      sollAb,
      sollAn: k.fahrten.at(-1)!.scheduledEndTime,
      sollUmstiege: k.fahrten.length - 1,
      soll: k.fahrten,
      reisender: {
        ort: { stopId: k.fahrten[0].from.stopId, name: k.fahrten[0].from.name },
        ziel: { stopId: nach.id, name: nach.name },
        zeit: sollAb,
        plan: structuredClone(k.fahrten),
        anBord: false,
      },
    });
    if (angelegt) neu++;
  }
  speicher.merkePlanung(strecke.id, datum, kandidaten.length);
  return neu;
}

const signatur = (fahrten: { tripId?: string; scheduledStartTime: string }[]) =>
  `${fahrten[0].scheduledStartTime}|${fahrten.map((f) => f.tripId).join('>')}`;
