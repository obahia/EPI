import Link from "next/link";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { SealMark } from "@/components/seal-mark";
import { getCurrentUser, verifySession } from "@/lib/supabase/dal";
import { isWellFormedInvitationToken } from "@/lib/crypto/invitation-token";
import { AcceptForm } from "./accept-form";
import { signOutToInvitation } from "./actions";

/** A link that lets someone into a tenant has no business in a search index or a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Where an invitation link lands. Outside (dashboard) on purpose: the person opening it has
 * no membership yet, so there is no company to put in a sidebar and nothing to navigate to.
 *
 * This page reads NOTHING about the invitation -- not the organization, not the role, not who
 * sent it. It cannot: authz.membership_invitations is granted to no role, and the only
 * function that reads it is api.accept_invitation, which the person has to invoke themselves.
 * That is the right shape rather than a limitation to work around: a page that described the
 * invitation before acceptance would confirm, to anyone holding a guessed or leaked link,
 * that it is real and which tenant it opens.
 */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await verifySession();
  const user = session.isAuthenticated ? await getCurrentUser() : null;

  // Checked before anything is hashed or looked up: a malformed link cannot have come from
  // generateInvitationToken, so it never reaches the database.
  const wellFormed = isWellFormedInvitationToken(token);
  const nextParam = `/convite/${encodeURIComponent(token)}`;

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-3">
          <SealMark className="size-10" />
          <span className="font-heading text-xl font-extrabold tracking-tight">Selo</span>
        </div>

        {!wellFormed ? (
          <>
            <h1 className="font-heading text-3xl font-extrabold tracking-tight">Convite inválido</h1>
            <p className="text-muted-foreground">
              Este link não está completo. Confira se ele foi copiado inteiro, ou peça um novo a
              quem administra a organização.
            </p>
          </>
        ) : !user ? (
          <>
            <h1 className="font-heading text-3xl font-extrabold tracking-tight">
              Você foi convidado para o Selo
            </h1>
            <p className="text-muted-foreground">
              Entre com a conta do e-mail que recebeu este convite, ou crie uma conta com esse
              mesmo e-mail. O convite vale só para ele — depois de entrar, você volta direto para
              esta tela.
            </p>
            <div className="flex flex-col gap-3">
              <Button asChild className="h-13 text-base">
                <Link href={`/login?next=${encodeURIComponent(nextParam)}`}>Entrar</Link>
              </Button>
              <Button asChild variant="outline" className="h-13 text-base">
                <Link href={`/login?mode=signup&next=${encodeURIComponent(nextParam)}`}>
                  Criar conta
                </Link>
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="font-heading text-3xl font-extrabold tracking-tight">
              Você foi convidado para o Selo
            </h1>
            <p className="text-muted-foreground">
              Ao aceitar, você passa a ter acesso à organização que enviou o convite, no perfil e
              no escopo definidos por quem o enviou.
            </p>
            <div className="flex flex-col items-start gap-1.5 rounded-2xl bg-secondary px-4 py-3 text-[13px]">
              <p>
                Você está entrando como <strong>{user.email}</strong>. Se o convite foi enviado
                para outro e-mail, ele será recusado.
              </p>
              <form action={signOutToInvitation}>
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="cursor-pointer font-bold underline underline-offset-4">
                  Sair e entrar com outra conta
                </button>
              </form>
            </div>
            <AcceptForm token={token} />
          </>
        )}
      </div>
    </main>
  );
}
