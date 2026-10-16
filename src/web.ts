// Auswertungsseite: serverseitig gerendertes HTML ohne Abhängigkeiten.

import { createServer, type Server } from 'node:http';
import { strecken } from './config.ts';
import type { Ereignis, Kurzreise, Speicher } from './db.ts';
import { verspaetungsText } from './reisender.ts';
import { lokaleStunde, lokalesDatum, tagKurz, uhrzeit } from './zeit.ts';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Klasse = 'puenktlich' | 'leicht' | 'stunde' | 'zwei' | 'gestrandet';
const klassen: { id: Klasse; name: string }[] = [
  { id: 'puenktlich', name: 'unter 6 min' },
  { id: 'leicht', name: '6–59 min' },
  { id: 'stunde', name: '60–119 min' },
  { id: 'zwei', name: 'ab 120 min' },
  { id: 'gestrandet', name: 'gestrandet' },
];

function klasse(r: Kurzreise): Klasse | null {
  if (r.zustand === 'gestrandet') return 'gestrandet';
  if (r.zustand !== 'angekommen' || r.verspaetungMin === null) return null;
  if (r.verspaetungMin < 6) return 'puenktlich';
  if (r.verspaetungMin < 60) return 'leicht';
  if (r.verspaetungMin < 120) return 'stunde';
  return 'zwei';
}
const ueberStunde = (r: Kurzreise) => ['stunde', 'zwei', 'gestrandet'].includes(klasse(r) ?? '');
const prozent = (teil: number, ganz: number) => (ganz ? `${Math.round((teil / ganz) * 100)} %` : '–');
const streckenName = (id: string) => strecken.find((s) => s.id === id)?.name ?? id;

interface Filter {
  strecke?: string;
  zeitraum: string;
  seit?: string;
}

function leseFilter(url: URL): Filter {
  const strecke = strecken.some((s) => s.id === url.searchParams.get('strecke'))
    ? url.searchParams.get('strecke')!
    : undefined;
  const zeitraum = ['7', '30', 'alle'].includes(url.searchParams.get('zeitraum') ?? '')
    ? url.searchParams.get('zeitraum')!
    : '30';
  const seit = zeitraum === 'alle' ? undefined : lokalesDatum(new Date(Date.now() - (Number(zeitraum) - 1) * 86_400_000));
  return { strecke, zeitraum, seit };
}

function filterLink(f: Filter, aenderung: Partial<Filter>, pfad = '/') {
  const n = { ...f, ...aenderung };
  const p = new URLSearchParams();
  if (n.strecke) p.set('strecke', n.strecke);
  if (n.zeitraum !== '30') p.set('zeitraum', n.zeitraum);
  const q = p.toString();
  return `${pfad}${q ? `?${q}` : ''}`;
}

function filterLeiste(f: Filter, pfad: string) {
  const chip = (aktiv: boolean, href: string, text: string) =>
    `<a class="chip${aktiv ? ' aktiv' : ''}" href="${esc(href)}"${aktiv ? ' aria-current="true"' : ''}>${esc(text)}</a>`;
  return `<nav class="filter" aria-label="Filter">
    <div class="gruppe">${chip(!f.strecke, filterLink(f, { strecke: undefined }, pfad), 'Alle Strecken')}${strecken
      .map((s) => chip(f.strecke === s.id, filterLink(f, { strecke: s.id }, pfad), s.name))
      .join('')}</div>
    <div class="gruppe">${[
      ['7', '7 Tage'],
      ['30', '30 Tage'],
      ['alle', 'Alles'],
    ]
      .map(([z, t]) => chip(f.zeitraum === z, filterLink(f, { zeitraum: z }, pfad), t))
      .join('')}</div>
  </nav>`;
}

function verteilung(reisen: Kurzreise[]) {
  const zahl = Object.fromEntries(klassen.map((k) => [k.id, 0])) as Record<Klasse, number>;
  for (const r of reisen) {
    const k = klasse(r);
    if (k) zahl[k]++;
  }
  return zahl;
}

