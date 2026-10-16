// Schmaler Client für die Transitous-API (MOTIS v5). Anfragen laufen
// nacheinander mit Mindestabstand, damit wir den ehrenamtlichen Dienst
// nicht belasten.

export interface Halt {
  name: string;
  stopId: string;
  parentId?: string;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
}

export interface Abschnitt {
  mode: string;
  from: Halt;
  to: Halt;
  startTime: string;
  endTime: string;
  scheduledStartTime: string;
  scheduledEndTime: string;
  realTime: boolean;
  duration: number;
  tripId?: string;
  displayName?: string;
  headsign?: string;
  agencyName?: string;
  cancelled?: boolean;
  intermediateStops?: Halt[];
}

export interface Reiseplan {
  startTime: string;
  endTime: string;
  duration: number;
  transfers: number;
  legs: Abschnitt[];
}

export interface PlanAntwort {
  itineraries: Reiseplan[];
  nextPageCursor?: string;
}

export interface Ort {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface PlanAnfrage {
  von: string;
  nach: string;
  zeit: Date;
  echtzeit: boolean;
  suchfensterSek?: number;
  verkehrsmittel: string;
}

export interface Fahrplanauskunft {
  plan(anfrage: PlanAnfrage): Promise<PlanAntwort>;
  // null, wenn Transitous die Fahrt nicht (mehr) kennt.
  fahrt(tripId: string): Promise<Reiseplan | null>;
  suche(text: string): Promise<Ort[]>;
}

export class TransitousFehler extends Error {
  status: number;
  constructor(status: number, text: string) {
    super(`Transitous ${status}: ${text.slice(0, 200)}`);
    this.status = status;
  }
}

export class Transitous implements Fahrplanauskunft {
  #basis: string;
  #userAgent: string;
  #abstandMs: number;
  #warteschlange: Promise<unknown> = Promise.resolve();
  #letzte = 0;
  anfragen = 0;

  constructor(basis: string, userAgent: string, abstandMs: number) {
    this.#basis = basis.replace(/\/$/, '');
    this.#userAgent = userAgent;
    this.#abstandMs = abstandMs;
  }

  plan(a: PlanAnfrage): Promise<PlanAntwort> {
    const p: Record<string, string> = {
      fromPlace: a.von,
      toPlace: a.nach,
      time: a.zeit.toISOString(),
      transitModes: a.verkehrsmittel,
      realtimeMode: a.echtzeit ? 'REALTIME' : 'OFF',
    };
    if (a.suchfensterSek) p.searchWindow = String(a.suchfensterSek);
    return this.#hole('/api/v5/plan', p);
  }

  async fahrt(tripId: string): Promise<Reiseplan | null> {
    try {
      return await this.#hole<Reiseplan>('/api/v5/trip', { tripId });
    } catch (e) {
      if (e instanceof TransitousFehler && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  suche(text: string): Promise<Ort[]> {
    return this.#hole('/api/v1/geocode', { text, type: 'STOP' });
  }

  #hole<T>(pfad: string, parameter: Record<string, string>): Promise<T> {
    const lauf = this.#warteschlange.then(() => this.#holeJetzt<T>(pfad, parameter));
    this.#warteschlange = lauf.catch(() => undefined);
    return lauf;
  }

  async #holeJetzt<T>(pfad: string, parameter: Record<string, string>): Promise<T> {
    const url = `${this.#basis}${pfad}?${new URLSearchParams(parameter)}`;
    for (let versuch = 1; ; versuch++) {
      const warten = this.#letzte + this.#abstandMs - Date.now();
      if (warten > 0) await new Promise((r) => setTimeout(r, warten));
      this.#letzte = Date.now();
      this.anfragen++;
      try {
        const antwort = await fetch(url, {
          headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (antwort.ok) return (await antwort.json()) as T;
        const text = await antwort.text();
        // 4xx außer 429 lohnt keinen zweiten Versuch.
        if (antwort.status < 500 && antwort.status !== 429) throw new TransitousFehler(antwort.status, text);
        if (versuch >= 3) throw new TransitousFehler(antwort.status, text);
      } catch (e) {
        if (e instanceof TransitousFehler && e.status < 500 && e.status !== 429) throw e;
        if (versuch >= 3) throw e;
      }
      await new Promise((r) => setTimeout(r, 5_000 * versuch));
    }
  }
}

export const istFahrt = (a: Abschnitt) => a.mode !== 'WALK' && a.tripId !== undefined;
