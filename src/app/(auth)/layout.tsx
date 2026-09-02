import { getLocale } from "@/i18n/get-locale";
import { getDictionary } from "@/i18n/dictionaries";
import { I18nProvider } from "@/i18n/provider";

/**
 * Chrome-free treatment for the whole auth flow (login/forgot/reset) -- no
 * header, nothing in the top corners. Login (implemented from the Selo
 * Desktop design) fills this edge-to-edge as a split screen; forgot/reset add
 * their own centering and padding since they stay a centered card.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <I18nProvider locale={locale} dict={dict}>
      <div className="flex flex-1 flex-col bg-background">{children}</div>
    </I18nProvider>
  );
}
