# Bahn-Statistik

Wie oft scheitert eine Bahnverbindung, und wie viel später kommt man dann an?

Ein virtueller Reisender fährt **jede Verbindung des Tages** auf drei Strecken nach:

- Heide (Holst) → Berlin Hbf
- Hamburg-Altona → Köln Hbf
- Mittenwald → Bremen Hbf

Gezählt wird, wann er tatsächlich am Ziel ankommt, verglichen mit dem Fahrplan. Besonders interessant sind Reisen mit **60 min oder mehr Verspätung**. Ab da gibt es nach den Fahrgastrechten 25 % des Fahrpreises zurück, ab 120 min 50 %.

## So arbeitet der Reisende

1. **Soll:** Jeden Abend um 22 Uhr holt er für den Folgetag alle Verbindungen aus dem reinen Fahrplan, ohne Echtzeit. Damit zählen auch Züge mit, die schon vorher als ausgefallen gemeldet waren.
   - Aussortiert werden Verbindungen, die eine andere klar schlägt, also früher los und nicht früher da.
   - Ebenso solche, die mehr als doppelt so lange brauchen wie die schnellste des Tages.
   - FlixTrain zählt nicht mit.
2. **Abfahrt:** Zur Abfahrtszeit schaut er nach, ob der Zug fährt. Fällt er aus, plant er neu.
3. **Umstieg:** Bei der Ankunft vergleicht er die tatsächliche Ankunft mit der tatsächlichen Abfahrt des Anschlusses.
   - Der Anschluss klappt, wenn mindestens der geplante Übergang bleibt, höchstens aber 5 min verlangt werden.
   - Sonst sucht er ab dem Bahnhof, an dem er steht, die Verbindung mit der frühesten Ankunft, wie man es mit dem DB Navigator auch tun würde.
4. **Teilausfall:** Endet ein Zug vorzeitig, steigt er am letzten bedienten Halt aus und plant dort neu.
5. **Ziel:** Die Verspätung ist die tatsächliche Ankunft minus die Soll-Ankunft. Wer 24 h nach der Soll-Ankunft nicht da ist oder keine Weiterfahrt findet, gilt als gestrandet.

Annahmen: Der Reisende hat ein Flexpreis-Ticket, also keine Zugbindung, und steigt in einen verspäteten Zug ein, statt nach Alternativen zu suchen. Für einen Umstieg braucht er höchstens 5 min.

## Datenquelle

Fahrplan und Echtzeit kommen von [Transitous](https://transitous.org), einem offenen, gemeinschaftlich betriebenen Routenplaner (MOTIS). Für Deutschland nutzt er die DELFI-Daten mit Echtzeit.

Die inoffiziellen Schnittstellen von bahn.de und DB Navigator (db-vendo-client) sperrt die Bahn seit 2026 per TLS-Fingerprinting. Deshalb nutzt dieses Projekt sie nicht.

Nutzungsbedingungen von Transitous:
- nur nicht kommerziell
- quelloffen
- User-Agent mit Kontakt
- sparsame Nutzung: Hier sind es etwa 25 Planungsabfragen am Tag sowie einige Hundert Fahrt- und Umplanungsabfragen, mit mindestens 1,5 s Abstand
- Quellennachweis: Die Seite verlinkt [die Datenquellen](https://transitous.org/sources/)

## Auswertung

Die Webseite läuft auf Port 3050:
- Je Strecke der Anteil der Reisen mit 60 min oder mehr Verspätung, die Verteilung, die mittlere und die schlimmste Verspätung
- Die Liste aller Reisen mit 60 min oder mehr, mit dem Ablauf jeder Reise
- Nach Abfahrtsstunde: wann es am häufigsten schiefgeht
- An welchen Bahnhöfen Anschlüsse reißen oder Züge ausfallen

## Auf dem Raspberry Pi

Voraussetzung: 64-Bit-Raspberry-Pi-OS (das Node-24-Image gibt es nur für arm64) und Docker mit Compose.

```bash
git clone https://github.com/rathjenick/bahn-statistik.git
cd bahn-statistik
mkdir -p daten
docker compose up -d --build
```

Danach ist die Auswertung unter `http://<pi>:3050` erreichbar. Die Datenbank liegt in `daten/bahn.sqlite`. Für eine Sicherung reicht es, diese Datei zu kopieren, am besten mit `sqlite3 daten/bahn.sqlite ".backup sicherung.sqlite"`.

Aktualisieren:

```bash
git pull && docker compose up -d --build
```

## Lokal entwickeln

Node 24 führt TypeScript direkt aus und bringt SQLite mit. Laufzeit-Abhängigkeiten gibt es keine.

```bash
npm install
npm test
npm run check
npm start
```

## Einstellungen

Alle Einstellungen sind Umgebungsvariablen, siehe `src/config.ts`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | 3050 | Port der Auswertung |
| `DATENBANK` | `daten/bahn.sqlite` | Pfad zur SQLite-Datei |
| `USER_AGENT` | `bahn-statistik/0.1 (+GitHub-Link)` | Kennung gegenüber Transitous |
| `MINDEST_UMSTIEG_MIN` | 5 | Höchstens so viel Übergangszeit wird für einen Anschluss verlangt |
| `UMPLAN_PUFFER_MIN` | 3 | Beim Umplanen sucht der Reisende ab Ankunft plus Puffer |
| `PLANUNGS_STUNDE` | 22 | Ab dieser Stunde wird der Folgetag geplant |
| `MAX_DAUER_FAKTOR` | 2 | Soll-Verbindungen höchstens so viel länger als die schnellste |
| `MAX_UMSTIEGE` | 5 | Mehr Umstiege zählen nicht als Soll-Verbindung |
| `OHNE_BETREIBER` | `flix` | Betreiber, die nicht mitzählen (regulärer Ausdruck) |

Die Strecken stehen in `src/config.ts`.

## Lizenz

MIT. Die Daten unterliegen den Bedingungen der jeweiligen [Quellen](https://transitous.org/sources/).
