// Dauerbetrieb: plant die Tage, schickt die Reisenden los und liefert die
// Auswertungsseite aus.

import { einstellungen, strecken } from './config.ts';
import { oeffne, Speicher } from './db.ts';
import { planeTag } from './planung.ts';
import { schritt } from './reisender.ts';
import { Transitous } from './transitous.ts';
import { starteWebseite } from './web.ts';
import { folgetag, lokaleStunde, lokalesDatum, plusMinuten } from './zeit.ts';

const speicher = new Speicher(oeffne(einstellungen.datenbank));
const api = new Transitous(einstellungen.transitous, einstellungen.userAgent, einstellungen.anfrageAbstandMs);

const log = (...teile: unknown[]) => console.log(new Date().toISOString(), ...teile);

async function planen(jetzt: Date) {
  const heute = lokalesDatum(jetzt);
  const tage = [heute];
  if (lokaleStunde(jetzt) >= einstellungen.planungsStunde) tage.push(folgetag(heute));
  for (const datum of tage) {
    for (const strecke of strecken) {
      if (speicher.istGeplant(strecke.id, datum)) continue;
      try {
        // Läuft der Dienst erst im Laufe des Tages an, zählen nur noch künftige Abfahrten.
        const neu = await planeTag(api, speicher, strecke, datum, einstellungen, datum === heute ? jetzt : undefined);
        log(`Geplant ${strecke.id} ${datum}: ${neu} Verbindungen`);
      } catch (e) {
        log(`Planung ${strecke.id} ${datum} fehlgeschlagen:`, (e as Error).message);
      }
    }
  }
}

async function reisen(jetzt: Date) {
  for (const reise of speicher.faellige(jetzt)) {
    try {
      // Mehrere Schritte am Stück, falls der Dienst etwas nachholen muss.
      for (let i = 0; i < 10; i++) {
        const ereignisse = await schritt(reise, new Date(), api, einstellungen);
        for (const e of ereignisse) speicher.ereignis(reise.id, e.zeit, e.art, e.ort, e.text);
        speicher.speichere(reise);
        for (const e of ereignisse) if (e.art !== 'abfahrt' && e.art !== 'anschluss_ok') log(`#${reise.id} ${e.art} ${e.ort ?? ''}: ${e.text}`);
        if (!reise.naechstePruefung || Date.parse(reise.naechstePruefung) > Date.now()) break;
      }
    } catch (e) {
      reise.fehler = (e as Error).message;
      reise.naechstePruefung = plusMinuten(new Date(), 3);
      speicher.speichere(reise);
      log(`#${reise.id} Fehler:`, reise.fehler);
    }
  }
}

let laeuft = false;
async function takt() {
  if (laeuft) return;
  laeuft = true;
  try {
    const jetzt = new Date();
    await planen(jetzt);
    await reisen(jetzt);
  } finally {
    laeuft = false;
  }
}

const server = starteWebseite(speicher, einstellungen.port);
log(`Bahn-Statistik läuft, Auswertung auf http://localhost:${einstellungen.port}`);
await takt();
const uhr = setInterval(() => void takt().catch((e) => log('Takt-Fehler:', e)), 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(uhr);
    server.close();
    speicher.db.close();
    process.exit(0);
  });
}
