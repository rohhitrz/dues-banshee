import { Text, View } from "@react-pdf/renderer";
import type { RuleId } from "@dues-banshee/engine";
import type { DocumentProps } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { FONT_FAMILY, NoticePages, RuleList } from "./legal-notice";
import type { DocumentData } from "./legal-notice";

export const ODR_LINE = "File on the MSME ODR portal (odr.msme.gov.in)";
export const ODR_RULE_IDS: readonly RuleId[] = ["MSMED-ODR", "MSMED-18"];

export function OdrPack({ data }: { data: DocumentData }): ReactElement<DocumentProps> {
  return (
    <NoticePages
      title="MSME ODR pack"
      data={data}
      extra={
        <View>
          <Text style={{ fontSize: 11, fontFamily: FONT_FAMILY, fontWeight: "bold", marginTop: 14, marginBottom: 4 }}>{ODR_LINE}</Text>
          <RuleList ruleIds={ODR_RULE_IDS} />
        </View>
      }
    />
  );
}
