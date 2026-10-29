import "dotenv/config";

import { prisma } from "../src/lib/prisma";
import { buildPostRentalWhatsAppLink } from "../src/lib/reviews/whatsapp-review-link";

async function main(): Promise<void> {
const email = process.env.ADMIN_EMAIL?.trim();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error("ADMIN_EMAIL or ADMIN_PASSWORD is missing");
  process.exit(1);
}

const returned = await prisma.booking.findFirst({
  where: { status: { in: ["RETURNED", "COMPLETED"] } },
  orderBy: { updatedAt: "desc" },
  select: {
    id: true,
    status: true,
    customerPhone: true,
    customerFullName: true,
    loyaltyCreditIssued: { select: { id: true } },
  },
});

const confirmed = await prisma.booking.findFirst({
  where: { status: "CONFIRMED", reviewRequest: null },
  orderBy: { updatedAt: "desc" },
  select: { id: true, status: true },
});

if (!returned) {
  console.error("No returned or completed booking found");
  process.exit(1);
}

const login = await fetch("http://localhost:3000/api/admin/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});

if (!login.ok) {
  console.error(`Admin login failed: ${login.status}`);
  process.exit(1);
}

const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");

async function pageHtml(id: string): Promise<string> {
  const response = await fetch(`http://localhost:3000/en/admin/bookings/${id}`, {
    headers: { cookie },
  });
  if (!response.ok) {
    throw new Error(`Booking page ${response.status}`);
  }
  return response.text();
}

const html = await pageHtml(returned.id);
const expected = buildPostRentalWhatsAppLink({
  customerPhone: returned.customerPhone,
  customerFullName: returned.customerFullName,
  includeLoyaltyCredit: returned.loyaltyCreditIssued !== null,
});

const hasLabel = html.includes("Send on WhatsApp");
const hasResend = html.includes("Resend review request") || html.includes("Send review request");
console.log(`returned booking status=${returned.status} label=${hasLabel} emailAction=${hasResend} loyalty=${returned.loyaltyCreditIssued !== null}`);

if (expected.ok) {
  const marker = `https://wa.me/${expected.phone}?text=`;
  const hrefMatch = html.match(/href="(https:\/\/wa\.me\/[^"]+)"/);
  const href = hrefMatch?.[1]?.replaceAll("&amp;", "&") ?? "";
  const text = new URL(href || "https://wa.me/0").searchParams.get("text") ?? "";
  console.log(`wa.me present=${html.includes(marker)} phoneDigits=${expected.phone.length}`);
  console.log(`message has greeting=${text.startsWith("Hi ")}`);
  console.log(`message has loyalty=${text.includes("€5 credit available toward your next booking")}`);
  console.log(`message has review=${text.includes("shared your experience with us on Google")}`);
  console.log(`message loyalty matches credit=${text.includes("€5 credit available") === (returned.loyaltyCreditIssued !== null)}`);
  console.log(`message avoids review-for-credit=${!/review to receive|leave a review to/i.test(text)}`);
  if (!html.includes(marker) || !text.includes("shared your experience with us on Google")) process.exitCode = 1;
} else {
  console.log(`link unavailable reason=${expected.reason}`);
  const disabled = html.includes("No valid WhatsApp number available") || html.includes("Google review link is not configured");
  console.log(`unavailable message=${disabled}`);
  if (!disabled) process.exitCode = 1;
}

if (!hasLabel || !hasResend) process.exitCode = 1;

const withoutCredit = await prisma.booking.findFirst({
  where: { status: { in: ["RETURNED", "COMPLETED"] }, loyaltyCreditIssued: null },
  orderBy: { updatedAt: "desc" },
  select: { id: true, customerPhone: true, customerFullName: true },
});

if (withoutCredit) {
  const noCreditHtml = await pageHtml(withoutCredit.id);
  const noCreditHref = noCreditHtml.match(/href="(https:\/\/wa\.me\/[^"]+)"/)?.[1]?.replaceAll("&amp;", "&") ?? "";
  const noCreditText = noCreditHref ? (new URL(noCreditHref).searchParams.get("text") ?? "") : "";
  const noCreditLink = buildPostRentalWhatsAppLink({
    customerPhone: withoutCredit.customerPhone,
    customerFullName: withoutCredit.customerFullName,
    includeLoyaltyCredit: false,
  });
  console.log(`no-credit booking link=${noCreditLink.ok} omitsEuro=${noCreditText.length === 0 || !noCreditText.includes("€5")}`);
  if (noCreditLink.ok && noCreditText.includes("€5")) process.exitCode = 1;
}

if (confirmed) {
  const confirmedHtml = await pageHtml(confirmed.id);
  const confirmedHasLink = confirmedHtml.includes("https://wa.me/");
  console.log(`confirmed booking hides WhatsApp link=${!confirmedHasLink}`);
  if (confirmedHasLink) process.exitCode = 1;
}

await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
