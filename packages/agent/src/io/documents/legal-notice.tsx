import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { DocumentProps } from "@react-pdf/renderer";
import type { Supplier } from "@dues-banshee/db";
import { RULE_SOURCES } from "@dues-banshee/engine";
import type { Caveat, RuleId } from "@dues-banshee/engine";
import type { ReactElement, ReactNode } from "react";
import type { FactSheet } from "../../core/fact-sheet";
import { DISCLAIMER } from "../../core/final-text";

export const DRAFT_HEADER = "DRAFT \u2013 for the owner's review";
export const CAVEAT_TEXT = "The supplier registered on Udyam after this supply; the claim may be contested.";

export interface DocumentData {
  supplier: Pick<Supplier, "name" | "udyamNumber">;
  facts: FactSheet;
  ruleIds: readonly RuleId[];
  finalText: string;
  caveat: Caveat | undefined;
}

/**
 * Built-in Helvetica (WinAnsi) has no rupee glyph and would print U+20B9 as a wrong character.
 * Only the currency sign is swapped for "Rs. "; every digit stays as the Fact_Sheet formatted it.
 */
export function pdfSafe(text: string): string {
  return text.replaceAll("\u20B9", "Rs. ");
}

const styles = StyleSheet.create({
  page: { paddingTop: 60, paddingBottom: 60, paddingHorizontal: 48, fontFamily: "Helvetica", fontSize: 10.5, lineHeight: 1.4 },
  header: { position: "absolute", top: 24, left: 48, right: 48, fontSize: 9, fontFamily: "Helvetica-Bold", color: "#8a1c1c" },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", marginBottom: 12 },
  heading: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 4 },
  row: { flexDirection: "row", marginBottom: 2 },
  label: { width: 110, fontFamily: "Helvetica-Bold" },
  value: { flex: 1 },
  rule: { marginBottom: 3 },
  body: { marginTop: 2 },
  footer: { marginTop: 18, fontSize: 9, color: "#444444" },
});

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{typeof children === "string" ? pdfSafe(children) : children}</Text>
    </View>
  );
}

/** One line per rule ID, in the order given (the Basis_Line order). */
export function RuleList({ ruleIds }: { ruleIds: readonly RuleId[] }): ReactElement {
  return (
    <View>
      {ruleIds.map((id) => (
        <Text key={id} style={styles.rule}>
          {`${id} (${RULE_SOURCES[id]})`}
        </Text>
      ))}
    </View>
  );
}

/** The page content shared by both documents. `extra` renders between the facts and the Final_Text. */
export function NoticePages({
  title,
  data,
  extra,
}: {
  title: string;
  data: DocumentData;
  extra?: ReactNode;
}): ReactElement<DocumentProps> {
  const { supplier, facts, ruleIds, finalText, caveat } = data;
  const interest =
    facts.interest === null || facts.rate_as_of === null
      ? "Not available (no bank rate on record)"
      : `${facts.interest} (rate as of ${facts.rate_as_of})`;

  return (
    <Document title={title}>
      <Page size="A4" style={styles.page}>
        <Text fixed style={styles.header}>
          {DRAFT_HEADER}
        </Text>
        <Text style={styles.title}>{title}</Text>

        <Field label="Supplier">{supplier.name}</Field>
        <Field label="Udyam number">{supplier.udyamNumber}</Field>
        <Field label="Buyer">{facts.buyer_name}</Field>
        <Field label="Invoice number">{facts.invoice_number}</Field>
        <Field label="Principal">{facts.principal}</Field>
        <Field label="Due date">{facts.due_date}</Field>
        <Field label="Interest">{interest}</Field>

        {caveat === "registered_after_supply" ? <Text style={styles.heading}>{CAVEAT_TEXT}</Text> : null}

        <Text style={styles.heading}>Legal basis</Text>
        <RuleList ruleIds={ruleIds} />

        {extra}

        <Text style={styles.heading}>Message</Text>
        <Text style={styles.body}>{pdfSafe(finalText)}</Text>

        <Text style={styles.footer}>{DISCLAIMER}</Text>
      </Page>
    </Document>
  );
}

export function LegalNotice({ data }: { data: DocumentData }): ReactElement<DocumentProps> {
  return <NoticePages title="Legal notice" data={data} />;
}
