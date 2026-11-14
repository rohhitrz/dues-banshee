import { renderToBuffer } from "@react-pdf/renderer";
import { LegalNotice } from "./legal-notice";
import type { DocumentData } from "./legal-notice";
import { OdrPack } from "./odr-pack";

export type DocumentKind = "legal_notice" | "odr_pack";
export type { DocumentData };

/**
 * Renders the step 4 or 5 PDF. Every money value and date comes from `facts` (Fact_Sheet);
 * nothing is recomputed here.
 */
export async function renderDocument(kind: DocumentKind, data: DocumentData): Promise<Uint8Array> {
  const element = kind === "legal_notice" ? LegalNotice({ data }) : OdrPack({ data });
  const buffer = await renderToBuffer(element);
  return new Uint8Array(buffer);
}
