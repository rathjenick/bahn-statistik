import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Abschnitt } from './transitous.ts';

// Zustand des virtuellen Reisenden. `plan` enthält die noch offenen
// Fahrten; ist `anBord` gesetzt, sitzt er in plan[0].
export interface Reisender {
  ort: { stopId: string; name: string };
  ziel: { stopId: string; name: string };
  // Ab wann er am Ort ist (Ankunft bzw. Soll-Abfahrt am Start).
  zeit: string;
  plan: Fahrt[];
  anBord: boolean;
}

// Ein Abschnitt mit dem Übergang, der beim Planen vorgesehen war.
export type Fahrt = Abschnitt & { uebergangMin?: number };

export type Zustand = 'wartet' | 'unterwegs' | 'angekommen' | 'gestrandet';

export interface Reise {
  id: number;
  strecke: string;
  datum: string;
  sollAb: string;
  sollAn: string;
  sollUmstiege: number;
  soll: Abschnitt[];
  zustand: Zustand;
  reisender: Reisender;
  naechstePruefung: string | null;
  istAb: string | null;
  istAn: string | null;
  verspaetungMin: number | null;
  umplanungen: number;
  ausfaelle: number;
  verpassteAnschluesse: number;
  ursache: string | null;
  fehler: string | null;
}

export type Kurzreise = Pick<
  Reise,
  | 'id'
  | 'strecke'
  | 'datum'
  | 'sollAb'
  | 'sollAn'
  | 'sollUmstiege'
  | 'zustand'
  | 'istAb'
  | 'istAn'
  | 'verspaetungMin'
  | 'umplanungen'
  | 'ausfaelle'
  | 'verpassteAnschluesse'
  | 'ursache'
  | 'naechstePruefung'
>;

export type EreignisArt =
  | 'abfahrt'
  | 'ankunft_halt'
  | 'anschluss_ok'
  | 'anschluss_verpasst'
  | 'ausfall'
  | 'teilausfall'
  | 'umgeplant'
  | 'ankunft_ziel'
  | 'gestrandet'
  | 'hinweis';

export interface Ereignis {
  id: number;
  reiseId: number;
  zeit: string;
  art: EreignisArt;
  ort: string | null;
  text: string;
}

