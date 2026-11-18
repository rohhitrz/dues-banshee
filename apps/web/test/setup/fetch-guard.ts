// Req 9.1: no test reaches Twilio or Razorpay. Any fetch the test does not mock throws
// UnmockedRequestError, and the test fails if a request reached the guard or a fakeHttp left one unmatched.
import { afterEach } from "vitest";
import { collectFetchViolations, installFetchGuard } from "@dues-banshee/agent/testing";

installFetchGuard();

afterEach(() => {
  const violations = collectFetchViolations();
  if (violations.length > 0) throw new Error(`Unmocked HTTP request in this test:\n${violations.join("\n")}`);
});
