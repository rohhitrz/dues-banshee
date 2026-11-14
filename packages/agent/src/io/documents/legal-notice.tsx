import { fileURLToPath } from "node:url";
import { Document, Font, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
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
 * Built-in Helvetica (WinAnsi) has no rupee glyph, so formatINR output would print a wrong character.
 * Noto Sans (Regular + Bold, static TTF, OFL) is registered by absolute path so it resolves from any cwd.
 */
export const FONT_FAMILY = "Noto Sans";
export const FONT_FILES = {
  regular: fileURLToPath(new URL("../../../assets/fonts/NotoSans-Regular.ttf", import.meta.url)),
  bold: fileURLToPath(new URL("../../../assets/fonts/NotoSans-Bold.ttf", import.meta.url)),
} as const;

Font.register({
  family: FONT_FAMILY,
  fonts: [
    { src: FONT_FILES.regular, fontWeight: "normal" },
    { src: FONT_FILES.bold, fontWeight: "bold" },
  ],
});

const styles = StyleSheet.create({
  page: { paddingTop: 60, paddingBottom: 60, paddingHorizontal: 48, fontFamily: FONT_FAMILY, fontSize: 10.5, lineHeight: 1.4 },
  header: { position: "absolute", top: 24, left: 48, right: 48, fontSize: 9, fontFamily: FONT_FAMILY, fontWeight: "bold", color: "#8a1c1c" },
  title: { fontSize: 16, fontFamily: FONT_FAMILY, fontWeight: "bold", marginBottom: 12 },
  heading: { fontSize: 11, fontFamily: FONT_FAMILY, fontWeight: "bold", marginTop: 14, marginBottom: 4 },
  row: { flexDirection: "row", marginBottom: 2 },
  label: { width: 110, fontFamily: FONT_FAMILY, fontWeight: "bold" },
  value: { flex: 1 },
  rule: { marginBottom: 3 },
  body: { marginTop: 2 },
  footer: { marginTop: 18, fontSize: 9, color: "#444444" },
});

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{children}</Text>
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
        {/* One <Text> per line: a "\n" inside a run has no Noto Sans glyph, so react-pdf would fall back to Helvetica for it. */}
        <View style={styles.body}>
          {finalText.split("\n").map((line, i) => (
            <Text key={i}>{line === "" ? " " : line}</Text>
          ))}
        </View>

        <Text style={styles.footer}>{DISCLAIMER}</Text>
      </Page>
    </Document>
  );
}

export function LegalNotice({ data }: { data: DocumentData }): ReactElement<DocumentProps> {
  return <NoticePages title="Legal notice" data={data} />;
}
