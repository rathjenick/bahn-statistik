// Der virtuelle Reisende: Er fährt eine Soll-Verbindung nach, prüft an
// jedem Umstieg mit Echtzeitdaten, ob der Anschluss klappt, und plant
// sonst wie ein echter Fahrgast ab dem aktuellen Bahnhof neu.

import type { EreignisArt, Fahrt, Reise } from './db.ts';
import { istFahrt, type Abschnitt, type Fahrplanauskunft, type Halt, type Reiseplan } from './transitous.ts';
import { minutenZwischen, plusMinuten, uhrzeit } from './zeit.ts';

export interface Regeln {
  mindestUmstiegMin: number;
  umplanPufferMin: number;
  ankunftNachlaufMin: number;
  aufgebenNachStunden: number;
  verkehrsmittel: string;
  ohneBetreiber: string;
}

export interface NeuesEreignis {
  zeit: string;
  art: EreignisArt;
  ort: string | null;
  text: string;
}

// Merkt sich zu jedem Abschnitt den Übergang, den die Planung vorsah.
export function vorbereiten(abschnitte: Abschnitt[]): Fahrt[] {
  const fahrten = abschnitte.filter(istFahrt);
  return fahrten.map((f, i) => ({
    ...f,
    uebergangMin: i === 0 ? undefined : minutenZwischen(fahrten[i - 1].endTime, f.startTime),
  }));
}

// Verbindungen mit ausgeschlossenen Betreibern (z. B. FlixTrain) zählen nicht.
export const erlaubt = (fahrten: Fahrt[], ohneBetreiber: string) =>
  !ohneBetreiber || !fahrten.some((f) => new RegExp(ohneBetreiber, 'i').test(f.agencyName ?? ''));

const zugName = (f: Abschnitt) => f.displayName ?? f.tripId ?? f.mode;
const abfahrt = (h: Halt) => h.departure ?? h.scheduledDeparture;
const ankunft = (h: Halt) => h.arrival ?? h.scheduledArrival;

// Alle Halte einer Fahrt in Fahrtreihenfolge, mit Ausfall-Kennzeichen.
function halteDer(fahrt: Reiseplan): Halt[] {
  const halte: Halt[] = [];
  for (const leg of fahrt.legs) {
    for (const h of [leg.from, ...(leg.intermediateStops ?? []), leg.to]) {
      if (halte.at(-1)?.stopId === h.stopId) continue;
      halte.push(leg.cancelled ? { ...h, cancelled: true } : h);
    }
  }
  return halte;
}

