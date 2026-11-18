import type { Paise } from "@dues-banshee/engine";
import { z } from "zod";

const PAYMENT_LINKS_URL = "https://api.razorpay.com/v1/payment_links";

/** Cap for every Razorpay request (Req 3.5). */
export const RAZORPAY_TIMEOUT_MS = 10_000;

export interface PayLinkInfo {
  providerLinkId: string;
  /** The link's `short_url`. */
  url: string;
  amountPaise: Paise;
}

export type RazorpayResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      errorKind: "already_attempted" | "provider_error" | "timeout" | "network";
      httpStatus: number | null;
    };

export interface RazorpayClient {
  /** `GET /v1/payment_links?reference_id=<draftId>`: the first link whose `reference_id` is the Draft id, else `null`. */
  findByReference(draftId: string): Promise<RazorpayResult<PayLinkInfo | null>>;
  /** `POST /v1/payment_links`. */
  create(body: CreateLinkBody): Promise<RazorpayResult<PayLinkInfo>>;
}

export interface CreateLinkBody {
  /** The invoice principal in integer paise, from the Engine. */
  amount: Paise;
  currency: "INR";
  accept_partial: false;
  /** The Draft id. */
  reference_id: string;
  notes: { invoice_id: string };
  /** Razorpay sends nothing itself. */
  notify: { sms: false; email: false };
}

export interface RazorpayClientOptions {
  fetch: typeof globalThis.fetch;
  keyId: string;
  keySecret: string;
}

const linkEntity = z.object({
  id: z.string().min(1),
  short_url: z.string().min(1),
  amount: z.number().int().nonnegative(),
});

const linkList = z.object({ payment_links: z.array(z.unknown()) });
const referenceOnly = z.object({ reference_id: z.string().nullish() });
const errorBody = z.object({ error: z.object({ description: z.string().optional() }) });

type Raw =
  | { ok: true; httpStatus: number; json: unknown }
  | { ok: false; errorKind: "already_attempted" | "provider_error" | "timeout" | "network"; httpStatus: number | null };

function isTimeout(e: unknown): boolean {
  return typeof e === "object" && e !== null && "name" in e && (e.name === "TimeoutError" || e.name === "AbortError");
}

function toInfo(entity: z.infer<typeof linkEntity>): PayLinkInfo {
  return { providerLinkId: entity.id, url: entity.short_url, amountPaise: entity.amount };
}

/** A Razorpay Payment Links client over an injected `fetch`. It never throws. */
export function createRazorpayClient(options: RazorpayClientOptions): RazorpayClient {
  const authorization = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;

  async function request(method: "GET" | "POST", url: string, body?: CreateLinkBody): Promise<Raw> {
    try {
      const res = await options.fetch(url, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        if (isTimeout(e)) return { ok: false, errorKind: "timeout", httpStatus: res.status };
        json = undefined;
      }
      if (res.ok) return { ok: true, httpStatus: res.status, json };
      if (res.status === 400) {
        const parsed = errorBody.safeParse(json);
        const description = parsed.success ? (parsed.data.error.description ?? "") : "";
        if (/reference[ _]?id/i.test(description) && /already/i.test(description)) {
          return { ok: false, errorKind: "already_attempted", httpStatus: res.status };
        }
      }
      return { ok: false, errorKind: "provider_error", httpStatus: res.status };
    } catch (e) {
      return { ok: false, errorKind: isTimeout(e) ? "timeout" : "network", httpStatus: null };
    }
  }

  return {
    async findByReference(draftId) {
      const raw = await request("GET", `${PAYMENT_LINKS_URL}?reference_id=${encodeURIComponent(draftId)}`);
      if (!raw.ok) return raw;
      const list = linkList.safeParse(raw.json);
      if (!list.success) return { ok: false, errorKind: "provider_error", httpStatus: raw.httpStatus };
      const match = list.data.payment_links.find((entry) => {
        const ref = referenceOnly.safeParse(entry);
        return ref.success && ref.data.reference_id === draftId;
      });
      if (match === undefined) return { ok: true, value: null };
      const entity = linkEntity.safeParse(match);
      if (!entity.success) return { ok: false, errorKind: "provider_error", httpStatus: raw.httpStatus };
      return { ok: true, value: toInfo(entity.data) };
    },

    async create(body) {
      const raw = await request("POST", PAYMENT_LINKS_URL, body);
      if (!raw.ok) return raw;
      const entity = linkEntity.safeParse(raw.json);
      if (!entity.success) return { ok: false, errorKind: "provider_error", httpStatus: raw.httpStatus };
      return { ok: true, value: toInfo(entity.data) };
    },
  };
}
