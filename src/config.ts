// Strecken und Stellschrauben. Halte werden beim Planen per Namenssuche
// aufgelöst, weil sich die Stop-IDs bei Transitous mit jedem Datenimport
// ändern können.

export interface Strecke {
  id: string;
  name: string;
  von: HaltSuche;
  nach: HaltSuche;
}

export interface HaltSuche {
  suche: string;
  // Name, wie Transitous ihn liefert; schützt vor Treffern wie „Bonn Hbf“.
  name: string;
}

export const strecken: Strecke[] = [
  {
    id: 'heide-berlin',
    name: 'Heide (Holst) → Berlin Hbf',
    von: { suche: 'Heide(Holst)', name: 'Heide(Holst)' },
    nach: { suche: 'Berlin Hauptbahnhof', name: 'Berlin Hauptbahnhof' },
  },
  {
    id: 'altona-koeln',
    name: 'Hamburg-Altona → Köln Hbf',
    von: { suche: 'Hamburg-Altona', name: 'Hamburg-Altona' },
    nach: { suche: 'Köln Hauptbahnhof', name: 'Köln Hbf' },
  },
  {
    id: 'mittenwald-bremen',
    name: 'Mittenwald → Bremen Hbf',
    von: { suche: 'Mittenwald', name: 'Mittenwald' },
    nach: { suche: 'Bremen Hauptbahnhof', name: 'Bremen Hauptbahnhof' },
  },
];

const zahl = (name: string, standard: number) => {
  const wert = process.env[name];
  return wert === undefined || wert === '' ? standard : Number(wert);
};

export const einstellungen = {
  port: zahl('PORT', 3050),
  datenbank: process.env.DATENBANK ?? 'daten/bahn.sqlite',
  transitous: process.env.TRANSITOUS_URL ?? 'https://api.transitous.org',
  // Transitous verlangt Anwendungsname, Version und Kontakt.
  userAgent: process.env.USER_AGENT ?? 'bahn-statistik/0.1 (+https://github.com/rathjenick/bahn-statistik)',
  // Mindestabstand zwischen zwei Anfragen an Transitous.
  anfrageAbstandMs: zahl('ANFRAGE_ABSTAND_MS', 1500),
  // Ein Anschluss gilt als erreicht, wenn zwischen tatsächlicher Ankunft und
  // tatsächlicher Abfahrt mindestens min(geplanter Übergang, dieser Wert) liegt.
  mindestUmstiegMin: zahl('MINDEST_UMSTIEG_MIN', 5),
  // Beim Umplanen sucht der Reisende ab Ankunft + Puffer.
  umplanPufferMin: zahl('UMPLAN_PUFFER_MIN', 3),
  // Erst so viele Minuten nach der erwarteten Ankunft gilt sie als endgültig.
  ankunftNachlaufMin: zahl('ANKUNFT_NACHLAUF_MIN', 2),
  // Soll-Verbindungen: höchstens so viel länger als die schnellste des Tages.
  maxDauerFaktor: zahl('MAX_DAUER_FAKTOR', 2),
  maxUmstiege: zahl('MAX_UMSTIEGE', 5),
  // Uhrzeit (Europe/Berlin), ab der der Folgetag geplant wird.
  planungsStunde: zahl('PLANUNGS_STUNDE', 22),
  // Wer so lange nach der Soll-Ankunft nicht da ist, gilt als gestrandet.
  aufgebenNachStunden: zahl('AUFGEBEN_NACH_STUNDEN', 24),
  // Verkehrsmittel für Planung und Umplanung: alles außer Fernbus und Flugzeug.
  verkehrsmittel: process.env.VERKEHRSMITTEL ?? 'RAIL,SUBURBAN,SUBWAY,TRAM,BUS,FERRY',
  // Betreiber, deren Verbindungen nicht zählen (regulärer Ausdruck). Es geht um die Bahn, nicht um Flix.
  ohneBetreiber: process.env.OHNE_BETREIBER ?? 'flix',
};

export const zeitzone = 'Europe/Berlin';
