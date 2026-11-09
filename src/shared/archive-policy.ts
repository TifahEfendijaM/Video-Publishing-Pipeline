import type { PublicationStatus } from './status';

export interface PublicationOutcome { id:number; platform:string; surface:string; status:PublicationStatus }

/** Only the newest outcome for each destination counts, including a later retry. */
export function latestOutcomes<T extends PublicationOutcome>(rows:T[]):T[] {
  const latest=new Map<string,T>();
  for(const p of rows) {
    const key=`${p.platform}:${p.surface}`;
    if(!latest.has(key) || latest.get(key)!.id<p.id) latest.set(key,p);
  }
  return [...latest.values()];
}

export function fullyConfirmed(rows:PublicationOutcome[]):boolean {
  const latest=latestOutcomes(rows);
  return latest.some(p=>p.status==='confirmed') && latest.every(p=>p.status==='confirmed'||p.status==='unsupported');
}

/** A platform confirms only after every selected, supported surface confirms. */
export function platformPublicationCounts(rows:PublicationOutcome[]) {
  const platforms=new Map<string,PublicationOutcome[]>();
  for(const p of latestOutcomes(rows)) {
    if(p.status==='unsupported') continue;
    platforms.set(p.platform,[...(platforms.get(p.platform) ?? []),p]);
  }
  let confirmed=0,unconfirmed=0;
  for(const outcomes of platforms.values()) {
    if(outcomes.every(p=>p.status==='confirmed')) confirmed++; else unconfirmed++;
  }
  return {confirmed,unconfirmed};
}

export function majorityConfirmed(rows:PublicationOutcome[]):boolean {
  const {confirmed,unconfirmed}=platformPublicationCounts(rows);
  return confirmed>unconfirmed;
}
