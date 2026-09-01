"use server";

import { cookies } from "next/headers";
import { LOCALE_COOKIE, type Locale } from "./dictionaries";

export async function setLocale(locale: Locale) {
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
}