export async function schritt(
  r: Reise,
  jetzt: Date,
  api: Fahrplanauskunft,
  regeln: Regeln,
): Promise<NeuesEreignis[]> {
  const ereignisse: NeuesEreignis[] = [];
  const merke = (zeit: string, art: EreignisArt, ort: string | null, text: string) =>
    ereignisse.push({ zeit, art, ort, text });
  const rs = r.reisender;
  r.fehler = null;

  if (jetzt.getTime() > Date.parse(r.sollAn) + regeln.aufgebenNachStunden * 3_600_000) {
    strande(`Nach ${regeln.aufgebenNachStunden} Stunden nicht angekommen.`);
    return ereignisse;
  }

  const aktuelle = rs.plan[0];
  if (!aktuelle) {
    await umplanen(rs.zeit, 'Kein Abschnitt mehr offen');
    return ereignisse;
  }

  if (!rs.anBord) {
    // Am Bahnsteig: fährt der Zug, und ist er schon da?
    const fahrt = await api.fahrt(aktuelle.tripId!);
    let ab = aktuelle.startTime;
    let faelltAus = false;
    if (fahrt) {
      const halt = halteDer(fahrt).find((h) => h.stopId === aktuelle.from.stopId);
      if (halt) {
        faelltAus = halt.cancelled === true;
        ab = abfahrt(halt) ?? ab;
      }
    }
    if (faelltAus) {
      r.ausfaelle++;
      r.ursache ??= `${zugName(aktuelle)} fiel in ${aktuelle.from.name} aus`;
      merke(ab, 'ausfall', aktuelle.from.name, `${zugName(aktuelle)} (${uhrzeit(aktuelle.scheduledStartTime)}) fällt aus.`);
      await umplanen(rs.zeit, 'Ausfall');
      return ereignisse;
    }
    if (Date.parse(ab) < Date.parse(rs.zeit)) {
      // Der Zug ist weg, bevor der Reisende da war.
      r.verpassteAnschluesse++;
      r.ursache ??= `${zugName(aktuelle)} in ${aktuelle.from.name} verpasst`;
      merke(rs.zeit, 'anschluss_verpasst', aktuelle.from.name, `${zugName(aktuelle)} ist um ${uhrzeit(ab)} schon weg.`);
      await umplanen(rs.zeit, 'Anschluss weg');
      return ereignisse;
    }
    if (Date.parse(ab) > jetzt.getTime() + 60_000) {
      aktuelle.startTime = ab;
      r.naechstePruefung = ab;
      return ereignisse;
    }
    rs.anBord = true;
    aktuelle.startTime = ab;
    r.istAb ??= ab;
    r.zustand = 'unterwegs';
    const verspaetet = Math.round(minutenZwischen(aktuelle.scheduledStartTime, ab));
    merke(ab, 'abfahrt', aktuelle.from.name, `Abfahrt mit ${zugName(aktuelle)}${verspaetet > 0 ? ` (+${verspaetet})` : ''}.`);
    const ziel = fahrt && halteDer(fahrt).find((h) => h.stopId === aktuelle.to.stopId);
    const an = (ziel && ankunft(ziel)) ?? aktuelle.endTime;
    aktuelle.endTime = an;
    r.naechstePruefung = plusMinuten(an, regeln.ankunftNachlaufMin);
    return ereignisse;
  }

  // Im Zug: ist er am Ausstieg angekommen?
  const fahrt = await api.fahrt(aktuelle.tripId!);
  let ausstieg: Halt = aktuelle.to;
  let an = aktuelle.endTime;
  let teilausfall = false;
  if (fahrt) {
    const halte = halteDer(fahrt);
    const iEin = halte.findIndex((h) => h.stopId === aktuelle.from.stopId);
    const iAus = halte.findIndex((h) => h.stopId === aktuelle.to.stopId);
    if (iAus >= 0) {
      ausstieg = halte[iAus];
      if (ausstieg.cancelled) {
        // Der Zug endet vorzeitig: am letzten noch bedienten Halt raus.
        teilausfall = true;
        const ersatz = halte.slice(Math.max(iEin, 0), iAus).findLast((h) => !h.cancelled);
        ausstieg = ersatz ?? aktuelle.from;
      }
      an = (ausstieg === aktuelle.from ? abfahrt(ausstieg) : ankunft(ausstieg)) ?? an;
    }
  }
  if (Date.parse(an) + regeln.ankunftNachlaufMin * 60_000 > jetzt.getTime()) {
    if (!teilausfall) aktuelle.endTime = an;
    r.naechstePruefung = plusMinuten(an, regeln.ankunftNachlaufMin);
    return ereignisse;
  }

  rs.anBord = false;
  rs.plan.shift();
  rs.ort = { stopId: ausstieg.stopId, name: ausstieg.name };
  rs.zeit = an;

  if (teilausfall) {
    r.ausfaelle++;
    r.ursache ??= `${zugName(aktuelle)} endete vorzeitig in ${ausstieg.name}`;
    merke(an, 'teilausfall', ausstieg.name, `${zugName(aktuelle)} fährt nicht bis ${aktuelle.to.name}, Ausstieg in ${ausstieg.name}.`);
    await umplanen(an, 'Teilausfall');
    return ereignisse;
  }

  const verspaetet = Math.round(minutenZwischen(aktuelle.scheduledEndTime, an));
  const plus = verspaetet > 0 ? ` (+${verspaetet})` : '';
  if (rs.plan.length === 0) {
    r.istAn = an;
    r.verspaetungMin = Math.round(minutenZwischen(r.sollAn, an));
    r.zustand = 'angekommen';
    r.naechstePruefung = null;
    merke(an, 'ankunft_ziel', ausstieg.name, `Am Ziel mit ${zugName(aktuelle)}${plus}, ${verspaetungsText(r.verspaetungMin)}.`);
    return ereignisse;
  }

  merke(an, 'ankunft_halt', ausstieg.name, `Ankunft mit ${zugName(aktuelle)}${plus}.`);

  // Anschluss prüfen.
  const anschluss = rs.plan[0];
  const fahrt2 = await api.fahrt(anschluss.tripId!);
  let ab = anschluss.startTime;
  let faelltAus = false;
  if (fahrt2) {
    const halt = halteDer(fahrt2).find((h) => h.stopId === anschluss.from.stopId);
    if (halt) {
      faelltAus = halt.cancelled === true;
      ab = abfahrt(halt) ?? ab;
    }
  }
  if (faelltAus) {
    r.ausfaelle++;
    r.ursache ??= `Anschluss ${zugName(anschluss)} fiel in ${anschluss.from.name} aus`;
    merke(an, 'ausfall', anschluss.from.name, `Anschluss ${zugName(anschluss)} (${uhrzeit(anschluss.scheduledStartTime)}) fällt aus.`);
    await umplanen(an, 'Anschluss fällt aus');
    return ereignisse;
  }
  const noetig = Math.max(0, Math.min(anschluss.uebergangMin ?? regeln.mindestUmstiegMin, regeln.mindestUmstiegMin));
  const puffer = minutenZwischen(an, ab);
  if (puffer >= noetig) {
    anschluss.startTime = ab;
    r.naechstePruefung = ab;
    merke(an, 'anschluss_ok', anschluss.from.name, `Anschluss ${zugName(anschluss)} um ${uhrzeit(ab)} erreicht (${Math.round(puffer)} min Übergang).`);
    return ereignisse;
  }
  r.verpassteAnschluesse++;
  r.ursache ??= `Anschluss ${zugName(anschluss)} in ${anschluss.from.name} verpasst`;
  merke(
    an,
    'anschluss_verpasst',
    anschluss.from.name,
    puffer < 0
      ? `Anschluss ${zugName(anschluss)} verpasst, er fuhr schon ${Math.round(-puffer)} min vorher (${uhrzeit(ab)}).`
      : `Anschluss ${zugName(anschluss)} um ${uhrzeit(ab)} verpasst (${Math.round(puffer)} min statt ${Math.round(noetig)} min Übergang).`,
  );
  await umplanen(an, 'Anschluss verpasst');
  return ereignisse;

  function strande(text: string) {
    r.zustand = 'gestrandet';
    r.naechstePruefung = null;
    r.ursache ??= text;
    merke(jetzt.toISOString(), 'gestrandet', rs.ort.name, text);
  }

  // Sucht ab dem aktuellen Ort die Verbindung mit der frühesten Ankunft.
  async function umplanen(ab: string, anlass: string) {
    const start = plusMinuten(ab, regeln.umplanPufferMin);
    const antwort = await api.plan({
      von: rs.ort.stopId,
      nach: rs.ziel.stopId,
      zeit: new Date(start),
      echtzeit: true,
      verkehrsmittel: regeln.verkehrsmittel,
    });
    const kandidaten = antwort.itineraries
      .map((it) => vorbereiten(it.legs))
      .filter((f) => f.length > 0 && erlaubt(f, regeln.ohneBetreiber) && Date.parse(f[0].startTime) >= Date.parse(start) - 60_000)
      .sort((a, b) => Date.parse(a.at(-1)!.endTime) - Date.parse(b.at(-1)!.endTime));
    const beste = kandidaten[0];
    if (!beste) {
      strande(`${anlass}: keine Weiterfahrt ab ${rs.ort.name} gefunden.`);
      return;
    }
    rs.plan = beste;
    rs.anBord = false;
    rs.zeit = ab;
    r.umplanungen++;
    r.naechstePruefung = beste[0].startTime;
    const zuege = beste.map((f) => `${zugName(f)} ${uhrzeit(f.startTime)}`).join(', ');
    merke(ab, 'umgeplant', rs.ort.name, `${anlass}. Weiter mit ${zuege}, an ${uhrzeit(beste.at(-1)!.endTime)}.`);
  }
}

export function verspaetungsText(min: number): string {
  if (min <= 0) return 'pünktlich';
  if (min < 60) return `${min} min zu spät`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h ${m.toString().padStart(2, '0')} min zu spät`;
}