function verteilungsBalken(zahl: Record<Klasse, number>) {
  const summe = Object.values(zahl).reduce((a, b) => a + b, 0);
  if (!summe) return '<div class="balken leer">Noch keine beendeten Reisen</div>';
  return `<div class="balken" role="img" aria-label="${esc(
    klassen.map((k) => `${k.name}: ${zahl[k.id]}`).join(', '),
  )}">${klassen
    .filter((k) => zahl[k.id] > 0)
    .map(
      (k) =>
        `<span class="seg k-${k.id}" style="flex-grow:${zahl[k.id]}" data-tip="${esc(
          `${k.name}: ${zahl[k.id]} (${prozent(zahl[k.id], summe)})`,
        )}"></span>`,
    )
    .join('')}</div>`;
}

const legende = () =>
  `<ul class="legende">${klassen.map((k) => `<li><span class="punkt k-${k.id}"></span>${esc(k.name)}</li>`).join('')}</ul>`;

function streckenKarte(id: string, reisen: Kurzreise[], f: Filter) {
  const beendet = reisen.filter((r) => klasse(r));
  const ueber = beendet.filter(ueberStunde);
  const angekommen = beendet.filter((r) => r.zustand === 'angekommen');
  const zahl = verteilung(beendet);
  const mittel = angekommen.length
    ? Math.round(angekommen.reduce((s, r) => s + Math.max(0, r.verspaetungMin!), 0) / angekommen.length)
    : null;
  const schlimmste = angekommen.reduce<Kurzreise | null>(
    (m, r) => (!m || r.verspaetungMin! > m.verspaetungMin! ? r : m),
    null,
  );
  const laufend = reisen.filter((r) => r.zustand === 'unterwegs').length;
  return `<section class="karte">
    <h2><a href="${esc(filterLink(f, { strecke: id }))}">${esc(streckenName(id))}</a></h2>
    <div class="held"><span class="zahl">${prozent(ueber.length, beendet.length)}</span>
      <span class="unter">kommen 60 min oder mehr zu spät an<br>${ueber.length} von ${beendet.length} Reisen</span></div>
    ${verteilungsBalken(zahl)}
    <dl class="werte">
      <div><dt>Pünktlich (&lt; 6 min)</dt><dd>${prozent(zahl.puenktlich, beendet.length)}</dd></div>
      <div><dt>Mittlere Verspätung</dt><dd>${mittel === null ? '–' : `${mittel} min`}</dd></div>
      <div><dt>Schlimmste</dt><dd>${
        schlimmste ? `<a href="/reise/${schlimmste.id}">${esc(verspaetungsText(schlimmste.verspaetungMin!))}</a>` : '–'
      }</dd></div>
      <div><dt>Gerade unterwegs</dt><dd>${laufend}</dd></div>
    </dl>
  </section>`;
}

function reiseTabelle(reisen: Kurzreise[], mitStrecke: boolean) {
  if (!reisen.length) return '<p class="leer">Keine Reisen.</p>';
  return `<div class="tabelle"><table>
    <thead><tr><th>Tag</th>${mitStrecke ? '<th>Strecke</th>' : ''}<th>Soll</th><th>Ist an</th><th class="zahl">Verspätung</th><th>Was passiert ist</th></tr></thead>
    <tbody>${reisen
      .map((r) => {
        const k = klasse(r);
        const versp =
          r.zustand === 'gestrandet'
            ? 'gestrandet'
            : r.verspaetungMin === null
              ? r.zustand === 'unterwegs'
                ? 'unterwegs'
                : 'geplant'
              : r.verspaetungMin <= 0
                ? 'pünktlich'
                : `+${r.verspaetungMin} min`;
        return `<tr class="zeile" data-href="/reise/${r.id}" tabindex="0">
          <td>${esc(tagKurz(r.sollAb))}</td>
          ${mitStrecke ? `<td>${esc(streckenName(r.strecke))}</td>` : ''}
          <td class="zeit">${uhrzeit(r.sollAb)} → ${uhrzeit(r.sollAn)}</td>
          <td class="zeit">${uhrzeit(r.istAn)}</td>
          <td class="zahl">${k ? `<span class="punkt k-${k}"></span>` : ''}<a href="/reise/${r.id}">${esc(versp)}</a></td>
          <td>${esc(r.ursache ?? (r.umplanungen ? `${r.umplanungen}× umgeplant` : ''))}</td>
        </tr>`;
      })
      .join('')}</tbody></table></div>`;
}

function stundenDiagramm(reisen: Kurzreise[]) {
  const stunden = Array.from({ length: 24 }, () => ({ gesamt: 0, ueber: 0 }));
  for (const r of reisen) {
    if (!klasse(r)) continue;
    const s = stunden[lokaleStunde(new Date(r.sollAb))];
    s.gesamt++;
    if (ueberStunde(r)) s.ueber++;
  }
  if (!stunden.some((s) => s.gesamt)) return '<p class="leer">Noch keine beendeten Reisen.</p>';
  const b = 720;
  const h = 160;
  const breite = b / 24;
  const balken = stunden
    .map((s, i) => {
      const anteil = s.gesamt ? s.ueber / s.gesamt : 0;
      const hoehe = Math.max(s.gesamt ? 1 : 0, anteil * (h - 20));
      const tip = s.gesamt
        ? `${i}–${i + 1} Uhr: ${s.ueber} von ${s.gesamt} über 60 min (${prozent(s.ueber, s.gesamt)})`
        : `${i}–${i + 1} Uhr: keine Abfahrten`;
      return `<g data-tip="${esc(tip)}">
        <rect class="treffer" x="${i * breite}" y="0" width="${breite}" height="${h}"></rect>
        ${s.gesamt ? `<path class="saeule" d="${saeule(i * breite + 3, h, breite - 6, hoehe)}"></path>` : ''}
      </g>`;
    })
    .join('');
  const achse = [0, 6, 12, 18, 23]
    .map((i) => `<text x="${i * breite + breite / 2}" y="${h + 16}" text-anchor="middle">${i} Uhr</text>`)
    .join('');
  return `<figure class="diagramm">
    <svg viewBox="0 0 ${b} ${h + 22}" role="img" aria-label="Anteil der Reisen mit 60 min oder mehr Verspätung je Abfahrtsstunde">
      <line class="gitter" x1="0" x2="${b}" y1="20" y2="20"></line>
      <text class="gitter-text" x="0" y="14">100 %</text>
      <line class="grundlinie" x1="0" x2="${b}" y1="${h}" y2="${h}"></line>
      ${balken}${achse}
    </svg>
  </figure>`;
}

// Säule mit 4px gerundetem oberem Ende, unten bündig auf der Grundlinie.
function saeule(x: number, unten: number, w: number, hoehe: number) {
  const r = Math.min(4, hoehe, w / 2);
  const oben = unten - hoehe;
  return `M${x},${unten}V${oben + r}Q${x},${oben} ${x + r},${oben}H${x + w - r}Q${x + w},${oben} ${x + w},${oben + r}V${unten}Z`;
}

function bruchstellenTabelle(zeilen: { ort: string; art: string; anzahl: number }[]) {
  if (!zeilen.length) return '<p class="leer">Bisher ist nichts gerissen.</p>';
  const name: Record<string, string> = {
    anschluss_verpasst: 'Anschluss verpasst',
    ausfall: 'Zug fiel aus',
    teilausfall: 'Zug endete vorzeitig',
  };
  return `<div class="tabelle"><table><thead><tr><th>Bahnhof</th><th>Was</th><th class="zahl">Reisen</th></tr></thead><tbody>${zeilen
    .slice(0, 12)
    .map((z) => `<tr><td>${esc(z.ort)}</td><td>${esc(name[z.art] ?? z.art)}</td><td class="zahl">${z.anzahl}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

function uebersicht(speicher: Speicher, f: Filter) {
  const reisen = speicher.kurz({ strecke: f.strecke, seit: f.seit });
  const ids = f.strecke ? [f.strecke] : strecken.map((s) => s.id);
  const ueber = reisen.filter(ueberStunde);
  const heute = lokalesDatum(new Date());
  const heuteGeplant = reisen.filter((r) => r.datum === heute).length;
  return seite(
    'Bahn-Statistik',
    `<header class="kopf"><h1>Wie oft kommt man zu spät?</h1>
      <p>Ein virtueller Reisender fährt jede Verbindung des Tages nach. Reißt ein Anschluss oder fällt ein Zug aus, plant er ab dem Bahnhof neu, an dem er gerade steht. Gezählt wird die Ankunft am Ziel gegenüber dem Fahrplan. Ab 60 min gibt es 25 % des Fahrpreises zurück, ab 120 min 50 %.</p></header>
    ${filterLeiste(f, '/')}
    <div class="karten">${ids.map((id) => streckenKarte(id, reisen.filter((r) => r.strecke === id), f)).join('')}</div>
    ${legende()}
    <section><h2>60 min oder mehr zu spät <span class="anzahl">${ueber.length}</span></h2>
      ${reiseTabelle(ueber.slice(0, 50), !f.strecke)}
      <p class="mehr"><a href="${esc(filterLink(f, {}, '/reisen'))}">Alle Reisen ansehen</a> · heute ${heuteGeplant} Verbindungen geplant</p></section>
    <div class="zwei-spalten">
      <section><h2>Wann es am häufigsten schiefgeht</h2><p class="hinweis">Anteil der Reisen mit 60 min oder mehr Verspätung, nach geplanter Abfahrtsstunde</p>${stundenDiagramm(reisen)}</section>
      <section><h2>Wo es reißt</h2>${bruchstellenTabelle(speicher.bruchstellen({ strecke: f.strecke, seit: f.seit }))}</section>
    </div>`,
  );
}

function alleReisen(speicher: Speicher, f: Filter) {
  const reisen = speicher.kurz({ strecke: f.strecke, seit: f.seit });
  return seite(
    'Alle Reisen',
    `<p class="zurueck"><a href="${esc(filterLink(f, {}, '/'))}">← Übersicht</a></p>
    <header class="kopf"><h1>Alle Reisen <span class="anzahl">${reisen.length}</span></h1></header>
    ${filterLeiste(f, '/reisen')}
    ${reiseTabelle(reisen, !f.strecke)}`,
  );
}

const ereignisSymbol: Record<string, string> = {
  abfahrt: '→',
  ankunft_halt: '•',
  anschluss_ok: '✓',
  anschluss_verpasst: '✕',
  ausfall: '✕',
  teilausfall: '✕',
  umgeplant: '↻',
  ankunft_ziel: '◆',
  gestrandet: '✕',
  hinweis: 'i',
};

function reiseSeite(speicher: Speicher, id: number) {
  const r = speicher.reise(id);
  if (!r) return null;
  const ereignisse: Ereignis[] = speicher.ereignisse(id);
  const status =
    r.zustand === 'angekommen'
      ? verspaetungsText(r.verspaetungMin!)
      : r.zustand === 'gestrandet'
        ? 'gestrandet'
        : r.zustand === 'unterwegs'
          ? `unterwegs, gerade in ${r.reisender.anBord ? `${r.reisender.plan[0]?.displayName ?? 'Zug'}` : r.reisender.ort.name}`
          : 'noch nicht losgefahren';
  const k = klasse(r);
  const fahrten = (liste: typeof r.soll) =>
    `<div class="tabelle"><table><thead><tr><th>Zug</th><th>Ab</th><th></th><th>An</th><th></th></tr></thead><tbody>${liste
      .map(
        (f) =>
          `<tr><td><strong>${esc(f.displayName ?? f.mode)}</strong>${f.headsign ? ` <span class="leise">Richtung ${esc(f.headsign)}</span>` : ''}</td>
           <td>${esc(f.from.name)}</td><td class="zeit">${uhrzeit(f.scheduledStartTime)}</td>
           <td>${esc(f.to.name)}</td><td class="zeit">${uhrzeit(f.scheduledEndTime)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  return seite(
    `Reise ${tagKurz(r.sollAb)} ${uhrzeit(r.sollAb)}`,
    `<p class="zurueck"><a href="/?strecke=${esc(r.strecke)}">← ${esc(streckenName(r.strecke))}</a></p>
    <header class="kopf"><h1>${esc(tagKurz(r.sollAb))}, ${uhrzeit(r.sollAb)} → ${uhrzeit(r.sollAn)}</h1>
      <p class="status">${k ? `<span class="punkt k-${k}"></span>` : ''}${esc(status)}${
        r.istAn ? ` · tatsächlich an ${uhrzeit(r.istAn)}` : ''
      }</p></header>
    <dl class="werte reihe">
      <div><dt>Umstiege laut Plan</dt><dd>${r.sollUmstiege}</dd></div>
      <div><dt>Umgeplant</dt><dd>${r.umplanungen}×</dd></div>
      <div><dt>Ausfälle</dt><dd>${r.ausfaelle}</dd></div>
      <div><dt>Verpasste Anschlüsse</dt><dd>${r.verpassteAnschluesse}</dd></div>
    </dl>
    ${r.fehler ? `<p class="fehler">Letzter Abruf fehlgeschlagen: ${esc(r.fehler)}</p>` : ''}
    <div class="zwei-spalten">
      <section><h2>Was passiert ist</h2>${
        ereignisse.length
          ? `<ol class="verlauf">${ereignisse
              .map(
                (e) =>
                  `<li class="e-${esc(e.art)}"><span class="symbol" aria-hidden="true">${ereignisSymbol[e.art] ?? '•'}</span><span class="zeit">${uhrzeit(e.zeit)}</span><span><strong>${esc(e.ort ?? '')}</strong> ${esc(e.text)}</span></li>`,
              )
              .join('')}</ol>`
          : '<p class="leer">Noch nichts. Die Reise beginnt um ' + uhrzeit(r.sollAb) + '.</p>'
      }</section>
      <section><h2>Geplante Verbindung</h2>${fahrten(r.soll)}
      ${
        r.umplanungen && r.zustand !== 'angekommen' && r.zustand !== 'gestrandet'
          ? `<h2>Aktueller Plan</h2>${fahrten(r.reisender.plan)}`
          : ''
      }</section>
    </div>`,
  );
}

function seite(titel: string, inhalt: string) {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titel)}</title><style>${stil}</style></head>
<body><main>${inhalt}</main>
<footer>Fahrplan- und Echtzeitdaten: <a href="https://transitous.org/sources/">Transitous und seine Datenquellen</a>, Kartendaten © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende · <a href="https://github.com/rathjenick/bahn-statistik">Quellcode</a></footer>
<div id="tip" role="tooltip" hidden></div>
<script>${skript}</script></body></html>`;
}

const stil = `
:root{color-scheme:light;--flaeche:#fcfcfb;--karte:#ffffff;--rand:#e4e3df;--text:#0b0b0b;--text2:#52514e;--leise:#76756f;--akzent:#2a78d6;--saeule:#2a78d6;
--k-puenktlich:#0ca30c;--k-leicht:#fab219;--k-stunde:#ec835a;--k-zwei:#d03b3b;--k-gestrandet:#52514e;--fehler:#b42323}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--flaeche:#1a1a19;--karte:#232322;--rand:#383835;--text:#ffffff;--text2:#c3c2b7;--leise:#9a998f;--akzent:#6da7ec;--saeule:#3987e5;--k-gestrandet:#c3c2b7;--fehler:#e66767}}
:root[data-theme="dark"]{color-scheme:dark;--flaeche:#1a1a19;--karte:#232322;--rand:#383835;--text:#ffffff;--text2:#c3c2b7;--leise:#9a998f;--akzent:#6da7ec;--saeule:#3987e5;--k-gestrandet:#c3c2b7;--fehler:#e66767}
*{box-sizing:border-box}
body{margin:0;background:var(--flaeche);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 32px}
a{color:var(--akzent)}
h1{font-size:26px;line-height:1.2;margin:0 0 8px}
h2{font-size:17px;margin:28px 0 12px}
.kopf p{color:var(--text2);max-width:760px;margin:0}
.anzahl{color:var(--leise);font-weight:400}
.filter{display:flex;flex-wrap:wrap;gap:8px 24px;margin:20px 0 4px}
.gruppe{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--rand);border-radius:999px;padding:4px 12px;color:var(--text2);text-decoration:none;background:var(--karte)}
.chip:hover{border-color:var(--text2)}
.chip.aktiv{background:var(--text);color:var(--flaeche);border-color:var(--text)}
.karten{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:16px}
.karte{background:var(--karte);border:1px solid var(--rand);border-radius:12px;padding:16px 18px}
.karte h2{margin:0 0 10px;font-size:16px}.karte h2 a{color:var(--text);text-decoration:none}
.held{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.held .zahl{font-size:40px;font-weight:650;line-height:1;font-variant-numeric:tabular-nums}
.held .unter{color:var(--text2);font-size:13px;line-height:1.35}
.balken{display:flex;gap:2px;height:14px;border-radius:4px;overflow:hidden}
.balken.leer{display:block;height:auto;color:var(--leise);font-size:13px}
.seg{min-width:3px}
.k-puenktlich{background:var(--k-puenktlich)}.k-leicht{background:var(--k-leicht)}.k-stunde{background:var(--k-stunde)}.k-zwei{background:var(--k-zwei)}.k-gestrandet{background:var(--k-gestrandet)}
.legende{display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;padding:0;margin:12px 0 0;color:var(--text2);font-size:13px}
.punkt{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:baseline}
.werte{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;margin:14px 0 0}
.werte.reihe{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:16px 0}
.werte dt{color:var(--leise);font-size:12px}.werte dd{margin:0;font-variant-numeric:tabular-nums}
.tabelle{overflow-x:auto;border:1px solid var(--rand);border-radius:10px;background:var(--karte)}
table{border-collapse:collapse;width:100%;font-size:14px}
th{text-align:left;font-weight:500;color:var(--leise);font-size:12px;padding:8px 12px;border-bottom:1px solid var(--rand)}
td{padding:8px 12px;border-bottom:1px solid var(--rand);vertical-align:top}
tr:last-child td{border-bottom:0}
.zahl{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.zeit{white-space:nowrap;font-variant-numeric:tabular-nums}
tr.zeile{cursor:pointer}tr.zeile:hover,tr.zeile:focus-visible{background:color-mix(in srgb,var(--akzent) 8%,transparent);outline:none}
tr.zeile a{color:inherit;text-decoration:none}
.leer,.hinweis,.mehr,.leise{color:var(--leise)}.hinweis{font-size:13px;margin:-6px 0 8px}
.zwei-spalten{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:0 32px}
.diagramm{margin:0}.diagramm svg{width:100%;height:auto;overflow:visible}
.diagramm text{fill:var(--leise);font-size:12px}
.gitter{stroke:var(--rand);stroke-dasharray:2 4}.grundlinie{stroke:var(--text2)}
.saeule{fill:var(--saeule)}.treffer{fill:transparent}
g[data-tip]:hover .saeule{opacity:.8}
.verlauf{list-style:none;padding:0;margin:0}
.verlauf li{display:grid;grid-template-columns:20px 48px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--rand)}
.verlauf .symbol{text-align:center;color:var(--leise)}
.e-anschluss_verpasst .symbol,.e-ausfall .symbol,.e-teilausfall .symbol,.e-gestrandet .symbol{color:var(--k-zwei);font-weight:700}
.e-anschluss_ok .symbol{color:var(--k-puenktlich)}
.status{font-size:17px;color:var(--text)!important}
.fehler{color:var(--fehler)}
.zurueck{margin:0 0 12px}
footer{max-width:1180px;margin:0 auto;padding:16px;color:var(--leise);font-size:12px;border-top:1px solid var(--rand)}
#tip{position:fixed;pointer-events:none;background:var(--text);color:var(--flaeche);font-size:13px;padding:6px 10px;border-radius:6px;max-width:280px;z-index:10}
@media (max-width:600px){.held .zahl{font-size:34px}.werte{grid-template-columns:1fr 1fr}}
`;

const skript = `
const tip=document.getElementById('tip');
document.addEventListener('pointermove',e=>{const z=e.target.closest&&e.target.closest('[data-tip]');
if(!z){tip.hidden=true;return}tip.textContent=z.dataset.tip;tip.hidden=false;
const x=Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8);tip.style.left=x+'px';tip.style.top=(e.clientY+16)+'px'});
for(const z of document.querySelectorAll('tr[data-href]')){
z.addEventListener('click',e=>{if(!e.target.closest('a'))location.href=z.dataset.href});
z.addEventListener('keydown',e=>{if(e.key==='Enter')location.href=z.dataset.href})}
`;

export function starteWebseite(speicher: Speicher, port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const antworte = (status: number, html: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    try {
      if (url.pathname === '/') return antworte(200, uebersicht(speicher, leseFilter(url)));
      if (url.pathname === '/reisen') return antworte(200, alleReisen(speicher, leseFilter(url)));
      const treffer = url.pathname.match(/^\/reise\/(\d+)$/);
      if (treffer) {
        const html = reiseSeite(speicher, Number(treffer[1]));
        if (html) return antworte(200, html);
      }
      if (url.pathname === '/gesund') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      antworte(404, seite('Nicht gefunden', '<h1>Nicht gefunden</h1><p><a href="/">Zur Übersicht</a></p>'));
    } catch (e) {
      console.error(e);
      antworte(500, seite('Fehler', `<h1>Fehler</h1><pre>${esc((e as Error).message)}</pre>`));
    }
  });
  server.listen(port);
  return server;
}
