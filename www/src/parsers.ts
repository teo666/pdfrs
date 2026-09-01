export interface PageRange {
  start: number;
  end: number;
}

export interface PageRotation {
  page: number;
  degrees: number;
}

export interface PageRef {
  source: number;
  page: number;
}

/** "1-2,3-4" -> [{start:1,end:2},{start:3,end:4}] */
export function parseRanges(text: string): PageRange[] {
  return splitEntries(text).map((entry) => {
    const [start, end] = entry.split("-").map((n) => parseInt(n.trim(), 10));
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error(`Range non valido: "${entry}" (atteso "inizio-fine", es. "1-2")`);
    }
    return { start, end };
  });
}

/** "1:90,2:180" -> [{page:1,degrees:90},{page:2,degrees:180}] */
export function parseRotations(text: string): PageRotation[] {
  return splitEntries(text).map((entry) => {
    const [page, degrees] = entry.split(":").map((n) => parseInt(n.trim(), 10));
    if (Number.isNaN(page) || Number.isNaN(degrees)) {
      throw new Error(`Rotazione non valida: "${entry}" (atteso "pagina:gradi", es. "1:90")`);
    }
    return { page, degrees };
  });
}

/** "0:1,1:1,0:2" -> [{source:0,page:1},{source:1,page:1},{source:0,page:2}] */
export function parseLayout(text: string): PageRef[] {
  return splitEntries(text).map((entry) => {
    const [source, page] = entry.split(":").map((n) => parseInt(n.trim(), 10));
    if (Number.isNaN(source) || Number.isNaN(page)) {
      throw new Error(`Voce di layout non valida: "${entry}" (atteso "sorgente:pagina", es. "0:1")`);
    }
    return { source, page };
  });
}

function splitEntries(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