export function oeffne(pfad: string): DatabaseSync {
  if (pfad !== ':memory:') mkdirSync(dirname(pfad), { recursive: true });
  const db = new DatabaseSync(pfad);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS reisen (
      id INTEGER PRIMARY KEY,
      strecke TEXT NOT NULL,
      datum TEXT NOT NULL,
      signatur TEXT NOT NULL,
      soll_ab TEXT NOT NULL,
      soll_an TEXT NOT NULL,
      soll_umstiege INTEGER NOT NULL,
      soll_json TEXT NOT NULL,
      zustand TEXT NOT NULL,
      reisender_json TEXT NOT NULL,
      naechste_pruefung TEXT,
      ist_ab TEXT,
      ist_an TEXT,
      verspaetung_min INTEGER,
      umplanungen INTEGER NOT NULL DEFAULT 0,
      ausfaelle INTEGER NOT NULL DEFAULT 0,
      verpasste_anschluesse INTEGER NOT NULL DEFAULT 0,
      ursache TEXT,
      fehler TEXT,
      aktualisiert TEXT NOT NULL,
      UNIQUE (strecke, signatur)
    );
    CREATE INDEX IF NOT EXISTS reisen_faellig ON reisen (zustand, naechste_pruefung);
    CREATE INDEX IF NOT EXISTS reisen_datum ON reisen (strecke, datum);
    CREATE TABLE IF NOT EXISTS ereignisse (
      id INTEGER PRIMARY KEY,
      reise_id INTEGER NOT NULL REFERENCES reisen (id) ON DELETE CASCADE,
      zeit TEXT NOT NULL,
      art TEXT NOT NULL,
      ort TEXT,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ereignisse_reise ON ereignisse (reise_id, id);
    CREATE TABLE IF NOT EXISTS planungen (
      strecke TEXT NOT NULL,
      datum TEXT NOT NULL,
      geplant_am TEXT NOT NULL,
      anzahl INTEGER NOT NULL,
      PRIMARY KEY (strecke, datum)
    );
  `);
  return db;
}

type Zeile = Record<string, string | number | null>;

const alsReise = (z: Zeile): Reise => ({
  id: z.id as number,
  strecke: z.strecke as string,
  datum: z.datum as string,
  sollAb: z.soll_ab as string,
  sollAn: z.soll_an as string,
  sollUmstiege: z.soll_umstiege as number,
  soll: JSON.parse(z.soll_json as string),
  zustand: z.zustand as Zustand,
  reisender: JSON.parse(z.reisender_json as string),
  naechstePruefung: z.naechste_pruefung as string | null,
  istAb: z.ist_ab as string | null,
  istAn: z.ist_an as string | null,
  verspaetungMin: z.verspaetung_min as number | null,
  umplanungen: z.umplanungen as number,
  ausfaelle: z.ausfaelle as number,
  verpassteAnschluesse: z.verpasste_anschluesse as number,
  ursache: z.ursache as string | null,
  fehler: z.fehler as string | null,
});

export class Speicher {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // Legt eine Soll-Reise an; gibt false zurück, wenn es sie schon gibt.
  neueReise(r: {
    strecke: string;
    datum: string;
    signatur: string;
    sollAb: string;
    sollAn: string;
    sollUmstiege: number;
    soll: Abschnitt[];
    reisender: Reisender;
  }): boolean {
    const ergebnis = this.db
      .prepare(
        `INSERT OR IGNORE INTO reisen (strecke, datum, signatur, soll_ab, soll_an, soll_umstiege, soll_json,
           zustand, reisender_json, naechste_pruefung, aktualisiert)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'wartet', ?, ?, ?)`,
      )
      .run(
        r.strecke,
        r.datum,
        r.signatur,
        r.sollAb,
        r.sollAn,
        r.sollUmstiege,
        JSON.stringify(r.soll),
        JSON.stringify(r.reisender),
        r.sollAb,
        new Date().toISOString(),
      );
    return ergebnis.changes > 0;
  }

  faellige(jetzt: Date, grenze = 50): Reise[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM reisen WHERE zustand IN ('wartet', 'unterwegs') AND naechste_pruefung <= ?
           ORDER BY naechste_pruefung LIMIT ?`,
        )
        .all(jetzt.toISOString(), grenze) as Zeile[]
    ).map(alsReise);
  }

  reise(id: number): Reise | undefined {
    const z = this.db.prepare('SELECT * FROM reisen WHERE id = ?').get(id) as Zeile | undefined;
    return z && alsReise(z);
  }

  speichere(r: Reise): void {
    this.db
      .prepare(
        `UPDATE reisen SET zustand = ?, reisender_json = ?, naechste_pruefung = ?, ist_ab = ?, ist_an = ?,
           verspaetung_min = ?, umplanungen = ?, ausfaelle = ?, verpasste_anschluesse = ?, ursache = ?,
           fehler = ?, aktualisiert = ?
         WHERE id = ?`,
      )
      .run(
        r.zustand,
        JSON.stringify(r.reisender),
        r.naechstePruefung,
        r.istAb,
        r.istAn,
        r.verspaetungMin,
        r.umplanungen,
        r.ausfaelle,
        r.verpassteAnschluesse,
        r.ursache,
        r.fehler,
        new Date().toISOString(),
        r.id,
      );
  }

  ereignis(reiseId: number, zeit: string, art: EreignisArt, ort: string | null, text: string): void {
    this.db
      .prepare('INSERT INTO ereignisse (reise_id, zeit, art, ort, text) VALUES (?, ?, ?, ?, ?)')
      .run(reiseId, zeit, art, ort, text);
  }

  ereignisse(reiseId: number): Ereignis[] {
    return (this.db.prepare('SELECT * FROM ereignisse WHERE reise_id = ? ORDER BY id').all(reiseId) as Zeile[]).map(
      (z) => ({
        id: z.id as number,
        reiseId: z.reise_id as number,
        zeit: z.zeit as string,
        art: z.art as EreignisArt,
        ort: z.ort as string | null,
        text: z.text as string,
      }),
    );
  }

  istGeplant(strecke: string, datum: string): boolean {
    return this.db.prepare('SELECT 1 FROM planungen WHERE strecke = ? AND datum = ?').get(strecke, datum) !== undefined;
  }

  merkePlanung(strecke: string, datum: string, anzahl: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO planungen (strecke, datum, geplant_am, anzahl) VALUES (?, ?, ?, ?)')
      .run(strecke, datum, new Date().toISOString(), anzahl);
  }

  alle(filter: { strecke?: string; seit?: string; nurBeendet?: boolean } = {}): Reise[] {
    const bedingungen: string[] = [];
    const werte: string[] = [];
    if (filter.strecke) {
      bedingungen.push('strecke = ?');
      werte.push(filter.strecke);
    }
    if (filter.seit) {
      bedingungen.push('datum >= ?');
      werte.push(filter.seit);
    }
    if (filter.nurBeendet) bedingungen.push(`zustand IN ('angekommen', 'gestrandet')`);
    const wo = bedingungen.length ? `WHERE ${bedingungen.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM reisen ${wo} ORDER BY soll_ab DESC`).all(...werte) as Zeile[]).map(
      alsReise,
    );
  }

  // Schlanke Zeilen ohne JSON für die Auswertung.
  kurz(filter: { strecke?: string; seit?: string } = {}): Kurzreise[] {
    const bedingungen: string[] = [];
    const werte: string[] = [];
    if (filter.strecke) {
      bedingungen.push('strecke = ?');
      werte.push(filter.strecke);
    }
    if (filter.seit) {
      bedingungen.push('datum >= ?');
      werte.push(filter.seit);
    }
    const wo = bedingungen.length ? `WHERE ${bedingungen.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, strecke, datum, soll_ab AS sollAb, soll_an AS sollAn, soll_umstiege AS sollUmstiege,
           zustand, ist_ab AS istAb, ist_an AS istAn, verspaetung_min AS verspaetungMin, umplanungen,
           ausfaelle, verpasste_anschluesse AS verpassteAnschluesse, ursache, naechste_pruefung AS naechstePruefung
         FROM reisen ${wo} ORDER BY soll_ab DESC`,
      )
      .all(...werte) as unknown as Kurzreise[];
  }

  // Wo ist es gerissen? Zählt Ausfälle und verpasste Anschlüsse je Halt.
  bruchstellen(filter: { strecke?: string; seit?: string }): { ort: string; art: string; anzahl: number }[] {
    const bedingungen = [`e.art IN ('anschluss_verpasst', 'ausfall', 'teilausfall')`];
    const werte: string[] = [];
    if (filter.strecke) {
      bedingungen.push('r.strecke = ?');
      werte.push(filter.strecke);
    }
    if (filter.seit) {
      bedingungen.push('r.datum >= ?');
      werte.push(filter.seit);
    }
    return this.db
      .prepare(
        `SELECT e.ort AS ort, e.art AS art, COUNT(DISTINCT e.reise_id) AS anzahl
         FROM ereignisse e JOIN reisen r ON r.id = e.reise_id
         WHERE ${bedingungen.join(' AND ')}
         GROUP BY e.ort, e.art ORDER BY anzahl DESC LIMIT 30`,
      )
      .all(...werte) as { ort: string; art: string; anzahl: number }[];
  }
}
