import { createDb } from "../src/client";
import { seed } from "../src/seed";

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const demoBuyerWhatsapp = process.env["DEMO_BUYER_WHATSAPP"];
const { db, close } = createDb(url);
try {
  await seed(db, demoBuyerWhatsapp === undefined ? {} : { demoBuyerWhatsapp });
  console.log("Demo data seeded.");
} finally {
  await close();
}
