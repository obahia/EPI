import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { I18nProvider } from "@/i18n/provider";

/**
 * Dark, chrome-free treatment for the whole auth flow (login/forgot/reset) --
 * scoped to just this route group via the `dark` class (see the .dark block in
 * globals.css), never applied to the authenticated panel. No header: nothing in
 * the top corners, by explicit request -- the centered SealMark is each page's
 * only brand mark.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <I18nProvider locale={locale} dict={dict}>
      <div className="dark flex flex-1 flex-col bg-background">
        <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">{children}</main>
      </div>
    </I18nProvider>
  );
}
